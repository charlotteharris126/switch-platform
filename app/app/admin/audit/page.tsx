// /admin/audit — full audit trail across the platform.
//
// Surfaces every row in audit.actions: who did what, when, on which
// table/row, and the before/after values. The audit schema is exposed
// in the Data API and gated by RLS (readonly_analytics SELECT policy).
// Admin client (service role) bypasses RLS so we see everything.
//
// Filters land as URL searchParams so a filtered view can be linked or
// bookmarked. Pagination is offset-based with a 100-row page size; for
// deeper digging the operator can narrow by surface/action/target/date.

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminUser } from "@/lib/auth/require-admin";

interface AuditRow {
  id: number;
  created_at: string;
  actor_user_id: string | null;
  actor_email: string | null;
  surface: "provider" | "admin" | "system" | string;
  action: string;
  target_table: string | null;
  target_id: string | null;
  before_value: Record<string, unknown> | null;
  after_value: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
}

type SurfaceFilter = "all" | "admin" | "provider" | "system";
type RangeFilter = "24h" | "7d" | "30d" | "90d" | "all";

interface Filters {
  surface: SurfaceFilter;
  action: string;
  actor: string;
  target: string;
  range: RangeFilter;
  page: number;
}

const PAGE_SIZE = 100;
const RANGE_HOURS: Record<RangeFilter, number | null> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
  "90d": 24 * 90,
  all: null,
};

interface Props {
  searchParams: Promise<{
    surface?: string;
    action?: string;
    actor?: string;
    target?: string;
    range?: string;
    page?: string;
  }>;
}

export default async function AuditPage({ searchParams }: Props) {
  await requireAdminUser();

  const raw = await searchParams;
  const filters: Filters = {
    surface: parseSurface(raw.surface),
    action: typeof raw.action === "string" ? raw.action.trim() : "",
    actor: typeof raw.actor === "string" ? raw.actor.trim() : "",
    target: typeof raw.target === "string" ? raw.target.trim() : "",
    range: parseRange(raw.range),
    page: Math.max(0, parseInt(raw.page ?? "0", 10) || 0),
  };

  const admin = createAdminClient();
  let query = admin
    .schema("audit")
    .from("actions")
    .select(
      "id, created_at, actor_user_id, actor_email, surface, action, target_table, target_id, before_value, after_value, context",
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (filters.surface !== "all") query = query.eq("surface", filters.surface);
  if (filters.action) query = query.ilike("action", `%${filters.action}%`);
  if (filters.actor) query = query.ilike("actor_email", `%${filters.actor}%`);
  if (filters.target) query = query.ilike("target_table", `%${filters.target}%`);
  const rangeHours = RANGE_HOURS[filters.range];
  if (rangeHours != null) {
    const cutoff = new Date(Date.now() - rangeHours * 60 * 60 * 1000).toISOString();
    query = query.gte("created_at", cutoff);
  }

  const fromRow = filters.page * PAGE_SIZE;
  const toRow = fromRow + PAGE_SIZE - 1;
  query = query.range(fromRow, toRow);

  const { data: rowsRaw, count, error } = await query;
  const rows = (rowsRaw ?? []) as AuditRow[];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="max-w-7xl space-y-6">
      <div>
        <h1 className="text-[28px] font-extrabold text-[#11242e] tracking-tight">
          Audit trail
        </h1>
        <p className="text-sm text-[#5a6a72] mt-1">
          Every recorded action on the platform — admin moves, provider portal
          activity, system jobs. Most recent first. {total.toLocaleString()}{" "}
          total rows match this filter.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Filter</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="get" className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <SelectField name="surface" label="Surface" value={filters.surface}>
              <option value="all">All</option>
              <option value="admin">Admin</option>
              <option value="provider">Provider</option>
              <option value="system">System</option>
            </SelectField>
            <TextField name="action" label="Action contains" value={filters.action} placeholder="mark_outcome" />
            <TextField name="actor" label="Actor email contains" value={filters.actor} placeholder="@switchleads" />
            <TextField name="target" label="Target table contains" value={filters.target} placeholder="crm.enrolments" />
            <SelectField name="range" label="Range" value={filters.range}>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
              <option value="all">All time</option>
            </SelectField>
            <div className="flex items-end gap-2">
              <button
                type="submit"
                className="px-3 py-1.5 bg-[#11242e] text-white rounded-md text-sm font-semibold hover:bg-[#1b3340] transition-colors"
              >
                Apply
              </button>
              <Link
                href="/audit"
                className="px-3 py-1.5 text-[#11242e] border border-[#dde3e6] rounded-md text-sm font-medium hover:bg-[#f4f1ed] transition-colors"
              >
                Reset
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-rose-200 bg-rose-50">
          <CardContent className="pt-4 text-sm text-rose-900">
            Failed to load audit rows: {error.message}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="text-sm text-[#5a6a72] p-6">
              No rows match this filter.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">When</TableHead>
                  <TableHead className="w-24">Surface</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead className="min-w-[24rem]">Change</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <AuditTableRow key={r.id} row={r} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <Pagination
          filters={filters}
          totalPages={totalPages}
          shown={rows.length}
          fromRow={fromRow + 1}
          toRow={fromRow + rows.length}
          total={total}
        />
      )}
    </div>
  );
}

