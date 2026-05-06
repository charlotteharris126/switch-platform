// Edge Function: brevo-consent-reconcile-daily
//
// Daily cron at 04:00 UTC. Walks every Brevo contact, compares the contact's
// Email campaigns channel state (emailBlacklisted) to the latest
// marketing_opt_in for that email in leads.submissions, auto-corrects
// drift in the safe direction, logs every correction, and writes a
// leads.dead_letter alert if drift exceeds 2% of compared contacts.
//
// Phase 3d of the email platform rearchitecture (spec at
// platform/docs/email-platform-rearchitecture-spec.md). Sister to:
//   - Phase 3a (brevo-event-webhook): unsub events flip our DB
//   - Phase 3b (_shared/brevo upsertBrevoContact): every routing pushes
//     channel state to Brevo
//   - Phase 3c (data-ops 013 backfill): one-off correction for existing
//     contacts whose channel state predated the Phase 3b enforcement
//
// 3d closes the loop by catching anything 3a/3b/3c missed — primarily
// unsubs that happened via Brevo's UI (manual contact edits, Brevo's own
// blocklist auto-flips on hard bounce / complaint that didn't fire a
// webhook back to us, automation-internal unsubs, etc.).
//
// ASYMMETRIC AUTO-CORRECT (mirrors data-ops 013's rule):
//   - Brevo blocked AND DB consenting → DB updated to NOT consenting
//     (Brevo is source of truth for unsub events; DB caught up).
//   - Brevo unblocked AND DB not consenting → drift logged, NOT
//     auto-corrected. Could be many causes (hard bounce since cleared,
//     manual Brevo edit, attribute drift). Re-opt-in is the form's job
//     and the form's POST goes through Phase 3b's upsert which will
//     correct Brevo. We never auto-flip DB toward consent without an
//     explicit consent action from the contact.
//   - Both consistent → no work.
//
// Auth: x-audit-key / AUDIT_SHARED_SECRET (same pattern as email-stalled-cron,
// email-u4-cron, admin-brevo-chase, admin-brevo-resync, iris-daily-flags).
// Deploy with --no-verify-jwt — auth is the audit-key header.

import postgres from "npm:postgres@3";

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

const BREVO_API_BASE = "https://api.brevo.com/v3";
const BATCH_SIZE = 100;
const INTER_PAGE_DELAY_MS = 250;
const DRIFT_ALERT_THRESHOLD = 0.02;

interface BrevoContact {
  id: number;
  email: string;
  emailBlacklisted: boolean;
}

interface BrevoListResp {
  contacts: BrevoContact[];
  count: number;
}

