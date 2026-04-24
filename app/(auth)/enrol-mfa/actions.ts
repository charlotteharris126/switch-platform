"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type FactorRow = { id: string; status: string; friendly_name?: string | null };

type EnrolResult =
  | { type: "success"; factor_id: string; secret: string }
  | { type: "error"; message: string };

export async function startEnrolmentAction() {
  let result: EnrolResult;
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
      result = { type: "error", message: error?.message ?? "enrolment_failed_no_data" };
    } else {
      // We deliberately do NOT pass the QR code via URL — Supabase returns it as a full
      // SVG XML string which is too large for URL search params. The user types the
      // secret manually into their authenticator instead. QR rendering can be added
      // later as a client-side render from the secret.
      result = {
        type: "success",
        factor_id: data.id,
        secret: data.totp.secret,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[mfa-enrol] crashed at stage=${stage}`, e);
    result = { type: "error", message: `crash_${stage}_${msg.slice(0, 200)}` };
  }

  // Redirects sit outside any try/catch so Next.js can handle their throw correctly.
  if (result.type === "success") {
    const params = new URLSearchParams({
      factor_id: result.factor_id,
      secret: result.secret,
    });
    redirect(`/enrol-mfa?${params.toString()}`);
  } else {
    redirect(`/enrol-mfa?error=${encodeURIComponent(result.message)}`);
  }
}

export async function verifyEnrolmentAction(formData: FormData) {
  const factorId = formData.get("factor_id") as string;
  const code = (formData.get("code") as string)?.trim();

  let result: { type: "success" } | { type: "error"; message: string };

  if (!factorId || !code || code.length < 6) {
    redirect(`/enrol-mfa?error=invalid_code`);
  }

  try {
    const supabase = await createClient();

    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId,
    });
    if (challengeError) {
      result = { type: "error", message: challengeError.message };
    } else {
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challengeData!.id,
        code,
      });
      result = verifyError
        ? { type: "error", message: "invalid_code" }
        : { type: "success" };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[mfa-verify-enrol] crashed", e);
    result = { type: "error", message: `crash_${msg.slice(0, 200)}` };
  }

  if (result.type === "success") {
    redirect("/");
  }
  redirect(`/enrol-mfa?error=${encodeURIComponent(result.message)}`);
}
