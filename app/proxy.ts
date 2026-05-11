import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";
import { isAdmin } from "@/lib/auth/allowlist";

const PROVIDER_HOSTS = ["app.switchleads.co.uk", "app.localhost", "app.localhost:3000"];

const SHARED_AUTH_PATHS = [
  "/login",
  "/verify-mfa",
  "/enrol-mfa",
  "/reset-password",
  "/api/auth/callback",
  // Third-party OAuth callbacks (channel posting tokens — Session G.2+).
  // The redirect URI registered with LinkedIn / Meta / TikTok is the bare
  // /api/auth/<provider>/callback path on admin.switchleads.co.uk, so the
  // proxy must NOT prepend /admin/. The connect routes are listed too
  // because they redirect to the third-party authorise URL and need no
  // surface rewrite.
  "/api/auth/linkedin/connect",
  "/api/auth/linkedin/callback",
  "/api/auth/meta/connect",
  "/api/auth/meta/callback",
  // Provider portal auth pages — all reachable before a Supabase session
  // exists. /provider-login → /provider-verify-code is the live two-step
  // sign-in flow (email + password + email 6-digit code), retired the
  // passkey flow. /provider-set-password is the invite-link landing.
  // The passkey-* paths stay listed during the deprecation window so
  // any in-flight invite links return the deprecation notice instead of
  // bouncing to /login.
  "/provider-login",
  "/provider-verify-code",
  "/provider-set-password",
  "/passkey-login",
  "/passkey-enrol",
  "/api/passkey/register-options",
  "/api/passkey/register-verify",
  "/api/passkey/login-options",
  "/api/passkey/login-verify",
  // Public help pages. Reachable from invite emails before the recipient
  // has a Supabase session, and shareable. Bypasses both the auth gate
  // and the admin/provider surface rewrite.
  "/help",
];

function detectSurface(hostname: string): "admin" | "provider" {
  if (PROVIDER_HOSTS.some((h) => hostname === h)) return "provider";
  return "admin";
}

function isSharedAuthPath(pathname: string): boolean {
  return SHARED_AUTH_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function copyCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie);
  }
  return to;
}

export async function proxy(request: NextRequest) {
  const hostname = request.headers.get("host") ?? "";
  const pathname = request.nextUrl.pathname;
  const surface = detectSurface(hostname);

  // Refresh Supabase session. `sessionResponse` carries any updated auth cookies.
  const { response: sessionResponse, user } = await updateSession(request);
  sessionResponse.headers.set("x-surface", surface);

  // Auth paths are shared. No rewrite, no auth gate.
  if (isSharedAuthPath(pathname)) return sessionResponse;

  // Not signed in → surface-aware login redirect. Admins land on the
  // password+TOTP login at /login; providers land on the password+email-
  // OTP login at /provider-login.
  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = surface === "provider" ? "/provider-login" : "/login";
    url.searchParams.set("next", pathname);
    return copyCookies(sessionResponse, NextResponse.redirect(url));
  }

  // Admin surface enforces email allowlist.
  if (surface === "admin" && !isAdmin(user.email)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("error", "not_authorised");
    return copyCookies(sessionResponse, NextResponse.redirect(url));
  }

  // Hostname rewrite. User-facing URLs stay clean ("/leads"), Next.js routes to "/admin/leads".
  const prefix = surface === "admin" ? "/admin" : "/provider";
  if (!pathname.startsWith(prefix)) {
    const url = request.nextUrl.clone();
    url.pathname = `${prefix}${pathname === "/" ? "" : pathname}`;
    return copyCookies(sessionResponse, NextResponse.rewrite(url));
  }

  return sessionResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
