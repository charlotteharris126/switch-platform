// Public first-time-access guide. Linked from the provider invite
// email so a brand-new user can read it before they have a passkey
// or a sign-in.

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Getting started, SwitchLeads",
  description:
    "How to access your SwitchLeads provider account for the first time, set up a passkey, and find your way around.",
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
          Reading time: about 4 minutes.
        </p>
      </header>

      <Section step="1" title="The invite email">
        <p>
          Once your account is set up on our side, you&apos;ll get an email
          inviting you to register. It comes from{" "}
          <span className="font-semibold text-slate-900">
            Switchable Support
          </span>{" "}
          (sender address{" "}
          <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">
            support@switchleads.co.uk
          </code>
          ) with a subject line that mentions your SwitchLeads account.
        </p>
        <p>
          The email contains a single sign-in link, valid for seven days. Click
          it on the device you&apos;ll usually use to manage leads, ideally a
          phone or laptop with biometric sign-in (Touch ID, Face ID, or Windows
          Hello).
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

      <Section step="2" title="Setting up a passkey">
        <p>
          We don&apos;t use passwords. Instead, your account is protected by a{" "}
          <span className="font-semibold text-slate-900">passkey</span>, the
          same kind of biometric sign-in your phone or banking app uses.
        </p>
        <p>
          When you click the link, your device will prompt you to register.
          Confirm with your fingerprint, face, or device PIN. That&apos;s it.
          The whole step takes about ten seconds.
        </p>
        <p>
          Your passkey lives on the device you registered on. If you want to
          add another device later (a second laptop, a colleague&apos;s phone),
          it&apos;s a separate ceremony on that device, and we can send a fresh
          link for it.
        </p>
        <Callout tone="slate" title="Why passkeys?">
          They&apos;re harder to phish than passwords, you don&apos;t have to
          remember anything, and they&apos;re built into modern devices. The
          standard is the same one used by Apple, Google, Microsoft, and most
          UK banks.
        </Callout>
      </Section>

      <Section step="3" title="Signing in after that">
        <p>
          Next time you visit the portal, your device recognises the passkey
          and signs you in with a single biometric tap. No emailed links, no
          passwords.
        </p>
        <p>
          The portal lives at{" "}
          <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">
            app.switchleads.co.uk
          </code>
          . Bookmark it once you&apos;re signed in.
        </p>
      </Section>

      <Section step="4" title="What you&apos;ll see in the portal">
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
            where your profile, passkeys, team members, and pricing details
            live.
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
          of email you got, with a fresh sign-in link.
        </p>
        <p>
          Regular users can work leads, mark outcomes, and add notes. Admins
          can do all that plus invite or re-issue links to other team members.
        </p>
      </Section>

      <Section step="7" title="If something goes wrong">
        <p>
          Lost device, can&apos;t sign in, missing a lead you were expecting,
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

      <div className="pt-6 border-t border-slate-200">
        <p className="text-sm text-slate-700">
          Got your invite email? Click the link inside to register your
          passkey. Once you&apos;re signed in, everything else makes sense in
          about five minutes.
        </p>
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