interface DriftRow {
  email: string;
  brevo_blacklisted: boolean;
  db_marketing_opt_in: boolean;
  direction: "brevo_blocked_db_consenting" | "brevo_unblocked_db_no_consent";
  corrected: boolean;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "method not allowed" }, 405);
  }

  // Auth — vault-backed shared secret, same pattern as the other crons.
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

  const brevoApiKey = Deno.env.get("BREVO_API_KEY");
  if (!brevoApiKey) {
    return json({ error: "BREVO_API_KEY not set" }, 500);
  }

  let processed = 0;
  let inDb = 0;
  let consistent = 0;
  let driftBrevoBlockedDbConsenting = 0;
  let driftBrevoUnblockedDbNoConsent = 0;
  let corrected = 0;
  let driftSamples: DriftRow[] = [];
  const errors: string[] = [];

  let offset = 0;
  while (true) {
    let batch: BrevoContact[];
    try {
      batch = await listBrevoContacts(brevoApiKey, offset);
    } catch (err) {
      const msg = `Brevo list contacts at offset=${offset}: ${String(err)}`;
      console.error(msg);
      errors.push(msg);
      break;
    }

    if (batch.length === 0) break;

    for (const contact of batch) {
      processed++;
      if (!contact.email) continue;

      const emailLower = contact.email.toLowerCase();
      let dbState: { marketing_opt_in: boolean | null } | undefined;
      try {
        const [row] = await sql<Array<{ marketing_opt_in: boolean | null }>>`
          SELECT marketing_opt_in
            FROM leads.submissions
           WHERE LOWER(email) = ${emailLower}
             AND archived_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1
        `;
        dbState = row;
      } catch (err) {
        const msg = `DB read failed for ${emailLower}: ${String(err)}`;
        console.error(msg);
        errors.push(msg);
        continue;
      }

      if (!dbState || dbState.marketing_opt_in === null) {
        continue;
      }
      inDb++;

      const brevoBlocked = contact.emailBlacklisted === true;
      const dbConsenting = dbState.marketing_opt_in === true;
      const expectedBlocked = !dbConsenting;

      if (brevoBlocked === expectedBlocked) {
        consistent++;
        continue;
      }

      if (brevoBlocked && dbConsenting) {
        driftBrevoBlockedDbConsenting++;
        try {
          // marketing_opt_in UPDATE goes through functions_writer because the
          // RLS policy `functions_writer_consent_updates` from migration 0079
          // is the only path that permits the column write. consent_history
          // INSERT runs as the default connection role (matches the
          // brevo-event-webhook pattern). functions_writer also has INSERT
          // on consent_history per the table ACL, so wrapping both writes
          // in a single role-switched transaction is safe and atomic.
          await sql.begin(async (trx) => {
            await trx`SET LOCAL ROLE functions_writer`;
            await trx`
              UPDATE leads.submissions
                 SET marketing_opt_in = false,
                     updated_at = now()
               WHERE LOWER(email) = ${emailLower}
                 AND marketing_opt_in = true
                 AND archived_at IS NULL
            `;
            await trx`
              INSERT INTO crm.consent_history
                (contact_email, field_changed, old_value, new_value,
                 changed_by, source, metadata)
              VALUES (${emailLower}, 'SW_CONSENT_MARKETING', 'true', 'false',
                      'system:cron:brevo-consent-reconcile-daily',
                      'reconcile_brevo_to_db',
                      ${sql.json({ brevo_emailBlacklisted: true })})
            `;
          });
          corrected++;
          if (driftSamples.length < 25) {
            driftSamples.push({
              email: emailLower,
              brevo_blacklisted: true,
              db_marketing_opt_in: true,
              direction: "brevo_blocked_db_consenting",
              corrected: true,
            });
          }
        } catch (err) {
          const msg = `correction failed for ${emailLower}: ${String(err)}`;
          console.error(msg);
          errors.push(msg);
        }
      } else if (!brevoBlocked && !dbConsenting) {
        driftBrevoUnblockedDbNoConsent++;
        if (driftSamples.length < 25) {
          driftSamples.push({
            email: emailLower,
            brevo_blacklisted: false,
            db_marketing_opt_in: false,
            direction: "brevo_unblocked_db_no_consent",
            corrected: false,
          });
        }
      }
    }

    if (batch.length < BATCH_SIZE) break;
    offset += batch.length;
    await sleep(INTER_PAGE_DELAY_MS);
  }

  const totalDrift = driftBrevoBlockedDbConsenting + driftBrevoUnblockedDbNoConsent;
  const driftRate = inDb > 0 ? totalDrift / inDb : 0;

  if (driftRate > DRIFT_ALERT_THRESHOLD && inDb > 0) {
    try {
      // dead_letter INSERT goes through functions_writer because that role
      // has INSERT/UPDATE/SELECT on the table per ACL (and matches the
      // existing netlify-partial-capture / netlify-leads-reconcile pattern).
      // Charlotte's Mira Monday audit reads dead_letter for unresolved rows,
      // so a drift alert here surfaces in the weekly review automatically.
      await sql.begin(async (trx) => {
        await trx`SET LOCAL ROLE functions_writer`;
        await trx`
          INSERT INTO leads.dead_letter (source, error_context, raw_payload)
          VALUES (
            'brevo_consent_drift_alert',
            ${`Drift rate ${(driftRate * 100).toFixed(2)}% exceeds ${(DRIFT_ALERT_THRESHOLD * 100).toFixed(0)}% threshold (${totalDrift} drifted of ${inDb} compared)`},
            ${sql.json({
              processed,
              compared: inDb,
              consistent,
              drift_brevo_blocked_db_consenting: driftBrevoBlockedDbConsenting,
              drift_brevo_unblocked_db_no_consent: driftBrevoUnblockedDbNoConsent,
              corrected,
              drift_rate: driftRate,
              samples: driftSamples,
              errors: errors.slice(0, 10),
            })}
          )
        `;
      });
    } catch (err) {
      console.error("dead_letter alert insert failed:", String(err));
      errors.push(`dead_letter alert insert failed: ${String(err)}`);
    }
  }

  return json({
    processed,
    compared: inDb,
    consistent,
    drift_brevo_blocked_db_consenting: driftBrevoBlockedDbConsenting,
    drift_brevo_unblocked_db_no_consent: driftBrevoUnblockedDbNoConsent,
    corrected,
    drift_rate: driftRate,
    drift_alert_fired: driftRate > DRIFT_ALERT_THRESHOLD && inDb > 0,
    samples: driftSamples,
    errors,
  }, 200);
});

async function listBrevoContacts(apiKey: string, offset: number): Promise<BrevoContact[]> {
  const url = `${BREVO_API_BASE}/contacts?limit=${BATCH_SIZE}&offset=${offset}&sort=asc`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "api-key": apiKey, accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as BrevoListResp;
  return Array.isArray(data.contacts) ? data.contacts : [];
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
