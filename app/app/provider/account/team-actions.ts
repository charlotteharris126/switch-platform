"use server";

// Server Action — provider_admin invites another user to their account.
//
// Auth: caller must be an active provider_users row with
// role='provider_admin'. Verified server-side; the RLS-on-provider_users
// policy doesn't enforce role, so this is the trust boundary.
//
// Implementation: same pattern as the admin-side sendPortalInviteAction.
// Reads AUDIT_SHARED_SECRET from vault via service-role get_shared_secret
// helper, POSTs to provider-invite-link Edge Function. The function
// handles "row exists, regenerate token" case for re-invites.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

interface InviteArgs {
  email: string;
  role: "provider_admin" | "provider_user";
  display_name?: string;
}

type InviteResult = { ok: true; expiresAt: string } | { ok: false; error: string };

export async function inviteProviderUserAction(args: InviteArgs): Promise<InviteResult> {
  const email = args.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return { ok: false, error: "Enter a valid email." };
  }
  if (args.role !== "provider_admin" && args.role !== "provider_user") {
    return { ok: false, error: "Pick a valid role." };
  }

  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) return { ok: false, error: "Not signed in" };

  const admin = createAdminClient();

  // Resolve caller. Must be active + role='provider_admin'.
  const { data: caller, error: callerErr } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, provider_id, role, status")
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle<{ id: number; provider_id: string; role: string; status: string }>();
  if (callerErr) return { ok: false, error: callerErr.message };
  if (!caller) return { ok: false, error: "Active provider user not found" };
  if (caller.role !== "provider_admin") {
    return {
      ok: false,
      error: "Only account admins can invite users. Ask your account admin or email support@switchleads.co.uk.",
    };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    return { ok: false, error: "Server misconfigured" };
  }

  const { data: secret, error: secretErr } = await admin.rpc("get_shared_secret", {
    p_name: "AUDIT_SHARED_SECRET",
  });
  if (secretErr || typeof secret !== "string") {
    return { ok: false, error: `Vault read failed: ${secretErr?.message ?? "no value"}` };
  }

  let resp: Response;
  try {
    resp = await fetch(`${supabaseUrl}/functions/v1/provider-invite-link`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-audit-key": secret,
        // Bypass the demo-only fence in provider-invite-link, same as the
        // admin send-portal-invite path. Real providers (is_demo=false) are
        // already enrolled + logging in via that path; provider self-invite
        // is the same operation initiated by a provider_admin.
        "x-allow-real": "true",
      },
      body: JSON.stringify({
        provider_id: caller.provider_id,
        email,
        role: args.role,
        display_name: args.display_name?.trim() || undefined,
      }),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const body = (await resp.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    detail?: string;
    expires_at?: string;
  };
  if (!resp.ok || !body.ok) {
    return { ok: false, error: body.detail ?? body.error ?? `Edge Function ${resp.status}` };
  }

  return { ok: true, expiresAt: body.expires_at ?? new Date().toISOString() };
}

// ---------------------------------------------------------------------
// Remove a teammate. Soft delete: provider_users.status flips to
// 'removed', the auth row stays so any audit trail it owns keeps
// pointing at a real user.
//
// Guard rails:
//   - Caller must be an active provider_admin (same gate as invite)
//   - Target must belong to the caller's provider_id (RLS adds a second
//     check but we enforce here for the early-fail error message)
//   - Can't remove yourself (would lock yourself out)
//   - Can't remove the last remaining provider_admin (no admin left)
//
// Audit: writes via public.log_provider_action_v1 so the existing
// admin audit-trail page picks it up alongside outcome marks and note
// adds. before/after capture the role + status flip.
// ---------------------------------------------------------------------

type RemoveResult = { ok: true; removedEmail: string } | { ok: false; error: string };

export async function removeProviderUserAction(args: {
  provider_user_id: number;
}): Promise<RemoveResult> {
  if (typeof args.provider_user_id !== "number" || args.provider_user_id <= 0) {
    return { ok: false, error: "Invalid user id." };
  }

  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) return { ok: false, error: "Not signed in" };

  const admin = createAdminClient();

  // Resolve caller — must be active provider_admin
  const { data: caller, error: callerErr } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, provider_id, role, status")
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle<{ id: number; provider_id: string; role: string; status: string }>();
  if (callerErr) return { ok: false, error: callerErr.message };
  if (!caller) return { ok: false, error: "Active provider user not found" };
  if (caller.role !== "provider_admin") {
    return { ok: false, error: "Only account admins can remove team members." };
  }
  if (caller.id === args.provider_user_id) {
    return { ok: false, error: "You can't remove yourself. Ask another admin or email support@switchleads.co.uk." };
  }

  // Resolve target — must be on caller's provider, active
  const { data: target, error: targetErr } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, provider_id, contact_email, display_name, role, status")
    .eq("id", args.provider_user_id)
    .maybeSingle<{
      id: number;
      provider_id: string;
      contact_email: string;
      display_name: string | null;
      role: string;
      status: string;
    }>();
  if (targetErr) return { ok: false, error: targetErr.message };
  if (!target) return { ok: false, error: "That user doesn't exist." };
  if (target.provider_id !== caller.provider_id) {
    return { ok: false, error: "That user belongs to another account." };
  }
  if (target.status !== "active") {
    return { ok: false, error: "That user is already inactive." };
  }

  // Last-admin guard — count remaining active provider_admins after this
  // removal would land. If zero, refuse.
  if (target.role === "provider_admin") {
    const { count, error: countErr } = await admin
      .schema("crm")
      .from("provider_users")
      .select("id", { count: "exact", head: true })
      .eq("provider_id", caller.provider_id)
      .eq("role", "provider_admin")
      .eq("status", "active");
    if (countErr) return { ok: false, error: countErr.message };
    if ((count ?? 0) <= 1) {
      return {
        ok: false,
        error: "Can't remove the last admin. Promote another team member to admin first, or email support@switchleads.co.uk.",
      };
    }
  }

  const before = { role: target.role, status: target.status };
  const after = { role: target.role, status: "removed" };

  const { error: updateErr } = await admin
    .schema("crm")
    .from("provider_users")
    .update({ status: "removed" })
    .eq("id", target.id);
  if (updateErr) return { ok: false, error: updateErr.message };

  // Audit via the public wrapper so the admin audit page picks it up
  // (same write path as outcome marking). Uses the AUTHENTICATED
  // client so auth.uid() lands as the caller, not service-role.
  const { error: auditErr } = await supabase.rpc("log_provider_action_v1", {
    p_action: "remove_team_user",
    p_target_table: "crm.provider_users",
    p_target_id: String(target.id),
    p_before: before,
    p_after: after,
    p_context: {
      removed_email: target.contact_email,
      removed_display_name: target.display_name,
      provider_id: caller.provider_id,
    },
  });
  if (auditErr) {
    return {
      ok: false,
      error: `User removed but audit write failed: ${auditErr.message}`,
    };
  }

  return { ok: true, removedEmail: target.contact_email };
}
