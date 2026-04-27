import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { createClient } from "@/lib/supabase/server";

// LinkedIn OAuth — initiate.
//
// Flow: admin clicks "Connect LinkedIn" on /social/settings → this route
// generates a CSRF state, stashes it in a signed cookie alongside the brand +
// channel, and redirects the browser to LinkedIn's authorisation URL. After
// the admin approves on LinkedIn, LinkedIn redirects to the callback route
// with `code` + `state` query params.
//
// Env vars required (set on Netlify):
//   LINKEDIN_CLIENT_ID
//   LINKEDIN_CLIENT_SECRET (used by callback only; not here)
//   LINKEDIN_REDIRECT_URI = https://admin.switchleads.co.uk/api/auth/linkedin/callback
//   OAUTH_STATE_SECRET (any high-entropy string; signs the state cookie so a
//     malicious page can't forge a callback)

const ALLOWED_BRANDS = new Set(["switchleads", "switchable"]);
const ALLOWED_CHANNELS = new Set([
  "linkedin_personal",
  "linkedin_company",
]);

// Personal-profile scopes:
//   - openid + profile + email: OpenID Connect identity (member URN via /v2/userinfo)
//   - w_member_social:  WRITE — autonomous publishing to the profile
//   - r_member_social:  READ  — pulling reactions / comments / shares for analytics
// Both w_ and r_ are auto-granted by LinkedIn's "Share on LinkedIn" product.
// Company-page scopes (r_organization_social, w_organization_social) require
// Marketing Developer Platform approval and are added once that lands.
const PERSONAL_SCOPES = "openid profile email w_member_social r_member_social";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const brand = searchParams.get("brand") ?? "switchleads";
  const channel = searchParams.get("channel") ?? "linkedin_personal";

  if (!ALLOWED_BRANDS.has(brand)) {
    return NextResponse.json({ error: "invalid brand" }, { status: 400 });
  }
  if (!ALLOWED_CHANNELS.has(channel)) {
    return NextResponse.json({ error: "unsupported channel" }, { status: 400 });
  }

  // Caller must be an authenticated admin. Layered with the RLS gate inside
  // the upsert helper, but failing here gives a cleaner UX.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${origin}/login?next=${encodeURIComponent("/admin/social/settings")}`);
  }

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  const stateSecret = process.env.OAUTH_STATE_SECRET;
  if (!clientId || !redirectUri || !stateSecret) {
    return NextResponse.json(
      { error: "OAuth env not configured. Set LINKEDIN_CLIENT_ID, LINKEDIN_REDIRECT_URI, OAUTH_STATE_SECRET on Netlify." },
      { status: 500 },
    );
  }

  // Sign the state cookie so a malicious page can't forge a callback.
  const state = crypto.randomBytes(32).toString("hex");
  const payload = { state, brand, channel, ts: Date.now() };
  const payloadStr = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", stateSecret).update(payloadStr).digest("hex");
  const cookieValue = Buffer.from(JSON.stringify({ ...payload, sig })).toString("base64");

  // Pick scopes based on channel.
  const scopes = channel === "linkedin_personal" ? PERSONAL_SCOPES : PERSONAL_SCOPES;

  const authUrl = new URL("https://www.linkedin.com/oauth/v2/authorization");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", scopes);

  const res = NextResponse.redirect(authUrl.toString());
  res.cookies.set("linkedin_oauth_state", cookieValue, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600, // 10 minutes — enough for the OAuth dance, short enough to limit replay window
    path: "/",
  });
  return res;
}
