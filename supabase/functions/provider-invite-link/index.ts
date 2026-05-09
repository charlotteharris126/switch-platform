// Edge Function: provider-invite-link
//
// Admin-only endpoint that issues a one-time enrolment-only invite link to
// a provider user. The link allows the recipient to register a WebAuthn
// passkey at /provider/enrol/[token] — and ONLY that. The token cannot mint
// a session, cannot be replayed (single-use enforced by sha256 hash on the
// crm.provider_users row), and expires 15 minutes from issue.
//
// This function does NOT create a Supabase auth.users row. By design, the
// auth identity is created only at /api/passkey/register-verify after a
// successful passkey ceremony. This closes the "dormant auth user is
// hijackable via OTP/magic-link before passkey registration" edge case.
// See migration 0103 for the rationale.
//
// Auth: x-audit-key header against AUDIT_SHARED_SECRET. Admin-only caller.
//       (Intended caller: the /admin/providers/[id] "Send portal invite"
//       button, which is itself admin-RLS-gated. Direct curl access also
//       supported for testing.)
//
// Method: POST
// Body:   { provider_id: string, email: string, role?: 'provider_admin'|'provider_user', display_name?: string }
// Returns: 200 { ok: true, provider_user_id, expires_at, invite_url? } or
//         4xx { ok: false, error }
//
// Note on demo gating: during the portal MVP build phase, this function
// REJECTS calls for any provider whose is_demo=false unless the caller
// also sends x-allow-real=true. This is a defensive fence so we can't
// accidentally invite a real EMS / WYK / CD user before Clara's three
// gating conditions (RLS proof + /ultrareview + pen-test gate) are met.
// Remove the fence in a follow-up session once the gates clear.
//
// Secrets expected in env:
//   SUPABASE_DB_URL                     (auto-injected)
//   AUDIT_SHARED_SECRET                 (admin-caller auth)
//   PROVIDER_INVITE_SECRET              (HMAC key for invite tokens; new — needs setting)
//   BREVO_API_KEY                       (read by sendBrevoEmail)
//   BREVO_SENDER_EMAIL                  (SwitchLeads sender)
//   PORTAL_BASE_URL                     (e.g. https://app.switchleads.co.uk;
//                                        defaults to http://localhost:3000 for dev)

import postgres from "npm:postgres@3";
import { signInviteToken, sha256Hex } from "../_shared/invite-token.ts";
import { sendBrevoEmail } from "../_shared/brevo.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL is not set");
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

const PORTAL_BASE_URL = Deno.env.get("PORTAL_BASE_URL") ?? "http://localhost:3000";

interface ProviderRow {
  provider_id: string;
  company_name: string;
  is_demo: boolean;
  portal_enabled: boolean;
}

interface InviteRequest {
  provider_id?: string;
  email?: string;
  role?: string;
  display_name?: string;
}

