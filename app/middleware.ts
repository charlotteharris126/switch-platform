// Edge middleware. Runs before the request reaches Server Components.
//
// Responsibilities:
//   - Refresh Supabase session cookies on every request (lib/supabase/proxy.ts)
//   - Gate /provider/* routes: unauthenticated visitors redirect to
//     /provider/login. Public sub-routes (/provider/login, /provider/enrol/*)
//     and the passkey API endpoints are exempt.
//
// Admin gating still lives in app/admin/layout.tsx — middleware here does
// not duplicate it. Same separation of concerns the rest of the app follows.

import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

const PROVIDER_PUBLIC_PATHS = [
  "/provider/login",
  "/provider/auth/callback",
];

const PROVIDER_PUBLIC_PREFIXES = [
  "/provider/enrol/",
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Refresh the session on every request that touches auth-aware routes.
  // updateSession reads cookies, calls supabase.auth.getUser(), updates the
  // response with refreshed cookies if needed.
  const { response, user } = await updateSession(request);

  // Provider portal gate.
  if (pathname.startsWith("/provider")) {
    const isPublicPath = PROVIDER_PUBLIC_PATHS.includes(pathname);
    const isPublicPrefix = PROVIDER_PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));

    if (isPublicPath || isPublicPrefix) {
      return response;
    }

    if (!user) {
      const loginUrl = new URL("/provider/login", request.url);
      return NextResponse.redirect(loginUrl);
    }
  }

  return response;
}

// Matcher: every path EXCEPT static assets / favicon / Next internals.
// Keeps middleware off the hot path for the bulk of asset traffic.
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
