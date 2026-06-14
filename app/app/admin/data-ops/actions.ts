"use server";

// Server Actions for /admin/data-ops one-off jobs. Mirrors the gate pattern in
// /admin/blog/actions.ts: authenticated server client + isAdmin() email check,
// then the service-role admin client to call SECURITY DEFINER RPCs.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/allowlist";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function requireAdmin(): Promise<ActionResult<true>> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user || !isAdmin(userData.user.email)) {
    return { ok: false, error: "Not authorised" };
  }
  return { ok: true, data: true };
}

// Backfills waitlist contacts' name/location/qualification from their parent
// submission and re-syncs them to Brevo. Idempotent — re-running fills nothing
// more. See migration 0208 + platform/docs/waitlist-capture-fix.md.
export async function backfillWaitlistIdentityAction(): Promise<
  ActionResult<{ filled_count: number; affected_ids: number[] }>
> {
  const gate = await requireAdmin();
  if (!gate.ok) return gate;
  const admin = createAdminClient();
  const { data, error } = await admin.schema("crm").rpc("backfill_waitlist_identity_from_parent");
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  return {
    ok: true,
    data: {
      filled_count: Number(row?.filled_count ?? 0),
      affected_ids: (row?.affected_ids ?? []) as number[],
    },
  };
}
