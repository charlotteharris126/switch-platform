"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/allowlist";

export async function loginAction(formData: FormData) {
  const email = (formData.get("email") as string)?.trim().toLowerCase();
  const password = formData.get("password") as string;
  const next = (formData.get("next") as string) || "/";

  if (!email || !password) {
    redirect("/login?error=missing_credentials");
  }

  // Reject non-admin emails before even attempting auth — small UX courtesy
  // (proper enforcement happens in middleware).
  if (!isAdmin(email)) {
    redirect("/login?error=not_authorised");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  // Check MFA factor state
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const verifiedTotp = factorsData?.totp?.find((f) => f.status === "verified");

  if (!verifiedTotp) {
    // No MFA enrolled — force user through enrolment.
    redirect("/enrol-mfa");
  }

  // MFA enrolled. Step up to AAL2.
  redirect(`/verify-mfa?next=${encodeURIComponent(next)}`);
}
