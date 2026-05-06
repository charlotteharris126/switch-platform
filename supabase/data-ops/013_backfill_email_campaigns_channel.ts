// Phase 3c — Backfill the Email campaigns channel state on existing Brevo
// contacts so it matches the SW_CONSENT_MARKETING attribute. Counterpart to
// Phase 3b (which keeps the two in sync going forward, on every contact
// upsert from the Edge Functions).
//
// Spec: platform/docs/email-platform-rearchitecture-spec.md, Phase 3.
//
// What this does
// --------------
// Walks every Brevo contact in pages of 100, with a 250ms inter-call delay.
// For each contact:
//   - reads SW_CONSENT_MARKETING from the contact's attributes
//   - if the attribute is missing or null → SKIP (don't push channel state we
//     can't justify; the contact may pre-date the attribute being set)
//   - if SW_CONSENT_MARKETING = false AND emailBlacklisted = false →
//     update emailBlacklisted = true (block from Email campaigns)
//   - if SW_CONSENT_MARKETING = true AND emailBlacklisted = true → SKIP
//     deliberately. Don't UNBLOCK from a backfill: a contact whose
//     emailBlacklisted is currently true may be there for non-consent
//     reasons (hard bounce, complaint) and we don't want to override that
//     with an attribute-level signal alone. Re-opt-in is the runtime form
//     submission's job (which goes through Phase 3b's upsert path with full
//     context), not this backfill.
//   - otherwise → SKIP (channel state already matches attribute, no work)
//
// Resilience
// ----------
// - Halts if any single batch hits >0.5% error rate (so 1+ error per 100
//   contacts triggers halt). Owner inspects, fixes the cause, resumes.
// - Resumable via .backfill-checkpoint.json (offset + cumulative counters),
//   gitignored. Run with `--reset` to clear the checkpoint and start over.
// - Dry-run by default. Prints what WOULD change. Run with `--apply` to
//   actually mutate Brevo + write to crm.consent_history.
//
// Usage
// -----
//   # 1. dry run, owner reviews output
//   deno run --allow-net --allow-env --allow-read --allow-write \
//     data-ops/013_backfill_email_campaigns_channel.ts
//
//   # 2. live run after dry-run output looks correct
//   deno run --allow-net --allow-env --allow-read --allow-write \
//     data-ops/013_backfill_email_campaigns_channel.ts --apply
//
//   # 3. start over (clears checkpoint)
//   deno run --allow-net --allow-env --allow-read --allow-write \
//     data-ops/013_backfill_email_campaigns_channel.ts --reset
//
// Required env (sourced from .env or shell):
//   BREVO_API_KEY                 — contacts API key
//   SUPABASE_DB_URL               — Postgres connection string for consent_history INSERT
//                                   (only required when --apply is set)

const APPLY = Deno.args.includes("--apply");
const RESET = Deno.args.includes("--reset");

const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY");
if (!BREVO_API_KEY) {
  console.error("BREVO_API_KEY not set; aborting");
  Deno.exit(1);
}

// decodeURI handles paths with encoded chars (e.g. "Mobile%20Documents" in
// iCloud-synced workspaces). Without it Deno's writeTextFileSync receives the
// URL-encoded literal and fails NotFound on the real filesystem.
const CHECKPOINT_PATH = decodeURI(new URL("./.backfill-checkpoint.json", import.meta.url).pathname);
const BATCH_SIZE = 100;
const INTER_CALL_DELAY_MS = 250;
const HALT_ERROR_RATE = 0.005;

const BREVO_BASE = "https://api.brevo.com/v3";

interface BrevoContact {
  id: number;
  email: string;
  emailBlacklisted: boolean;
  smsBlacklisted?: boolean;
  attributes?: Record<string, unknown>;
}

interface BrevoListResp {
  contacts: BrevoContact[];
  count: number;
}

