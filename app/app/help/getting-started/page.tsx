// Public first-time-access guide. Linked from the provider invite
// email so a brand-new user can read it before they have a password
// or a sign-in.
//
// Sign-in flow (as of 2026-05-11): email + password, plus a short
// sign-in code emailed on each fresh sign-in. Passkey infrastructure
// retired the same day.

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Getting started, SwitchLeads",
  description:
    "How to access your SwitchLeads provider account for the first time, set up your password, and find your way around.",
  robots: { index: false, follow: false },
};

export default function GettingStartedPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-10 space-y-10">
      <header>
        <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">
          First-time access
        </p>
        <h1 className="text-3xl font-semibold text-slate-900 mt-2">
          Getting started with SwitchLeads
        </h1>
        <p className="text-base text-slate-700 mt-3 leading-relaxed">
          The SwitchLeads portal is where you receive and manage leads from
          Switchable. This guide walks you through your first sign-in, what to
          expect, and where to find things once you&apos;re in.
        </p>
        <p className="text-sm text-slate-500 mt-2">
          Reading time: about 3 minutes.
        </p>
      </header>

      <Callout tone="slate" title="Prefer to do this with us on the line?">
        While we&apos;re in pilot, we&apos;ll happily walk anyone through
        first-time setup on a 5-minute call. No tech background needed,
        no judgement. Email{" "}
        <a
          href="mailto:support@switchleads.co.uk"
          className="font-semibold text-slate-900 underline-offset-2 hover:underline"
        >
          support@switchleads.co.uk
        </a>{" "}
        with a couple of times that suit and we&apos;ll book it in.
      </Callout>

      <Section step="1" title="The invite email">
        <p>
          Once your account is set up on our side, you&apos;ll get an email
          inviting you to set a password. It comes from{" "}
          <span className="font-semibold text-slate-900">
            Switchable Support
          </span>{" "}
          (sender address{" "}
          <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">
            support@switchleads.co.uk
          </code>
          ) with a subject line about your SwitchLeads portal access.
        </p>
        <p>
          The email contains one button:{" "}
          <span className="font-semibold text-slate-900">Set up your password</span>.
          That link is valid for 24 hours and only works once.
        </p>
        <Callout tone="amber" title="Can&apos;t find the email?">
          Check your spam folder first. If it&apos;s not there, email{" "}
          <a
            href="mailto:support@switchleads.co.uk"
            className="font-semibold text-slate-900 underline-offset-2 hover:underline"
          >
            support@switchleads.co.uk
          </a>{" "}
          and we&apos;ll resend it.
        </Callout>
      </Section>

      <Section step="2" title="Setting your password">
        <p>
          Click the link in the invite email. You&apos;ll land on a page
          showing your email address (already filled in) and two boxes for
          your new password.
        </p>
        <p>
          Pick anything you&apos;ll remember, at least 12 characters. Long is
          better than fancy: three or four words strung together (e.g. {" "}
          <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">
            sunset-eagle-roast-window
          </code>
          ) is stronger than{" "}
          <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">
            P@ssw0rd1!
          </code>{" "}
          and easier to type.
        </p>
        <p>
          Click <span className="font-semibold text-slate-900">Set password</span>{" "}
          when both boxes match. You&apos;ll be taken to the sign-in page with a
          green &quot;Password set&quot; banner.
        </p>
        <Callout tone="slate" title="Save it somewhere you trust">
          A password manager (1Password, Bitwarden, your browser&apos;s built-in
          one) is the easiest way. Otherwise jot it somewhere safe — you&apos;ll
          need it next time you sign in on a new device.
        </Callout>
      </Section>

      <Section step="3" title="Signing in">
        <p>
          On the sign-in page (
          <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">
            app.switchleads.co.uk
          </code>
          ) enter your email and password. Click{" "}
          <span className="font-semibold text-slate-900">Continue</span>.
        </p>
        <p>
          On a brand-new device or browser, we&apos;ll email you a short
          sign-in code (a few digits) to confirm it&apos;s really you. Open
          your inbox, copy the code, paste it into the box on the next
          screen, click <span className="font-semibold text-slate-900">Sign in</span>.
          You&apos;re in.
        </p>
        <p>
          Day to day, you stay signed in. The code only appears on a fresh
          device or after you&apos;ve been away for a long time — you&apos;re
          not entering one every time you visit.
        </p>
        <Callout tone="amber" title="Forgot your password?">
          Click <span className="font-semibold">Forgot your password?</span> on
          the sign-in page. We&apos;ll email you a reset link. Set a new
          password, then sign in again with it.
        </Callout>
      </Section>

      <Section step="4" title="What you'll see in the portal">
        <p>
          The home screen shows what needs your attention right now: callbacks,
          fastrack-ready leads, open leads waiting for a first call, and any
          stale follow-ups. Each card tells you how long that bucket has been
          waiting.
        </p>
        <p>
          From the top nav, you can move between:
        </p>
        <ul className="list-disc pl-5 space-y-1.5 text-slate-700">
          <li>
            <span className="font-semibold text-slate-900">Home</span>, the
            at-a-glance dashboard.
          </li>
          <li>
            <span className="font-semibold text-slate-900">Leads</span>, the
            full list with filters (action needed, callback, fastrack, open,
            calling, meeting booked, enrolled, cold).
          </li>
          <li>
            <span className="font-semibold text-slate-900">Account</span>,
            where your profile, team members, and pricing details live.
          </li>
          <li>
            <span className="font-semibold text-slate-900">Support</span>,
            help guides and a contact form.
          </li>
        </ul>
      </Section>

      <Section step="5" title="Working a lead">
        <p>
          Click any lead from the list to open the detail view. You&apos;ll
          see what the learner submitted, any fastrack confirmation details,
          and a notes log on the right.
        </p>
        <p>
          As you work the lead, you mark its outcome step by step: first call,
          attempt 2, attempt 3, meeting booked, enrolled, lost, or cannot
          reach. The portal tracks the dates automatically. You can add free
          notes at any point and they&apos;re visible to everyone on your team
          and to us.
        </p>
        <p>
          A few states need extra detail: marking a lead as lost asks you to
          pick a reason. This helps us tighten the funnel above you.
        </p>
      </Section>

      <Section step="6" title="Adding teammates">
        <p>
          The first user we set up on your account is an admin. From{" "}
          <span className="font-semibold text-slate-900">Account</span>, an
          admin can invite teammates by email and choose whether they&apos;re
          another admin or a regular user. Invited teammates get the same kind
          of email you got, with a fresh password-setup link.
        </p>
        <p>
          Regular users can work leads, mark outcomes, and add notes. Admins
          can do all that plus invite or re-issue links to other team members.
        </p>
      </Section>

      <Section step="7" title="If something goes wrong">
        <p>
          Locked out, can&apos;t sign in, missing a lead you were expecting,
          or anything that looks off: email{" "}
          <a
            href="mailto:support@switchleads.co.uk"
            className="font-semibold text-slate-900 underline-offset-2 hover:underline"
          >
            support@switchleads.co.uk
          </a>
          . We aim to reply within one working day, usually faster.
        </p>
        <p>
          Once you&apos;re signed in, the{" "}
          <span className="font-semibold text-slate-900">Support</span> page
          inside the portal has a contact form that goes to the same place,
          plus a longer set of help guides.
        </p>
      </Section>

      <div className="pt-6 border-t border-slate-200 space-y-3">
        <p className="text-sm text-slate-700">
          Got your invite email? Click the link inside to set your password.
          Once you&apos;re signed in, everything else makes sense in about
          five minutes.
        </p>
        <div className="bg-slate-900 text-white rounded-xl p-4 text-sm">
          <p className="font-semibold mb-1">Stuck at any step?</p>
          <p className="text-slate-200">
            Email{" "}
            <a
              href="mailto:support@switchleads.co.uk"
              className="font-semibold text-white underline-offset-2 hover:underline"
            >
              support@switchleads.co.uk
            </a>{" "}
            and we&apos;ll book a 5-minute screen-share to walk you through
            it. Pilot providers get this as standard.
          </p>
        </div>
      </div>
    </div>
  );
}

function Section({
  step,
  title,
  children,
}: {
  step: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline gap-3 mb-3">
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-slate-900 text-white text-xs font-semibold tabular-nums shrink-0">
          {step}
        </span>
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      </div>
      <div className="space-y-3 text-sm text-slate-700 leading-relaxed pl-10">
        {children}
      </div>
    </section>
  );
}

function Callout({
  tone,
  title,
  children,
}: {
  tone: "amber" | "slate";
  title: string;
  children: React.ReactNode;
}) {
  const palette =
    tone === "amber"
      ? "bg-amber-50 border-amber-200 text-amber-900"
      : "bg-slate-100 border-slate-200 text-slate-700";
  return (
    <div className={`mt-3 border rounded-lg p-3 text-xs ${palette}`}>
      <p className="font-semibold mb-1">{title}</p>
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}
