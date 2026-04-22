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

  // Not signed in → /login.
  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
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
