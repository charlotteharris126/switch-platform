"use server";

// Server Action — step 2 of provider sign-in. Verifies the 6-digit email
// OTP and mints the session.
//
// Pairs with /provider-login/actions.ts (step 1: validate password +
// send OTP). The two-step flow gives us genuine 2FA on a fresh sign-in
// — neither factor alone establishes the session.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

type Result = { ok: true } | { ok: false; error: string };

export async function providerLoginVerifyAction(args: {
  email: string;
  code: string;
}): Promise<Result> {
  const email = typeof args.email === "string" ? args.email.trim().toLowerCase() : "";
  const code = typeof args.code === "string" ? args.code.trim() : "";

  if (!email || !/^\d{6,8}$/.test(code)) {
    return { ok: false, error: "Enter the sign-in code from your email." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token: code,
    type: "email",
  });

  if (error || !data?.user || !data?.session) {
    return { ok: false, error: "That code doesn't match (or it expired). Try again, or start over." };
  }

  // Confirm the user is still an active provider_users row. Step 1
  // already checked this but a paranoid recheck protects against the
  // edge case where the row was suspended between step 1 and step 2.
  const admin = createAdminClient();
  const { data: pu } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, status")
    .eq("auth_user_id", data.user.id)
    .maybeSingle<{ id: number; status: string }>();

  if (!pu || pu.status !== "active") {
    await supabase.auth.signOut();
    return { ok: false, error: "This account isn't active. Email support@switchleads.co.uk." };
  }

  // Best-effort: stamp last_login_at so the admin team listing shows
  // when each provider user last actually signed in.
  await admin
    .schema("crm")
    .from("provider_users")
    .update({ last_login_at: new Date().toISOString() })
    .eq("id", pu.id);

  return { ok: true };
}
