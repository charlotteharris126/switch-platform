// /provider — gated home for authenticated provider users.
//
// Middleware (../middleware.ts) ensures only authenticated users reach this
// page. We re-confirm here and pull the provider_users + provider rows so
// the placeholder shows context.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SignOutButton } from "./sign-out-button";

interface ProviderUserRow {
  id: number;
  provider_id: string;
  contact_email: string;
  display_name: string | null;
  role: string;
  enrolled_at: string | null;
  status: string;
}

interface ProviderRow {
  company_name: string;
}

export default async function ProviderHomePage() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) redirect("/passkey-login");

  const admin = createAdminClient();
  const { data: pu } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, provider_id, contact_email, display_name, role, enrolled_at, status")
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle<ProviderUserRow>();

  if (!pu) {
    // Auth user exists but no active provider_users mapping. Possibly suspended,
    // revoked, or auth user was created outside the portal flow. Sign them out.
    await supabase.auth.signOut();
    redirect("/passkey-login?error=no_active_account");
  }

  const { data: provider } = await admin
    .schema("crm")
    .from("providers")
    .select("company_name")
    .eq("provider_id", pu.provider_id)
    .maybeSingle<ProviderRow>();

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-slate-200 p-8">
        <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">SwitchLeads</p>
        <h1 className="text-2xl font-semibold text-slate-900 mt-2">Welcome</h1>
        <p className="text-slate-600 mt-3 text-sm">
          Signed in as <strong>{pu.display_name ?? pu.contact_email}</strong> for{" "}
          <strong>{provider?.company_name ?? pu.provider_id}</strong>.
        </p>
        <div className="mt-6 p-4 bg-slate-50 border border-slate-200 rounded-lg">
          <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold">Coming next</p>
          <ul className="mt-2 text-sm text-slate-700 space-y-1">
            <li>&middot; Your routed leads</li>
            <li>&middot; Outcome marking</li>
            <li>&middot; Account &amp; billing</li>
          </ul>
        </div>
        <form action={signOutAction} className="mt-6">
          <SignOutButton />
        </form>
      </div>
    </div>
  );
}

async function signOutAction() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/passkey-login");
}
