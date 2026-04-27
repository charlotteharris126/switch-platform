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

  const { error: updateErr } = await supabase
    .schema("leads")
    .from("dead_letter")
    .update({
      replayed_at: new Date().toISOString(),
      error_context: annotated,
    })
    .eq("id", deadLetterId);

  if (updateErr) return { ok: false, error: updateErr.message };

  revalidatePath("/errors");
  return { ok: true };
}
