"use server";

// Server Action — provider sets their initial password from an invite
// link. Mirrors the auth path of the retired passkey enrolment route
// (lib/webauthn/invite-token + sha256Hex against
// crm.provider_users.current_invite_token_hash) but the outcome is a
// Supabase Auth password, not a passkey credential.
//
// Idempotent on a second click only if the token hash row still
// matches — i.e. someone who navigates back to the same /set-password
// URL within the token's TTL can set the password again. After the
// first successful set we clear the hash so the link can't be reused.

import { createAdminClient } from "@/lib/supabase/admin";
import { verifyInviteToken, sha256Hex } from "@/lib/webauthn/invite-token";

const MIN_PASSWORD_LENGTH = 12;

type Result = { ok: true } | { ok: false; error: string };

export async function setProviderPasswordAction(args: {
  token: string;
  password: string;
}): Promise<Result> {
  if (typeof args.token !== "string" || args.token.length === 0) {
    return { ok: false, error: "Missing token." };
  }
  if (typeof args.password !== "string" || args.password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }

  const inviteSecret = process.env.PROVIDER_INVITE_SECRET;
  if (!inviteSecret) {
    return { ok: false, error: "Server misconfigured (missing PROVIDER_INVITE_SECRET)." };
  }

  const verify = await verifyInviteToken(args.token, inviteSecret);
  if (!verify.ok || !verify.payload) {
    if (verify.error === "expired") return { ok: false, error: "This invite has expired." };
    return { ok: false, error: "This invite link can't be used." };
  }

  const admin = createAdminClient();

  const { data: row } = await admin
    .schema("crm")
    .from("provider_users")
    .select(
      "id, provider_id, contact_email, display_name, auth_user_id, status, current_invite_token_hash, current_invite_expires_at",
    )
    .eq("id", verify.payload.provider_user_id)
    .maybeSingle<{
      id: number;
      provider_id: string;
      contact_email: string;
      display_name: string | null;
      auth_user_id: string | null;
      status: string;
      current_invite_token_hash: string | null;
      current_invite_expires_at: string | null;
    }>();

  if (!row) return { ok: false, error: "Provider user not found." };

  const tokenHash = await sha256Hex(args.token);
  if (row.current_invite_token_hash !== tokenHash) {
    return { ok: false, error: "This invite has already been used. Ask your admin for a fresh one." };
  }
  if (!row.current_invite_expires_at || new Date(row.current_invite_expires_at) < new Date()) {
    return { ok: false, error: "This invite has expired." };
  }

  // Mint or update the auth.users row.
  let authUserId = row.auth_user_id;
  if (!authUserId) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: row.contact_email,
      password: args.password,
      email_confirm: true,
      user_metadata: {
        provider_user_id: row.id,
        provider_id: row.provider_id,
      },
    });
    if (createErr || !created.user) {
      return { ok: false, error: createErr?.message ?? "Could not create your account." };
    }
    authUserId = created.user.id;
  } else {
    const { error: updateErr } = await admin.auth.admin.updateUserById(authUserId, {
      password: args.password,
      email_confirm: true,
    });
    if (updateErr) {
      return { ok: false, error: updateErr.message };
    }
  }

  // Finalise the provider_users row: clear the invite token, mark active,
  // link auth_user_id if not already.
  const { error: puUpdErr } = await admin
    .schema("crm")
    .from("provider_users")
    .update({
      auth_user_id: authUserId,
      status: "active",
      enrolled_at: row.status === "active" ? undefined : new Date().toISOString(),
      current_invite_token_hash: null,
      current_invite_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  if (puUpdErr) {
    return { ok: false, error: puUpdErr.message };
  }

  return { ok: true };
}
