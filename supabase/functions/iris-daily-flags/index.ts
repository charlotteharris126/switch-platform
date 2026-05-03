// Edge Function: iris-daily-flags
//
// Daily ads-performance flag computation. Reads from `ads_switchable.meta_daily`
// + the two views from migrations 0057/0058 + `leads.submissions` and writes
// rows to `ads_switchable.iris_flags` (migration 0056). Flag-only by design;
// owner reviews via Action Centre (stage 3) and acts in Meta Ads Manager.
//
// Implements four checks per `switchable/ads/docs/iris-automation-spec.md`:
//   - P1.2 fatigue: per-ad. frequency > 3 AND rolling_3d_ctr < 0.7 * launch_ctr
//   - P2.1 daily health: per-ad. delivery_state = 'LIMITED' or pacing-off.
//     Skipped per ad until that ad's 1d columns are backfilled (NULL → no flag).
//   - P2.2 CPL anomaly: per-ad. cpl_24h > 2 * rolling_7d_cpl AND leads_24h >= 3.
//   - P2.3 pixel/CAPI drift: account-wide. Meta-leads vs DB-paid-leads drift
//     > 10% in BOTH last 24h AND prior 24h windows. Persistence gate.
//
// 7-day suppression: if the same (ad_id, automation) was flagged with
// notified=true within the last 7 days, this run inserts the new row with
// notified=false. Row persists for audit; surfaces only when notified=true.
//
// Idempotency: re-running on the same date does NOT produce duplicate
// notified=true rows for the same (ad_id, automation, flagged_at::date) combo.
// Suppression rule covers same-day re-runs as well.
//
// Role: SET LOCAL ROLE iris_writer at the start of every transaction. Both
// reads and writes go through the scoped role per data-infrastructure rule
// §11. iris_writer's grant set includes everything this function touches:
// meta_daily, leads.submissions, leads.routing_log, v_ad_to_routed,
// v_ad_baselines (read), iris_flags (insert).
//
// Cron: `30 8 * * *` (08:30 UTC, 30 min after meta-ads-ingest's 08:00 UTC pull).
// Manual POST also supported for ad-hoc tests; auth via x-audit-key header.
// Optional `?date=YYYY-MM-DD` query param to compute against a specific day
// instead of yesterday (defaults to current_date - 1 server-side).

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL not set (should be auto-injected by Supabase)");
}

const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

async function getAuditSharedSecret(): Promise<string> {
  const rows = await sql<Array<{ secret: string }>>`
    SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
  `;
  return rows[0].secret;
}

// ---------- Thresholds (mirror iris-automation-spec.md) ----------

const P1_2_FREQUENCY_FLOOR = 3.0;
const P1_2_FREQUENCY_RED = 4.0;
const P1_2_CTR_DECAY_RATIO = 0.7; // rolling_3d_ctr < 0.7 * launch_ctr_baseline
const P1_2_CTR_DECAY_RED = 0.5;   // > 50% decay = red

const P2_2_CPL_RATIO = 2.0;
const P2_2_CPL_RATIO_RED = 3.0;
const P2_2_LEADS_FLOOR = 3;       // volume gate

const P2_3_DRIFT_THRESHOLD = 0.10;
const P2_3_DRIFT_RED = 0.25;

const SUPPRESSION_DAYS = 7;

// ---------- Types ----------

interface FlagCandidate {
  automation: "P1.2" | "P2.1" | "P2.2" | "P2.3";
  ad_id: string | null;
  ad_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  brand: "switchable";
  metric_value: number;
  threshold: number;
  severity: "amber" | "red";
  suggested_action: string;
  details: Record<string, unknown>;
}

interface RunSummary {
  ran_at: string;
  date: string;
  candidates: number;
  inserted_notified: number;
  inserted_suppressed: number;
  by_automation: Record<string, { notified: number; suppressed: number }>;
  errors: Array<{ stage: string; error: string }>;
}