function AuditTableRow({ row }: { row: AuditRow }) {
  const submissionId =
    row.context && typeof row.context === "object" && "submission_id" in row.context
      ? (row.context as { submission_id?: number }).submission_id
      : null;

  return (
    <TableRow>
      <TableCell className="text-xs whitespace-nowrap font-mono align-top">
        {formatDateTime(row.created_at)}
      </TableCell>
      <TableCell className="align-top">
        <SurfaceBadge surface={row.surface} />
      </TableCell>
      <TableCell className="text-xs align-top">
        <div className="text-[#11242e]">{row.actor_email ?? "—"}</div>
      </TableCell>
      <TableCell className="text-xs align-top">
        <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
          {row.action}
        </code>
      </TableCell>
      <TableCell className="text-xs align-top">
        <div className="font-mono text-[11px] text-[#5a6a72]">
          {row.target_table ?? "—"}
        </div>
        {row.target_id && (
          <div className="font-mono text-[11px] text-[#11242e]">
            #{row.target_id}
          </div>
        )}
        {submissionId != null && (
          <div className="text-[11px] mt-1">
            <Link
              href={`/leads/${submissionId}`}
              className="text-[#cd8b76] hover:text-[#b3412e] font-semibold"
            >
              lead #{submissionId} →
            </Link>
          </div>
        )}
      </TableCell>
      <TableCell className="align-top">
        <ChangeSummary
          before={row.before_value}
          after={row.after_value}
          context={row.context}
        />
      </TableCell>
    </TableRow>
  );
}

