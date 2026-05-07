// Edge Function: email-sunset-cron
//
// Daily cron at 03:00 UTC. Two-phase engagement-based sunset for
// marketing-consenting Switchable contacts. Implements the spec's
// deliverability backstop (platform/docs/email-platform-rearchitecture-spec.md
// §"Sunset policy"). Without this backstop, marketing emails keep firing at
// dead inboxes after long periods of zero engagement, hurting sender
// reputation. Cron runs ahead of brevo-consent-reconcile-daily (04:00 UTC)
// so any suppression flips have settled before the reconcile pass reads
// state.
//
// Phase 1 — re-engagement send:
//   Candidates: marketing_opt_in=true contacts whose first email_log send
//   landed ≥180 days ago AND with no opened/clicked rows in the last 180
//   days AND no re_engagement row sent yet. (The first-send floor is the
//   "contact has actually had a chance to engage" gate — same family as
//   the 30-day grace from the entry-filter rule. Brand-new contacts who
//   have never been emailed don't qualify.)
//   Action: sendTransactional with BREVO_TEMPLATE_RE_ENGAGEMENT to the
//   contact's most recent submission row.
//
// Phase 2 — suppress:
//   Candidates: contacts who received re_engagement ≥14 days ago AND have
//   no opened/clicked rows in email_log dated after that re_engagement
//   triggered_at AND still carry marketing_opt_in=true.
//   Action: flip marketing_opt_in=false on every matching submission row,
//   push SW_CONSENT_MARKETING=false + channel=unsubscribed to Brevo, log
//   to crm.consent_history with source='sunset_suppression'.
//
// Asymmetry: only the marketing channel is suppressed. Transactional
// (utility) sends keep working — the contract basis for those emails is
// independent of marketing engagement.
//
// Auth: x-audit-key / AUDIT_SHARED_SECRET vault lookup (matches every
// other internal cron). Deploy with --no-verify-jwt.
//
// BREVO_TEMPLATE_RE_ENGAGEMENT must be set in Supabase Vault before the
// cron does any real Phase 1 work — otherwise Phase 1 silently skips
// every candidate via the missing-template branch in sendTransactional.
// Phase 2 runs regardless of template state (it only fires for contacts
// that already received the re-engagement).

import postgres from "npm:postgres@3";
import { sendTransactional, upsertBrevoContact } from "../_shared/brevo.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL is not set.");
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

const THROTTLE_MS = 250;
const SUNSET_DAYS = 180;
const REENGAGE_GRACE_DAYS = 14;

interface ReEngagementCandidate {
  submission_id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
}

interface SuppressionCandidate {
  email: string;
  reengagement_triggered_at: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  const providedKey = req.headers.get("x-audit-key");
  if (!providedKey) return new Response("Unauthorized", { status: 401 });

