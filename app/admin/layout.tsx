import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/allowlist";
import { AdminShell } from "@/components/admin-shell";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (!user) {
    redirect("/login");
  }

  if (!isAdmin(user.email)) {
    redirect("/login?error=not_authorised");
  }

  // AAL2 enforcement: confirm the user has stepped up via MFA this session.
  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalData?.currentLevel !== "aal2") {
    if (aalData?.nextLevel === "aal2") {
      // User has MFA enrolled but hasn't stepped up yet → challenge.
      redirect("/verify-mfa");
    } else {
      // User has no MFA factor → enrol.
      redirect("/enrol-mfa");
    }
  }

  return <AdminShell user={{ email: user.email }}>{children}</AdminShell>;
}
