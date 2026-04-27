import { NextResponse, type NextRequest } from "next/server";
import crypto from "node:crypto";
import { createClient } from "@/lib/supabase/server";

// LinkedIn OAuth — callback.
//
// LinkedIn redirects here after the admin approves on its consent screen.
// We:
//   1. Verify the CSRF state cookie matches the `state` query param.
//   2. Exchange the auth code for an access token via LinkedIn's token endpoint.
//   3. Fetch the authenticated user's URN via /v2/userinfo (OpenID Connect).
//   4. Call social.upsert_oauth_token() — it encrypts the token via Supabase
//      Vault and writes the metadata row in one transaction.
//   5. Redirect back to /admin/social/settings with status.

const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function redirectWithStatus(origin: string, params: Record<string, string>) {
  const url = new URL("/admin/social/settings", origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url.toString());
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const oauthError = searchParams.get("error");
  const oauthErrorDesc = searchParams.get("error_description");

  if (oauthError) {
    return redirectWithStatus(origin, {
      status: "error",
      error: oauthError,
      error_description: oauthErrorDesc ?? "",
    });
  }

  if (!code || !state) {
    return redirectWithStatus(origin, { status: "error", error: "missing_code_or_state" });
  }

  // Verify CSRF cookie
  const cookieValue = request.cookies.get("linkedin_oauth_state")?.value;
  if (!cookieValue) {
    return redirectWithStatus(origin, { status: "error", error: "missing_state_cookie" });
  }

  const stateSecret = process.env.OAUTH_STATE_SECRET;
  if (!stateSecret) {
    return redirectWithStatus(origin, { status: "error", error: "missing_state_secret_env" });
  }

  let parsed: { state: string; brand: string; channel: string; ts: number; sig: string };
  try {
    parsed = JSON.parse(Buffer.from(cookieValue, "base64").toString("utf8"));
  } catch {
    return redirectWithStatus(origin, { status: "error", error: "bad_cookie" });
  }

  const { sig: providedSig, ...rest } = parsed;
  const expectedSig = crypto
    .createHmac("sha256", stateSecret)
    .update(JSON.stringify(rest))
    .digest("hex");

  if (
    !providedSig ||
    !crypto.timingSafeEqual(Buffer.from(providedSig, "hex"), Buffer.from(expectedSig, "hex"))
  ) {
    return redirectWithStatus(origin, { status: "error", error: "bad_signature" });
  }
  if (rest.state !== state) {
    return redirectWithStatus(origin, { status: "error", error: "state_mismatch" });
  }
  if (Date.now() - rest.ts > STATE_MAX_AGE_MS) {
    return redirectWithStatus(origin, { status: "error", error: "state_expired" });
  }

  const { brand, channel } = rest;

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return redirectWithStatus(origin, { status: "error", error: "missing_oauth_env" });
  }

  // Exchange code for token
  const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    return redirectWithStatus(origin, {
      status: "error",
      error: "token_exchange_failed",
      detail: errText.slice(0, 200),
    });
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    scope?: string;
    token_type?: string;
  };

  // Fetch userinfo (OpenID Connect) to get the LinkedIn member id.
  // The /v2/userinfo endpoint returns: { sub, name, given_name, family_name, picture, email, ... }
  // `sub` is the LinkedIn member id; full URN is urn:li:person:{sub}.
  const userinfoRes = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userinfoRes.ok) {
    return redirectWithStatus(origin, { status: "error", error: "userinfo_failed" });
  }

  const userinfo = (await userinfoRes.json()) as { sub?: string; name?: string };
  if (!userinfo.sub) {
    return redirectWithStatus(origin, { status: "error", error: "userinfo_missing_sub" });
  }

  const externalAccountId =
    channel === "linkedin_personal" ? `urn:li:person:${userinfo.sub}` : userinfo.sub;

  // Get the authenticated admin user (for the authorised_by audit field)
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return redirectWithStatus(origin, { status: "error", error: "not_authenticated" });
  }

  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;

  // Call helper RPC (migration 0030). Atomic: encrypts via vault.create_secret
  // and upserts the metadata row + writes audit row in one transaction.
  const { error: rpcError } = await supabase.schema("social").rpc("upsert_oauth_token", {
    p_brand: brand,
    p_channel: channel,
    p_provider: "linkedin",
    p_external_account_id: externalAccountId,
    p_access_token: tokenData.access_token,
    p_refresh_token: tokenData.refresh_token ?? null,
    p_expires_at: expiresAt,
    p_scopes: tokenData.scope?.split(/\s+/).filter(Boolean) ?? null,
    p_authorised_by: user.id,
  });

  if (rpcError) {
    return redirectWithStatus(origin, {
      status: "error",
      error: "upsert_failed",
      detail: rpcError.message.slice(0, 200),
    });
  }

  const res = redirectWithStatus(origin, {
    status: "connected",
    brand,
    channel,
    account: userinfo.name ?? "",
  });
  res.cookies.delete("linkedin_oauth_state");
  return res;
}