  let expectedKey: string;
  try {
    const [row] = await sql<Array<{ secret: string }>>`
      SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
    `;
    expectedKey = row?.secret ?? "";
    if (!expectedKey) throw new Error("AUDIT_SHARED_SECRET not in vault");
  } catch (err) {
    console.error("vault secret fetch failed:", String(err));
    return json({ error: "AUDIT_SHARED_SECRET not retrievable from vault" }, 500);
  }
  if (providedKey !== expectedKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  // -----------------------------------------------------------------
  // Phase 1: re-engagement candidates
  // -----------------------------------------------------------------
  // One candidate row per email address, picking the MOST RECENT submission
  // (any opt-in state) and then filtering on its marketing_opt_in. This
  // matters: a contact may have re-submitted later with opt-in=false. The
  // most-recent submission is the active expression of consent. Picking
  // an older opt-in=true row would silently re-engage someone who later
  // unticked the consent box (GDPR Art. 21 exposure).
  let reEngageCandidates: ReEngagementCandidate[];
  try {
    reEngageCandidates = await sql<ReEngagementCandidate[]>`
      WITH per_email AS (
        SELECT DISTINCT ON (LOWER(s.email))
               s.id               AS submission_id,
               s.email            AS email,
               s.first_name,
               s.last_name,
               s.marketing_opt_in AS marketing_opt_in
          FROM leads.submissions s
         WHERE s.is_dq = false
           AND s.archived_at IS NULL
           AND s.email IS NOT NULL
         ORDER BY LOWER(s.email), s.submitted_at DESC
      )
      SELECT pe.submission_id, pe.email, pe.first_name, pe.last_name
        FROM per_email pe
       WHERE pe.marketing_opt_in = true
         AND EXISTS (
               -- has had at least one HEALTHY-STATUS send ≥180 days ago,
               -- so they've genuinely received emails. Bounced / failed /
               -- queued rows don't count — they never reached the inbox.
               SELECT 1 FROM crm.email_log el
                JOIN leads.submissions s2 ON s2.id = el.submission_id
                WHERE LOWER(s2.email) = LOWER(pe.email)
                  AND el.status IN ('sent', 'delivered', 'opened', 'clicked')
                  AND el.triggered_at < now() - (${SUNSET_DAYS}::int || ' days')::interval
             )
         AND NOT EXISTS (
               -- no opens/clicks in the last 180 days
               SELECT 1 FROM crm.email_log el
                JOIN leads.submissions s2 ON s2.id = el.submission_id
                WHERE LOWER(s2.email) = LOWER(pe.email)
                  AND el.status IN ('opened', 'clicked')
                  AND el.triggered_at >= now() - (${SUNSET_DAYS}::int || ' days')::interval
             )
         AND NOT EXISTS (
               -- never re-engaged before (one-shot per contact). LIMIT 500
               -- self-resumes correctly: processed rows fall out via this
               -- guard on the next run.
               SELECT 1 FROM crm.email_log el
                JOIN leads.submissions s2 ON s2.id = el.submission_id
                WHERE LOWER(s2.email) = LOWER(pe.email)
                  AND el.email_type = 're_engagement'
             )
       ORDER BY pe.submission_id
       LIMIT 500
    `;
  } catch (err) {
    console.error("re-engagement candidate query failed:", String(err));
    return json({ error: `re-engagement candidate query: ${String(err)}` }, 500);
  }

  const reEngageTemplateId = parseEnvInt("BREVO_TEMPLATE_RE_ENGAGEMENT");
  let reEngageSent = 0;
  let reEngageSkipped = 0;
  let reEngageFailed = 0;
  for (let i = 0; i < reEngageCandidates.length; i++) {
    if (i > 0) await sleep(THROTTLE_MS);
    const c = reEngageCandidates[i];

    if (reEngageTemplateId == null) {
      reEngageSkipped++;
      continue;
    }

    const recipientName = [c.first_name, c.last_name].filter(Boolean).join(" ") || undefined;
    const result = await sendTransactional({
      sql,
      templateId: reEngageTemplateId,
      recipient: { email: c.email, name: recipientName },
      params: {
        FIRSTNAME: c.first_name ?? "",
        LASTNAME: c.last_name ?? "",
      },
      submissionId: c.submission_id,
      emailType: "re_engagement",
      brand: "switchable",
      tags: ["re_engagement", "sunset", "cron"],
    });

    if (result.ok && result.status === "sent") {
      reEngageSent++;
    } else if (result.status === "skipped_duplicate" || result.status === "skipped_missing_template") {
      reEngageSkipped++;
    } else {
      reEngageFailed++;
    }
  }

  // -----------------------------------------------------------------
  // Phase 2: suppression candidates
  // -----------------------------------------------------------------
  // Anyone whose re_engagement send was ≥14 days ago AND who hasn't opened
  // or clicked anything since. Idempotent on marketing_opt_in=true.
  let suppressCandidates: SuppressionCandidate[];
  try {
    suppressCandidates = await sql<SuppressionCandidate[]>`
      WITH reengaged AS (
        SELECT LOWER(s.email)         AS email_lower,
               MAX(el.triggered_at)   AS reengagement_triggered_at
          FROM crm.email_log el
          JOIN leads.submissions s ON s.id = el.submission_id
         WHERE el.email_type = 're_engagement'
           AND el.status IN ('sent', 'delivered', 'opened', 'clicked')
         GROUP BY LOWER(s.email)
      )
      SELECT r.email_lower AS email, r.reengagement_triggered_at::text AS reengagement_triggered_at
        FROM reengaged r
       WHERE r.reengagement_triggered_at < now() - (${REENGAGE_GRACE_DAYS}::int || ' days')::interval
         AND NOT EXISTS (
               SELECT 1 FROM crm.email_log el
                JOIN leads.submissions s2 ON s2.id = el.submission_id
                WHERE LOWER(s2.email) = r.email_lower
                  AND el.status IN ('opened', 'clicked')
                  AND el.triggered_at > r.reengagement_triggered_at
             )
         AND EXISTS (
               -- only act on contacts still flagged consenting in our DB.
               -- Idempotent guard: previously-suppressed contacts skip.
               SELECT 1 FROM leads.submissions s3
                WHERE LOWER(s3.email) = r.email_lower
                  AND s3.marketing_opt_in = true
             )
       ORDER BY r.reengagement_triggered_at
       LIMIT 500
    `;
  } catch (err) {
    console.error("suppression candidate query failed:", String(err));
    return json({
      error: `suppression candidate query: ${String(err)}`,
      reengagement: { candidates: reEngageCandidates.length, sent: reEngageSent, skipped: reEngageSkipped, failed: reEngageFailed },
    }, 500);
  }

  let suppressed = 0;
  let suppressFailed = 0;
  for (let i = 0; i < suppressCandidates.length; i++) {
    if (i > 0) await sleep(THROTTLE_MS);
    const c = suppressCandidates[i];

    try {
      // DB flip + audit row in a single transaction. If either fails,
      // both roll back — no orphan audit rows claiming a suppression
      // that didn't happen, and no silent retry loop on the next cron
      // run because the marketing_opt_in flip is what makes the contact
      // fall out of subsequent suppression queries (idempotent guard).
      // Failure of the Brevo push *after* commit is recovered by the
      // 04:00 UTC reconcile cron (migration 0081) which catches DB-Brevo
      // drift in either direction.
      await sql.begin(async (trx) => {
        await trx`SET LOCAL ROLE functions_writer`;

        // Find a representative submission for the consent_history audit
        // row inside the transaction — read the same DB state we're
        // about to mutate.
        const subRows = await trx<Array<{ id: number }>>`
          SELECT id FROM leads.submissions
           WHERE LOWER(email) = ${c.email}
           ORDER BY submitted_at DESC
           LIMIT 1
        `;
        const submissionId = subRows[0]?.id ?? null;

        await trx`
          UPDATE leads.submissions
             SET marketing_opt_in = false
           WHERE LOWER(email) = ${c.email}
             AND marketing_opt_in = true
        `;

        await trx`
          INSERT INTO crm.consent_history (
            submission_id,
            contact_email,
            field_changed,
            old_value,
            new_value,
            changed_by,
            source,
            metadata
          ) VALUES (
            ${submissionId},
            ${c.email},
            'SW_CONSENT_MARKETING',
            'true',
            'false',
            'system',
            'sunset_suppression',
            ${trx.json({ reengagement_triggered_at: c.reengagement_triggered_at })}
          )
        `;
      });

      // Brevo push: attribute + channel state. Same upsertBrevoContact
      // path as Phase 3a webhook handler. After-commit by design — if it
      // fails, the daily reconcile cron at 04:00 UTC fixes drift.
      const upsertResult = await upsertBrevoContact({
        email: c.email,
        attributes: { SW_CONSENT_MARKETING: false },
        marketingOptIn: false,
      });
      if (!upsertResult.ok) {
        console.error(`sunset suppress: Brevo push failed for ${c.email}:`, upsertResult.error);
      }

      suppressed++;
    } catch (err) {
      console.error(`sunset suppress: failed for ${c.email}:`, String(err));
      suppressFailed++;
    }
  }

  return json({
    reengagement: {
      candidates: reEngageCandidates.length,
      sent: reEngageSent,
      skipped: reEngageSkipped,
      failed: reEngageFailed,
      missing_template_env: reEngageTemplateId == null,
    },
    suppression: {
      candidates: suppressCandidates.length,
      suppressed,
      failed: suppressFailed,
    },
  }, 200);
});

function parseEnvInt(name: string): number | null {
  const raw = Deno.env.get(name);
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
