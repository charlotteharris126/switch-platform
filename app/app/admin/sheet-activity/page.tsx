import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatAgo, truncate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { RealtimeRefresh } from "@/components/realtime-refresh";

type SearchParams = {
  provider?: string;
  action?: string;
  column?: string;
  days?: string;
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

  let editsQuery = supabase
    .schema("crm")
    .from("sheet_edits_log")
    .select(
      "id, enrolment_id, submission_id, provider_id, column_name, old_value, new_value, editor_email, edited_at, received_at, action, applied_status, ai_summary, ai_confidence, reason",
      { count: "exact" },
    )
    .gte("received_at", since)
    .order("id", { ascending: false })
    .limit(200);

  if (sp.provider) editsQuery = editsQuery.eq("provider_id", sp.provider);
  if (sp.action && (VALID_ACTIONS as readonly string[]).includes(sp.action)) {
    editsQuery = editsQuery.eq("action", sp.action);
  }
  if (sp.column === "Status" || sp.column === "Notes") {
    editsQuery = editsQuery.eq("column_name", sp.column);
  }

  const [{ data: edits, count }, { data: providers }] = await Promise.all([
    editsQuery,
    supabase.schema("crm").from("providers").select("provider_id, company_name").eq("active", true).order("company_name"),
  ]);

  const editRows: EditRow[] = (edits ?? []) as EditRow[];
  const providerRows: ProviderRow[] = (providers ?? []) as ProviderRow[];

  // Counts for the headline tiles
  const counts = {
    total: editRows.length,
    mirrored: editRows.filter((r) => r.action === "mirrored").length,
    anomalies: editRows.filter((r) => r.action === "queued" || r.action === "rejected" || r.action === "ai_error").length,
    aiSuggested: editRows.filter((r) => r.action === "ai_suggested").length,
  };

  return (
    <div className="max-w-6xl space-y-6">
      <RealtimeRefresh tables={[{ schema: "crm", table: "sheet_edits_log" }]} />

      <PageHeader
        eyebrow="Pipeline"
        title="Provider sheet activity"
        subtitle={
          <span>
            Every edit providers make to the Status or Notes columns flows here. Status edits auto-update the database; Notes edits are logged (Channel B / AI is gated until legal sign-off).
          </span>
        }
      />

      <ActivityFilters
        currentProvider={sp.provider ?? null}
        currentAction={sp.action ?? null}
        currentColumn={sp.column ?? null}
        currentDays={days}
        providers={providerRows}
      />

      {/* Headline tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Tile label="Total edits" value={counts.total} note={`Last ${days}d`} />
        <Tile label="Mirrored" value={counts.mirrored} note="Status changes applied" tone="good" />
        <Tile label="Anomalies" value={counts.anomalies} note="Need a look" tone={counts.anomalies > 0 ? "warn" : undefined} />
        <Tile label="AI suggested" value={counts.aiSuggested} note="Awaiting your approval" />
      </div>

      {/* Activity table */}
      <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Lead</TableHead>
              <TableHead>Column</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>Result</TableHead>
              <TableHead>Note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {editRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-[#5a6a72] py-8">
                  No sheet edits in the last {days} day{days === 1 ? "" : "s"}.
                </TableCell>
              </TableRow>
            ) : (
              editRows.map((r) => {
                const provider = providerRows.find((p) => p.provider_id === r.provider_id);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap text-xs text-[#5a6a72]">
                      <span title={formatDateTime(r.received_at)}>{formatAgo(r.received_at)}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {provider?.company_name ?? r.provider_id}
                    </TableCell>
                    <TableCell>
                      {r.submission_id ? (
                        <Link
                          href={`/leads/${r.submission_id}`}
                          className="text-[#143643] hover:text-[#cd8b76]"
                        >
                          #{r.submission_id}
                        </Link>
                      ) : (
                        <span className="text-[#5a6a72]">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.column_name}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.column_name === "Status" ? (
                        <span>
                          <span className="text-[#5a6a72]">{r.old_value || "—"}</span>
                          {" → "}
                          <span className="font-medium">{r.new_value || "—"}</span>
                        </span>
                      ) : (
                        <span title={r.new_value ?? ""}>{truncate(r.new_value ?? "", 80)}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={ACTION_VARIANT[r.action] ?? "outline"}>
                        {ACTION_LABEL[r.action] ?? r.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-[#5a6a72] max-w-[280px]">
                      {r.reason ?? r.ai_summary ?? ""}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {count !== null && count !== undefined && count > editRows.length ? (
        <p className="text-xs text-[#5a6a72] text-center">
          Showing {editRows.length} most recent of {count} total. Narrow the date range or filter to see older edits.
        </p>
      ) : null}
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
      {/* Provider */}
      <FilterGroup label="Provider">
        <FilterPill href={buildHref({ provider: null })} active={!currentProvider}>
          All
        </FilterPill>
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

      {/* Column */}
      <FilterGroup label="Column">
        <FilterPill href={buildHref({ column: null })} active={!currentColumn}>
          Both
        </FilterPill>
        <FilterPill href={buildHref({ column: "Status" })} active={currentColumn === "Status"}>
          Status
        </FilterPill>
        <FilterPill href={buildHref({ column: "Notes" })} active={currentColumn === "Notes"}>
          Notes
        </FilterPill>
      </FilterGroup>

      {/* Action */}
      <FilterGroup label="Result">
        <FilterPill href={buildHref({ action: null })} active={!currentAction}>
          All
        </FilterPill>
        <FilterPill href={buildHref({ action: "mirrored" })} active={currentAction === "mirrored"}>
          Mirrored
        </FilterPill>
        <FilterPill
          href={buildHref({ action: "queued" })}
          active={currentAction === "queued"}
        >
          Anomalies
        </FilterPill>
        <FilterPill
          href={buildHref({ action: "ai_suggested" })}
          active={currentAction === "ai_suggested"}
        >
          AI suggested
        </FilterPill>
      </FilterGroup>

      {/* Range */}
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
