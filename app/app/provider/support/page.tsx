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
    .select("contact_email, provider_id")
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle<{ contact_email: string; provider_id: string }>();

  const replyEmail = pu?.contact_email ?? user.email ?? "your registered email";

  // Determine the provider's shape so the Common questions section can
  // filter out guides that don't apply. Employer-providers (Riverside)
  // shouldn't see fastrack / callback / attempt-counter explanations.
  let isEmployer = false;
  if (pu?.provider_id) {
    const { data: provider } = await admin
      .schema("crm")
      .from("providers")
      .select("funding_types")
      .eq("provider_id", pu.provider_id)
      .maybeSingle<{ funding_types: string[] | null }>();
    isEmployer = Array.isArray(provider?.funding_types)
      && provider!.funding_types!.includes("apprenticeship");
  }
  const visibleGuides = GUIDES.filter((g) => {
    if (g.for === "both") return true;
    return isEmployer ? g.for === "employer" : g.for === "learner";
  });

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

        {/* Get started card. Re-runs the welcome deck on demand — same
            forced walkthrough every user sees on first login, but no
            longer gated. Sits above the FAQ as the canonical "I want to
            re-orient" entry point. */}
        <section className="bg-white border border-slate-200 rounded-xl p-5 flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
              Get started
            </p>
            <p className="text-sm text-slate-700">
              Walk back through the portal tour any time. Same one we show
              every new team member on their first sign-in.
            </p>
          </div>
          <a
            href="/provider/welcome"
            className="inline-flex items-center justify-center rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold px-4 py-2 transition-colors shrink-0"
          >
            Open the tour →
          </a>
        </section>

        {/* Public first-time-access guide. Kept as a shareable link for
            teammates who don't yet have a sign-in. */}
        <section className="text-xs text-slate-500">
          Share with a teammate before their invite lands:{" "}
          <a
            href="/help/getting-started"
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-slate-700 underline-offset-2 hover:underline"
          >
            /help/getting-started
          </a>
          . No sign-in required.
        </section>

        {/* Help guides: short answers to the things providers most often ask. */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
            Common questions
          </h2>
          <div className="space-y-3">
            {visibleGuides.map((g) => (
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
type GuideAudience = "learner" | "employer" | "both";
const GUIDES: Array<{ q: string; a: React.ReactNode; for: GuideAudience }> = [
  {
    for: "learner",
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
    for: "employer",
    q: "How do I mark an outcome on an employer lead?",
    a: (
      <>
        Click into any lead from the Leads list. Use the stepper under
        &quot;Move this lead forward&quot; to advance through Engaged, In
        progress, and Signed. Use &quot;Mark not signed&quot; to close out a
        lead that won&apos;t proceed (you&apos;ll be asked for a reason).
        Outcomes are forward-only on the main stepper. If you marked Not
        signed by mistake, the Not signed screen has buttons to move the
        lead back to Engaged, In progress, or Signed.
      </>
    ),
  },
  {
    for: "learner",
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
    for: "learner",
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
    for: "both",
    q: "Where do my notes go?",
    a: (
      <>
        Notes you write on a lead are visible to anyone on your team in the
        portal and to SwitchLeads support. They&apos;re NOT visible to the
        learner or employer. Each note is timestamped and tagged with the
        author&apos;s display name, so you can keep a running log of what was
        said on each call. Notes from SwitchLeads (in blue, tagged
        &quot;Switchable&quot;) appear in the same log.
      </>
    ),
  },
  {
    for: "learner",
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
    for: "employer",
    q: "What's the 60-day clock?",
    a: (
      <>
        Once an employer lead is at Engaged or In progress, you&apos;ve got
        60 days from the last status update to confirm a Signed outcome. At
        day 50 the lead shows a &quot;60-day clock approaching&quot; flag.
        If no update lands by day 60, the system auto-flips the lead to
        &quot;Presumed signed&quot; and you&apos;ll be billed unless you raise
        a dispute within 7 days. The cleanest workflow: update the status as
        soon as the employer signs, and the clock resets.
      </>
    ),
  },
  {
    for: "both",
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
    for: "both",
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
    for: "both",
    q: "What is the 6-8 digit code I'm asked for?",
    a: (
      <>
        When you sign in on a fresh device or browser we email you a short
        sign-in code as a second check. Open your inbox, copy the code, paste
        it into the box. Day to day you stay signed in for about a week, the
        code only kicks in on a fresh sign-in.
      </>
    ),
  },
];