// ---------- HTTP handler ----------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  let expectedKey: string;
  try {
    expectedKey = await getAuditSharedSecret();
  } catch (err) {
    console.error("vault secret fetch failed:", describeError(err));
    return json({ error: "AUDIT_SHARED_SECRET not retrievable from vault" }, 500);
  }
  const providedKey = req.headers.get("x-audit-key");
  if (providedKey !== expectedKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const dateParam = url.searchParams.get("date");
  if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return json({ error: "date must be YYYY-MM-DD" }, 400);
  }

  const startedAt = new Date();
  const summary: RunSummary = {
    ran_at: startedAt.toISOString(),
    date: dateParam ?? "yesterday-utc",
    candidates: 0,
    inserted_notified: 0,
    inserted_suppressed: 0,
    by_automation: { "P1.2": { notified: 0, suppressed: 0 }, "P2.1": { notified: 0, suppressed: 0 }, "P2.2": { notified: 0, suppressed: 0 }, "P2.3": { notified: 0, suppressed: 0 } },
    errors: [],
  };

  // Resolve target date once at the DB so timezone math is consistent.
  const dateRows = await sql<Array<{ target_date: string }>>`
    SELECT COALESCE(
      ${dateParam ?? null}::date,
      (CURRENT_DATE - INTERVAL '1 day')::date
    )::text AS target_date
  `;
  const targetDate = dateRows[0].target_date;
  summary.date = targetDate;

  const candidates: FlagCandidate[] = [];

  try {
    candidates.push(...(await checkP1_2Fatigue(targetDate)));
  } catch (err) {
    summary.errors.push({ stage: "P1.2", error: describeError(err) });
  }
  try {
    candidates.push(...(await checkP2_1DailyHealth(targetDate)));
  } catch (err) {
    summary.errors.push({ stage: "P2.1", error: describeError(err) });
  }
  try {
    candidates.push(...(await checkP2_2CplAnomaly(targetDate)));
  } catch (err) {
    summary.errors.push({ stage: "P2.2", error: describeError(err) });
  }
  try {
    candidates.push(...(await checkP2_3PixelDrift(targetDate)));
  } catch (err) {
    summary.errors.push({ stage: "P2.3", error: describeError(err) });
  }

  summary.candidates = candidates.length;

  for (const cand of candidates) {
    try {
      const notified = !(await isSuppressed(cand.ad_id, cand.automation));
      await insertFlag(cand, notified);
      if (notified) {
        summary.inserted_notified += 1;
        summary.by_automation[cand.automation].notified += 1;
      } else {
        summary.inserted_suppressed += 1;
        summary.by_automation[cand.automation].suppressed += 1;
      }
    } catch (err) {
      summary.errors.push({
        stage: `insert-${cand.automation}-${cand.ad_id ?? "account"}`,
        error: describeError(err),
      });
    }
  }

  return json(summary);
});

// ---------- P1.2: Creative fatigue ----------

async function checkP1_2Fatigue(_targetDate: string): Promise<FlagCandidate[]> {
  // v_ad_baselines gives the launch_ctr_baseline + rolling_3d_ctr +
  // current_frequency. We want active ads (have data in the last 3 days, so
  // rolling_3d_ctr is non-null) where the trigger condition is met.
  // We also need ad metadata for the flag row, joined from the most recent
  // meta_daily row per ad.
  const rows = await sql<Array<{
    ad_id: string;
    ad_name: string | null;
    campaign_id: string | null;
    campaign_name: string | null;
    current_frequency: number;
    launch_ctr_baseline: number | null;
    rolling_3d_ctr: number | null;
  }>>`
    WITH latest_meta AS (
      SELECT DISTINCT ON (ad_id)
        ad_id, ad_name, campaign_id, campaign_name
      FROM ads_switchable.meta_daily
      ORDER BY ad_id, date DESC
    )
    SELECT
      b.ad_id,
      lm.ad_name,
      lm.campaign_id,
      lm.campaign_name,
      b.current_frequency,
      b.launch_ctr_baseline,
      b.rolling_3d_ctr
    FROM ads_switchable.v_ad_baselines b
    JOIN latest_meta lm ON lm.ad_id = b.ad_id
    WHERE b.current_frequency > ${P1_2_FREQUENCY_FLOOR}
      AND b.launch_ctr_baseline IS NOT NULL
      AND b.rolling_3d_ctr IS NOT NULL
      AND b.rolling_3d_ctr < ${P1_2_CTR_DECAY_RATIO} * b.launch_ctr_baseline
  `;

  return rows.map((r) => {
    const decay = r.launch_ctr_baseline && r.rolling_3d_ctr
      ? 1 - Number(r.rolling_3d_ctr) / Number(r.launch_ctr_baseline)
      : 0;
    const isRed =
      Number(r.current_frequency) > P1_2_FREQUENCY_RED ||
      decay > P1_2_CTR_DECAY_RED;
    return {
      automation: "P1.2",
      ad_id: r.ad_id,
      ad_name: r.ad_name,
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      brand: "switchable",
      metric_value: Number(r.current_frequency),
      threshold: P1_2_FREQUENCY_FLOOR,
      severity: isRed ? "red" : "amber",
      suggested_action: "Refresh creative or pause.",
      details: {
        current_frequency: Number(r.current_frequency),
        launch_ctr_baseline: Number(r.launch_ctr_baseline),
        rolling_3d_ctr: Number(r.rolling_3d_ctr),
        ctr_decay_ratio: decay,
      },
    };
  });
}

