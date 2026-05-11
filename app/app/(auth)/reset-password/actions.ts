"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/allowlist";

export async function requestResetAction(formData: FormData) {
  const email = (formData.get("email") as string)?.trim().toLowerCase();
  if (!email) {
    redirect("/reset-password?error=missing_email");
  }

  // Send the reset for any well-formed email. Supabase silently no-ops if
  // the address isn't registered, so we never reveal whether an account
  // exists. Same response either way.
  //
  // The redirectTo URL handles BOTH admin and provider users — after they
  // click the email link and set a new password, confirmResetAction below
  // detects which audience they belong to and routes them to the right
  // sign-in page.
  const headersList = await headers();
  const host = headersList.get("host") ?? "admin.switchleads.co.uk";
  const proto = host.includes("localhost") ? "http" : "https";
  const redirectTo = `${proto}://${host}/api/auth/callback?next=/reset-password/confirm`;

  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email, { redirectTo });

  redirect("/reset-password?sent=true");
}

export async function confirmResetAction(formData: FormData) {
  const password = formData.get("password") as string;
  const confirm = formData.get("confirm") as string;

  if (!password || password.length < 12) {
    redirect("/reset-password/confirm?error=password_too_short");
  }
  if (password !== confirm) {
    redirect("/reset-password/confirm?error=passwords_do_not_match");
  }

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const userEmail = userData?.user?.email ?? null;

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    redirect(`/reset-password/confirm?error=${encodeURIComponent(error.message)}`);
  }

  // Route by audience: admins back to /login (their TOTP MFA still applies
  // on next sign-in), providers back to /provider-login (where they'll
  // re-enter password + receive a fresh email OTP code). Sign them out
  // first so they're forced through the full sign-in flow with the new
  // password.
  const callerIsAdmin = userEmail ? isAdmin(userEmail) : false;

  if (callerIsAdmin) {
    redirect("/login?reset=success");
  }

  // Provider path. Confirm the email actually maps to an active
  // provider_users row before kicking them out — if not, fall back to
  // admin login so they're not stranded.
  let isProvider = false;
  if (userEmail) {
    const admin = createAdminClient();
    const { data: pu } = await admin
      .schema("crm")
      .from("provider_users")
      .select("id, status")
      .eq("contact_email", userEmail)
      .eq("status", "active")
      .maybeSingle<{ id: number; status: string }>();
    isProvider = pu != null;
  }

  await supabase.auth.signOut();

  if (isProvider) {
    redirect("/provider-login?reset=success");
  }
  redirect("/login?reset=success");
}
