import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatAgo, truncate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { PendingActions } from "./pending-actions";

type SearchParams = {
  provider?: string;
  action?: string;
  column?: string;
  days?: string;
};

const ACTION_LABEL: Record<string, string> = {
  mirrored: "Mirrored",
  queued: "Anomaly",
  note_only: "Note logged",
  ai_suggested: "AI suggested",
  ai_approved: "Approved",
  ai_rejected: "Rejected",
  ai_overridden: "Overridden",
  ai_error: "AI error",
  rejected: "Rejected",
};

const ACTION_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  mirrored: "default",
  ai_approved: "default",
  ai_overridden: "default",
  note_only: "secondary",
  ai_suggested: "outline",
  queued: "destructive",
  ai_error: "destructive",
  ai_rejected: "outline",
  rejected: "destructive",
};

const VALID_ACTIONS = [
  "mirrored",
  "queued",
  "note_only",
  "ai_suggested",
  "ai_approved",
  "ai_rejected",
  "ai_overridden",
  "ai_error",
  "rejected",
] as const;

type EditRow = {
  id: number;
  enrolment_id: number | null;
  submission_id: number | null;
  provider_id: string;
  column_name: string;
  old_value: string | null;
  new_value: string | null;
  editor_email: string | null;
  edited_at: string;
  received_at: string;
  action: string;
  applied_status: string | null;
  ai_summary: string | null;
  ai_confidence: string | null;
  reason: string | null;
};

type PendingRow = {
  id: number;
  enrolment_id: number;
  current_status: string;
  suggested_status: string;
  ai_summary: string | null;
  ai_confidence: string | null;
  created_at: string;
};

type SubmissionRow = { id: number; first_name: string | null; last_name: string | null; course_id: string | null };
type EnrolmentRow = { id: number; submission_id: number; provider_id: string; status: string };
type ProviderRow = { provider_id: string; company_name: string };

