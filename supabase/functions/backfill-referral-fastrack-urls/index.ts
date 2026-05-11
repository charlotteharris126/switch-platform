// Edge Function: backfill-referral-fastrack-urls
//
// One-shot data-ops backfill, equivalent to data-ops/024 but executable
// from the admin UI without local env setup.
//
// Why an Edge Function: BREVO_API_KEY + SUPABASE_DB_URL already live on
// Supabase's side; running locally requires the operator to retrieve both
// (Brevo's UI doesn't reveal existing keys, and direct DB hosts are
// IPv6-only on new projects). The Function sidesteps both.
//
// Auth: x-audit-key matched against AUDIT_SHARED_SECRET in vault. Same
// pattern as admin-notify-callback / admin-brevo-resync.
//
// Body: { "apply": boolean }
//   apply=false → dry-run, no writes, returns the same summary shape
//   apply=true  → live writes, returns counts + spot-check before/after
//
// Response shape (200):
//   {
//     ok: true,
//     mode: "dry_run" | "apply",
//     audience_size: 47,
//     processed: 225,
//     mutated: 12,
//     skipped_no_submission: 178,
//     skipped_already_matching: 35,
//     errors: 0,
//     error_messages: [...],
//     spot_checks: [
//       { email, before_referral, before_fastrack, desired_referral,
//         desired_fastrack, after_referral, after_fastrack }
//     ]
//   }
//
// Driver: Wren ask 2026-05-10. Backfills SW_REFERRAL_URL (rewired
// 2026-05-04 commits aadf5ad → 30e62e0 with no contact backfill) plus
// SW_FASTRACK_URL (introduced 2026-05-09, pre-cutover contacts have no
// value set). Process lock in
// feedback_brevo_attribute_wiring_requires_backfill.md +
// platform/CLAUDE.md Core discipline.

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL not set");
}
const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY");
if (!BREVO_API_KEY) {
  throw new Error("BREVO_API_KEY not set in Edge Function env");
}

const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

const BREVO_BASE = "https://api.brevo.com/v3";
const BATCH_SIZE = 100;
const INTER_WRITE_DELAY_MS = 250;
const HALT_ERROR_RATE = 0.005;
const SPOT_CHECK_COUNT = 3;

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

interface SpotCheck {
  email: string;
  before_referral: string;
  before_fastrack: string;
  desired_referral: string;
  desired_fastrack: string;
  after_referral?: string;
  after_fastrack?: string;
}

async function getAuditSharedSecret(): Promise<string> {
  const rows = await sql<Array<{ secret: string }>>`
    SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
  `;
  const secret = rows[0]?.secret;
  if (!secret) throw new Error("AUDIT_SHARED_SECRET not in vault");
  return secret;
}

async function loadAudienceMap(): Promise<Map<string, SubmissionDesired>> {
  const rows = await sql<Array<{
    email: string;
    referral_code: string | null;
    client_nonce: string | null;
  }>>`
    SELECT DISTINCT ON (lower(email))
      lower(email) AS email,
      referral_code,
      client_nonce
    FROM leads.submissions
    WHERE email IS NOT NULL
      AND marketing_opt_in = true
    ORDER BY lower(email), submitted_at DESC
  `;

  const map = new Map<string, SubmissionDesired>();
  for (const r of rows) {
    map.set(r.email, {
      referral_code: r.referral_code,
      client_nonce: r.client_nonce,
      desired_referral_url: buildReferralUrl(r.referral_code),
      desired_fastrack_url: buildFastrackUrl(r.client_nonce),
    });
  }
  return map;
}

async function listBrevoContacts(offset: number): Promise<BrevoContact[]> {
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

async function getBrevoContact(email: string): Promise<BrevoContact | null> {
  const url = `${BREVO_BASE}/contacts/${encodeURIComponent(email)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "api-key": BREVO_API_KEY!, accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Brevo get ${email} ${res.status}: ${await res.text()}`);
  return (await res.json()) as BrevoContact;
}

