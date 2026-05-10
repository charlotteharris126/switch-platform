// /provider/support — contact the SwitchLeads team via a form.
//
// Submissions land in crm.support_requests + fire an email to
// support@switchleads.co.uk. The form pre-resolves the caller's contact
// email to show "we'll reply to <email>" so the provider knows where
// the response goes.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ProviderShell } from "../provider-shell";
import { SupportForm } from "./support-form";
import { submitSupportRequestAction } from "./actions";

export default async function ProviderSupportPage() {
  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) redirect("/passkey-login");

  const admin = createAdminClient();
  const { data: pu } = await admin
    .schema("crm")
    .from("provider_users")
    .select("contact_email")
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle<{ contact_email: string }>();

  const replyEmail = pu?.contact_email ?? user.email ?? "your registered email";

  return (
    <ProviderShell active="support">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Support</h1>
          <p className="text-sm text-slate-500 mt-1">
            Anything you can&apos;t do from the portal — drop us a line. We aim to reply
            within one working day.
          </p>
        </div>

        <SupportForm initialEmail={replyEmail} onSubmit={submitSupportRequestAction} />

        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-slate-600">
          <p className="font-semibold text-slate-700 mb-1">Prefer email?</p>
          <p>
            Send your message direct to{" "}
            <a
              href="mailto:support@switchleads.co.uk"
              className="font-semibold text-slate-900 hover:underline"
            >
              support@switchleads.co.uk
            </a>
            . The form above does the same thing, just with your account context
            attached so we can find you faster.
          </p>
        </div>
      </div>
    </ProviderShell>
  );
}
