"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/allowlist";

export async function requestResetAction(formData: FormData) {
  const email = (formData.get("email") as string)?.trim().toLowerCase();
  if (!email) {
    redirect("/reset-password?error=missing_email");
  }

  // Don't reveal whether the email is allowlisted or not — always say "check your inbox".
  // But only actually send the email if it's an admin email (no point spamming randoms).
  if (isAdmin(email)) {
    const headersList = await headers();
    const host = headersList.get("host") ?? "admin.switchleads.co.uk";
    const proto = host.includes("localhost") ? "http" : "https";
    const redirectTo = `${proto}://${host}/api/auth/callback?next=/reset-password/confirm`;

    const supabase = await createClient();
    await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  }

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
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    redirect(`/reset-password/confirm?error=${encodeURIComponent(error.message)}`);
  }

  redirect("/login?reset=success");
}