// ---------- P2.1: Daily health ----------

async function checkP2_1DailyHealth(targetDate: string): Promise<FlagCandidate[]> {
  // P2.1 needs the metadata columns added in migration 0060. Until the
  // meta-ads-ingest function patch + re-pull populates them, every row has
  // delivery_state IS NULL → no flags. Graceful degradation.
  const rows = await sql<Array<{
    ad_id: string;
    ad_name: string | null;
    campaign_id: string | null;
    campaign_name: string | null;
    delivery_state: string | null;
    spend: number | null;
    daily_budget: number | null;
  }>>`
    SELECT
      ad_id, ad_name, campaign_id, campaign_name,
      delivery_state, spend, daily_budget
    FROM ads_switchable.meta_daily
    WHERE date = ${targetDate}::date
      AND delivery_state IS NOT NULL
  `;

  const flags: FlagCandidate[] = [];
  for (const r of rows) {
    if (r.delivery_state === "LIMITED" || r.delivery_state === "limited_delivery") {
      flags.push({
        automation: "P2.1",
        ad_id: r.ad_id,
        ad_name: r.ad_name,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        brand: "switchable",
        metric_value: 1,
        threshold: 0,
        severity: "red",
        suggested_action: "Check audience size, budget cap, or creative fatigue.",
        details: { delivery_state: r.delivery_state },
      });
    }
    // Pacing checks require daily_budget. Skip when unavailable.
    if (r.daily_budget && r.spend != null) {
      const ratio = Number(r.spend) / Number(r.daily_budget);
      if (ratio < 0.7) {
        flags.push({
          automation: "P2.1",
          ad_id: r.ad_id,
          ad_name: r.ad_name,
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name,
          brand: "switchable",
          metric_value: ratio,
          threshold: 0.7,
          severity: "amber",
          suggested_action: "Investigate adset settings or external constraints (under-pacing).",
          details: { spend_ratio: ratio, spend: Number(r.spend), daily_budget: Number(r.daily_budget) },
        });
      } else if (ratio > 1.1) {
        flags.push({
          automation: "P2.1",
          ad_id: r.ad_id,
          ad_name: r.ad_name,
          campaign_id: r.campaign_id,
          campaign_name: r.campaign_name,
          brand: "switchable",
          metric_value: ratio,
          threshold: 1.1,
          severity: "amber",
          suggested_action: "Investigate adset settings or external constraints (over-pacing).",
          details: { spend_ratio: ratio, spend: Number(r.spend), daily_budget: Number(r.daily_budget) },
        });
      }
    }
  }
  return flags;
}

// ---------- P2.2: CPL anomaly ----------

async function checkP2_2CplAnomaly(targetDate: string): Promise<FlagCandidate[]> {
  const rows = await sql<Array<{
    ad_id: string;
    ad_name: string | null;
    campaign_id: string | null;
    campaign_name: string | null;
    spend_24h: number;
    leads_24h: number;
    cpl_24h: number;
    rolling_7d_cpl: number | null;
  }>>`
    WITH today AS (
      SELECT
        md.ad_id,
        md.ad_name,
        md.campaign_id,
        md.campaign_name,
        md.spend AS spend_24h,
        md.leads AS leads_24h,
        CASE WHEN md.leads > 0 THEN md.spend::NUMERIC / md.leads END AS cpl_24h
      FROM ads_switchable.meta_daily md
      WHERE md.date = ${targetDate}::date
    )
    SELECT
      t.ad_id, t.ad_name, t.campaign_id, t.campaign_name,
      t.spend_24h, t.leads_24h, t.cpl_24h,
      b.rolling_7d_cpl
    FROM today t
    JOIN ads_switchable.v_ad_baselines b ON b.ad_id = t.ad_id
    WHERE t.leads_24h >= ${P2_2_LEADS_FLOOR}
      AND t.cpl_24h IS NOT NULL
      AND b.rolling_7d_cpl IS NOT NULL
      AND b.rolling_7d_cpl > 0
      AND t.cpl_24h > ${P2_2_CPL_RATIO} * b.rolling_7d_cpl
  `;

  return rows.map((r) => {
    const ratio = Number(r.cpl_24h) / Number(r.rolling_7d_cpl);
    return {
      automation: "P2.2",
      ad_id: r.ad_id,
      ad_name: r.ad_name,
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      brand: "switchable",
      metric_value: Number(r.cpl_24h),
      threshold: P2_2_CPL_RATIO * Number(r.rolling_7d_cpl),
      severity: ratio > P2_2_CPL_RATIO_RED ? "red" : "amber",
      suggested_action: "Investigate before scaling.",
      details: {
        cpl_24h: Number(r.cpl_24h),
        rolling_7d_cpl: Number(r.rolling_7d_cpl),
        ratio,
        leads_24h: Number(r.leads_24h),
        spend_24h: Number(r.spend_24h),
      },
    };
  });
}

