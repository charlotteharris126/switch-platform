// Shared HMAC token helpers for provider portal enrolment-only invite links.
//
// Used by:
//   - provider-invite-link    — signs the enrolment-only token, embeds it
//                                in the Brevo invite email link
//   - /api/passkey/register-options + register-verify — verify the token
//                                on the provider's first arrival, then
//                                consume it (clear the row's hash) once
//                                passkey enrolment succeeds.
//
// Design (mirrors _shared/pending-update-token.ts and routing-token.ts):
//   - Token format:  <base64url(payload_json)>.<base64url(hmac_sha256_signature)>
//   - Signed with:   PROVIDER_INVITE_SECRET (Edge Function secret, rotated annually)
//   - Validity:      15 minutes from issue. Shorter than the 7-day approval
//                    tokens because this is an auth-credential-issuance
//                    ceremony — short windows reduce phishing/forwarding risk.
//   - Integrity:     constant-time signature compare
//   - Single-use:    enforced by checking the row's current_invite_token_hash
//                    column at verify time, NOT by the token itself. Verify
//                    endpoint clears the hash on success so a second attempt
//                    finds no live invite.
//   - Scope:         token only authorises the passkey-registration path.
//                    It cannot mint a session. The verify endpoint will not
//                    return a session unless a passkey ceremony also
//                    succeeds — the token alone is useless.
//
// Token payload deliberately carries nothing sensitive: just the
// provider_users.id (so we know which row to register against), an issued_at,
// and an expires_at. The provider_id and email are not in the payload —
// they live on the row keyed by provider_users.id and are read server-side
// at verify time. Keeps the URL short and side-channel-free.

export interface InviteTokenPayload {
  provider_user_id: number;
  issued_at: number;   // unix seconds
  expires_at: number;  // unix seconds
}

const TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes

export async function signInviteToken(
  providerUserId: number,
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: InviteTokenPayload = {
    provider_user_id: providerUserId,
    issued_at: now,
    expires_at: now + TOKEN_TTL_SECONDS,
  };
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sigB64 = await hmacSha256B64url(payloadB64, secret);
  return `${payloadB64}.${sigB64}`;
}

export interface VerifyInviteResult {
  ok: boolean;
  payload?: InviteTokenPayload;
  error?: "malformed" | "bad_signature" | "expired";
}

export async function verifyInviteToken(
  token: string,
  secret: string,
): Promise<VerifyInviteResult> {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, error: "malformed" };
  const [payloadB64, sigB64] = parts;

  const expectedSigB64 = await hmacSha256B64url(payloadB64, secret);
  if (!constantTimeEqual(sigB64, expectedSigB64)) {
    return { ok: false, error: "bad_signature" };
  }

  let payload: InviteTokenPayload;
  try {
    const json = new TextDecoder().decode(b64urlDecode(payloadB64));
    payload = JSON.parse(json) as InviteTokenPayload;
  } catch {
    return { ok: false, error: "malformed" };
  }

  if (
    typeof payload.provider_user_id !== "number" ||
    typeof payload.issued_at !== "number" ||
    typeof payload.expires_at !== "number"
  ) {
    return { ok: false, error: "malformed" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now > payload.expires_at) {
    return { ok: false, error: "expired" };
  }

  return { ok: true, payload };
}

// sha256 of the full token string. Stored on the provider_users row at
// invite-issue time. The verify endpoint compares the incoming token's
// sha256 against the stored value and rejects if they differ — that's the
// single-use enforcement (overwriting the row's hash kills a previous
// invite even if its HMAC is still valid).
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- HMAC + base64url helpers (duplicated from sibling token modules;
// kept inline rather than refactored to a deeper shared module so each
// token type's dependencies stay obvious at the import site) ----

async function hmacSha256B64url(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return b64urlEncode(new Uint8Array(sig));
}

function b64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice(0, (4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