function ChangeSummary({
  before,
  after,
  context,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
}) {
  const beforeEntries = before ? Object.entries(before) : [];
  const afterEntries = after ? Object.entries(after) : [];
  const allKeys = new Set([...beforeEntries.map(([k]) => k), ...afterEntries.map(([k]) => k)]);

  if (allKeys.size === 0 && !context) {
    return <span className="text-xs text-[#5a6a72]">—</span>;
  }

  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-[#11242e] hover:text-[#cd8b76] select-none">
        {summariseChange(before, after, context)}
      </summary>
      <div className="mt-2 space-y-2 border-l-2 border-[#dde3e6] pl-3">
        {allKeys.size > 0 && (
          <div className="space-y-0.5">
            {[...allKeys].map((k) => {
              const b = before?.[k];
              const a = after?.[k];
              return (
                <div key={k} className="font-mono text-[11px]">
                  <span className="text-[#5a6a72]">{k}:</span>{" "}
                  <span className="text-rose-700">{formatJson(b)}</span>
                  {" → "}
                  <span className="text-emerald-700">{formatJson(a)}</span>
                </div>
              );
            })}
          </div>
        )}
        {context && Object.keys(context).length > 0 && (
          <pre className="text-[10px] font-mono text-[#5a6a72] whitespace-pre-wrap break-all max-h-40 overflow-auto">
            {JSON.stringify(context, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}

function summariseChange(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  context: Record<string, unknown> | null,
): string {
  // Most common shape: status change. Surface it inline so the operator
  // doesn't have to expand every row to see what moved.
  if (before && "status" in before && after && "status" in after) {
    const b = String(before.status);
    const a = String(after.status);
    if (b !== a) return `status: ${b} → ${a}`;
  }
  if (!before && after && Object.keys(after).length > 0) {
    return `set ${Object.keys(after).join(", ")}`;
  }
  if (before && !after && Object.keys(before).length > 0) {
    return `cleared ${Object.keys(before).join(", ")}`;
  }
  if (context && "bulk_mode" in context) {
    return `bulk ${(context as { bulk_mode?: string }).bulk_mode ?? ""}`;
  }
  if (before && after) {
    return "changed (click to expand)";
  }
  return "details (click to expand)";
}

function formatJson(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function SurfaceBadge({ surface }: { surface: string }) {
  const tone: Record<string, string> = {
    admin: "bg-blue-100 text-blue-900 border-blue-200",
    provider: "bg-emerald-100 text-emerald-900 border-emerald-200",
    system: "bg-slate-100 text-slate-700 border-slate-200",
  };
  const cls = tone[surface] ?? tone.system;
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${cls}`}
    >
      {surface}
    </span>
  );
}

function TextField({
  name,
  label,
  value,
  placeholder,
}: {
  name: string;
  label: string;
  value: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-[#5a6a72] mb-1">
        {label}
      </span>
      <input
        type="text"
        name={name}
        defaultValue={value}
        placeholder={placeholder}
        className="w-full border border-[#dde3e6] rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#cd8b76]"
      />
    </label>
  );
}

function SelectField({
  name,
  label,
  value,
  children,
}: {
  name: string;
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] font-semibold uppercase tracking-wide text-[#5a6a72] mb-1">
        {label}
      </span>
      <select
        name={name}
        defaultValue={value}
        className="w-full border border-[#dde3e6] rounded-md px-2 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#cd8b76]"
      >
        {children}
      </select>
    </label>
  );
}

function Pagination({
  filters,
  totalPages,
  shown,
  fromRow,
  toRow,
  total,
}: {
  filters: Filters;
  totalPages: number;
  shown: number;
  fromRow: number;
  toRow: number;
  total: number;
}) {
  const prevHref = filters.page > 0 ? hrefWith(filters, filters.page - 1) : null;
  const nextHref = filters.page < totalPages - 1 ? hrefWith(filters, filters.page + 1) : null;

  return (
    <div className="flex items-center justify-between gap-3 text-xs text-[#5a6a72]">
      <div>
        Showing {shown > 0 ? `${fromRow.toLocaleString()}–${toRow.toLocaleString()}` : "0"}{" "}
        of {total.toLocaleString()}
      </div>
      <div className="flex items-center gap-2">
        {prevHref ? (
          <Link
            href={prevHref}
            className="px-3 py-1 border border-[#dde3e6] rounded-md text-[#11242e] hover:bg-[#f4f1ed] font-medium"
          >
            ← Previous
          </Link>
        ) : (
          <span className="px-3 py-1 text-[#cbd1d3] cursor-not-allowed">← Previous</span>
        )}
        <span className="tabular-nums">
          Page {filters.page + 1} of {totalPages}
        </span>
        {nextHref ? (
          <Link
            href={nextHref}
            className="px-3 py-1 border border-[#dde3e6] rounded-md text-[#11242e] hover:bg-[#f4f1ed] font-medium"
          >
            Next →
          </Link>
        ) : (
          <span className="px-3 py-1 text-[#cbd1d3] cursor-not-allowed">Next →</span>
        )}
      </div>
    </div>
  );
}

function hrefWith(filters: Filters, page: number): string {
  const params = new URLSearchParams();
  if (filters.surface !== "all") params.set("surface", filters.surface);
  if (filters.action) params.set("action", filters.action);
  if (filters.actor) params.set("actor", filters.actor);
  if (filters.target) params.set("target", filters.target);
  if (filters.range !== "30d") params.set("range", filters.range);
  if (page > 0) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/audit?${qs}` : "/audit";
}

function parseSurface(v: string | undefined): SurfaceFilter {
  if (v === "admin" || v === "provider" || v === "system") return v;
  return "all";
}

function parseRange(v: string | undefined): RangeFilter {
  if (v === "24h" || v === "7d" || v === "30d" || v === "90d" || v === "all") return v;
  return "30d";
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
