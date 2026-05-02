"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

// Mark a dead-letter row as resolved manually. Sets replayed_at = now() with
// no replay_submission_id so it's recognisable as a manual mark vs an actual
// replay (which would set both).
//
// Use case: errors that have been dealt with out-of-band (e.g. owner manually
// inserted the lead via SQL, or the failure has aged out and is no longer
// relevant). Adds a note in error_context so the audit trail is clear.
export async function markErrorResolved(deadLetterId: number, note: string): Promise<ActionResult> {
  if (!note || note.trim().length === 0) {
    return { ok: false, error: "Add a note explaining how it was resolved." };
  }

  const supabase = await createClient();
  const { data: existing, error: readErr } = await supabase
    .schema("leads")
    .from("dead_letter")
    .select("id, error_context, replayed_at")
    .eq("id", deadLetterId)
    .maybeSingle();

  if (readErr) return { ok: false, error: readErr.message };
  if (!existing) return { ok: false, error: "Error row not found." };
  if (existing.replayed_at) return { ok: false, error: "Already marked resolved." };

  const annotated = `${existing.error_context ?? ""}\n[manually resolved ${new Date().toISOString()}]: ${note}`.trim();

  // .select() so we get the affected row back. RLS UPDATE without policy
  // returns 0 rows silently — we'd otherwise return ok=true with nothing
  // changed. Bit Charlotte 2 May 2026.
  const { data: updated, error: updateErr } = await supabase
    .schema("leads")
    .from("dead_letter")
    .update({
      replayed_at: new Date().toISOString(),
      error_context: annotated,
    })
    .eq("id", deadLetterId)
    .select("id");

  if (updateErr) return { ok: false, error: updateErr.message };
  if (!updated || updated.length === 0) {
    return { ok: false, error: "Update blocked by access policy. Re-deploy migration 0051?" };
  }

  revalidatePath("/errors");
  return { ok: true };
}

// Bulk-mark all unresolved rows for a given source as resolved with a single
// note. For sources where individual rows don't need per-row review (e.g.
// "Brevo upsert failed" — Brevo is eventually consistent, the row exists
// in the DB, the email tool will catch up). Saves clicking 30+ Mark Resolved
// buttons one by one.
export async function bulkMarkSourceResolved(
  source: string,
  note: string,
): Promise<ActionResult & { resolved?: number }> {
  if (!note || note.trim().length === 0) {
    return { ok: false, error: "Add a note explaining the cleanup reason." };
  }

  const supabase = await createClient();
  const stamp = new Date().toISOString();
  const annotation = `\n[bulk resolved ${stamp}]: ${note}`;

  const { data: existing, error: readErr } = await supabase
    .schema("leads")
    .from("dead_letter")
    .select("id, error_context")
    .eq("source", source)
    .is("replayed_at", null)
    .limit(500);

  if (readErr) return { ok: false, error: readErr.message };
  const rows = existing ?? [];
  if (rows.length === 0) return { ok: true, resolved: 0 };

  let resolved = 0;
  for (const r of rows) {
    const annotated = `${r.error_context ?? ""}${annotation}`.trim();
    const { data: updated, error: updateErr } = await supabase
      .schema("leads")
      .from("dead_letter")
      .update({ replayed_at: stamp, error_context: annotated })
      .eq("id", r.id)
      .is("replayed_at", null)
      .select("id");
    if (!updateErr && updated && updated.length > 0) resolved += 1;
  }

  revalidatePath("/errors");
  return { ok: true, resolved };
}
