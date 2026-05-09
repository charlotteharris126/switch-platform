// Browser/Server-shared invite token verification (Web Crypto), mirroring
// the Edge Function's _shared/invite-token.ts. Same algorithm, same
// payload shape — both sign with PROVIDER_INVITE_SECRET.
//
// Used by:
//   /api/passkey/register-options   — verify token before generating options
//   /api/passkey/register-verify    — verify token before consuming the
//                                      stored hash on the provider_users row

export interface InviteTokenPayload {
  provider_user_id: number;
  issued_at: number;
  expires_at: number;
}

export interface VerifyInviteResult {
  ok: boolean;
  payload?: InviteTokenPayload;
  error?: "malformed" | "bad_signature" | "expired";
}

export async function verifyInviteToken(token: string, secret: string): Promise<VerifyInviteResult> {
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

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256B64url(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64urlEncode(new Uint8Array(sig));
}

function b64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice(0, (4 - (s.length % 4)) % 4);
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
