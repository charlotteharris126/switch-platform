// Backfill SW_REFERRAL_URL + SW_FASTRACK_URL on existing Brevo contacts.
//
// Driver
// ------
// Wren ask 2026-05-10. The buildReferralUrl() helper in
// `_shared/route-lead.ts` was rewired on 2026-05-04 (commit aadf5ad
// → 30e62e0) from per-funding-category paths
// (`/find-funded-courses/?ref=` or `/find-your-course/?ref=`) to a
// single `/refer/?ref=` for everyone, but no Brevo backfill ran when
// the wiring changed. Existing contacts hold stale referral URLs;
// any marketing broadcast referencing SW_REFERRAL_URL renders the
// stale value verbatim.
//
// Same pass also backfills SW_FASTRACK_URL (introduced 2026-05-09):
// pre-2026-05-09 contacts won't have it set, and the U1 funded
// transactional template + future marketing both depend on it.
//
// Memory locks the principle in
// `feedback_brevo_attribute_wiring_requires_backfill.md` — any change
// to a route-lead.ts function producing a Brevo attribute requires a
// same-session backfill of existing contacts.
//
// Scope
// -----
// Every Brevo contact whose latest leads.submissions row has
// marketing_opt_in=true. (The Switchable Marketing list filter is
// applied implicitly via marketing_opt_in — that's the source of
// truth. We don't hit Brevo's list endpoint.)
//
// What this does
// --------------
// 1. Reads every leads.submissions row, latest-per-lowercased-email,
//    where marketing_opt_in=true. Builds an in-memory map
//    email → { funding_category, referral_code, client_nonce }.
//    Single query, indexed scan, fast.
// 2. Walks Brevo contacts in pages of 100, 250ms inter-call delay.
// 3. For each Brevo contact:
//    - Skip if email not in the DB map (not a marketing-opt-in
//      learner — could be admin/internal/etc.).
//    - Compute desired SW_REFERRAL_URL and SW_FASTRACK_URL using the
//      same helpers route-lead.ts uses, so output matches runtime
//      writes byte-for-byte.
//    - Compare with the contact's current Brevo attribute values
//      (treating missing/null/empty as equivalent for skip-on-match).
//    - If both match → skip.
//    - Otherwise → upsert via the Brevo contacts endpoint with both
//      attributes in one call.
// 4. Spot-checks 3 random emails before/after for the operator to
//    eyeball. Picked deterministically from the first batch via a
//    seeded shuffle so re-runs hit the same emails.
//
// Resilience
// ----------
// - Halts if any single batch hits >0.5% error rate. Owner inspects,
//   fixes the cause, re-runs to resume from checkpoint.
// - Resumable via .024-checkpoint.json (offset + cumulative
//   counters). Run with `--reset` to clear the checkpoint.
// - Dry-run by default. Prints WOULD changes. Run with `--apply` to
//   actually mutate Brevo.
//
// Usage
// -----
//   # dry run
//   deno run --allow-net --allow-env --allow-read --allow-write \
//     supabase/data-ops/024_backfill_referral_and_fastrack_urls_2026_05_10.ts
//
//   # live run after dry-run output looks right
//   deno run --allow-net --allow-env --allow-read --allow-write \
//     supabase/data-ops/024_backfill_referral_and_fastrack_urls_2026_05_10.ts --apply
//
//   # start over
//   deno run --allow-net --allow-env --allow-read --allow-write \
//     supabase/data-ops/024_backfill_referral_and_fastrack_urls_2026_05_10.ts --reset
//
// Required env:
//   BREVO_API_KEY     contacts API key
//   SUPABASE_DB_URL   Postgres connection string (read-only suffices,
//                     but service-role/owner is fine; matches the
//                     013 precedent)

const APPLY = Deno.args.includes("--apply");
const RESET = Deno.args.includes("--reset");

const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY");
if (!BREVO_API_KEY) {
  console.error("BREVO_API_KEY not set; aborting");
  Deno.exit(1);
}
const SUPABASE_DB_URL = Deno.env.get("SUPABASE_DB_URL");
if (!SUPABASE_DB_URL) {
  console.error("SUPABASE_DB_URL not set; aborting");
  Deno.exit(1);
}

const CHECKPOINT_PATH = decodeURI(
  new URL("./.024-checkpoint.json", import.meta.url).pathname,
);
const BATCH_SIZE = 100;
const INTER_CALL_DELAY_MS = 250;
const HALT_ERROR_RATE = 0.005;
const SPOT_CHECK_COUNT = 3;

const BREVO_BASE = "https://api.brevo.com/v3";

// --- URL helpers, mirror _shared/route-lead.ts exactly ---------------------

function buildReferralUrl(referralCode: string | null): string {
  const base = "https://switchable.org.uk/refer/";
  return referralCode
    ? `${base}?ref=${encodeURIComponent(referralCode)}`
    : base;
}

