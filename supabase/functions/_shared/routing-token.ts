// Shared HMAC token helpers for the owner confirm-link flow.
//
// Used by:
//   - netlify-lead-router  — signs confirm links, embeds them in the owner notification email
//   - routing-confirm      — verifies the token on click
//
// Design:
//   - Token format:  <base64url(payload_json)>.<base64url(hmac_sha256_signature)>
//   - Signed with:   ROUTING_CONFIRM_SHARED_SECRET (Edge Function secret, rotated annually)
//   - Validity:      14 days from issue (matches the 14-day auto-presume-enrolled window)
//   - Integrity:     constant-time signature compare
//   - Idempotency:   enforced by routing-confirm checking leads.submissions.primary_routed_to
//                    (not in the token itself — tokens are stateless)
//
// Why HMAC + base64url (not JWT): no third-party dep, no algorithm negotiation surface,
// no "alg: none" class of bugs. Signing and verification are ~30 lines each.

export interface RoutingTokenPayload {
  submission_id: number;
  provider_id: string;
  issued_at: number;   // unix seconds
  expires_at: number;  // unix seconds
}

const TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days

export async function signRoutingToken(
  submissionId: number,
  providerId: string,
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: RoutingTokenPayload = {
    submission_id: submissionId,
    provider_id: providerId,
    issued_at: now,
    expires_at: now + TOKEN_TTL_SECONDS,
  };
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sigB64 = await hmacSha256B64url(payloadB64, secret);
  return `${payloadB64}.${sigB64}`;
}

export interface VerifyResult {
  ok: boolean;
  payload?: RoutingTokenPayload;
  error?: "malformed" | "bad_signature" | "expired";
}

export async function verifyRoutingToken(
  token: string,
  secret: string,
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, error: "malformed" };
  const [payloadB64, sigB64] = parts;

  const expectedSigB64 = await hmacSha256B64url(payloadB64, secret);
  if (!constantTimeEqual(sigB64, expectedSigB64)) {
    return { ok: false, error: "bad_signature" };
  }

  let payload: RoutingTokenPayload;
  try {
    const json = new TextDecoder().decode(b64urlDecode(payloadB64));
    payload = JSON.parse(json) as RoutingTokenPayload;
  } catch {
    return { ok: false, error: "malformed" };
  }

  if (
    typeof payload.submission_id !== "number" ||
    typeof payload.provider_id !== "string" ||
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

// ---- HMAC + base64url helpers ----

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
