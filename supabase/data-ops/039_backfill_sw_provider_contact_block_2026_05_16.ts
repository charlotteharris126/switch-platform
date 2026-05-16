// Backfill SW_PROVIDER_CONTACT_BLOCK on existing Brevo contacts.
//
// Driver: Wren push 2026-05-16. SW_PROVIDER_CONTACT_BLOCK was originally
// shipped as a per-send transactional param (Session 47, 2026-05-15) but
// switched to a Brevo contact attribute today for template-preview
// visibility and consistency with the rest of the SW_* set. Existing
// Switchable contacts don't carry the attribute yet — this backfill
// populates it before Wren publishes the trimmed U1 funded templates
// that reference `{{ contact.SW_PROVIDER_CONTACT_BLOCK }}`.
//
// Memory: `feedback_brevo_attribute_wiring_requires_backfill.md`.
//
// What this does
// --------------
// 1. Fetches AUDIT_SHARED_SECRET from Vault (read-only, single query).
// 2. Reads every non-archived leads.submissions.id that has an email.
// 3. Batches IDs (100 per call) and POSTs each batch to admin-brevo-resync.
//    The Edge Function re-upserts each contact, which now writes the new
//    attribute via upsertLearnerInBrevo / upsertLearnerInBrevoNoMatch.
// 4. Aggregates ok / skipped / error counts and prints a tally.
//
// Pre-reqs: SW_PROVIDER_CONTACT_BLOCK registered in Brevo as a text
// attribute (Charlotte step 1), and the four Edge Functions redeployed
// with the attribute-writing code (Charlotte step 2). Without those the
// resyncs will run but write nothing visible.
//
// Usage
// -----
//   ./scripts/run-039-backfill.sh
//
//   # or directly:
//   deno run --allow-net --allow-env --allow-read \
//     supabase/data-ops/039_backfill_sw_provider_contact_block_2026_05_16.ts
//
// Required env:
//   SUPABASE_DB_URL   Postgres connection string

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  console.error("Error: SUPABASE_DB_URL not set");
  Deno.exit(1);
}

const PROJECT_REF = "igvlngouxcirqhlsrhga";
const BATCH_SIZE = 100;
const FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/admin-brevo-resync`;

const sql = postgres(DATABASE_URL, { max: 1, prepare: false });

try {
  const [keyRow] = await sql<Array<{ secret: string | null }>>`
    SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
  `;
  const auditKey = keyRow?.secret;
  if (!auditKey) {
    console.error("Error: AUDIT_SHARED_SECRET not found in Vault");
    Deno.exit(1);
  }

  const rows = await sql<Array<{ id: number }>>`
    SELECT id
      FROM leads.submissions
     WHERE archived_at IS NULL
       AND email IS NOT NULL
     ORDER BY id
  `;
  const ids = rows.map((r) => Number(r.id));
  console.log(`Found ${ids.length} submissions to resync (batches of ${BATCH_SIZE})\n`);

  let okCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  const errorMessages: string[] = [];

  const totalBatches = Math.ceil(ids.length / BATCH_SIZE);
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    Deno.stdout.writeSync(new TextEncoder().encode(`Batch ${batchNum}/${totalBatches} (ids ${batch[0]}–${batch[batch.length - 1]})... `));

    let resp: Response;
    try {
      resp = await fetch(FUNCTION_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-audit-key": auditKey },
        body: JSON.stringify({ submissionIds: batch }),
      });
    } catch (err) {
      console.log(`FETCH FAILED: ${err instanceof Error ? err.message : String(err)}`);
      errorCount += batch.length;
      errorMessages.push(`Batch ${batchNum}: fetch failed`);
      continue;
    }

    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      console.log(`HTTP ${resp.status}`);
      errorCount += batch.length;
      errorMessages.push(`Batch ${batchNum}: HTTP ${resp.status} ${JSON.stringify(body).slice(0, 200)}`);
      continue;
    }

    const results = (body.results ?? []) as Array<{ id: number; status: string; reason?: string }>;
    let bOk = 0, bSkip = 0, bErr = 0;
    for (const r of results) {
      if (r.status === "ok") bOk++;
      else if (r.status === "skipped") bSkip++;
      else {
        bErr++;
        errorMessages.push(`  id=${r.id}: ${r.reason ?? "unknown"}`);
      }
    }
    okCount += bOk;
    skippedCount += bSkip;
    errorCount += bErr;
    console.log(`ok=${bOk} skipped=${bSkip} errors=${bErr}`);
  }

  console.log(`\n— Totals —`);
  console.log(`ok       ${okCount}`);
  console.log(`skipped  ${skippedCount}`);
  console.log(`errors   ${errorCount}`);
  if (errorMessages.length > 0) {
    console.log(`\nFirst 20 error reasons:`);
    for (const m of errorMessages.slice(0, 20)) console.log(m);
  }
} finally {
  await sql.end();
}
