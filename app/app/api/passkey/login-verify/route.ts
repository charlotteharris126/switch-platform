// POST /api/passkey/login-verify
//
// Second half of the WebAuthn authentication ceremony. Verifies the
// browser's response against the challenge we issued, updates the
// passkey's counter (replay protection), records last_login_at, and
// mints a Supabase session.

import { NextResponse, type NextRequest } from "next/server";
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient as createSsrClient } from "@/lib/supabase/server";
import { getWebAuthnConfig } from "@/lib/webauthn/config";
import { readChallengeCookie, clearChallengeCookie } from "@/lib/webauthn/challenge-cookie";

export const runtime = "nodejs";

interface PasskeyRow {
  id: number;
  provider_user_id: number;
  credential_id: string;
  public_key: string;          // hex-encoded ('\xDEADBEEF') from Postgres BYTEA
  counter: string;             // bigint comes back as string
  device_type: "singleDevice" | "multiDevice" | null;
}

interface ProviderUserRow {
  id: number;
  contact_email: string;
  auth_user_id: string | null;
  status: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { response?: AuthenticationResponseJSON } | null;
  const assertion = body?.response;
  if (!assertion) return NextResponse.json({ ok: false, error: "response_required" }, { status: 400 });

  const cookie = await readChallengeCookie();
  if (!cookie || cookie.kind !== "authenticate") {
    return NextResponse.json({ ok: false, error: "challenge_missing_or_expired" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Look up the passkey by credential_id (assertion.id is the credential id base64url)
  const { data: passkey } = await admin
    .schema("crm")
    .from("provider_passkeys")
    .select("id, provider_user_id, credential_id, public_key, counter, device_type")
    .eq("credential_id", assertion.id)
    .is("disabled_at", null)
    .maybeSingle<PasskeyRow>();

  if (!passkey) return NextResponse.json({ ok: false, error: "passkey_not_found" }, { status: 404 });

  const { data: user } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, contact_email, auth_user_id, status")
    .eq("id", passkey.provider_user_id)
    .maybeSingle<ProviderUserRow>();

  if (!user) return NextResponse.json({ ok: false, error: "user_not_found" }, { status: 404 });
  if (user.status !== "active") {
    return NextResponse.json({ ok: false, error: `user_${user.status}` }, { status: 403 });
  }
  if (!user.auth_user_id) {
    return NextResponse.json({ ok: false, error: "user_not_provisioned" }, { status: 500 });
  }

  // Cookie carries email it was issued for; defence-in-depth check.
  if (cookie.email && cookie.email !== user.contact_email.toLowerCase()) {
    return NextResponse.json({ ok: false, error: "challenge_mismatch" }, { status: 400 });
  }

  // BYTEA from Postgres comes back as a hex-prefixed string '\x...'.
  // Convert to Uint8Array for SimpleWebAuthn.
  const publicKey = hexBytesToUint8(passkey.public_key);

  const config = getWebAuthnConfig();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: cookie.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      credential: {
        id: passkey.credential_id,
        publicKey,
        counter: Number(passkey.counter),
      },
      requireUserVerification: false,
    });
  } catch (err) {
    console.error("verifyAuthenticationResponse threw:", err);
    return NextResponse.json({ ok: false, error: "auth_verification_failed" }, { status: 400 });
  }

  if (!verification.verified || !verification.authenticationInfo) {
    return NextResponse.json({ ok: false, error: "auth_not_verified" }, { status: 400 });
  }

  // Update counter (replay protection) + last_used_at.
  const newCounter = verification.authenticationInfo.newCounter;
  await admin
    .schema("crm")
    .from("provider_passkeys")
    .update({
      counter: newCounter,
      last_used_at: new Date().toISOString(),
    })
    .eq("id", passkey.id);

  await admin
    .schema("crm")
    .from("provider_users")
    .update({ last_login_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", user.id);

  // Mint a Supabase session for this auth user
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: user.contact_email,
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
  return NextResponse.json({ ok: true, redirect: "/provider" });
}

function hexBytesToUint8(hex: string): Uint8Array<ArrayBuffer> {
  // Postgres BYTEA returns '\xDEADBEEF' format
  const cleaned = hex.startsWith("\\x") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) throw new Error("invalid hex bytea length");
  const buf = new ArrayBuffer(cleaned.length / 2);
  const out = new Uint8Array(buf);
  for (let i = 0; i < cleaned.length; i += 2) {
    out[i / 2] = parseInt(cleaned.substring(i, i + 2), 16);
  }
  return out;
}
