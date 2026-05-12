// Provider agreement summary — rendered inside /provider/account and
// /admin/preview/[provider_id]/account (it used to be its own /provider/agreement
// page but the standalone nav tab was overkill for what is a once-per-pilot
// reference; lives inside account now so both surfaces show it).
//
// All four sub-components are pure presentational. The parent page is
// responsible for selecting the relevant columns off crm.providers and
// passing them in.

import Link from "next/link";

export interface AgreementRow {
  company_name: string;
  agreement_version: "v1" | "v2" | null;
  agreement_signed_at: string | null;
  agreement_notion_page_id: string | null;
  sla_provider_obligations: string[] | null;
  sla_switchleads_obligations: string[] | null;
  sla_first_attempt_hours: number;
  sla_attempts_required: number;
  sla_attempt_window_days: number;
  sla_stale_attempt_hours: number;
  sla_presumed_flip_days: number;
  sla_accepted_at: string | null;
  sla_accepted_version: string | null;
}

// Comma-joined list of every column this component needs, ready to drop
// into a Supabase .select(...) call. Keeps the column list in one place so
// future additions only have to touch this file.
export const AGREEMENT_COLUMNS =
  "agreement_version, agreement_signed_at, agreement_notion_page_id, sla_provider_obligations, sla_switchleads_obligations, sla_first_attempt_hours, sla_attempts_required, sla_attempt_window_days, sla_stale_attempt_hours, sla_presumed_flip_days, sla_accepted_at, sla_accepted_version";

// Renders flat (no outer card wrapper) — the parent page wraps it in its
// own Card so it sits in the visual rhythm of /provider/account.
export function AgreementSection({ row }: { row: AgreementRow }) {
  const signedDate = row.agreement_signed_at
    ? new Date(row.agreement_signed_at).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;
  const versionLabel =
    row.agreement_version === "v2"
      ? "PPA v2"
      : row.agreement_version === "v1"
        ? "PPA v1"
        : "Pilot Provider Agreement";

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide bg-slate-100 text-slate-800 border border-slate-200">
            {versionLabel}
          </span>
          {signedDate && (
            <span className="text-xs text-slate-500">Signed {signedDate}</span>
          )}
        </div>
        <p className="text-sm text-slate-700 mt-2">
          Quick reference to your pilot agreement. The full PPA you signed at
          onboarding is the binding document; email{" "}
          <a href="mailto:support@switchleads.co.uk" className="underline">
            support@switchleads.co.uk
          </a>{" "}
          if you need a fresh copy.
        </p>
      </div>

      <SlaThresholds row={row} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className={`px-4 py-3 border-b ${headerTone}`}>
        <h4 className="text-sm font-semibold">{title}</h4>
        <p className="text-xs mt-0.5 opacity-80">{subtitle}</p>
      </div>
      <ul className="p-4 space-y-2">
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
      hint: 'How many contact attempts before "cannot reach" is the right outcome.',
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
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <h4 className="text-sm font-semibold text-slate-900">Your SLA thresholds</h4>
        {acceptedDate && (
          <span className="text-xs text-slate-500">
            Re-confirmed in portal {acceptedDate}
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500 mt-1">
        Drives the badges and reminders you see in the portal. Same thresholds
        the auto-flip cron honours when it bumps stale leads to Presumed.
      </p>
      <ul className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
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
  if (!notionPageId) return null;
  return (
    <div>
      <p className="text-sm text-slate-700">
        We keep an internal canonical copy of your PPA. Your own signed copy
        was emailed to you at onboarding.
      </p>
      <Link
        href={`https://www.notion.so/${notionPageId.replace(/-/g, "")}`}
        target="_blank"
        rel="noopener"
        className="inline-flex items-center mt-3 px-4 py-2 text-sm font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800 cursor-pointer"
      >
        Open the PPA in Notion
      </Link>
    </div>
  );
}
