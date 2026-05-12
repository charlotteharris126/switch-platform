// /provider/sla-agreement — first-sign-in re-agreement page.
//
// Provider sees this on their very first portal session AND any time
// SLA_VERSION (in ./actions.ts) is bumped beyond what they last
// accepted. Until they click "I agree", the layout gate at
// /provider/layout.tsx redirects every other /provider/* route back
// here. Auto-flip cron also gates on acceptance: leads under an
// unaccepted provider never get auto-flipped to Presumed.
//
// The page reads the provider's per-row SLA values so it shows the
// exact thresholds they're accepting — same values that drive the
// portal overdue badges + the cron's flip timing.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { acceptSlaAction } from "./actions";
import { SLA_VERSION } from "./version";

interface ProviderSlaRow {
  provider_id: string;
  company_name: string;
  agreement_version: "v1" | "v2" | null;
  sla_first_attempt_hours: number;
  sla_attempts_required: number;
  sla_attempt_window_days: number;
  sla_stale_attempt_hours: number;
  sla_presumed_flip_days: number;
  sla_accepted_at: string | null;
  sla_accepted_version: string | null;
}

export default async function SlaAgreementPage() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) redirect("/provider-login");

  const admin = createAdminClient();
  const { data: pu } = await admin
    .schema("crm")
    .from("provider_users")
    .select("provider_id, display_name, contact_email, role")
    .eq("auth_user_id", userData.user.id)
    .eq("status", "active")
    .maybeSingle<{ provider_id: string; display_name: string | null; contact_email: string; role: string }>();
  if (!pu) {
    await supabase.auth.signOut();
    redirect("/provider-login?error=no_active_account");
  }
  const isAdminRole = pu.role === "provider_admin";

  const { data: row } = await admin
    .schema("crm")
    .from("providers")
    .select(
      "provider_id, company_name, agreement_version, sla_first_attempt_hours, sla_attempts_required, sla_attempt_window_days, sla_stale_attempt_hours, sla_presumed_flip_days, sla_accepted_at, sla_accepted_version",
    )
    .eq("provider_id", pu.provider_id)
    .maybeSingle<ProviderSlaRow>();
  if (!row) {
    return (
      <FallbackShell>
        <h1 className="text-xl font-semibold text-slate-900">
          We can&apos;t find your provider record.
        </h1>
        <p className="text-sm text-slate-500 mt-2">
          Email{" "}
          <a href="mailto:support@switchleads.co.uk" className="underline">support@switchleads.co.uk</a>
          {" "}and we&apos;ll sort it.
        </p>
      </FallbackShell>
    );
  }

  // If they've already accepted the current version, send them to /provider.
  // (Layout gate handles the reverse direction.)
  if (row.sla_accepted_at && row.sla_accepted_version === SLA_VERSION) {
    redirect("/provider");
  }

  const presumedLabel = row.agreement_version === "v2" ? "Presumed signed" : "Presumed enrolled";
  const closeoutLabel = row.agreement_version === "v2" ? "signed" : "enrolled";
  const greetingName = pu.display_name ?? pu.contact_email;

  return (
    <FallbackShell>
      <div className="space-y-6">
        <header>
          <p className="text-xs uppercase tracking-widest font-semibold text-slate-500">
            Welcome to your portal, {greetingName}
          </p>
          <h1 className="text-2xl font-semibold text-slate-900 mt-1">
            Before you start, let&apos;s re-confirm how this works
          </h1>
          <p className="text-sm text-slate-600 mt-2">
            We agreed your pilot terms when you signed the PPA. Now you&apos;re in the
            portal, here&apos;s the day-to-day shape of it. Quick read, takes a minute.
          </p>
        </header>

        <Section title="Your side">
          <ul className="space-y-3 text-sm text-slate-800">
            <Bullet>
              First contact with every routed lead within{" "}
              <strong>{row.sla_first_attempt_hours} hours</strong> of arrival.
            </Bullet>
            <Bullet>
              Up to <strong>{row.sla_attempts_required} attempts over {row.sla_attempt_window_days} days</strong> before
              marking <em>Cannot reach</em>. The portal nudges you when an attempt
              has been sitting for more than <strong>{row.sla_stale_attempt_hours} hours</strong>.
            </Bullet>
            <Bullet>
              Update the lead&apos;s status as you work it in the portal. Your
              Google Sheet will stay around for a while as a fallback and
              syncs automatically when you mark a major outcome, so you can
              keep working from either side.
            </Bullet>
          </ul>
        </Section>

        <Section title="Our side">
          <ul className="space-y-3 text-sm text-slate-800">
            <Bullet>
              Every routed lead has been pre-screened so it matches your
              eligibility criteria. We only bill on confirmed enrolments,
              and on untouched leads left at Open for{" "}
              <strong>{row.sla_presumed_flip_days} days</strong> (the auto-flip
              rule below).
            </Bullet>
            <Bullet>
              We surface stale leads in your portal home + the leads list
              with an <strong>Overdue</strong> badge, so nothing slips.
            </Bullet>
            <Bullet>
              We email you the minute a lead lands and we&apos;re reachable on{" "}
              <a href="mailto:support@switchleads.co.uk" className="underline">support@switchleads.co.uk</a>
              {" "}if anything&apos;s off.
            </Bullet>
          </ul>
        </Section>

        <Section title="The 14-day rule" subtitle="The bit we need you to know">
          <p className="text-sm text-slate-800">
            If a lead is still sitting at <strong>Open</strong> with no outcome after
            {" "}<strong>{row.sla_presumed_flip_days} days</strong>, our system marks it{" "}
            <strong>{presumedLabel}</strong> and triggers billing for that {closeoutLabel}.
          </p>
          <p className="text-sm text-slate-700 mt-3">
            We give you a 7-day window after that to dispute (open the lead → record a
            dispute). If you&apos;ve genuinely been working it and just haven&apos;t
            updated the status, please update the status — that resets the clock and
            keeps things clean.
          </p>
          <p className="text-sm text-slate-700 mt-3">
            <strong>Engaged / In progress / 1st-2nd-3rd no answer / Cannot reach / Lost / Not signed</strong> —
            any of these counts as you having actioned the lead, so the auto-flip
            doesn&apos;t fire on them. It only fires on leads still at <em>Open</em>.
          </p>
        </Section>

        {isAdminRole ? (
          <form action={acceptSlaAction}>
            <button
              type="submit"
              className="w-full md:w-auto px-6 py-3 text-sm font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800 cursor-pointer"
            >
              Got it — take me to the portal
            </button>
            <p className="text-xs text-slate-500 mt-2">
              Clicking this confirms you&apos;ve read the working agreement above
              (logged with timestamp + your account).
            </p>
          </form>
        ) : (
          <div className="bg-amber-50 border border-amber-200 rounded-md p-4">
            <p className="text-sm text-amber-900 font-semibold">
              Your admin needs to sign in and accept this first.
            </p>
            <p className="text-sm text-amber-800 mt-2">
              The provider admin on your team has to read and confirm this
              agreement before anyone else on the team gets portal access.
              Ping them to log in, or email{" "}
              <a href="mailto:support@switchleads.co.uk" className="underline">support@switchleads.co.uk</a>
              {" "}if you&apos;re not sure who that is.
            </p>
          </div>
        )}
      </div>
    </FallbackShell>
  );
}

function FallbackShell({ children }: { children: React.ReactNode }) {
  // Intentionally not wrapped in ProviderShell — the standard provider
  // nav assumes the user is past the SLA gate (so e.g. the Leads count
  // badge can fetch). Until they accept, they get a plain-frame view
  // with no nav.
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-slate-900 px-6 py-4">
        <span className="text-sm font-bold text-white">SwitchLeads</span>
      </header>
      <main className="max-w-3xl mx-auto p-6 md:p-10">{children}</main>
    </div>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl p-5">
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="text-slate-400 select-none mt-0.5">•</span>
      <span>{children}</span>
    </li>
  );
}