interface Checkpoint {
  offset: number;
  totalProcessed: number;
  totalMutated: number;
  totalSkipped: number;
  totalErrors: number;
  startedAt: string;
  lastUpdatedAt: string;
  apply: boolean;
}

function freshCheckpoint(): Checkpoint {
  const now = new Date().toISOString();
  return {
    offset: 0,
    totalProcessed: 0,
    totalMutated: 0,
    totalSkipped: 0,
    totalErrors: 0,
    startedAt: now,
    lastUpdatedAt: now,
    apply: APPLY,
  };
}

function loadCheckpoint(): Checkpoint {
  if (RESET) {
    try { Deno.removeSync(CHECKPOINT_PATH); } catch { /* ignore */ }
    return freshCheckpoint();
  }
  try {
    const raw = Deno.readTextFileSync(CHECKPOINT_PATH);
    const c = JSON.parse(raw) as Checkpoint;
    if (c.apply !== APPLY) {
      console.error(
        `Checkpoint apply=${c.apply} doesn't match current --apply=${APPLY}. ` +
          `Run with --reset to start over, or re-run with the matching mode.`,
      );
      Deno.exit(1);
    }
    return c;
  } catch {
    return freshCheckpoint();
  }
}

function saveCheckpoint(c: Checkpoint): void {
  c.lastUpdatedAt = new Date().toISOString();
  Deno.writeTextFileSync(CHECKPOINT_PATH, JSON.stringify(c, null, 2));
}

async function listContacts(offset: number): Promise<BrevoContact[]> {
  const url = `${BREVO_BASE}/contacts?limit=${BATCH_SIZE}&offset=${offset}&sort=asc`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "api-key": BREVO_API_KEY!, accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Brevo list contacts ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as BrevoListResp;
  return Array.isArray(data.contacts) ? data.contacts : [];
}

async function blacklistContact(email: string): Promise<void> {
  const url = `${BREVO_BASE}/contacts/${encodeURIComponent(email)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "api-key": BREVO_API_KEY!,
      "content-type": "application/json",
    },
    body: JSON.stringify({ emailBlacklisted: true }),
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Brevo update ${email} ${res.status}: ${await res.text()}`);
  }
}

function readSwConsent(c: BrevoContact): boolean | null {
  const a = c.attributes;
  if (!a) return null;
  const v = a["SW_CONSENT_MARKETING"];
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  return null;
}

interface PgClient {
  queryArray: (sql: string, args: unknown[]) => Promise<unknown>;
  end: () => Promise<void>;
}

async function openPg(): Promise<PgClient | null> {
  if (!APPLY) return null;
  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!dbUrl) {
    console.error("SUPABASE_DB_URL not set; required for --apply (consent_history writes)");
    Deno.exit(1);
  }
  const { Client } = await import("https://deno.land/x/postgres@v0.19.3/mod.ts");
  const client = new Client(dbUrl);
  await client.connect();
  return client as unknown as PgClient;
}

