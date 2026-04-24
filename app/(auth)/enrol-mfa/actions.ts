"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type FactorRow = { id: string; status: string; friendly_name?: string | null };

function isRedirectError(e: unknown): boolean {
  // Next.js wraps redirect() in a thrown error with a digest starting NEXT_REDIRECT.
  // We must NOT swallow that — re-throw so the framework handles it.
  return (
    typeof e === "object" &&
    e !== null &&
    "digest" in e &&
    typeof (e as { digest?: unknown }).digest === "string" &&
    (e as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

export async function startEnrolmentAction() {
  // Diagnostic wrapper — if anything throws unexpectedly, surface the stage + message
  // in the URL so we can see what's actually breaking.
  let stage = "init";
  try {
    stage = "create_client";
    const supabase = await createClient();

    stage = "cleanup";
    try {
      const { data: factorsResp } = await supabase.auth.mfa.listFactors();
      const allFactors = ((factorsResp as unknown as { all?: FactorRow[] })?.all ?? []) as FactorRow[];
      const unverified = allFactors.filter((f) => f.status === "unverified");
      for (const factor of unverified) {
        await supabase.auth.mfa.unenroll({ factorId: factor.id });
      }
    } catch (cleanupError) {
      console.error("[mfa-enrol] cleanup failed (non-fatal)", cleanupError);
    }

    stage = "enroll";
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `Admin TOTP (${new Date().toISOString()})`,
    });

    if (error || !data) {
      console.error("[mfa-enrol] enroll returned error", error);
      redirect(`/enrol-mfa?error=${encodeURIComponent(error?.message ?? "enrolment_failed_no_data")}`);
    }

    stage = "redirect_to_qr";
    const params = new URLSearchParams({
      factor_id: data.id,
      qr: data.totp.qr_code,
      secret: data.totp.secret,
    });
    redirect(`/enrol-mfa?${params.toString()}`);
  } catch (e) {
    // Re-throw redirect "errors" — Next.js needs to handle them as redirects.
    if (isRedirectError(e)) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[mfa-enrol] crashed at stage=${stage}`, e);
    redirect(`/enrol-mfa?error=${encodeURIComponent(`crash_${stage}_${msg.slice(0, 200)}`)}`);
  }
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
