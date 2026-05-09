// WebAuthn challenge cookie helpers.
//
// Pattern (recommended by SimpleWebAuthn): store the challenge bytes in an
// httpOnly cookie between the options-call and verify-call. ~60 second
// lifetime per ceremony. No DB churn, no cleanup cron, no leakage between
// tabs.
//
// The cookie carries the JSON-serialised challenge (already a base64url
// string from generate*Options) plus a small `kind` field
// ('register' | 'authenticate') so a register-verify endpoint refuses an
// authenticate-flow challenge and vice versa.

import { cookies } from "next/headers";

export interface ChallengeCookie {
  challenge: string;
  kind: "register" | "authenticate";
  // Auxiliary fields per ceremony. kept loose; verify endpoints read what
  // they need.
  provider_user_id?: number;
  email?: string;
}

const COOKIE_NAME = "__sl_passkey_challenge";
const COOKIE_TTL_SECONDS = 90; // 90s — comfortably wider than any ceremony

export async function setChallengeCookie(payload: ChallengeCookie): Promise<void> {
  const store = await cookies();
  store.set({
    name: COOKIE_NAME,
    value: JSON.stringify(payload),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_TTL_SECONDS,
  });
}

export async function readChallengeCookie(): Promise<ChallengeCookie | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ChallengeCookie;
    if (parsed.kind !== "register" && parsed.kind !== "authenticate") return null;
    if (typeof parsed.challenge !== "string" || !parsed.challenge) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearChallengeCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
