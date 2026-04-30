// Shared HMAC token helpers for AI-suggestion approval links (Channel B of
// the sheet→DB mirror — see platform/docs/sheet-mirror-scoping.md).
//
// Used by:
//   - sheet-edit-mirror        — signs resolver tokens, embeds them in the
//                                 owner approval email
//   - pending-update-confirm   — verifies the token on Approve / Reject /
//                                 Override click
//
// Design (mirrors _shared/routing-token.ts):
//   - Token format:  <base64url(payload_json)>.<base64url(hmac_sha256_signature)>
//   - Signed with:   PENDING_UPDATE_SECRET (Edge Function secret, rotated annually)
//   - Validity:      7 days from issue (matches resolver_token_expires_at on
//                    crm.pending_updates rows; longer windows risk stale
//                    suggestions being approved against changed enrolment state)
//   - Integrity:     constant-time signature compare
//   - Idempotency:   enforced by pending-update-confirm checking
//                    crm.pending_updates.status (not in the token itself)

export interface PendingUpdateTokenPayload {
  pending_update_id: number;
  action: "approve" | "reject" | "override";
  issued_at: number;   // unix seconds
  expires_at: number;  // unix seconds
}

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export async function signPendingUpdateToken(
  pendingUpdateId: number,
  action: "approve" | "reject" | "override",
  secret: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: PendingUpdateTokenPayload = {
    pending_update_id: pendingUpdateId,
    action,
    issued_at: now,
    expires_at: now + TOKEN_TTL_SECONDS,
  };
  const payloadB64 = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sigB64 = await hmacSha256B64url(payloadB64, secret);
  return `${payloadB64}.${sigB64}`;
}

export interface VerifyPendingUpdateResult {
  ok: boolean;
  payload?: PendingUpdateTokenPayload;
  error?: "malformed" | "bad_signature" | "expired";
}

export async function verifyPendingUpdateToken(
  token: string,
  secret: string,
): Promise<VerifyPendingUpdateResult> {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, error: "malformed" };
  const [payloadB64, sigB64] = parts;

  const expectedSigB64 = await hmacSha256B64url(payloadB64, secret);
  if (!constantTimeEqual(sigB64, expectedSigB64)) {
    return { ok: false, error: "bad_signature" };
  }

  let payload: PendingUpdateTokenPayload;
  try {
    const json = new TextDecoder().decode(b64urlDecode(payloadB64));
    payload = JSON.parse(json) as PendingUpdateTokenPayload;
  } catch {
    return { ok: false, error: "malformed" };
  }

  if (
    typeof payload.pending_update_id !== "number" ||
    !["approve", "reject", "override"].includes(payload.action) ||
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

// ---- HMAC + base64url helpers (duplicated from routing-token.ts; kept
// inline rather than refactored to a shared module so each token type's
// dependencies stay obvious at the import site) ----

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