async function upsertBrevoContact(email: string, attrs: Record<string, string>): Promise<void> {
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
  return (
    readAttrString(current, "SW_REFERRAL_URL") === desired.desired_referral_url &&
    readAttrString(current, "SW_FASTRACK_URL") === desired.desired_fastrack_url
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface RunSummary {
  mode: "dry_run" | "apply";
  audience_size: number;
  processed: number;
  mutated: number;
  skipped_no_submission: number;
  skipped_already_matching: number;
  errors: number;
  error_messages: string[];
  spot_checks: SpotCheck[];
}

async function run(apply: boolean): Promise<RunSummary> {
  const audience = await loadAudienceMap();

  // Pass 1: walk Brevo contacts and partition into "would-change" vs
  // "already-matching", remembering the first SPOT_CHECK_COUNT of each
  // for the spot-check panel. We seed spot-check candidates DURING the
  // mutation pass so we don't double-walk Brevo's contact list. The
  // candidates we pick from the first traversal are then re-fetched
  // after-the-fact for the after-state (apply mode).
  const mismatchedSpot: SpotCheck[] = [];
  const matchedSpot: SpotCheck[] = [];

  let processed = 0;
  let mutated = 0;
  let skippedNoSub = 0;
  let skippedMatching = 0;
  let errors = 0;
  const errorMessages: string[] = [];

  let offset = 0;
  let batch = await listBrevoContacts(offset);

  while (true) {
    if (batch.length === 0) break;

    let batchErrors = 0;

    for (const contact of batch) {
      processed++;
      if (!contact.email) {
        skippedNoSub++;
        continue;
      }
      const desired = audience.get(contact.email.toLowerCase());
      if (!desired) {
        skippedNoSub++;
        continue;
      }

      const matches = attrsMatch(contact, desired);

      // Capture spot-check samples during the walk: prioritise mismatches
      // (showing real diffs is more useful) but keep a couple of matches
      // as a sanity-check that already-current contacts are recognised.
      if (matches) {
        if (matchedSpot.length < SPOT_CHECK_COUNT) {
          matchedSpot.push({
            email: contact.email,
            before_referral: readAttrString(contact, "SW_REFERRAL_URL"),
            before_fastrack: readAttrString(contact, "SW_FASTRACK_URL"),
            desired_referral: desired.desired_referral_url,
            desired_fastrack: desired.desired_fastrack_url,
          });
        }
        skippedMatching++;
        continue;
      }

      if (mismatchedSpot.length < SPOT_CHECK_COUNT) {
        mismatchedSpot.push({
          email: contact.email,
          before_referral: readAttrString(contact, "SW_REFERRAL_URL"),
          before_fastrack: readAttrString(contact, "SW_FASTRACK_URL"),
          desired_referral: desired.desired_referral_url,
          desired_fastrack: desired.desired_fastrack_url,
        });
      }

      if (!apply) {
        mutated++; // would-mutate count
        continue;
      }

      try {
        await upsertBrevoContact(contact.email, {
          SW_REFERRAL_URL: desired.desired_referral_url,
          SW_FASTRACK_URL: desired.desired_fastrack_url,
        });
        mutated++;
      } catch (err) {
        errors++;
        batchErrors++;
        const msg = `${contact.email}: ${err instanceof Error ? err.message : String(err)}`;
        errorMessages.push(msg);
        console.error("[error]", msg);
      }
      await sleep(INTER_WRITE_DELAY_MS);
    }

    const batchErrorRate = batch.length > 0 ? batchErrors / batch.length : 0;
    if (batchErrorRate > HALT_ERROR_RATE) {
      console.error(
        `HALT — batch error rate ${(batchErrorRate * 100).toFixed(2)}% exceeds threshold`,
      );
      break;
    }

    if (batch.length < BATCH_SIZE) break;
    offset += batch.length;
    batch = await listBrevoContacts(offset);
  }

  // Combine mismatched + matched into a single ordered list. Mismatched
  // first so the operator sees real diffs at the top.
  const spotChecks: SpotCheck[] = [...mismatchedSpot, ...matchedSpot];

  // Re-fetch spot-check emails to capture after-state.
  if (apply) {
    for (const sc of spotChecks) {
      const c = await getBrevoContact(sc.email);
      if (c) {
        sc.after_referral = readAttrString(c, "SW_REFERRAL_URL");
        sc.after_fastrack = readAttrString(c, "SW_FASTRACK_URL");
      }
    }
  } else {
    // Dry-run "after" is the desired value (since no writes happened).
    for (const sc of spotChecks) {
      sc.after_referral = sc.desired_referral;
      sc.after_fastrack = sc.desired_fastrack;
    }
  }

  return {
    mode: apply ? "apply" : "dry_run",
    audience_size: audience.size,
    processed,
    mutated,
    skipped_no_submission: skippedNoSub,
    skipped_already_matching: skippedMatching,
    errors,
    error_messages: errorMessages,
    spot_checks: spotChecks,
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let expected: string;
  try {
    expected = await getAuditSharedSecret();
  } catch (err) {
    console.error("vault secret fetch failed:", String(err));
    return json({ ok: false, error: "AUDIT_SHARED_SECRET not retrievable from vault" }, 500);
  }
  const provided = req.headers.get("x-audit-key");
  if (!provided || provided !== expected) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let body: { apply?: unknown };
  try {
    body = await req.json() as { apply?: unknown };
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  const apply = body.apply === true;

  try {
    const summary = await run(apply);
    return json({ ok: true, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("backfill failed:", msg);
    return json({ ok: false, error: msg }, 500);
  }
});
