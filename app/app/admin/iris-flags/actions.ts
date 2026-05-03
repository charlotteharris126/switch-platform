"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

// Mark an Iris flag as resolved (read by owner). Stamps read_by_owner_at = now().
// Idempotent: re-resolving an already-resolved flag is a no-op (the WHERE clause
// filters to read_by_owner_at IS NULL only).
export async function markFlagResolved(input: { flagId: number }): Promise<ActionResult> {
  const supabase = await createClient();

  const { error } = await supabase
    .schema("ads_switchable")
    .from("iris_flags")
    .update({ read_by_owner_at: new Date().toISOString() })
    .eq("id", input.flagId)
    .is("read_by_owner_at", null);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/");
  revalidatePath("/iris-flags");
  return { ok: true };
}

// Bulk mark all currently-active notified flags as resolved. Used by the
// "Resolve all" action when owner has scanned the queue and decided nothing
// needs follow-up. Returns the count of rows updated.
export async function markAllFlagsResolved(): Promise<ActionResult & { count?: number }> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema("ads_switchable")
    .from("iris_flags")
    .update({ read_by_owner_at: new Date().toISOString() })
    .eq("notified", true)
    .is("read_by_owner_at", null)
    .select("id");

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/");
  revalidatePath("/iris-flags");
  return { ok: true, count: data?.length ?? 0 };
}
