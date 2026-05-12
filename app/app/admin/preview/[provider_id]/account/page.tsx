// /admin/preview/[provider_id]/account — read-only admin impersonation of
// /provider/account scoped to the target provider.
//
// Mirrors the cards rendered in /provider/account/page.tsx but inline-
// renders the contents (no DisplayNameForm, no TeamPanel write surface)
// so preview mode can't accidentally fire any Server Action.
//
// The viewer-role assumption: previews default to "as if you were a
// provider_admin", since the admin-gated Business + Pricing cards are
// the bits Charlotte most needs to verify before cutover. Toggling
// between admin and user roles is a future option if/when needed.

import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminUser } from "@/lib/auth/require-admin";
import { PreviewHeader } from "../preview-header";
import {
  AgreementSection,
  AGREEMENT_COLUMNS,
  type AgreementRow,
} from "@/app/provider/agreement-section";

interface ProviderRow extends AgreementRow {
  provider_id: string;
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

interface TeamUserRow {
  id: number;
  contact_email: string;
  display_name: string | null;
  role: string;
  status: string;
  invited_at: string;
  last_login_at: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  provider_admin: "Admin",
  provider_user: "User",
};

interface Props {
  params: Promise<{ provider_id: string }>;
}

export default async function PreviewAccountPage({ params }: Props) {
  await requireAdminUser();
  const { provider_id: rawId } = await params;
  const providerId = decodeURIComponent(rawId);

  const admin = createAdminClient();

  const { data: provider } = await admin
    .schema("crm")
    .from("providers")
    .select(`provider_id, company_name, contact_email, contact_phone, pilot_status, billing_model, pricing_model, per_enrolment_fee, percent_rate, min_fee, max_fee, free_enrolments_remaining, is_demo, ${AGREEMENT_COLUMNS}`)
    .eq("provider_id", providerId)
    .maybeSingle<ProviderRow>();
  if (!provider) notFound();

  const { data: teamData } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, contact_email, display_name, role, status, invited_at, last_login_at")
    .eq("provider_id", providerId)
    .neq("status", "removed")
    .order("invited_at", { ascending: true });

  const teamUsers = (teamData ?? []) as TeamUserRow[];

  return (
    <>
      <PreviewHeader
        providerId={providerId}
        companyName={provider.company_name}
        isDemo={provider.is_demo}
        active="account"
      />
      <div className="bg-slate-50 min-h-screen">
        <div className="max-w-3xl mx-auto p-6 space-y-6">
          <div>
            <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">
              {provider.company_name}
            </p>
            <h1 className="text-2xl font-semibold text-slate-900 mt-1">Your account</h1>
            <p className="text-xs text-slate-500 mt-2">
              Showing the admin-role view of /provider/account. Sign-in &amp; security
              and team listings are rendered read-only; Business + Pricing cards
              are visible because providers in the admin role see them.
            </p>
          </div>

          <Card title="Team">
            {teamUsers.length === 0 ? (
              <p className="text-sm text-slate-500">No team users seeded yet. This provider can&apos;t access the portal until a `provider_users` row exists and `portal_enabled` is flipped on.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {teamUsers.map((u) => (
                  <li key={u.id} className="py-3 flex items-baseline justify-between gap-4 text-sm">
                    <div className="min-w-0">
                      <div className="text-slate-900 font-medium truncate">
                        {u.display_name || u.contact_email}
                      </div>
                      {u.display_name && (
                        <div className="text-xs text-slate-500 truncate">{u.contact_email}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-500 whitespace-nowrap">
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-slate-100 text-slate-700 border border-slate-200">
                        {ROLE_LABEL[u.role] ?? u.role}
                      </span>
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide bg-slate-100 text-slate-700 border border-slate-200">
                        {u.status}
                      </span>
                      <span>
                        {u.last_login_at
                          ? `Last login ${formatDate(u.last_login_at)}`
                          : `Invited ${formatDate(u.invited_at)}`}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Sign-in & security" subtitle="How they sign in to the portal.">
            <p className="text-sm text-slate-700">
              Provider users sign in with email and password. On a fresh
              device or browser they enter a short code we email them.
              Day-to-day, cookies keep them signed in.
            </p>
            <p className="text-xs text-slate-500 mt-3">
              Forgotten password: handled via the &quot;Forgot password&quot;
              link on the sign-in page. If they can&apos;t self-serve,
              re-issue the invite from /admin/providers/{providerId}.
            </p>
          </Card>

          <Card title="Your business" subtitle="Admin-only card on the real account page.">
            <Row label="Company" value={provider.company_name} />
            <Row label="Business email" value={provider.contact_email ?? "-"} />
            <Row label="Business phone" value={provider.contact_phone ?? "-"} />
            <Row
              label="Pilot status"
              value={provider.pilot_status ? humanise(provider.pilot_status) : "-"}
            />
            {provider.is_demo && (
              <Row label="" value={<span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-violet-100 text-violet-800 border border-violet-200">Demo provider</span>} />
            )}
          </Card>

          <Card title="Pricing">
            <BillingSummary provider={provider} />
          </Card>

          <Card
            title="Pilot agreement"
            subtitle="Same view the provider sees inside their Account page."
          >
            <AgreementSection row={provider} />
          </Card>
        </div>
      </div>
    </>
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

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-900 text-right">{value}</span>
    </div>
  );
}

function BillingSummary({ provider }: { provider: ProviderRow }) {
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
  // free_enrolments_remaining intentionally hidden (mirrors /provider/account).
  // The counter has no decrement path; surfacing it misleads providers.
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
