"use server";

// Server Actions for the /provider/account page.
//
// Reads via the admin (service_role) client because crm.provider_passkeys
// has no provider-context RLS policy; server-side scoping (provider_user_id
// match against the caller's row) is the trust boundary. Adding a proper
// provider RLS policy on provider_passkeys is a follow-up.
//
// Writes audit through public.log_provider_action_v1 same as outcome
// marking — every passkey removal lands a row in audit.actions.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface ProviderUserRow {
  id: number;
  provider_id: string;
}

type Result = { ok: true } | { ok: false; error: string };

async function resolveProviderUser(): Promise<
  | { ok: true; user: { authUserId: string }; pu: ProviderUserRow }
  | { ok: false; error: string }
> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { ok: false, error: "Not signed in" };

  const admin = createAdminClient();
  const { data: pu, error } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, provider_id")
    .eq("auth_user_id", userData.user.id)
    .eq("status", "active")
    .maybeSingle<ProviderUserRow>();

  if (error) return { ok: false, error: error.message };
  if (!pu) return { ok: false, error: "Active provider user not found" };

  return { ok: true, user: { authUserId: userData.user.id }, pu };
}

export async function removePasskeyAction(args: { passkeyId: number }): Promise<Result> {
  const ctx = await resolveProviderUser();
  if (!ctx.ok) return ctx;

  const admin = createAdminClient();

  // Confirm ownership before disabling. Scope to caller's provider_user_id.
  const { data: existing, error: readErr } = await admin
    .schema("crm")
    .from("provider_passkeys")
    .select("id, provider_user_id, nickname, disabled_at")
    .eq("id", args.passkeyId)
    .maybeSingle<{ id: number; provider_user_id: number; nickname: string | null; disabled_at: string | null }>();

  if (readErr) return { ok: false, error: readErr.message };
  if (!existing) return { ok: false, error: "Passkey not found" };
  if (existing.provider_user_id !== ctx.pu.id) {
    return { ok: false, error: "That passkey isn't yours to remove" };
  }
  if (existing.disabled_at) {
    return { ok: false, error: "Passkey is already removed" };
  }

  // Refuse to remove the LAST active passkey — locks the user out.
  const { count, error: countErr } = await admin
    .schema("crm")
    .from("provider_passkeys")
    .select("id", { count: "exact", head: true })
    .eq("provider_user_id", ctx.pu.id)
    .is("disabled_at", null);

  if (countErr) return { ok: false, error: countErr.message };
  if ((count ?? 0) <= 1) {
    return { ok: false, error: "This is your only passkey — removing it would lock you out. Add another one first, or contact Charlotte to re-issue an invite." };
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await admin
    .schema("crm")
    .from("provider_passkeys")
    .update({ disabled_at: nowIso })
    .eq("id", args.passkeyId);

  if (updErr) return { ok: false, error: updErr.message };

  // Audit. Uses the user's own session (authenticated) so the inner
  // helper can attribute to their provider_users row.
  const supabase = await createClient();
  const { error: auditError } = await supabase.rpc("log_provider_action_v1", {
    p_action: "remove_passkey",
    p_target_table: "crm.provider_passkeys",
    p_target_id: String(args.passkeyId),
    p_before: { disabled_at: null, nickname: existing.nickname },
    p_after: { disabled_at: nowIso, nickname: existing.nickname },
    p_context: null,
  });

  if (auditError) {
    return { ok: false, error: `Removed but audit write failed: ${auditError.message}` };
  }

  revalidatePath("/provider/account");
  return { ok: true };
}

export async function updateDisplayNameAction(args: { displayName: string }): Promise<Result> {
  const trimmed = args.displayName.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Display name can't be empty." };
  }
  if (trimmed.length > 80) {
    return { ok: false, error: "Display name is too long (max 80 chars)." };
  }

  const ctx = await resolveProviderUser();
  if (!ctx.ok) return ctx;

  const admin = createAdminClient();

  // Read current value for audit before/after.
  const { data: before, error: readErr } = await admin
    .schema("crm")
    .from("provider_users")
    .select("display_name")
    .eq("id", ctx.pu.id)
    .maybeSingle<{ display_name: string | null }>();
  if (readErr) return { ok: false, error: readErr.message };

  if ((before?.display_name ?? "") === trimmed) {
    return { ok: true };
  }

  const { error: updErr } = await admin
    .schema("crm")
    .from("provider_users")
    .update({ display_name: trimmed, updated_at: new Date().toISOString() })
    .eq("id", ctx.pu.id);
  if (updErr) return { ok: false, error: updErr.message };

  const supabase = await createClient();
  const { error: auditError } = await supabase.rpc("log_provider_action_v1", {
    p_action: "update_display_name",
    p_target_table: "crm.provider_users",
    p_target_id: String(ctx.pu.id),
    p_before: { display_name: before?.display_name ?? null },
    p_after: { display_name: trimmed },
    p_context: null,
  });

  if (auditError) {
    return { ok: false, error: `Saved but audit write failed: ${auditError.message}` };
  }

  revalidatePath("/provider/account");
  revalidatePath("/provider");
  return { ok: true };
}