export default async function SheetActivityPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const days = Math.min(90, Math.max(1, Number(sp.days) || 7));
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  const supabase = await createClient();

  // Edits in window
  let editsQuery = supabase
    .schema("crm")
    .from("sheet_edits_log")
    .select(
      "id, enrolment_id, submission_id, provider_id, column_name, old_value, new_value, editor_email, edited_at, received_at, action, applied_status, ai_summary, ai_confidence, reason",
    )
    .gte("received_at", since)
    .order("id", { ascending: false })
    .limit(500);

  if (sp.provider) editsQuery = editsQuery.eq("provider_id", sp.provider);
  if (sp.action && (VALID_ACTIONS as readonly string[]).includes(sp.action)) {
    editsQuery = editsQuery.eq("action", sp.action);
  }
  if (sp.column === "Status" || sp.column === "Notes") {
    editsQuery = editsQuery.eq("column_name", sp.column);
  }

  const [{ data: editsData }, { data: pendingData }, { data: providersData }] = await Promise.all([
    editsQuery,
    supabase
      .schema("crm")
      .from("pending_updates")
      .select("id, enrolment_id, current_status, suggested_status, ai_summary, ai_confidence, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
    supabase.schema("crm").from("providers").select("provider_id, company_name").eq("active", true).order("company_name"),
  ]);

  const edits: EditRow[] = (editsData ?? []) as EditRow[];
  const pending: PendingRow[] = (pendingData ?? []) as PendingRow[];
  const providers: ProviderRow[] = (providersData ?? []) as ProviderRow[];

  // Hydrate lead + enrolment context
  const submissionIds = Array.from(
    new Set([
      ...edits.map((e) => e.submission_id).filter((v): v is number => v !== null),
      ...pending.map((p) => p.enrolment_id),
    ]),
  );
  const enrolmentIds = Array.from(
    new Set([
      ...edits.map((e) => e.enrolment_id).filter((v): v is number => v !== null),
      ...pending.map((p) => p.enrolment_id),
    ]),
  );

  const [{ data: enrolmentsData }, { data: submissionsData }] = await Promise.all([
    enrolmentIds.length > 0
      ? supabase
          .schema("crm")
          .from("enrolments")
          .select("id, submission_id, provider_id, status")
          .in("id", enrolmentIds)
      : Promise.resolve({ data: [] as EnrolmentRow[] }),
    submissionIds.length > 0
      ? supabase
          .schema("leads")
          .from("submissions")
          .select("id, first_name, last_name, course_id")
          .in("id", submissionIds)
      : Promise.resolve({ data: [] as SubmissionRow[] }),
  ]);

  const enrolmentMap = new Map<number, EnrolmentRow>();
  for (const e of (enrolmentsData ?? []) as EnrolmentRow[]) enrolmentMap.set(e.id, e);
  // Also map by submission_id for hydrating edits that reference submission_id
  const enrolmentBySub = new Map<string, EnrolmentRow>();
  for (const e of enrolmentMap.values()) {
    enrolmentBySub.set(`${e.submission_id}:${e.provider_id}`, e);
  }
  const submissionMap = new Map<number, SubmissionRow>();
  for (const s of (submissionsData ?? []) as SubmissionRow[]) submissionMap.set(s.id, s);
  const providerMap = new Map<string, ProviderRow>();
  for (const p of providers) providerMap.set(p.provider_id, p);

  // Group edits by lead key (submission_id + provider_id)
  type Group = {
    key: string;
    submission_id: number | null;
    provider_id: string;
    edits: EditRow[];
    latestAt: string;
  };
  const groups = new Map<string, Group>();
  for (const e of edits) {
    const key = `${e.submission_id ?? "x"}:${e.provider_id}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, submission_id: e.submission_id, provider_id: e.provider_id, edits: [], latestAt: e.received_at };
      groups.set(key, g);
    }
    g.edits.push(e);
    if (e.received_at > g.latestAt) g.latestAt = e.received_at;
  }
  const groupList = Array.from(groups.values()).sort((a, b) => (a.latestAt < b.latestAt ? 1 : -1));

  const counts = {
    total: edits.length,
    mirrored: edits.filter((r) => r.action === "mirrored").length,
    anomalies: edits.filter((r) => r.action === "queued" || r.action === "rejected" || r.action === "ai_error").length,
    pendingNow: pending.length,
  };

  return (
    <div className="max-w-6xl space-y-6">
      <RealtimeRefresh
        tables={[
          { schema: "crm", table: "sheet_edits_log" },
          { schema: "crm", table: "pending_updates" },
        ]}
      />

      <PageHeader
        eyebrow="Pipeline"
        title="Provider sheet activity"
        subtitle={
          <span>
            Every edit providers make to Status or Notes flows here. Status edits auto-update the database; Notes edits run through Claude — implied status changes appear below for your call.
          </span>
        }
      />

      <ActivityFilters
        currentProvider={sp.provider ?? null}
        currentAction={sp.action ?? null}
        currentColumn={sp.column ?? null}
        currentDays={days}
        providers={providers}
      />

      {/* Headline tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Tile label="Total edits" value={counts.total} note={`Last ${days}d`} />
        <Tile label="Status mirrored" value={counts.mirrored} note="Auto-applied" tone="good" />
        <Tile label="Anomalies" value={counts.anomalies} note="Need a look" tone={counts.anomalies > 0 ? "warn" : undefined} />
        <Tile label="Awaiting your call" value={counts.pendingNow} note="AI suggestions" tone={counts.pendingNow > 0 ? "warn" : undefined} />
      </div>

      {/* Pending AI suggestions */}
      {pending.length > 0 ? (
        <section>
          <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">
            Awaiting your call ({pending.length})
          </p>
          <div className="space-y-3">
            {pending.map((p) => {
              const enrol = enrolmentMap.get(p.enrolment_id);
              const sub = enrol ? submissionMap.get(enrol.submission_id) : null;
              const prov = enrol ? providerMap.get(enrol.provider_id) : null;
              const leadName = sub
                ? [sub.first_name, sub.last_name].filter(Boolean).join(" ") || `#${sub.id}`
                : `#${p.enrolment_id}`;
              return (
                <div
                  key={p.id}
                  className="bg-white border border-[#dad4cb] rounded-xl p-4 shadow-[0_1px_2px_rgba(17,36,46,0.04)]"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
                    <div>
                      <p className="font-medium">
                        {sub?.id ? (
                          <Link href={`/leads/${sub.id}`} className="text-[#143643] hover:text-[#cd8b76]">
                            {leadName}
                          </Link>
                        ) : (
                          leadName
                        )}
                        <span className="text-xs text-[#5a6a72] ml-2">
                          {prov?.company_name ?? enrol?.provider_id} · {sub?.course_id ?? "—"}
                        </span>
                      </p>
                      <p className="text-xs text-[#5a6a72] mt-1">
                        Current: <span className="font-medium text-[#143643]">{p.current_status}</span>
                        {" · "}
                        Suggested: <span className="font-medium text-[#143643]">{p.suggested_status}</span>
                        {p.ai_confidence ? ` (${p.ai_confidence})` : ""}
                      </p>
                    </div>
                    <span className="text-xs text-[#5a6a72]" title={formatDateTime(p.created_at)}>
                      {formatAgo(p.created_at)}
                    </span>
                  </div>
                  {p.ai_summary ? (
                    <p className="text-sm italic text-[#5a6a72] mb-3">&ldquo;{p.ai_summary}&rdquo;</p>
                  ) : null}
                  <PendingActions pendingUpdateId={p.id} suggestedStatus={p.suggested_status} />
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Activity feed grouped by lead */}
      <section>
        <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">
          Recent activity ({groupList.length} {groupList.length === 1 ? "lead" : "leads"})
        </p>
        {groupList.length === 0 ? (
          <div className="bg-white border border-[#dad4cb] rounded-xl p-8 text-center text-[#5a6a72]">
            No sheet edits in the last {days} day{days === 1 ? "" : "s"}.
          </div>
        ) : (
          <div className="space-y-3">
            {groupList.map((g) => {
              const enrol = g.submission_id !== null ? enrolmentBySub.get(`${g.submission_id}:${g.provider_id}`) : null;
              const sub = g.submission_id !== null ? submissionMap.get(g.submission_id) : null;
              const prov = providerMap.get(g.provider_id);
              const leadName = sub
                ? [sub.first_name, sub.last_name].filter(Boolean).join(" ") || `#${sub.id}`
                : g.submission_id
                  ? `#${g.submission_id}`
                  : "Unknown lead";
              const editCount = g.edits.length;
              return (
                <details
                  key={g.key}
                  className="group bg-white border border-[#dad4cb] rounded-xl shadow-[0_1px_2px_rgba(17,36,46,0.04)] overflow-hidden"
                >
                  <summary className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 bg-[#f4f1ed] cursor-pointer list-none select-none hover:bg-[#ece8e0] [&::-webkit-details-marker]:hidden">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[#5a6a72] text-xs transition-transform group-open:rotate-90">▶</span>
                      <span className="font-medium">{leadName}</span>
                      <span className="text-xs text-[#5a6a72]">
                        {prov?.company_name ?? g.provider_id} · {sub?.course_id ?? "—"}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {editCount} edit{editCount === 1 ? "" : "s"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      {enrol ? (
                        <span>
                          Status: <span className="font-medium text-[#143643]">{enrol.status}</span>
                        </span>
                      ) : null}
                      <span className="text-[#5a6a72]" title={formatDateTime(g.latestAt)}>
                        {formatAgo(g.latestAt)}
                      </span>
                    </div>
                  </summary>
                  <div className="border-t border-[#dad4cb]">
                    {sub?.id ? (
                      <div className="px-4 py-2 text-xs">
                        <Link href={`/leads/${sub.id}`} className="text-[#cd8b76] hover:text-[#b3412e]">
                          Open lead #{sub.id} →
                        </Link>
                      </div>
                    ) : null}
                    <ul className="divide-y divide-[#f0ece6]">
                      {g.edits.map((e) => (
                        <li key={e.id} className="px-4 py-2 flex flex-wrap items-center gap-3 text-sm">
                          <span className="text-xs text-[#5a6a72] w-16 shrink-0" title={formatDateTime(e.received_at)}>
                            {formatAgo(e.received_at)}
                          </span>
                          <Badge variant="outline" className="shrink-0">{e.column_name}</Badge>
                          <span className="flex-1 min-w-0">
                            {e.column_name === "Status" ? (
                              <span>
                                <span className="text-[#5a6a72]">{e.old_value || "—"}</span>
                                {" → "}
                                <span className="font-medium">{e.new_value || "—"}</span>
                              </span>
                            ) : (
                              <span title={e.new_value ?? ""}>{truncate(e.new_value ?? "", 100)}</span>
                            )}
                          </span>
                          <Badge variant={ACTION_VARIANT[e.action] ?? "outline"} className="shrink-0">
                            {ACTION_LABEL[e.action] ?? e.action}
                          </Badge>
                          {e.reason ? (
                            <span className="text-xs text-[#5a6a72] basis-full pl-20" title={e.reason}>
                              {truncate(e.reason, 140)}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: number;
  note: string;
  tone?: "good" | "warn";
}) {
  const valueColor =
    tone === "good"
      ? "text-emerald-700"
      : tone === "warn"
        ? "text-[#cd8b76]"
        : "text-[#143643]";
  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-4 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
      <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-1">{label}</p>
      <p className={`text-2xl font-bold ${valueColor}`}>{value}</p>
      <p className="text-xs text-[#5a6a72] mt-1">{note}</p>
    </div>
  );
}

function ActivityFilters({
  currentProvider,
  currentAction,
  currentColumn,
  currentDays,
  providers,
}: {
  currentProvider: string | null;
  currentAction: string | null;
  currentColumn: string | null;
  currentDays: number;
  providers: ProviderRow[];
}) {
  function buildHref(overrides: Record<string, string | null>): string {
    const params = new URLSearchParams();
    const merged = {
      provider: currentProvider,
      action: currentAction,
      column: currentColumn,
      days: String(currentDays),
      ...overrides,
    };
    for (const [k, v] of Object.entries(merged)) {
      if (v !== null && v !== "" && v !== undefined) params.set(k, String(v));
    }
    const q = params.toString();
    return `/sheet-activity${q ? `?${q}` : ""}`;
  }

  return (
    <div className="flex flex-wrap gap-3 text-sm">
      <FilterGroup label="Provider">
        <FilterPill href={buildHref({ provider: null })} active={!currentProvider}>All</FilterPill>
        {providers.map((p) => (
          <FilterPill
            key={p.provider_id}
            href={buildHref({ provider: p.provider_id })}
            active={currentProvider === p.provider_id}
          >
            {p.company_name}
          </FilterPill>
        ))}
      </FilterGroup>

      <FilterGroup label="Column">
        <FilterPill href={buildHref({ column: null })} active={!currentColumn}>Both</FilterPill>
        <FilterPill href={buildHref({ column: "Status" })} active={currentColumn === "Status"}>Status</FilterPill>
        <FilterPill href={buildHref({ column: "Notes" })} active={currentColumn === "Notes"}>Notes</FilterPill>
      </FilterGroup>

      <FilterGroup label="Result">
        <FilterPill href={buildHref({ action: null })} active={!currentAction}>All</FilterPill>
        <FilterPill href={buildHref({ action: "mirrored" })} active={currentAction === "mirrored"}>Mirrored</FilterPill>
        <FilterPill href={buildHref({ action: "queued" })} active={currentAction === "queued"}>Anomalies</FilterPill>
        <FilterPill href={buildHref({ action: "ai_suggested" })} active={currentAction === "ai_suggested"}>AI suggested</FilterPill>
      </FilterGroup>

      <FilterGroup label="Range">
        {[1, 7, 30].map((d) => (
          <FilterPill key={d} href={buildHref({ days: String(d) })} active={currentDays === d}>
            {d === 1 ? "Today" : `${d}d`}
          </FilterPill>
        ))}
      </FilterGroup>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">{label}</span>
      <div className="flex gap-1">{children}</div>
    </div>
  );
}

function FilterPill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`px-3 py-1 rounded-full text-xs border ${
        active
          ? "bg-[#143643] text-white border-[#143643]"
          : "bg-white text-[#143643] border-[#dad4cb] hover:bg-[#f4f1ed]"
      }`}
    >
      {children}
    </Link>
  );
}
