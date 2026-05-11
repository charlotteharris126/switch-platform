// /provider/support. contact the SwitchLeads team via a form.
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
  if (!user) redirect("/provider-login");

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
      <div className="max-w-3xl mx-auto p-6 space-y-8">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Support</h1>
          <p className="text-sm text-slate-500 mt-1">
            Quick answers below. If they don&apos;t cover it, drop us a line and we&apos;ll
            reply within one working day.
          </p>
        </div>

        {/* Long-form intro guide. Same page that lives outside the login
            for first-time access — useful to share with a teammate before
            their invite lands. */}
        <section className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
            New to the portal?
          </p>
          <p className="text-sm text-slate-700">
            The full first-time-access walkthrough lives at{" "}
            <a
              href="/help/getting-started"
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-slate-900 underline-offset-2 hover:underline"
            >
              /help/getting-started
            </a>
            . Shareable with anyone, no sign-in required.
          </p>
        </section>

        {/* Help guides: short answers to the things providers most often ask. */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
            Common questions
          </h2>
          <div className="space-y-3">
            {GUIDES.map((g) => (
              <details
                key={g.q}
                className="group bg-white border border-slate-200 rounded-xl overflow-hidden"
              >
                <summary className="cursor-pointer list-none px-5 py-4 flex items-center justify-between gap-3 hover:bg-slate-50 transition-colors">
                  <span className="text-sm font-semibold text-slate-900">{g.q}</span>
                  <span className="text-slate-400 text-lg group-open:rotate-45 transition-transform shrink-0">
                    +
                  </span>
                </summary>
                <div className="px-5 pb-4 text-sm text-slate-700 leading-relaxed border-t border-slate-100 pt-3">
                  {g.a}
                </div>
              </details>
            ))}
          </div>
        </section>

        {/* Form */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
            Still need help? Send us a message
          </h2>
          <SupportForm initialEmail={replyEmail} onSubmit={submitSupportRequestAction} />
        </section>

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

// Short-form help. For longer how-tos, the public first-time-access guide
// (coming next) sits at /help/getting-started outside the auth gate.
//
// Plain ASCII quotes only in q/a strings: q is rendered as a JSX expression
// (not text), so HTML entities show literally; consistent with the rest of
// the codebase. No em dashes per copy.md.
const GUIDES: Array<{ q: string; a: React.ReactNode }> = [
  {
    q: "How do I mark an outcome on a lead?",
    a: (
      <>
        Click into any lead from the Leads list. Use the stepper under
        &quot;Move this lead forward&quot; to advance through 1st / 2nd / 3rd
        no answer, Meeting booked, or Enrolled. Use the &quot;Or close this
        out&quot; row for Cannot reach or Lost. Outcomes are forward-only on
        the attempt counter, so once you&apos;re at &quot;2nd no answer&quot;
        you can&apos;t step back to &quot;1st&quot;. If you ticked Lost by
        mistake, the Lost screen has buttons to recover the lead back to any
        active state.
      </>
    ),
  },
  {
    q: "What does the Fastrack badge mean?",
    a: (
      <>
        Fastrack means the learner has filled in the second-stage form
        confirming their cohort dates, that they&apos;ve got their docs, and
        re-confirmed their Level 3 status. They&apos;re the closest to ready-to-
        enrol. Fastrack leads are pinned to the top of your leads list with a
        violet badge. Open the lead detail to see the full fastrack form
        contents (including any L3 mismatch warning) under &quot;Fastrack
        submission&quot;.
      </>
    ),
  },
  {
    q: 'What does "Callback requested" mean?',
    a: (
      <>
        It means the SwitchLeads team has flagged this lead for your immediate
        attention. Usually because the learner has been in touch and asked us
        to pass the message on. Callback leads pin to the top of your list with
        a red dot, you&apos;ll see a banner on the home page, and the count
        appears on the Leads nav badge. Open the lead detail and read the note
        in the right-hand panel; once you mark any new outcome on the lead the
        flag clears automatically.
      </>
    ),
  },
  {
    q: "Where do my notes go?",
    a: (
      <>
        Notes you write on a lead are visible to anyone on your team in the
        portal and to SwitchLeads support. They&apos;re NOT visible to the
        learner. Each note is timestamped and tagged with the author&apos;s
        display name, so you can keep a running log of what was said on each
        call. Notes from SwitchLeads (in blue, tagged &quot;Switchable&quot;)
        appear in the same log.
      </>
    ),
  },
  {
    q: "What should I do when a lead doesn't pick up?",
    a: (
      <>
        Mark them &quot;1st no answer&quot;. Try again 24-48 hours later, and
        if no luck, mark them &quot;2nd no answer&quot;, then &quot;3rd&quot;.
        After three solid attempts on different days/times, mark them
        &quot;Cannot reach&quot;. Cannot reach isn&apos;t terminal: if they get
        back in touch later, you can move them straight to &quot;Meeting
        booked&quot; or &quot;Enrolled&quot; from the Cannot reach screen.
      </>
    ),
  },
  {
    q: "When does the timer reset?",
    a: (
      <>
        Two timers run on each lead. &quot;In your queue&quot; counts from when
        the lead was routed to you and never resets. &quot;At current
        status&quot; counts from the last status change you made, so it resets
        every time you mark a new outcome. Both are visible at the top of the
        lead detail page.
      </>
    ),
  },
  {
    q: "Forgot my password / can't sign in, what do I do?",
    a: (
      <>
        On the sign-in page, click{" "}
        <span className="font-semibold text-slate-900">Forgot your password?</span>{" "}
        under the password field. We&apos;ll email you a reset link. Set a new
        password and you&apos;re back in. If that doesn&apos;t arrive within a
        minute (check spam first), email{" "}
        <a
          href="mailto:support@switchleads.co.uk"
          className="font-semibold text-slate-900 hover:underline"
        >
          support@switchleads.co.uk
        </a>{" "}
        and we&apos;ll send a fresh invite link to your registered email.
      </>
    ),
  },
  {
    q: "What is the 6-8 digit code I'm asked for?",
    a: (
      <>
        When you sign in on a fresh device or browser we email you a short
        sign-in code as a second check. Open your inbox, copy the code, paste
        it into the box. Day to day you stay signed in for about a week — the
        code only kicks in on a fresh sign-in.
      </>
    ),
  },
];
