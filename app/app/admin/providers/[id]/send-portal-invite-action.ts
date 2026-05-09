"use server";

// Server Action — calls the provider-invite-link Edge Function on behalf of
// an authenticated admin. The /admin layout already gates non-admins;
// we trust that gate.

import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/allowlist";

interface Args {
  provider_id: string;
  email: string;
  role: "provider_admin" | "provider_user";
  display_name?: string;
}

type Result = { ok: true; expiresAt: string } | { ok: false; error: string };

export async function sendPortalInviteAction(args: Args): Promise<Result> {
  // Defence in depth: re-check admin even though /admin layout gates.
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user || !isAdmin(userData.user.email)) {
    return { ok: false, error: "Not authorised" };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const auditKey = process.env.AUDIT_SHARED_SECRET;
  if (!supabaseUrl || !auditKey) {
    return { ok: false, error: "Server misconfigured (NEXT_PUBLIC_SUPABASE_URL or AUDIT_SHARED_SECRET missing)" };
  }

  const url = `${supabaseUrl}/functions/v1/provider-invite-link`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-audit-key": auditKey,
      },
      body: JSON.stringify(args),
    });
  } catch (err) {
    return { ok: false, error: `Network error calling Edge Function: ${err instanceof Error ? err.message : String(err)}` };
  }

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    detail?: string;
    expires_at?: string;
  };

  if (!res.ok || !body.ok) {
    return { ok: false, error: body.detail ?? body.error ?? `Edge Function returned ${res.status}` };
  }

  return { ok: true, expiresAt: body.expires_at ?? new Date().toISOString() };
}
