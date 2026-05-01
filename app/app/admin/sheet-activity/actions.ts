"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Resolve a pending AI suggestion from the dashboard. Calls the
// crm.resolve_pending_update SECURITY DEFINER RPC so the dashboard's
// authenticated role can apply state changes without needing direct
// UPDATE/INSERT grants on every table involved (matching the existing
// fire_provider_chaser pattern).
//
// The RPC handles: pending_updates status flip, enrolment status update,
// audit row in sheet_edits_log, and dispute insert (if status=disputed).
// Idempotent — repeated clicks after the first one return "already <status>".

export type ResolveResult = {
  ok: boolean;
  message: string;
};

export async function resolvePendingUpdate(
  pendingUpdateId: number,
  action: "approve" | "reject" | "override",
  overrideStatus?: string,
): Promise<ResolveResult> {
  const supabase = await createClient();

  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return { ok: false, message: "Not signed in" };
  }

  const { data, error } = await supabase
    .schema("crm")
    .rpc("resolve_pending_update", {
      p_id: pendingUpdateId,
      p_action: action,
      p_override_status: overrideStatus ?? null,
    });

  if (error) {
    return { ok: false, message: error.message ?? "Unknown error" };
  }

  const row = (data as Array<{ ok: boolean; message: string; applied_status: string | null }>)?.[0];
  if (!row) {
    return { ok: false, message: "No response from RPC" };
  }

  if (row.ok) {
    revalidatePath("/sheet-activity");
  }

  return { ok: row.ok, message: row.message };
}
