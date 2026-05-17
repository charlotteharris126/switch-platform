import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AdminShell } from "@/components/admin-shell";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();

  // Proxy middleware (proxy.ts) is the auth boundary: it already validated
  // the user via supabase.auth.getUser() and gated admin access via the
  // allowlist. If we hit this layout, the user is signed-in and authorised,
  // so we trust that and read the local session (no extra network call to
  // Supabase Auth on every admin navigation). Saves one full RTT per click.
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) {
    // Defensive: cookies expired between middleware and here, or someone
    // hit the layout outside the proxy. Bounce back to login.
    redirect("/login");
  }

  // AAL2 enforcement: confirm the user has stepped up via MFA this session.
  // mfa.getAuthenticatorAssuranceLevel() reads the JWT locally, no network.
  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalData?.currentLevel !== "aal2") {
    if (aalData?.nextLevel === "aal2") {
      redirect("/verify-mfa");
    } else {
      redirect("/enrol-mfa");
    }
  }

  return <AdminShell user={{ email: user.email }}>{children}</AdminShell>;
}
