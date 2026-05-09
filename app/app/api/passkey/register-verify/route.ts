// POST /api/passkey/register-verify
//
// Second half of the WebAuthn registration ceremony. Verifies the
// browser's response against the challenge we issued, registers the
// passkey, creates the Supabase auth.users row (FIRST time only), and
// mints a session.
//
// On success, the response sets Supabase session cookies via the SSR
// client and returns { ok: true, redirect: '/provider' }.

import { NextResponse, type NextRequest } from "next/server";
import { verifyRegistrationResponse, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient as createSsrClient } from "@/lib/supabase/server";
import { getWebAuthnConfig } from "@/lib/webauthn/config";
import { readChallengeCookie, clearChallengeCookie } from "@/lib/webauthn/challenge-cookie";
import { verifyInviteToken, sha256Hex } from "@/lib/webauthn/invite-token";

export const runtime = "nodejs";

interface ProviderUserRow {
  id: number;
  provider_id: string;
  contact_email: string;
  display_name: string | null;
  auth_user_id: string | null;
  status: string;
  current_invite_token_hash: string | null;
  current_invite_expires_at: string | null;
}

export async function POST(request: NextRequest) {
  const inviteSecret = process.env.PROVIDER_INVITE_SECRET;
  if (!inviteSecret) {
    return NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as { token?: string; response?: RegistrationResponseJSON } | null;
  const token = body?.token?.trim();
  const attestation = body?.response;
  if (!token) return NextResponse.json({ ok: false, error: "token_required" }, { status: 400 });
  if (!attestation) return NextResponse.json({ ok: false, error: "response_required" }, { status: 400 });

  // Verify token + cookie state
  const tokenVerify = await verifyInviteToken(token, inviteSecret);
  if (!tokenVerify.ok) return NextResponse.json({ ok: false, error: `token_${tokenVerify.error}` }, { status: 400 });

  const cookie = await readChallengeCookie();
  if (!cookie || cookie.kind !== "register") {
    return NextResponse.json({ ok: false, error: "challenge_missing_or_expired" }, { status: 400 });
  }
  if (cookie.provider_user_id !== tokenVerify.payload!.provider_user_id) {
    return NextResponse.json({ ok: false, error: "challenge_mismatch" }, { status: 400 });
  }

  const providerUserId = tokenVerify.payload!.provider_user_id;
  const admin = createAdminClient();

  // Re-fetch row + re-check hash (single-use enforcement)
  const { data: row } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, provider_id, contact_email, display_name, auth_user_id, status, current_invite_token_hash, current_invite_expires_at")
    .eq("id", providerUserId)
    .maybeSingle<ProviderUserRow>();

  if (!row) return NextResponse.json({ ok: false, error: "user_not_found" }, { status: 404 });
  if (row.status === "revoked" || row.status === "suspended") {
    return NextResponse.json({ ok: false, error: `user_${row.status}` }, { status: 403 });
  }
  const tokenHash = await sha256Hex(token);
  if (row.current_invite_token_hash !== tokenHash) {
    return NextResponse.json({ ok: false, error: "invite_already_used" }, { status: 400 });
  }
  if (!row.current_invite_expires_at || new Date(row.current_invite_expires_at) < new Date()) {
    return NextResponse.json({ ok: false, error: "invite_expired" }, { status: 400 });
  }

  // Verify the WebAuthn registration response
  const config = getWebAuthnConfig();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: attestation,
      expectedChallenge: cookie.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      requireUserVerification: false,
    });
  } catch (err) {
    console.error("verifyRegistrationResponse threw:", err);
    return NextResponse.json({ ok: false, error: "registration_verification_failed" }, { status: 400 });
  }

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json({ ok: false, error: "registration_not_verified" }, { status: 400 });
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  // Create the auth.users row IFF we don't have one yet for this provider_user.
  // Random unguessable password — Supabase requires one for createUser, but we
  // never expose any flow that signs in with it. Provider only signs in via
  // /api/passkey/login-verify which mints sessions out-of-band.
  let authUserId: string | null = row.auth_user_id;
  if (!authUserId) {
    const randomPassword = b64urlOfRandom(48);
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: row.contact_email,
      password: randomPassword,
      email_confirm: true,
      user_metadata: {
        passkey_only: true,
        provider_user_id: providerUserId,
        provider_id: row.provider_id,
      },
    });
    if (createErr || !created.user) {
      console.error("auth.admin.createUser failed:", createErr);
      return NextResponse.json({ ok: false, error: "auth_user_create_failed" }, { status: 500 });
    }
    authUserId = created.user.id;
  }

  // Insert the passkey row
  const { error: insertErr } = await admin
    .schema("crm")
    .from("provider_passkeys")
    .insert({
      provider_user_id: providerUserId,
      credential_id: credential.id,
      public_key: bytesToHex(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? null,
      device_type: credentialDeviceType,
      backed_up: credentialBackedUp,
    });
  if (insertErr) {
    console.error("provider_passkeys insert failed:", insertErr);
    return NextResponse.json({ ok: false, error: "passkey_insert_failed" }, { status: 500 });
  }

  // Update provider_users: status='active', enrolled_at, link auth_user_id, clear invite hash
  const { error: updateErr } = await admin
    .schema("crm")
    .from("provider_users")
    .update({
      auth_user_id: authUserId,
      status: "active",
      enrolled_at: new Date().toISOString(),
      current_invite_token_hash: null,
      current_invite_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", providerUserId);
  if (updateErr) {
    console.error("provider_users update failed:", updateErr);
    return NextResponse.json({ ok: false, error: "user_update_failed" }, { status: 500 });
  }

  // Mint a session via admin.generateLink(magiclink) + verifyOtp(token_hash).
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: row.contact_email,
  });
  if (linkErr || !linkData?.properties?.hashed_token) {
    console.error("generateLink failed:", linkErr);
    return NextResponse.json({ ok: false, error: "session_mint_failed" }, { status: 500 });
  }

  const ssr = await createSsrClient();
  const { error: otpErr } = await ssr.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: "magiclink",
  });
  if (otpErr) {
    console.error("verifyOtp (session-mint) failed:", otpErr);
    return NextResponse.json({ ok: false, error: "session_set_failed" }, { status: 500 });
  }

  await clearChallengeCookie();
  // Redirect to the provider home. On app.switchleads.co.uk this is `/` (the
  // proxy rewrites to /provider). On admin/local without a hostname rewrite,
  // /provider works directly.
  return NextResponse.json({ ok: true, redirect: "/" });
}

function b64urlOfRandom(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let str = "";
  for (const b of buf) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return "\\x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
