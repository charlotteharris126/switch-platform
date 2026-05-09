// POST /api/passkey/register-options
//
// First half of the WebAuthn registration ceremony. The browser will call
// this with the invite token, get back challenge options, then call
// `navigator.credentials.create()` with those options, then post the
// result to /api/passkey/register-verify.

import { NextResponse, type NextRequest } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWebAuthnConfig } from "@/lib/webauthn/config";
import { setChallengeCookie } from "@/lib/webauthn/challenge-cookie";
import { verifyInviteToken, sha256Hex } from "@/lib/webauthn/invite-token";

export const runtime = "nodejs";

interface ProviderUserRow {
  id: number;
  contact_email: string;
  display_name: string | null;
  status: string;
  enrolled_at: string | null;
  current_invite_token_hash: string | null;
  current_invite_expires_at: string | null;
}

interface PasskeyRow {
  credential_id: string;
  transports: string[] | null;
}

export async function POST(request: NextRequest) {
  const inviteSecret = process.env.PROVIDER_INVITE_SECRET;
  if (!inviteSecret) {
    return NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as { token?: string } | null;
  const token = body?.token?.trim();
  if (!token) {
    return NextResponse.json({ ok: false, error: "token_required" }, { status: 400 });
  }

  const verify = await verifyInviteToken(token, inviteSecret);
  if (!verify.ok) {
    return NextResponse.json({ ok: false, error: `token_${verify.error}` }, { status: 400 });
  }
  const providerUserId = verify.payload!.provider_user_id;

  const admin = createAdminClient();

  // Look up the row + verify hash matches + expiry hasn't passed (defence in
  // depth — token's own exp already passed verifyInviteToken, but the row's
  // hash check is the single-use enforcement).
  const { data: row } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, contact_email, display_name, status, enrolled_at, current_invite_token_hash, current_invite_expires_at")
    .eq("id", providerUserId)
    .maybeSingle<ProviderUserRow>();

  if (!row) {
    return NextResponse.json({ ok: false, error: "user_not_found" }, { status: 404 });
  }
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

  // Existing passkeys (so the browser refuses to re-register the same one).
  const { data: existingPasskeys } = await admin
    .schema("crm")
    .from("provider_passkeys")
    .select("credential_id, transports")
    .eq("provider_user_id", providerUserId)
    .is("disabled_at", null);

  const config = getWebAuthnConfig();
  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: row.contact_email,
    userDisplayName: row.display_name ?? row.contact_email,
    userID: new TextEncoder().encode(`provider_user_${providerUserId}`),
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    excludeCredentials: ((existingPasskeys ?? []) as PasskeyRow[]).map((p) => ({
      id: p.credential_id,
      transports: (p.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
  });

  await setChallengeCookie({
    challenge: options.challenge,
    kind: "register",
    provider_user_id: providerUserId,
  });

  return NextResponse.json({ ok: true, options });
}

// Re-export the type from SimpleWebAuthn so we can cast transports without
// a deeper import.
type AuthenticatorTransportFuture = "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";