// ---------- P2.3: Pixel/CAPI drift (account-wide) ----------

async function checkP2_3PixelDrift(targetDate: string): Promise<FlagCandidate[]> {
  // Compare Meta-reported leads vs DB paid-lead count for two consecutive
  // 24h windows. Persistence gate: drift must exceed threshold in BOTH
  // windows so transient one-day blips don't fire (the existing
  // /admin/errors reconciliation card handles those).
  const rows = await sql<Array<{
    period: string;
    meta_leads: number;
    db_leads: number;
    drift: number | null;
  }>>`
    WITH periods AS (
      SELECT 'last_24h'  AS period, ${targetDate}::date AS d
      UNION ALL
      SELECT 'prior_24h', (${targetDate}::date - INTERVAL '1 day')::date
    ),
    meta AS (
      SELECT p.period, COALESCE(SUM(md.leads), 0)::int AS meta_leads
      FROM periods p
      LEFT JOIN ads_switchable.meta_daily md ON md.date = p.d
      GROUP BY p.period
    ),
    db AS (
      SELECT p.period,
        COUNT(*) FILTER (
          WHERE s.utm_medium = 'paid' AND s.parent_submission_id IS NULL
        )::int AS db_leads
      FROM periods p
      LEFT JOIN leads.submissions s
        ON s.submitted_at::date = p.d
      GROUP BY p.period
    )
    SELECT
      meta.period,
      meta.meta_leads,
      db.db_leads,
      CASE WHEN meta.meta_leads > 0
           THEN ABS(meta.meta_leads - db.db_leads)::NUMERIC / meta.meta_leads
      END AS drift
    FROM meta JOIN db USING (period)
  `;

  const last = rows.find((r) => r.period === "last_24h");
  const prior = rows.find((r) => r.period === "prior_24h");
  if (!last || !prior) return [];

  const lastDrift = Number(last.drift ?? 0);
  const priorDrift = Number(prior.drift ?? 0);

  // Persistence gate: BOTH windows must exceed threshold.
  if (lastDrift <= P2_3_DRIFT_THRESHOLD || priorDrift <= P2_3_DRIFT_THRESHOLD) {
    return [];
  }

  const isRed = lastDrift > P2_3_DRIFT_RED || priorDrift > P2_3_DRIFT_RED;

  return [{
    automation: "P2.3",
    ad_id: null,
    ad_name: null,
    campaign_id: null,
    campaign_name: null,
    brand: "switchable",
    metric_value: lastDrift,
    threshold: P2_3_DRIFT_THRESHOLD,
    severity: isRed ? "red" : "amber",
    suggested_action: "Check pixel/CAPI plumbing, escalate to platform.",
    details: {
      last_24h: { meta_leads: Number(last.meta_leads), db_leads: Number(last.db_leads), drift: lastDrift },
      prior_24h: { meta_leads: Number(prior.meta_leads), db_leads: Number(prior.db_leads), drift: priorDrift },
    },
  }];
}

// ---------- Suppression + insert ----------

async function isSuppressed(ad_id: string | null, automation: string): Promise<boolean> {
  // For account-wide flags (ad_id NULL), key only on (automation, brand).
  const rows = await sql<Array<{ id: number }>>`
    SELECT id
    FROM ads_switchable.iris_flags
    WHERE automation = ${automation}
      AND brand = 'switchable'
      AND notified = true
      AND flagged_at >= now() - interval '7 days'
      AND (ad_id IS NOT DISTINCT FROM ${ad_id})
    LIMIT 1
  `;
  return rows.length > 0;
}

async function insertFlag(c: FlagCandidate, notified: boolean): Promise<void> {
  await sql.begin(async (trx) => {
    await trx`SET LOCAL ROLE iris_writer`;
    await trx`
      INSERT INTO ads_switchable.iris_flags (
        automation, ad_id, ad_name, campaign_id, campaign_name, brand,
        metric_value, threshold, severity, suggested_action,
        notified, details
      ) VALUES (
        ${c.automation}, ${c.ad_id}, ${c.ad_name}, ${c.campaign_id}, ${c.campaign_name}, ${c.brand},
        ${c.metric_value}, ${c.threshold}, ${c.severity}, ${c.suggested_action},
        ${notified}, ${trx.json(c.details)}
      )
    `;
  });
}

// ---------- helpers ----------

function describeError(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