async function logConsentHistory(
  pg: PgClient,
  email: string,
  oldBlacklisted: boolean,
  newBlacklisted: boolean,
): Promise<void> {
  await pg.queryArray(
    `INSERT INTO crm.consent_history
       (contact_email, field_changed, old_value, new_value, changed_by, source, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      email,
      "EMAIL_CAMPAIGNS_CHANNEL",
      oldBlacklisted ? "blocked" : "subscribed",
      newBlacklisted ? "blocked" : "subscribed",
      "system",
      "backfill",
      JSON.stringify({ script: "013_backfill_email_campaigns_channel" }),
    ],
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const mode = APPLY ? "APPLY (live mutations)" : "DRY-RUN (no mutations)";
  console.log(`=== Phase 3c backfill: ${mode} ===`);

  const checkpoint = loadCheckpoint();
  console.log(`resuming from offset=${checkpoint.offset}, totals so far:`, {
    processed: checkpoint.totalProcessed,
    mutated: checkpoint.totalMutated,
    skipped: checkpoint.totalSkipped,
    errors: checkpoint.totalErrors,
  });

  const pg = await openPg();

  try {
    while (true) {
      const batch = await listContacts(checkpoint.offset);
      if (batch.length === 0) {
        console.log("no more contacts; backfill complete");
        break;
      }

      let batchMutated = 0;
      let batchSkipped = 0;
      let batchErrors = 0;

      for (const contact of batch) {
        if (!contact.email) {
          batchSkipped++;
          continue;
        }

        const swConsent = readSwConsent(contact);

        if (swConsent === null) {
          batchSkipped++;
          continue;
        }

        // Coerce defensively. Brevo should always return emailBlacklisted as
        // a boolean, but if it ever omits the field treat the contact as
        // not-blacklisted (the Brevo default for fresh contacts) so an
        // undefined doesn't slip into the mutation path uncoerced.
        const currentBlacklisted = contact.emailBlacklisted === true;
        const desiredBlacklisted = !swConsent; // consent true → blacklisted false

        if (currentBlacklisted === desiredBlacklisted) {
          batchSkipped++;
          continue;
        }

        // ASYMMETRIC RULE — only block; never unblock from backfill.
        // A contact whose emailBlacklisted is currently true may be there
        // for non-consent reasons (hard bounce, complaint) and we don't want
        // to override that with an attribute-level signal alone. Re-opt-in
        // is the runtime form submission's job (Phase 3b's upsert path with
        // full context), not this backfill.
        if (currentBlacklisted === true && desiredBlacklisted === false) {
          batchSkipped++;
          if (!APPLY) {
            console.log(`[skip-unblock] ${contact.email} blocked at Brevo, attribute says consent=true; leaving as-is`);
          }
          continue;
        }

        // Only path that actually mutates: contact currently allowed, attribute
        // says consent=false → block.
        if (!APPLY) {
          console.log(`[would-block] ${contact.email} (SW_CONSENT_MARKETING=false, emailBlacklisted=false → true)`);
          batchMutated++;
          continue;
        }

        try {
          await blacklistContact(contact.email);
          if (pg) {
            await logConsentHistory(pg, contact.email, currentBlacklisted, true);
          }
          batchMutated++;
          console.log(`[blocked] ${contact.email}`);
        } catch (err) {
          batchErrors++;
          console.error(`[error] ${contact.email}:`, String(err));
        }
        await sleep(INTER_CALL_DELAY_MS);
      }

      checkpoint.offset += batch.length;
      checkpoint.totalProcessed += batch.length;
      checkpoint.totalMutated += batchMutated;
      checkpoint.totalSkipped += batchSkipped;
      checkpoint.totalErrors += batchErrors;
      saveCheckpoint(checkpoint);

      const batchErrorRate = batchErrors / batch.length;
      console.log(
        `batch done: processed=${batch.length} mutated=${batchMutated} ` +
          `skipped=${batchSkipped} errors=${batchErrors} errorRate=${(batchErrorRate * 100).toFixed(2)}%`,
      );

      if (batchErrorRate > HALT_ERROR_RATE) {
        console.error(
          `\nHALT — batch error rate ${(batchErrorRate * 100).toFixed(2)}% exceeds threshold ${HALT_ERROR_RATE * 100}%.`,
        );
        console.error("Investigate the failed contacts above, then re-run to resume from checkpoint.");
        Deno.exit(2);
      }

      if (batch.length < BATCH_SIZE) {
        console.log("partial final batch returned; backfill complete");
        break;
      }
    }
  } finally {
    if (pg) await pg.end();
  }

  console.log("\n=== summary ===");
  console.log(`mode: ${mode}`);
  console.log(`processed: ${checkpoint.totalProcessed}`);
  console.log(`mutated:   ${checkpoint.totalMutated}`);
  console.log(`skipped:   ${checkpoint.totalSkipped}`);
  console.log(`errors:    ${checkpoint.totalErrors}`);
  console.log(`checkpoint: ${CHECKPOINT_PATH}`);
}

await main();
