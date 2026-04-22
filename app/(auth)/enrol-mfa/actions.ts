"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function startEnrolmentAction() {
  const supabase = await createClient();

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "Admin TOTP",
  });

  if (error || !data) {
    redirect(`/enrol-mfa?error=${encodeURIComponent(error?.message ?? "enrolment_failed")}`);
  }

  // Pass factor id, qr code, and secret to the page via search params.
  const params = new URLSearchParams({
    factor_id: data.id,
    qr: data.totp.qr_code,
    secret: data.totp.secret,
  });
  redirect(`/enrol-mfa?${params.toString()}`);
}

export async function verifyEnrolmentAction(formData: FormData) {
  const factorId = formData.get("factor_id") as string;
  const code = (formData.get("code") as string)?.trim();

  if (!factorId || !code || code.length < 6) {
    redirect(`/enrol-mfa?error=invalid_code`);
  }

  const supabase = await createClient();

  const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
    factorId,
  });
  if (challengeError) {
    redirect(`/enrol-mfa?error=${encodeURIComponent(challengeError.message)}`);
  }

  const { error: verifyError } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challengeData!.id,
    code,
  });

  if (verifyError) {
    redirect(`/enrol-mfa?error=invalid_code`);
  }

  // Enrolment complete. AAL2 is now active for the session.
  redirect("/");
}