interface ProviderUserRow {
  id: number;
  status: string;
  enrolled_at: string | null;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return jsonError("method_not_allowed", "POST only", 405);
  }

  // Admin auth — read AUDIT_SHARED_SECRET from Vault via the allowlisted
  // get_shared_secret helper (same pattern as netlify-leads-reconcile et al.,
  // per migration 0019 + secrets-rotation.md). Vault is single source of
  // truth for this secret; Edge Function env was deliberately unset.
  const audit = req.headers.get("x-audit-key");
  let expected: string | null = null;
  try {
    const [row] = await sql<{ secret: string | null }[]>`
      SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
    `;
    expected = row?.secret ?? null;
  } catch (err) {
    console.error("get_shared_secret(AUDIT_SHARED_SECRET) failed:", err);
    return jsonError("server_misconfigured", "shared secret read failed", 500);
  }
  if (!expected) {
    return jsonError("server_misconfigured", "shared secret missing in vault", 500);
  }
  if (!audit || audit !== expected) {
    return jsonError("unauthorized", "x-audit-key required", 401);
  }

  // Parse body
  let body: InviteRequest;
  try {
    body = await req.json() as InviteRequest;
  } catch {
    return jsonError("bad_request", "invalid JSON body", 400);
  }

  const provider_id = (body.provider_id ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const role = (body.role ?? "provider_admin").trim();
  const display_name = (body.display_name ?? "").trim() || null;

  if (!provider_id) return jsonError("bad_request", "provider_id required", 400);
  if (!email || !email.includes("@")) return jsonError("bad_request", "valid email required", 400);
  if (role !== "provider_admin" && role !== "provider_user") {
    return jsonError("bad_request", "role must be provider_admin or provider_user", 400);
  }

  // Look up provider
  const [provider] = await sql<ProviderRow[]>`
    SELECT provider_id, company_name, is_demo, portal_enabled
      FROM crm.providers
     WHERE provider_id = ${provider_id}
       AND archived_at IS NULL
  `;
  if (!provider) {
    return jsonError("provider_not_found", `no active provider with id ${provider_id}`, 404);
  }

  // Demo-only fence (lift after Clara's three gating conditions clear)
  const allowReal = req.headers.get("x-allow-real") === "true";
  if (!provider.is_demo && !allowReal) {
    return jsonError(
      "real_provider_locked",
      "real-provider invites are gated behind x-allow-real=true until RLS proof + /ultrareview + pen-test gate clear",
      403,
    );
  }

  if (!provider.portal_enabled) {
    return jsonError(
      "portal_disabled",
      `portal_enabled=false for ${provider_id}; flip the flag in crm.providers first`,
      403,
    );
  }

  // Sign the invite token. We need the provider_user_id, so first
  // upsert the row (without the token), then sign + UPDATE the hash.
  const inviteSecret = Deno.env.get("PROVIDER_INVITE_SECRET");
  if (!inviteSecret) {
    console.error("PROVIDER_INVITE_SECRET not set");
    return jsonError("server_misconfigured", "invite secret missing", 500);
  }

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  // UPSERT crm.provider_users by (provider_id, contact_email).
  // No native composite unique key exists, so we do a defensive lookup
  // first and INSERT/UPDATE accordingly.
  const [existing] = await sql<ProviderUserRow[]>`
    SELECT id, status, enrolled_at
      FROM crm.provider_users
     WHERE provider_id = ${provider_id}
       AND lower(contact_email) = ${email}
     LIMIT 1
  `;

  let providerUserId: number;

  if (existing) {
    if (existing.status === "revoked") {
      return jsonError("user_revoked", "this email is revoked for this provider; admin must un-revoke first", 409);
    }
    if (existing.status === "suspended") {
      return jsonError("user_suspended", "this email is suspended for this provider; admin must un-suspend first", 409);
    }
    providerUserId = existing.id;
    // Re-issue: replace invite hash + expiry, leave status as-is. If they
    // were 'active' (already enrolled before), this issues a NEW invite that
    // — when consumed — registers an additional passkey for the same user.
    // Useful for "I bought a new laptop" flows.
  } else {
    const [inserted] = await sql<{ id: number }[]>`
      INSERT INTO crm.provider_users (
        provider_id, contact_email, display_name, role, status, invited_at
      ) VALUES (
        ${provider_id}, ${email}, ${display_name}, ${role}, 'invited', now()
      )
      RETURNING id
    `;
    providerUserId = inserted.id;
  }

  const token = await signInviteToken(providerUserId, inviteSecret);
  const tokenHash = await sha256Hex(token);

  await sql`
    UPDATE crm.provider_users
       SET current_invite_token_hash  = ${tokenHash},
           current_invite_expires_at  = ${expiresAt.toISOString()},
           updated_at                 = now()
     WHERE id = ${providerUserId}
  `;

  // Build invite URL — /passkey-enrol/<token> is a shared auth path on the
  // Next.js proxy (no rewrite, no auth gate). Reachable directly from any
  // hostname (admin.* and app.*).
  const inviteUrl = `${PORTAL_BASE_URL}/passkey-enrol/${token}`;

  // Send the invite email (SwitchLeads brand)
  const subject = `Set up your ${provider.company_name} portal access`;
  const htmlContent = renderInviteEmail({
    company: provider.company_name,
    inviteUrl,
    expiresAtIso: expiresAt.toISOString(),
  });

  const emailResult = await sendBrevoEmail({
    to: [{ email, name: display_name ?? undefined }],
    subject,
    htmlContent,
    brand: "switchleads",
    tags: ["provider-portal-invite"],
  });

  if (!emailResult.ok) {
    // We've already issued the token. Returning 502 with the URL still set
    // means the admin can copy/paste the link manually. Token isn't lost.
    console.error("Brevo invite send failed:", emailResult.error);
    return new Response(
      JSON.stringify({
        ok: false,
        error: "email_send_failed",
        detail: emailResult.error,
        provider_user_id: providerUserId,
        expires_at: expiresAt.toISOString(),
        invite_url: inviteUrl, // surfaced so admin can DM/SMS the link
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      provider_user_id: providerUserId,
      expires_at: expiresAt.toISOString(),
      // invite_url is included only when caller passed x-debug=true. Don't
      // expose it by default — it's a credential-issuance link.
      invite_url: req.headers.get("x-debug") === "true" ? inviteUrl : undefined,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});

function jsonError(code: string, message: string, status: number): Response {
  return new Response(
    JSON.stringify({ ok: false, error: code, detail: message }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function renderInviteEmail(args: { company: string; inviteUrl: string; expiresAtIso: string }): string {
  const expires = new Date(args.expiresAtIso);
  const expiresText = expires.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #0f172a;">
  <p style="margin: 0 0 16px;">Hi,</p>
  <p style="margin: 0 0 16px;">You've been invited to set up portal access for <strong>${escapeHtml(args.company)}</strong> on SwitchLeads.</p>
  <p style="margin: 0 0 16px;">Click the button below on the device you want to log in from. Your browser will ask you to register a passkey (Touch ID, Face ID, Windows Hello, or a security key) — that becomes your way in from now on. No passwords, no codes.</p>
  <p style="margin: 24px 0;">
    <a href="${escapeHtml(args.inviteUrl)}" style="display: inline-block; background: #0f172a; color: #ffffff; padding: 12px 20px; border-radius: 8px; text-decoration: none; font-weight: 600;">Set up your passkey</a>
  </p>
  <p style="margin: 0 0 16px; color: #475569; font-size: 14px;">This link expires at <strong>${escapeHtml(expiresText)}</strong> and only works once. If it expires before you use it, ask the SwitchLeads team for a new one.</p>
  <p style="margin: 0 0 16px; color: #475569; font-size: 14px;">If you weren't expecting this invite, you can ignore the email — the link does nothing on its own and dies after the time above.</p>
  <p style="margin: 24px 0 0; color: #94a3b8; font-size: 12px;">SwitchLeads · provider portal access</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
