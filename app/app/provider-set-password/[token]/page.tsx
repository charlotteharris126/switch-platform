// /provider-set-password/[token]
//
// Provider clicks the invite link from their email and lands here. The
// token in the URL is opaque to this server component — it's verified
// server-side by the setProviderPasswordAction Server Action when the
// form submits. We pre-verify here only to show their email address
// (read-only) on the form and surface "link expired / already used"
// up front rather than after they've typed a password.

import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyInviteToken, sha256Hex } from "@/lib/webauthn/invite-token";
import { SetPasswordForm } from "./set-password-form";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function SetPasswordPage({ params }: Props) {
  const { token } = await params;

  const inviteSecret = process.env.PROVIDER_INVITE_SECRET;
  if (!inviteSecret) return <InviteUnavailable reason="Server misconfigured." />;

  const verify = await verifyInviteToken(token, inviteSecret);
  if (!verify.ok || !verify.payload) {
    if (verify.error === "expired") return <InviteExpired />;
    return <InviteUnavailable reason="That invite link looks corrupted." />;
  }

  const admin = createAdminClient();
  const { data: row } = await admin
    .schema("crm")
    .from("provider_users")
    .select(
      "id, contact_email, display_name, status, current_invite_token_hash, current_invite_expires_at",
    )
    .eq("id", verify.payload.provider_user_id)
    .maybeSingle<{
      id: number;
      contact_email: string;
      display_name: string | null;
      status: string;
      current_invite_token_hash: string | null;
      current_invite_expires_at: string | null;
    }>();

  if (!row) notFound();

  // Hash check (defence-in-depth, mirrors the existing passkey path).
  const tokenHash = await sha256Hex(token);
  if (row.current_invite_token_hash !== tokenHash) {
    return <InviteUnavailable reason="This invite has already been used. If you need a fresh one, ask the admin who set you up." />;
  }
  if (!row.current_invite_expires_at || new Date(row.current_invite_expires_at) < new Date()) {
    return <InviteExpired />;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4 py-10">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-slate-200 p-8">
        <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">SwitchLeads</p>
        <h1 className="text-2xl font-semibold text-slate-900 mt-2">Set your password</h1>
        <p className="text-slate-600 mt-3 text-sm">
          Hi{row.display_name ? `, ${row.display_name}` : ""}. Choose a password for your
          portal account. Next time you sign in, you&apos;ll enter your email
          and this password, then a 6-digit code we email you (only when
          you sign in fresh — day to day you stay signed in).
        </p>
        <SetPasswordForm token={token} email={row.contact_email} />
        <div className="mt-6 pt-4 border-t border-slate-100 text-xs text-slate-500">
          <p>
            Trouble?{" "}
            <a
              href="mailto:support@switchleads.co.uk"
              className="font-semibold text-slate-700 underline-offset-2 hover:underline"
            >
              support@switchleads.co.uk
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

function InviteExpired() {
  return (
    <CenteredCard
      heading="This invite has expired"
      body="Invite links last 24 hours. Drop the admin a note and they'll send you a fresh one."
    />
  );
}

function InviteUnavailable({ reason }: { reason: string }) {
  return <CenteredCard heading="This invite can't be used" body={reason} />;
}

function CenteredCard({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-slate-200 p-8">
        <h1 className="text-xl font-semibold text-slate-900">{heading}</h1>
        <p className="text-slate-600 mt-3 text-sm">{body}</p>
        <p className="text-slate-500 mt-4 text-xs">
          Email{" "}
          <a
            href="mailto:support@switchleads.co.uk"
            className="font-semibold text-slate-700 underline-offset-2 hover:underline"
          >
            support@switchleads.co.uk
          </a>{" "}
          and we&apos;ll sort it.
        </p>
      </div>
    </div>
  );
}
