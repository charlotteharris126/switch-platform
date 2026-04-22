"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type FactorRow = { id: string; status: string; friendly_name?: string | null };

export async function startEnrolmentAction() {
  const supabase = await createClient();

  // Clean up any stuck unverified factors from previous attempts. Supabase rejects
  // duplicate friendly names, so without this, repeat clicks fail with "already exists".
  const { data: factorsResp } = await supabase.auth.mfa.listFactors();
  // SDK types are narrow here; the runtime payload includes both verified and unverified.
  const allFactors = ((factorsResp as unknown as { all?: FactorRow[] })?.all ?? []) as FactorRow[];
  const unverified = allFactors.filter((f) => f.status === "unverified");
  for (const factor of unverified) {
    await supabase.auth.mfa.unenroll({ factorId: factor.id });
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    // Unique name per call so collisions never block enrolment, even if cleanup misses one.
    friendlyName: `Admin TOTP (${new Date().toISOString()})`,
  });

  if (error || !data) {
    redirect(`/enrol-mfa?error=${encodeURIComponent(error?.message ?? "enrolment_failed")}`);
  }

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
