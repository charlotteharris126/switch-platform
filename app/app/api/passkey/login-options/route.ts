// POST /api/passkey/login-options
//
// First half of the WebAuthn authentication ceremony. The browser POSTs an
// email, gets back challenge options + the list of credential IDs allowed
// for that account, then runs `navigator.credentials.get()`, then posts
// the result to /api/passkey/login-verify.
//
// Security note on email enumeration: even when no provider_users row
// exists for the email, we return a fully-formed options object with an
// empty allowCredentials list. Browsers will then either show "no passkeys
// available" or silently fail; either way the response shape is identical
// to a real account, so an attacker cannot distinguish enrolled-emails
// from non-enrolled ones via timing or response shape.

import { NextResponse, type NextRequest } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWebAuthnConfig } from "@/lib/webauthn/config";
import { setChallengeCookie } from "@/lib/webauthn/challenge-cookie";

export const runtime = "nodejs";

interface ProviderUserRow {
  id: number;
  status: string;
}

interface PasskeyRow {
  credential_id: string;
  transports: string[] | null;
}

type AuthenticatorTransportFuture = "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { email?: string } | null;
  const email = body?.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ ok: false, error: "email_required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const config = getWebAuthnConfig();

  // Look up active provider_users by email
  const { data: users } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, status")
    .eq("contact_email", email)
    .eq("status", "active");

  const userRows = (users ?? []) as ProviderUserRow[];

  // Pull active passkeys for those users (could be more than one row per
  // person if they're somehow mapped to multiple providers, though v1 is
  // one provider per auth user).
  let passkeys: PasskeyRow[] = [];
  if (userRows.length > 0) {
    const { data } = await admin
      .schema("crm")
      .from("provider_passkeys")
      .select("credential_id, transports")
      .in("provider_user_id", userRows.map((u) => u.id))
      .is("disabled_at", null);
    passkeys = (data ?? []) as PasskeyRow[];
  }

  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    allowCredentials: passkeys.map((p) => ({
      id: p.credential_id,
      transports: (p.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
    })),
    userVerification: "preferred",
  });

  await setChallengeCookie({ challenge: options.challenge, kind: "authenticate", email });

  return NextResponse.json({ ok: true, options });
}