function buildFastrackUrl(clientNonce: string | null): string {
  if (!clientNonce) return "";
  return `https://switchable.org.uk/funded/thank-you/?ref=${encodeURIComponent(clientNonce)}`;
}

// ---------------------------------------------------------------------------

interface SubmissionDesired {
  funding_category: string | null;
  referral_code: string | null;
  client_nonce: string | null;
  desired_referral_url: string;
  desired_fastrack_url: string;
}

interface BrevoContact {
  id: number;
  email: string;
  emailBlacklisted: boolean;
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
  totalSkippedNoSubmission: number;
  totalSkippedAlreadyMatching: number;
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
    totalSkippedNoSubmission: 0,
    totalSkippedAlreadyMatching: 0,
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

interface PgClient {
  queryObject: <T>(sql: string) => Promise<{ rows: T[] }>;
  end: () => Promise<void>;
}

async function openPg(): Promise<PgClient> {
  const { Client } = await import("https://deno.land/x/postgres@v0.19.3/mod.ts");
  const client = new Client(SUPABASE_DB_URL);
  await client.connect();
  return client as unknown as PgClient;
}

async function loadAudienceMap(pg: PgClient): Promise<Map<string, SubmissionDesired>> {
  // DISTINCT ON (lower(email)) gives the latest row per email by submitted_at.
  // marketing_opt_in filter is applied to the latest row only — matches Wren's
  // scope ("marketing_opt_in=true on their latest submission").
  const { rows } = await pg.queryObject<{
    email: string;
    funding_category: string | null;
    referral_code: string | null;
    client_nonce: string | null;
  }>(`
    SELECT DISTINCT ON (lower(email))
      lower(email) AS email,
      funding_category,
      referral_code,
      client_nonce
    FROM leads.submissions
    WHERE email IS NOT NULL
      AND marketing_opt_in = true
    ORDER BY lower(email), submitted_at DESC
  `);

  const map = new Map<string, SubmissionDesired>();
  for (const r of rows) {
    map.set(r.email, {
      funding_category: r.funding_category,
      referral_code: r.referral_code,
      client_nonce: r.client_nonce,
      desired_referral_url: buildReferralUrl(r.referral_code),
      desired_fastrack_url: buildFastrackUrl(r.client_nonce),
    });
  }
  return map;
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

async function getContact(email: string): Promise<BrevoContact | null> {
  const url = `${BREVO_BASE}/contacts/${encodeURIComponent(email)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "api-key": BREVO_API_KEY!, accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Brevo get ${email} ${res.status}: ${await res.text()}`);
  return (await res.json()) as BrevoContact;
}

async function upsertContact(email: string, attrs: Record<string, string>): Promise<void> {
  const res = await fetch(`${BREVO_BASE}/contacts`, {
    method: "POST",
    headers: {
      "api-key": BREVO_API_KEY!,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ email, updateEnabled: true, attributes: attrs }),
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Brevo upsert ${email} ${res.status}: ${await res.text()}`);
  }
}

function readAttrString(c: BrevoContact, name: string): string {
  const v = c.attributes?.[name];
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function attrsMatch(current: BrevoContact, desired: SubmissionDesired): boolean {
  // Treat missing/null/empty as equivalent so we don't churn writes when
  // both sides effectively hold the empty value.
  return (
    readAttrString(current, "SW_REFERRAL_URL") === desired.desired_referral_url &&
    readAttrString(current, "SW_FASTRACK_URL") === desired.desired_fastrack_url
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runSpotCheck(
  label: string,
  emails: string[],
  desiredMap: Map<string, SubmissionDesired>,
): Promise<void> {
  console.log(`\n=== Spot check: ${label} ===`);
  for (const email of emails) {
    const c = await getContact(email);
    if (!c) {
      console.log(`  ${email}: NOT FOUND in Brevo`);
      continue;
    }
    const desired = desiredMap.get(email.toLowerCase());
    console.log(`  ${email}`);
    console.log(`    SW_REFERRAL_URL  current=${JSON.stringify(readAttrString(c, "SW_REFERRAL_URL"))}`);
    console.log(`                     desired=${JSON.stringify(desired?.desired_referral_url ?? "<not in audience>")}`);
    console.log(`    SW_FASTRACK_URL  current=${JSON.stringify(readAttrString(c, "SW_FASTRACK_URL"))}`);
    console.log(`                     desired=${JSON.stringify(desired?.desired_fastrack_url ?? "<not in audience>")}`);
  }
}

async function pickSpotCheckEmails(
  desiredMap: Map<string, SubmissionDesired>,
): Promise<string[]> {
  // Walk the first batch of Brevo contacts, intersect with the audience,
  // return up to SPOT_CHECK_COUNT. Deterministic on Brevo's sort=asc order.
  const first = await listContacts(0);
  const picks: string[] = [];
  for (const c of first) {
    if (!c.email) continue;
    if (desiredMap.has(c.email.toLowerCase())) picks.push(c.email);
    if (picks.length >= SPOT_CHECK_COUNT) break;
  }
  return picks;
}

async function main(): Promise<void> {
  const mode = APPLY ? "APPLY (live mutations)" : "DRY-RUN (no mutations)";
  console.log(`=== 024 backfill SW_REFERRAL_URL + SW_FASTRACK_URL: ${mode} ===`);

  const pg = await openPg();
  let desiredMap: Map<string, SubmissionDesired>;
  try {
    desiredMap = await loadAudienceMap(pg);
    console.log(`audience size (latest-submission marketing_opt_in=true): ${desiredMap.size}`);
  } finally {
    await pg.end();
  }

  // Pick spot-check emails BEFORE the run, then re-check AFTER.
  const spotEmails = await pickSpotCheckEmails(desiredMap);
  if (spotEmails.length > 0) {
    await runSpotCheck("BEFORE", spotEmails, desiredMap);
  } else {
    console.log("\n(no spot-check emails available — first Brevo batch had nobody in audience)");
  }

  const checkpoint = loadCheckpoint();
  console.log(
    `\nresuming from offset=${checkpoint.offset}, totals so far: ` +
      `processed=${checkpoint.totalProcessed} mutated=${checkpoint.totalMutated} ` +
      `skipped(no-sub)=${checkpoint.totalSkippedNoSubmission} ` +
      `skipped(match)=${checkpoint.totalSkippedAlreadyMatching} ` +
      `errors=${checkpoint.totalErrors}`,
  );

  while (true) {
    const batch = await listContacts(checkpoint.offset);
    if (batch.length === 0) {
      console.log("\nno more contacts; backfill complete");
      break;
    }

    let batchMutated = 0;
    let batchSkippedNoSub = 0;
    let batchSkippedMatching = 0;
    let batchErrors = 0;

    for (const contact of batch) {
      if (!contact.email) {
        batchSkippedNoSub++;
        continue;
      }
      const desired = desiredMap.get(contact.email.toLowerCase());
      if (!desired) {
        batchSkippedNoSub++;
        continue;
      }

      if (attrsMatch(contact, desired)) {
        batchSkippedMatching++;
        continue;
      }

      if (!APPLY) {
        console.log(
          `[would-write] ${contact.email} ` +
            `referral=${JSON.stringify(readAttrString(contact, "SW_REFERRAL_URL"))}→` +
            `${JSON.stringify(desired.desired_referral_url)} ` +
            `fastrack=${JSON.stringify(readAttrString(contact, "SW_FASTRACK_URL"))}→` +
            `${JSON.stringify(desired.desired_fastrack_url)}`,
        );
        batchMutated++;
        continue;
      }

      try {
        await upsertContact(contact.email, {
          SW_REFERRAL_URL: desired.desired_referral_url,
          SW_FASTRACK_URL: desired.desired_fastrack_url,
        });
        batchMutated++;
        console.log(`[written] ${contact.email}`);
      } catch (err) {
        batchErrors++;
        console.error(`[error] ${contact.email}:`, String(err));
      }
      await sleep(INTER_CALL_DELAY_MS);
    }

    checkpoint.offset += batch.length;
    checkpoint.totalProcessed += batch.length;
    checkpoint.totalMutated += batchMutated;
    checkpoint.totalSkippedNoSubmission += batchSkippedNoSub;
    checkpoint.totalSkippedAlreadyMatching += batchSkippedMatching;
    checkpoint.totalErrors += batchErrors;
    saveCheckpoint(checkpoint);

    const batchErrorRate = batch.length > 0 ? batchErrors / batch.length : 0;
    console.log(
      `batch done: processed=${batch.length} mutated=${batchMutated} ` +
        `skipped(no-sub)=${batchSkippedNoSub} skipped(match)=${batchSkippedMatching} ` +
        `errors=${batchErrors} errorRate=${(batchErrorRate * 100).toFixed(2)}%`,
    );

    if (batchErrorRate > HALT_ERROR_RATE) {
      console.error(
        `\nHALT — batch error rate ${(batchErrorRate * 100).toFixed(2)}% exceeds threshold ${HALT_ERROR_RATE * 100}%.`,
      );
      Deno.exit(2);
    }

    if (batch.length < BATCH_SIZE) {
      console.log("partial final batch returned; backfill complete");
      break;
    }
  }

  if (spotEmails.length > 0) {
    await runSpotCheck("AFTER", spotEmails, desiredMap);
  }

  console.log("\n=== summary ===");
  console.log(`mode: ${mode}`);
  console.log(`audience size: ${desiredMap.size}`);
  console.log(`processed: ${checkpoint.totalProcessed}`);
  console.log(`mutated:   ${checkpoint.totalMutated}`);
  console.log(`skipped (not in audience): ${checkpoint.totalSkippedNoSubmission}`);
  console.log(`skipped (already matching): ${checkpoint.totalSkippedAlreadyMatching}`);
  console.log(`errors:    ${checkpoint.totalErrors}`);
  console.log(`checkpoint: ${CHECKPOINT_PATH}`);
}

await main();
