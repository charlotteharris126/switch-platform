// /provider/account. profile, provider info, sign-in info, team.
//
// Reads provider_users + providers via the admin (service-role) client
// — crm.provider_users RLS is admin-only so the authenticated session
// can't satisfy self-lookup.
//
// Sign-in is now email + password + email OTP on fresh devices. Passkey
// infrastructure retired 2026-05-11; PasskeyList component and the
// passkey query no longer rendered here.

import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireProviderUser } from "@/lib/auth/require-provider";
import { ProviderShell } from "../provider-shell";
import { DisplayNameForm } from "./display-name-form";
import { TeamPanel, type TeamUserRow } from "./team-panel";
import { updateDisplayNameAction } from "./actions";
import { inviteProviderUserAction, removeProviderUserAction } from "./team-actions";
import { AgreementSection, AGREEMENT_COLUMNS, type AgreementRow } from "../agreement-section";

interface ProviderUserRow {
  id: number;
  provider_id: string;
  contact_email: string;
  display_name: string | null;
  role: string;
  enrolled_at: string | null;
  status: string;
  invited_at: string;
}

interface ProviderRow extends AgreementRow {
  company_name: string;
  contact_email: string;
  contact_phone: string | null;
  pilot_status: string | null;
  billing_model: string | null;
  pricing_model: string | null;
  per_enrolment_fee: number | null;
  percent_rate: number | null;
  min_fee: number | null;
  max_fee: number | null;
  free_enrolments_remaining: number | null;
  is_demo: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  provider_admin: "Admin",
  provider_user: "User",
};

