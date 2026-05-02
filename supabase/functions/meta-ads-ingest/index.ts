// Edge Function: meta-ads-ingest
//
// Pulls daily ad-level performance from Meta Marketing API and upserts
// into ads_switchable.meta_daily. Idempotent on (date, ad_id) — safe to
// re-run for the same date range.
//
// Auth: x-audit-key header matched against AUDIT_SHARED_SECRET (same
// pattern as netlify-leads-reconcile and admin-brevo-resync). Designed
// to be called from pg_cron daily, plus manually from the dashboard for
// backfills. Deploy with --no-verify-jwt; verify_jwt=false in config.toml.
//
// Required env:
//   META_ACCESS_TOKEN     System User token with ads_read on the account
//   META_AD_ACCOUNT_ID    Numeric account id (we prepend act_ ourselves)
//
// Body (optional):
//   { "since": "2026-04-01", "until": "2026-05-02" }  // YYYY-MM-DD
//
// Default range: last 7 days (rolling window). Last 7d covers any late
// attribution Meta backdates within their settlement window.
//
// Response shape:
//   { ok: true, rows_upserted, days, accounts: [...], pages_fetched }
//
// Failure handling:
//   - Token / network error → leads.dead_letter row + 500 to caller
//   - Per-row upsert failure → logged to leads.dead_letter, ingestion continues

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN");
const META_AD_ACCOUNT_ID = Deno.env.get("META_AD_ACCOUNT_ID");
const META_API_VERSION = Deno.env.get("META_API_VERSION") ?? "v22.0";

if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL is not set.");

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

interface InsightRow {
  date_start: string;
  date_stop: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  frequency?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  account_id?: string;
  actions?: Array<{ action_type: string; value: string }>;
}

