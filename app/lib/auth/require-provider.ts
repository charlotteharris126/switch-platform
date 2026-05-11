// Server-side helper for provider portal pages. Verifies the caller is
// signed in, resolves their provider_user row + provider_id, and returns
// them. Throws-by-redirect on missing or inactive session, mirroring the
// pattern used by `requireAdminUser()`.
//
// Uses `auth.getUser()` (re-verifies the JWT with the auth server), not
// `auth.getSession()` (cookie-only). The proxy already calls getUser()
// on every request, so this is defence-in-depth.
//
// `provider_users` has admin-gated RLS that the authenticated session
// can't satisfy on self-lookup, so the lookup goes via the admin client.
// That's safe — we restrict by auth_user_id, which is the only key the
// caller could be looking themselves up by.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export interface ProviderUserContext {
  authUserId: string;
  providerUserId: number;
  providerId: string;
  contactEmail: string;
  displayName: string | null;
  role: string;
}

export async function requireProviderUser(): Promise<ProviderUserContext> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  const user = data?.user;
  if (error || !user) {
    redirect("/provider-login");
  }

  const admin = createAdminClient();
  const { data: pu } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, provider_id, contact_email, display_name, role, status")
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle<{
      id: number;
      provider_id: string;
      contact_email: string;
      display_name: string | null;
      role: string;
      status: string;
    }>();

  if (!pu) {
    await supabase.auth.signOut();
    redirect("/provider-login?error=no_active_account");
  }

  return {
    authUserId: user.id,
    providerUserId: pu.id,
    providerId: pu.provider_id,
    contactEmail: pu.contact_email,
    displayName: pu.display_name,
    role: pu.role,
  };
}
