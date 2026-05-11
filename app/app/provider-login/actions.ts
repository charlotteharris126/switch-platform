"use server";

// Server Action — step 1 of provider sign-in. Validates email + password
// against Supabase Auth, then immediately signs out so a session isn't
// established yet, then triggers a 6-digit email OTP via signInWithOtp.
// The user enters the code on /provider-verify-code to complete sign-in.
//
// Step 2 (the OTP verify) is in /provider-verify-code/actions.ts —
// keeping the two halves in separate routes makes the URL the source of
// truth for "where we are in the flow" and lets the user copy-paste the
// code without losing state.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

type Result = { ok: true } | { ok: false; error: string };

export async function providerLoginStartAction(args: {
  email: string;
  password: string;
}): Promise<Result> {
  const email = typeof args.email === "string" ? args.email.trim().toLowerCase() : "";
  const password = typeof args.password === "string" ? args.password : "";
  if (!email || !password) {
    return { ok: false, error: "Email and password required." };
  }

  // Bind a fresh client so signInWithPassword writes its cookies into
  // THIS request's response (we immediately signOut so they never reach
  // the browser, but the call still needs a cookie-aware client).
  const supabase = await createClient();

  const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (signInErr || !signInData?.user) {
    // Constant-time-ish: don't reveal whether the email exists or not.
    return { ok: false, error: "Wrong email or password." };
  }

  // Defence-in-depth: confirm the signed-in user actually maps to an
  // active provider_users row before sending the OTP. An admin who
  // typo'd their way to /provider-login should bounce here rather than
  // get a code email.
  const admin = createAdminClient();
  const { data: pu } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, status")
    .eq("auth_user_id", signInData.user.id)
    .maybeSingle<{ id: number; status: string }>();

  // Sign out either way — we never want a session at this stage.
  await supabase.auth.signOut();

  if (!pu) {
    return { ok: false, error: "Wrong email or password." };
  }
  if (pu.status !== "active") {
    return { ok: false, error: "This account is suspended. Email support@switchleads.co.uk." };
  }

  // Mint the email OTP. shouldCreateUser:false is critical — without it
  // an attacker probing the OTP endpoint could create fresh accounts.
  const { error: otpErr } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });

  if (otpErr) {
    return { ok: false, error: "Couldn't send the verification code. Try again or email support." };
  }

  return { ok: true };
}