interface InsightsResponse {
  data: InsightRow[];
  paging?: { next?: string; cursors?: { before?: string; after?: string } };
  error?: { message: string; type: string; code: number };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Auth via Vault-stored audit secret
  const providedKey = req.headers.get("x-audit-key");
  if (!providedKey) return json({ error: "missing x-audit-key" }, 401);
  let expectedKey: string;
  try {
    const [row] = await sql<Array<{ secret: string }>>`
      SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
    `;
    expectedKey = row?.secret ?? "";
    if (!expectedKey) throw new Error("AUDIT_SHARED_SECRET not in vault");
  } catch (err) {
    console.error("vault fetch failed:", String(err));
    return json({ error: "AUDIT_SHARED_SECRET not retrievable" }, 500);
  }
  if (providedKey !== expectedKey) return json({ error: "unauthorized" }, 401);

  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    return json({ error: "META_ACCESS_TOKEN or META_AD_ACCOUNT_ID not set" }, 500);
  }

  // Parse optional date range
  let since: string;
  let until: string;
  try {
    const body = (await req.json().catch(() => ({}))) as { since?: string; until?: string };
    until = body.until ?? new Date().toISOString().slice(0, 10);
    since = body.since ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    return json({ error: "since/until must be YYYY-MM-DD" }, 400);
  }

  const adAccountId = META_AD_ACCOUNT_ID.replace(/^act_/, "");
  const fields = [
    "date_start",
    "date_stop",
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
    "ad_id",
    "ad_name",
    "spend",
    "impressions",
    "reach",
    "frequency",
    "clicks",
    "ctr",
    "cpc",
    "cpm",
    "actions",
    "account_id",
  ].join(",");

  const baseUrl = `https://graph.facebook.com/${META_API_VERSION}/act_${adAccountId}/insights`;
  const params = new URLSearchParams({
    level: "ad",
    time_increment: "1",
    time_range: JSON.stringify({ since, until }),
    fields,
    limit: "200",
    access_token: META_ACCESS_TOKEN,
  });

  let url: string | undefined = `${baseUrl}?${params.toString()}`;
  const collected: InsightRow[] = [];
  let pagesFetched = 0;
  const MAX_PAGES = 50; // safety bound

  while (url && pagesFetched < MAX_PAGES) {
    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
    } catch (err) {
      await persistDeadLetter("edge_function_meta_ingest_fetch", { url: redactToken(url), since, until }, `fetch failed: ${String(err)}`);
      return json({ error: `fetch failed: ${String(err)}` }, 502);
    }

    let body: InsightsResponse;
    try {
      body = (await resp.json()) as InsightsResponse;
    } catch {
      await persistDeadLetter("edge_function_meta_ingest_parse", { since, until }, `non-JSON response (status ${resp.status})`);
      return json({ error: `non-JSON response from Meta (${resp.status})` }, 502);
    }

    if (!resp.ok || body.error) {
      await persistDeadLetter("edge_function_meta_ingest_api", { since, until, status: resp.status }, `Meta API error: ${body.error?.message ?? `HTTP ${resp.status}`}`);
      return json({ error: body.error?.message ?? `Meta API ${resp.status}`, raw: body }, 502);
    }

    collected.push(...(body.data ?? []));
    url = body.paging?.next;
    pagesFetched += 1;
  }

  // Upsert
  let upserted = 0;
  let upsertFailures = 0;
  for (const r of collected) {
    if (!r.ad_id || !r.date_start) continue;

    const leadsCount = sumActionLeads(r.actions);
    const spendNum = numOr(r.spend, 0);
    const cpl = leadsCount > 0 ? Math.round((spendNum / leadsCount) * 100) / 100 : null;

    try {
      await sql`
        INSERT INTO ads_switchable.meta_daily (
          date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
          ad_id, ad_name,
          spend, impressions, reach, frequency, clicks, ctr, cpc, cpm,
          leads, cost_per_lead,
          fetched_at, raw_payload
        ) VALUES (
          ${r.date_start}, ${r.account_id ?? adAccountId}, ${r.campaign_id ?? ""}, ${r.campaign_name ?? null},
          ${r.adset_id ?? null}, ${r.adset_name ?? null},
          ${r.ad_id}, ${r.ad_name ?? null},
          ${spendNum}, ${numOr(r.impressions, 0)}, ${numOrNull(r.reach)}, ${numOrNull(r.frequency)},
          ${numOr(r.clicks, 0)}, ${numOrNull(r.ctr)}, ${numOrNull(r.cpc)}, ${numOrNull(r.cpm)},
          ${leadsCount}, ${cpl},
          now(), ${sql.json(r as unknown as Record<string, unknown>)}
        )
        ON CONFLICT (date, ad_id) DO UPDATE SET
          ad_account_id = EXCLUDED.ad_account_id,
          campaign_id = EXCLUDED.campaign_id,
          campaign_name = EXCLUDED.campaign_name,
          adset_id = EXCLUDED.adset_id,
          adset_name = EXCLUDED.adset_name,
          ad_name = EXCLUDED.ad_name,
          spend = EXCLUDED.spend,
          impressions = EXCLUDED.impressions,
          reach = EXCLUDED.reach,
          frequency = EXCLUDED.frequency,
          clicks = EXCLUDED.clicks,
          ctr = EXCLUDED.ctr,
          cpc = EXCLUDED.cpc,
          cpm = EXCLUDED.cpm,
          leads = EXCLUDED.leads,
          cost_per_lead = EXCLUDED.cost_per_lead,
          fetched_at = EXCLUDED.fetched_at,
          raw_payload = EXCLUDED.raw_payload
      `;
      upserted += 1;
    } catch (err) {
      upsertFailures += 1;
      console.error("meta_daily upsert failed:", String(err));
      await persistDeadLetter("edge_function_meta_ingest_upsert", { ad_id: r.ad_id, date: r.date_start }, `upsert failed: ${String(err)}`);
    }
  }

  return json(
    {
      ok: true,
      since,
      until,
      pages_fetched: pagesFetched,
      rows_received: collected.length,
      rows_upserted: upserted,
      rows_failed: upsertFailures,
    },
    200,
  );
});

// ---- Helpers ----

function sumActionLeads(actions: Array<{ action_type: string; value: string }> | undefined): number {
  if (!actions) return 0;
  // Meta exposes lead conversions under several action_type values depending
  // on event source (pixel, CAPI, on-Facebook lead form). Sum them all.
  const leadTypes = new Set(["lead", "onsite_conversion.lead", "offsite_conversion.fb_pixel_lead", "leadgen.other"]);
  let total = 0;
  for (const a of actions) {
    if (leadTypes.has(a.action_type)) total += Number(a.value) || 0;
  }
  return total;
}

function numOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function persistDeadLetter(source: string, ctx: unknown, errorContext: string): Promise<void> {
  try {
    await sql`
      INSERT INTO leads.dead_letter (source, raw_payload, error_context, received_at)
      VALUES (${source}, ${sql.json(ctx as Record<string, unknown>)}, ${errorContext}, now())
    `;
  } catch (err) {
    console.error("dead_letter write failed:", String(err));
  }
}

function redactToken(url: string): string {
  return url.replace(/access_token=[^&]+/, "access_token=REDACTED");
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
