// /provider/account — profile, provider info, passkeys.
//
// Reads provider_users + providers + provider_passkeys via the admin
// (service-role) client. crm.provider_passkeys has no provider-context
// RLS policy, so server-side scoping (provider_user_id match against the
// caller's row) is the trust boundary for the passkey list.
//
// Self-service "add another passkey" is a separate WebAuthn ceremony with
// new API routes — not in this initial pass. For now support issues a
// fresh invite via /admin/providers/[id] when a provider needs an extra
// device.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ProviderShell } from "../provider-shell";
import { PasskeyList } from "./passkey-list";
import { DisplayNameForm } from "./display-name-form";
import { removePasskeyAction, updateDisplayNameAction } from "./actions";

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

interface ProviderRow {
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

interface PasskeyRow {
  id: number;
  nickname: string | null;
  device_type: string | null;
  created_at: string;
  last_used_at: string | null;
  disabled_at: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  provider_admin: "Admin",
  provider_user: "User",
};

export default async function ProviderAccountPage() {
  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) redirect("/passkey-login");

  const admin = createAdminClient();

  const { data: pu } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, provider_id, contact_email, display_name, role, enrolled_at, status, invited_at")
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle<ProviderUserRow>();

  if (!pu) {
    await supabase.auth.signOut();
    redirect("/passkey-login?error=no_active_account");
  }

  // provider + passkeys in parallel — both depend on pu but not on each other.
  const [providerResult, passkeyResult] = await Promise.all([
    admin
      .schema("crm")
      .from("providers")
      .select("company_name, contact_email, contact_phone, pilot_status, billing_model, pricing_model, per_enrolment_fee, percent_rate, min_fee, max_fee, free_enrolments_remaining, is_demo")
      .eq("provider_id", pu.provider_id)
      .maybeSingle<ProviderRow>(),
    admin
      .schema("crm")
      .from("provider_passkeys")
      .select("id, nickname, device_type, created_at, last_used_at, disabled_at")
      .eq("provider_user_id", pu.id)
      .is("disabled_at", null)
      .order("created_at", { ascending: true }),
  ]);

  const provider = providerResult.data;
  const passkeyRowsRaw = passkeyResult.data;

  const passkeyRows = (passkeyRowsRaw ?? []) as PasskeyRow[];

  // Best-effort "this device" tag: most-recently-used active passkey.
  const mostRecent = [...passkeyRows].sort((a, b) => {
    const aTime = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
    const bTime = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
    return bTime - aTime;
  })[0];

  const passkeys = passkeyRows.map((p) => ({
    id: p.id,
    nickname: p.nickname,
    device_type: p.device_type,
    created_at: p.created_at,
    last_used_at: p.last_used_at,
    is_current: mostRecent ? mostRecent.id === p.id : false,
  }));

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
        <Card title="Sign-in & security" subtitle="Your registered passkeys.">
          <PasskeyList passkeys={passkeys} onRemove={removePasskeyAction} />
          <p className="text-xs text-slate-500 mt-4">
            Need another device? Email{" "}
            <a href="mailto:support@switchleads.co.uk" className="font-medium text-slate-700 hover:text-slate-900 underline-offset-2 hover:underline">
              support@switchleads.co.uk
            </a>{" "}
            and we&apos;ll send a fresh invite link.
          </p>
        </Card>

        {/* Provider info */}
        <Card title="Your business" subtitle="What we have on file. Email support@switchleads.co.uk to change anything here.">
          <Row label="Company" value={provider?.company_name ?? "—"} />
          <Row label="Business email" value={provider?.contact_email ?? "—"} />
          <Row label="Business phone" value={provider?.contact_phone ?? "—"} />
          <Row
            label="Pilot status"
            value={provider?.pilot_status ? humanise(provider.pilot_status) : "—"}
          />
          {provider?.is_demo && (
            <Row label="" value={<span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-violet-100 text-violet-800 border border-violet-200">Demo provider</span>} />
          )}
        </Card>

        {/* Billing */}
        <Card title="Pricing">
          <BillingSummary provider={provider} />
        </Card>

        {/* Support */}
        <Card title="Need help?">
          <p className="text-sm text-slate-700">
            Email{" "}
            <a
              href="mailto:support@switchleads.co.uk"
              className="font-semibold text-slate-900 hover:underline underline-offset-2"
            >
              support@switchleads.co.uk
            </a>{" "}
            for anything you can&apos;t do from the portal — billing queries, business
            details to update, lost device, anything else. We aim to get back to you
            within one working day.
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
  if (!provider) return <p className="text-sm text-slate-500">—</p>;

  const lines: Array<{ label: string; value: React.ReactNode }> = [];
  if (provider.pricing_model) lines.push({ label: "Pricing model", value: humanise(provider.pricing_model) });
  if (provider.billing_model) lines.push({ label: "Billing", value: humanise(provider.billing_model) });
  if (provider.per_enrolment_fee != null) {
    lines.push({ label: "Per enrolment", value: `£${provider.per_enrolment_fee}` });
  }
  if (provider.percent_rate != null) {
    const min = provider.min_fee != null ? `£${provider.min_fee}` : "—";
    const max = provider.max_fee != null ? `£${provider.max_fee}` : "—";
    lines.push({ label: "Percent of fee", value: `${provider.percent_rate}% (min ${min}, max ${max})` });
  }
  if (provider.free_enrolments_remaining != null) {
    lines.push({ label: "Free enrolments left", value: provider.free_enrolments_remaining });
  }

  if (lines.length === 0) return <p className="text-sm text-slate-500">—</p>;

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
