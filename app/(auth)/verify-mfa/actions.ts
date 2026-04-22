"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function verifyMfaAction(formData: FormData) {
  const code = (formData.get("code") as string)?.trim();
  const next = (formData.get("next") as string) || "/";

  if (!code || code.length < 6) {
    redirect(`/verify-mfa?error=invalid_code&next=${encodeURIComponent(next)}`);
  }

  const supabase = await createClient();

  // Find the verified TOTP factor.
  const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError) {
    redirect(`/verify-mfa?error=${encodeURIComponent(factorsError.message)}`);
  }

  const verifiedTotp = factorsData?.totp?.find((f) => f.status === "verified");
  if (!verifiedTotp) {
    redirect("/enrol-mfa");
  }

  // Create a challenge.
  const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId: verifiedTotp.id,
  });
  if (challengeError) {
    redirect(`/verify-mfa?error=${encodeURIComponent(challengeError.message)}`);
  }

  // Verify the code against the challenge.
  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId: verifiedTotp.id,
    challengeId: challengeData!.id,
    code,
  });

  if (verifyError) {
    redirect(`/verify-mfa?error=invalid_code&next=${encodeURIComponent(next)}`);
  }

  redirect(next);
}

export async function signOutAction() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
