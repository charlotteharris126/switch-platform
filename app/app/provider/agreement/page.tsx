// /provider/agreement — pilot provider sees their PPA at a glance.
//
// Two columns: "Your side" (provider obligations) and "Our side"
// (SwitchLeads obligations). Both read from new crm.providers columns
// (migration 0123 + data-ops 026). Below: link to the full PPA in Notion
// for the canonical text.
//
// RLS: the authenticated provider role can SELECT its own provider row
// via crm.provider_user_provider_id() helper (migration 0096). Admin
// preview reads via the admin client and scopes by URL param.

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";
import { requireProviderUser } from "@/lib/auth/require-provider";
import { ProviderShell } from "../provider-shell";

interface AgreementRow {
  provider_id: string;
  company_name: string;
  agreement_version: "v1" | "v2" | null;
  agreement_signed_at: string | null;
  agreement_notion_page_id: string | null;
  sla_provider_obligations: string[] | null;
  sla_switchleads_obligations: string[] | null;
  billing_model: string | null;
  pricing_model: string | null;
  sla_first_attempt_hours: number;
  sla_attempts_required: number;
  sla_attempt_window_days: number;
  sla_stale_attempt_hours: number;
  sla_presumed_flip_days: number;
  sla_accepted_at: string | null;
  sla_accepted_version: string | null;
}

export default async function ProviderAgreementPage() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) redirect("/provider-login");

  const ctx = await requireProviderUser();

  // Provider context is admin-client-scoped (the crm.provider_users RLS
  // gates self-lookup on this surface).
  const admin = createAdminClient();
  const { data: row } = await admin
    .schema("crm")
    .from("providers")
    .select(
      "provider_id, company_name, agreement_version, agreement_signed_at, agreement_notion_page_id, sla_provider_obligations, sla_switchleads_obligations, billing_model, pricing_model, sla_first_attempt_hours, sla_attempts_required, sla_attempt_window_days, sla_stale_attempt_hours, sla_presumed_flip_days, sla_accepted_at, sla_accepted_version",
    )
    .eq("provider_id", ctx.providerId)
    .maybeSingle<AgreementRow>();

  return (
    <ProviderShell active="agreement">
      <div className="max-w-5xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">Our agreement</h1>
          <p className="text-sm text-slate-500 mt-1">
            The pilot terms you and SwitchLeads signed up to. Full text in Notion,
            quick reference here.
          </p>
        </div>

        {!row ? (
          <EmptyState />
        ) : (
          <>
            <AgreementSummary row={row} />

            <SlaThresholds row={row} />

            <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
              <ObligationsCard
                title="Your side"
                subtitle={`What ${row.company_name} commits to`}
                bullets={row.sla_provider_obligations}
                tone="provider"
              />
              <ObligationsCard
                title="Our side"
                subtitle="What SwitchLeads commits to"
                bullets={row.sla_switchleads_obligations}
                tone="switchleads"
              />
            </div>

            <FullDocLink notionPageId={row.agreement_notion_page_id} />
          </>
        )}
      </div>
    </ProviderShell>
  );
}

function EmptyState() {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-8 text-center">
      <h2 className="text-sm font-semibold text-slate-900">Agreement not loaded yet</h2>
      <p className="text-sm text-slate-500 mt-2">
        We&apos;ve got your record but the summary text hasn&apos;t been pulled in yet.
        Reach out and we&apos;ll sort it.
      </p>
    </div>
  );
}

function AgreementSummary({ row }: { row: AgreementRow }) {
  const signedDate = row.agreement_signed_at
    ? new Date(row.agreement_signed_at).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;
  const versionLabel = row.agreement_version === "v2" ? "PPA v2" : row.agreement_version === "v1" ? "PPA v1" : "Pilot Provider Agreement";

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-slate-900">{versionLabel}</h2>
        {signedDate && (
          <span className="text-xs text-slate-500">
            Signed {signedDate}
          </span>
        )}
      </div>
      <p className="text-sm text-slate-700 mt-2">
        The cards below are the in-portal summary of your pilot agreement. The
        full PPA you signed at onboarding is the binding document; if you need
        a fresh copy email{" "}
        <a href="mailto:support@switchleads.co.uk" className="underline">support@switchleads.co.uk</a>.
      </p>
    </div>
  );
}

