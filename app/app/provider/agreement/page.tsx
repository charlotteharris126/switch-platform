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
      "provider_id, company_name, agreement_version, agreement_signed_at, agreement_notion_page_id, sla_provider_obligations, sla_switchleads_obligations, billing_model, pricing_model",
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
        Pilot terms cover the duration of the pilot. The bullets below are a
        short-form reference — the full clause-by-clause text is in your signed
        Notion document.
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

function FullDocLink({ notionPageId }: { notionPageId: string | null }) {
  return (
    <div className="mt-6 bg-slate-50 border border-slate-200 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-slate-900">Full agreement</h3>
      {notionPageId ? (
        <>
          <p className="text-sm text-slate-700 mt-1">
            The complete signed document lives in Notion.
          </p>
          <Link
            href={`https://www.notion.so/${notionPageId.replace(/-/g, "")}`}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center mt-3 px-4 py-2 text-sm font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800 cursor-pointer"
          >
            Open in Notion ↗
          </Link>
        </>
      ) : (
        <p className="text-sm text-slate-500 mt-1 italic">
          The link to your full agreement isn&apos;t wired up yet. Ask us for a
          direct link if you need it.
        </p>
      )}
    </div>
  );
}