export default async function ProviderAccountPage() {
  // requireProviderUser fires the welcome + SLA gates; without it /account
  // was a bypass route for users who hadn't completed onboarding. Bit
  // Riverside's Freya 2026-05-18 (Charlotte): she logged in, didn't finish
  // /provider/welcome, and could still reach /account because this page
  // ran its own bespoke session check that skipped the gates.
  const ctx = await requireProviderUser();

  const admin = createAdminClient();

  // Re-fetch the provider_user with the extra fields the page renders
  // (enrolled_at, invited_at) on top of the canonical fields the gate
  // already returned.
  const { data: pu } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, provider_id, contact_email, display_name, role, enrolled_at, status, invited_at")
    .eq("id", ctx.providerUserId)
    .maybeSingle<ProviderUserRow>();

  if (!pu) {
    // Defence-in-depth: shouldn't be reachable since requireProviderUser
    // already verified the row exists with status='active'.
    throw new Error("provider_user row missing after gate");
  }

  // provider + team users in parallel.
  const [providerResult, teamResult] = await Promise.all([
    admin
      .schema("crm")
      .from("providers")
      .select(`company_name, contact_email, contact_phone, pilot_status, billing_model, pricing_model, per_enrolment_fee, percent_rate, min_fee, max_fee, free_enrolments_remaining, is_demo, ${AGREEMENT_COLUMNS}`)
      .eq("provider_id", pu.provider_id)
      .maybeSingle<ProviderRow>(),
    admin
      .schema("crm")
      .from("provider_users")
      .select("id, contact_email, display_name, role, status, invited_at, last_login_at")
      .eq("provider_id", pu.provider_id)
      .neq("status", "removed")
      .order("invited_at", { ascending: true }),
  ]);

  const provider = providerResult.data;
  const teamRowsRaw = teamResult.data ?? [];
  const teamUsers: TeamUserRow[] = (teamRowsRaw as Array<{
    id: number;
    contact_email: string;
    display_name: string | null;
    role: string;
    status: string;
    invited_at: string;
    last_login_at: string | null;
  }>).map((t) => ({
    id: t.id,
    contact_email: t.contact_email,
    display_name: t.display_name,
    role: t.role,
    status: t.status,
    invited_at: t.invited_at,
    last_login_at: t.last_login_at,
    is_self: t.id === pu.id,
  }));
  const callerIsAdmin = pu.role === "provider_admin";

  return (
    <ProviderShell active="account">
      <div className="max-w-3xl mx-auto p-6 space-y-6">
        <div>
          <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">
            {provider?.company_name ?? pu.provider_id}
          </p>
          <h1 className="text-2xl font-semibold text-slate-900 mt-1">Your account</h1>
        </div>

        {/* Profile */}
        <Card title="Profile">
          <DisplayNameForm
            initialValue={pu.display_name ?? ""}
            onSave={updateDisplayNameAction}
          />
          <Row label="Email" value={pu.contact_email} />
          <Row label="Role" value={ROLE_LABEL[pu.role] ?? pu.role} />
          <Row
            label="Enrolled"
            value={pu.enrolled_at ? formatDate(pu.enrolled_at) : "Not enrolled yet"}
          />
        </Card>

        {/* Sign-in & security */}
        <Card title="Sign-in & security" subtitle="How you sign in to this portal.">
          <p className="text-sm text-slate-700">
            You sign in with your email and password. On a fresh device or
            browser, we&apos;ll also email you a short code to confirm it&apos;s
            you. Day to day you stay signed in.
          </p>
          <p className="text-xs text-slate-500 mt-3">
            Forgot your password? Use the{" "}
            <a
              href="/reset-password"
              className="font-medium text-slate-700 hover:text-slate-900 underline-offset-2 hover:underline"
            >
              Forgot password
            </a>{" "}
            link on the sign-in page.
          </p>
          <p className="text-xs text-slate-500 mt-2">
            Anything else? Email{" "}
            <a href="mailto:support@switchleads.co.uk" className="font-medium text-slate-700 hover:text-slate-900 underline-offset-2 hover:underline">
              support@switchleads.co.uk
            </a>
            .
          </p>
        </Card>

        {/* Team */}
        <Card
          title="Your team"
          subtitle={
            callerIsAdmin
              ? "Everyone with access to this account. Invite teammates and re-issue links if someone loses their device."
              : "Everyone with access to this account."
          }
        >
          <TeamPanel
            callerIsAdmin={callerIsAdmin}
            users={teamUsers}
            onInvite={inviteProviderUserAction}
            onRemove={removeProviderUserAction}
          />
        </Card>

        {/* Provider info — admin-only. Business and pricing are owner-level
            context; team members on the User role don't need (and shouldn't
            see) commercial terms. */}
        {callerIsAdmin && (
          <Card title="Your business" subtitle="What we have on file. Email support@switchleads.co.uk to change anything here.">
            <Row label="Company" value={provider?.company_name ?? "-"} />
            <Row label="Business email" value={provider?.contact_email ?? "-"} />
            <Row label="Business phone" value={provider?.contact_phone ?? "-"} />
            <Row
              label="Pilot status"
              value={provider?.pilot_status ? humanise(provider.pilot_status) : "-"}
            />
            {provider?.is_demo && (
              <Row label="" value={<span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-violet-100 text-violet-800 border border-violet-200">Demo provider</span>} />
            )}
          </Card>
        )}

        {/* Billing — admin-only, same reasoning. */}
        {callerIsAdmin && (
          <Card title="Pricing">
            <BillingSummary provider={provider} />
          </Card>
        )}

        {/* Pilot agreement — visible to all roles. Was a standalone
            /provider/agreement page until 2026-05-12; folded into Account
            because a once-per-pilot reference doesn't merit its own nav tab,
            and so the admin /preview surface picks it up too. */}
        {provider && (
          <Card
            title="Pilot agreement"
            subtitle="Quick reference for the PPA you signed. Email support to change anything."
          >
            <AgreementSection row={provider} />
          </Card>
        )}

        {/* Support */}
        <Card title="Need help?">
          <p className="text-sm text-slate-700">
            Anything you can&apos;t do from the portal: billing queries, business details
            to update, lost device, anything else.{" "}
            <Link
              href="/provider/support"
              className="font-semibold text-slate-900 hover:underline underline-offset-2"
            >
              Open the Support form
            </Link>{" "}
            (or email{" "}
            <a
              href="mailto:support@switchleads.co.uk"
              className="font-semibold text-slate-900 hover:underline underline-offset-2"
            >
              support@switchleads.co.uk
            </a>
            ). We aim to reply within one working day.
          </p>
        </Card>
      </div>
    </ProviderShell>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6">
      <div className="mb-4">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Row({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-900 text-right">{value}</span>
    </div>
  );
}

function BillingSummary({ provider }: { provider: ProviderRow | null | undefined }) {
  if (!provider) return <p className="text-sm text-slate-500">-</p>;

  const lines: Array<{ label: string; value: React.ReactNode }> = [];
  if (provider.pricing_model) lines.push({ label: "Pricing model", value: humanise(provider.pricing_model) });
  if (provider.billing_model) lines.push({ label: "Billing", value: humanise(provider.billing_model) });
  if (provider.per_enrolment_fee != null) {
    lines.push({ label: "Per enrolment", value: `£${provider.per_enrolment_fee}` });
  }
  if (provider.percent_rate != null) {
    const min = provider.min_fee != null ? `£${provider.min_fee}` : "-";
    const max = provider.max_fee != null ? `£${provider.max_fee}` : "-";
    lines.push({ label: "Percent of fee", value: `${provider.percent_rate}% (min ${min}, max ${max})` });
  }
  // free_enrolments_remaining intentionally hidden: the counter never gets
  // decremented (no trigger wired to crm.enrolments), so showing it would
  // mislead providers. Revisit when billing logic hardens and a proper
  // decrement path lands. Tracked: data correctness issue surfaced 2026-05-11.

  if (lines.length === 0) return <p className="text-sm text-slate-500">-</p>;

  return (
    <>
      {lines.map((l, i) => (
        <Row key={i} label={l.label} value={l.value} />
      ))}
    </>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function humanise(snake: string): string {
  return snake.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