function ObligationsCard({
  title,
  subtitle,
  bullets,
  tone,
}: {
  title: string;
  subtitle: string;
  bullets: string[] | null;
  tone: "provider" | "switchleads";
}) {
  const headerTone =
    tone === "provider"
      ? "bg-amber-50 text-amber-900 border-amber-200"
      : "bg-emerald-50 text-emerald-900 border-emerald-200";

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className={`px-5 py-3 border-b ${headerTone}`}>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs mt-0.5 opacity-80">{subtitle}</p>
      </div>
      <ul className="p-5 space-y-3">
        {(bullets ?? []).map((b, i) => (
          <li key={i} className="flex gap-2 text-sm text-slate-800">
            <span className="text-slate-400 select-none mt-0.5">•</span>
            <span>{b}</span>
          </li>
        ))}
        {(!bullets || bullets.length === 0) && (
          <li className="text-sm text-slate-500 italic">
            Not yet populated. Ping us if you&apos;d like this filled in now.
          </li>
        )}
      </ul>
    </div>
  );
}

function SlaThresholds({ row }: { row: AgreementRow }) {
  const acceptedDate = row.sla_accepted_at
    ? new Date(row.sla_accepted_at).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

  const items: Array<{ label: string; value: string; hint: string }> = [
    {
      label: "First contact",
      value: `Within ${row.sla_first_attempt_hours}h`,
      hint: "Time you've got from when we route a lead to making first contact.",
    },
    {
      label: "Attempts before giving up",
      value: `${row.sla_attempts_required} attempts over ${row.sla_attempt_window_days} days`,
      hint: "How many contact attempts before \"cannot reach\" is the right outcome.",
    },
    {
      label: "Retry an attempt by",
      value: `${row.sla_stale_attempt_hours}h after last try`,
      hint: "After this, the portal flags the lead as overdue so it doesn't slip.",
    },
    {
      label: "Auto-flip to presumed",
      value: `${row.sla_presumed_flip_days} days`,
      hint:
        "If a lead's still at Open after this long with no outcome, our system marks it Presumed " +
        (row.agreement_version === "v2" ? "signed" : "enrolled") +
        " and triggers billing (you get a 7-day window to dispute).",
    },
  ];

  return (
    <div className="mt-6 bg-white border border-slate-200 rounded-xl p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold text-slate-900">Your SLA thresholds</h3>
        {acceptedDate && (
          <span className="text-xs text-slate-500">
            Re-confirmed in portal {acceptedDate}
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500 mt-1">
        These drive the badges and reminders you see in the portal. Same
        thresholds the auto-flip cron honours when it bumps stale leads to
        Presumed.
      </p>
      <ul className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        {items.map((it) => (
          <li
            key={it.label}
            className="bg-slate-50 border border-slate-200 rounded-md px-3 py-2"
          >
            <p className="text-[11px] uppercase tracking-wide font-semibold text-slate-500">
              {it.label}
            </p>
            <p className="text-sm font-semibold text-slate-900 mt-0.5">{it.value}</p>
            <p className="text-xs text-slate-600 mt-1">{it.hint}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FullDocLink({ notionPageId }: { notionPageId: string | null }) {
  // Most pilot providers signed via Fillout / the apprenticeship signup
  // page, so the binding PPA was emailed to them at onboarding. The
  // Notion page is our internal canonical copy — kept here as a
  // fallback if Charlotte ever wants to share it directly, but hidden
  // from the provider UI when it's not set.
  if (!notionPageId) return null;
  return (
    <div className="mt-6 bg-slate-50 border border-slate-200 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-slate-900">Reference copy</h3>
      <p className="text-sm text-slate-700 mt-1">
        We keep an internal canonical copy of your PPA here. Your own signed
        copy was emailed to you at onboarding.
      </p>
      <Link
        href={`https://www.notion.so/${notionPageId.replace(/-/g, "")}`}
        target="_blank"
        rel="noopener"
        className="inline-flex items-center mt-3 px-4 py-2 text-sm font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800 cursor-pointer"
      >
        Open in Notion
      </Link>
    </div>
  );
}
