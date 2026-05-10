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
