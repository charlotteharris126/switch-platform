// /admin/providers/[id]/audit — audit trail scoped to one provider.
//
// Surfaces every audit.actions row where the provider portal users acted
// (context->>actor_provider_id matches) plus admin/system actions whose
// target is one of this provider's enrolments. Default range is 30 days;
// filterable like the global /audit page.

import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminUser } from "@/lib/auth/require-admin";
import { AuditTable, type AuditRow } from "@/app/admin/audit/audit-table";
import { ProviderTabs } from "../tabs";
import { Badge } from "@/components/ui/badge";

type SurfaceFilter = "all" | "admin" | "provider" | "system";
type RangeFilter = "24h" | "7d" | "30d" | "90d" | "all";

interface Filters {
  surface: SurfaceFilter;
  action: string;
  actor: string;
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
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    surface?: string;
    action?: string;
    actor?: string;
    range?: string;
    page?: string;
  }>;
}

export default async function ProviderAuditPage({ params, searchParams }: Props) {
  await requireAdminUser();

  const { id: raw } = await params;
  const providerId = decodeURIComponent(raw);

  const rawSearch = await searchParams;
  const filters: Filters = {
    surface: parseSurface(rawSearch.surface),
    action: typeof rawSearch.action === "string" ? rawSearch.action.trim() : "",
    actor: typeof rawSearch.actor === "string" ? rawSearch.actor.trim() : "",
    range: parseRange(rawSearch.range),
    page: Math.max(0, parseInt(rawSearch.page ?? "0", 10) || 0),
  };

  const admin = createAdminClient();

  const { data: provider } = await admin
    .schema("crm")
    .from("providers")
    .select("provider_id, company_name, is_demo")
    .eq("provider_id", providerId)
    .maybeSingle<{ provider_id: string; company_name: string; is_demo: boolean }>();
  if (!provider) notFound();

  // Filter: actor_provider_id in the audit row's context JSON equals this
  // provider. Captures every provider-portal action by users belonging to
  // this provider. Admin actions on this provider's data also carry the
  // provider_id in context (set by callers that know they're touching a
  // specific provider's enrolment) — same filter handles both.
  let query = admin
    .schema("audit")
    .from("actions")
    .select(
      "id, created_at, actor_user_id, actor_email, surface, action, target_table, target_id, before_value, after_value, context",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    // Provider scope. context->>'actor_provider_id' = providerId matches
    // both the provider-portal audit writer (audit.log_provider_action,
    // which injects actor_provider_id) and the bulk variant.
    .or(
      `context->>actor_provider_id.eq.${providerId},context->>provider_id.eq.${providerId}`,
    );

  if (filters.surface !== "all") query = query.eq("surface", filters.surface);
  if (filters.action) query = query.ilike("action", `%${filters.action}%`);
  if (filters.actor) query = query.ilike("actor_email", `%${filters.actor}%`);
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
    <div className="max-w-6xl space-y-6">
      <div>
        <Link
          href="/providers"
          className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#cd8b76] hover:text-[#b3412e]"
        >
          ← Back to providers
        </Link>
        <h1 className="text-[28px] font-extrabold text-[#11242e] mt-2 tracking-tight">
          {provider.company_name}
        </h1>
        <div className="flex gap-2 mt-2 items-center">
          <span className="text-xs text-[#5a6a72] font-mono">
            {provider.provider_id}
          </span>
          {provider.is_demo && (
            <Badge className="bg-violet-100 text-violet-800 hover:bg-violet-100">
              Demo
            </Badge>
          )}
        </div>
      </div>

      <ProviderTabs providerId={provider.provider_id} active="audit" />

      <div>
        <h2 className="text-base font-semibold text-[#11242e]">Audit trail</h2>
        <p className="text-sm text-[#5a6a72] mt-1">
          Every recorded action involving {provider.company_name} — portal users
          marking outcomes, admin moves on their leads, system jobs running on
          their data. Most recent first. {total.toLocaleString()} total rows
          match this filter.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Filter</CardTitle>
        </CardHeader>
        <CardContent>
          <form method="get" className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <SelectField name="surface" label="Surface" value={filters.surface}>
              <option value="all">All</option>
              <option value="admin">Admin</option>
              <option value="provider">Provider</option>
              <option value="system">System</option>
            </SelectField>
            <TextField
              name="action"
              label="Action contains"
              value={filters.action}
              placeholder="mark_outcome"
            />
            <TextField
              name="actor"
              label="Actor email contains"
              value={filters.actor}
              placeholder="@example.com"
            />
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
                href={`/providers/${encodeURIComponent(providerId)}/audit`}
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
          <AuditTable rows={rows} />
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <Pagination
          providerId={providerId}
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
  providerId,
  filters,
  totalPages,
  shown,
  fromRow,
  toRow,
  total,
}: {
  providerId: string;
  filters: Filters;
  totalPages: number;
  shown: number;
  fromRow: number;
  toRow: number;
  total: number;
}) {
  const prevHref = filters.page > 0 ? hrefWith(providerId, filters, filters.page - 1) : null;
  const nextHref =
    filters.page < totalPages - 1 ? hrefWith(providerId, filters, filters.page + 1) : null;

  return (
    <div className="flex items-center justify-between gap-3 text-xs text-[#5a6a72]">
      <div>
        Showing{" "}
        {shown > 0
          ? `${fromRow.toLocaleString()}–${toRow.toLocaleString()}`
          : "0"}{" "}
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

function hrefWith(providerId: string, filters: Filters, page: number): string {
  const params = new URLSearchParams();
  if (filters.surface !== "all") params.set("surface", filters.surface);
  if (filters.action) params.set("action", filters.action);
  if (filters.actor) params.set("actor", filters.actor);
  if (filters.range !== "30d") params.set("range", filters.range);
  if (page > 0) params.set("page", String(page));
  const qs = params.toString();
  const base = `/providers/${encodeURIComponent(providerId)}/audit`;
  return qs ? `${base}?${qs}` : base;
}

function parseSurface(v: string | undefined): SurfaceFilter {
  if (v === "admin" || v === "provider" || v === "system") return v;
  return "all";
}

function parseRange(v: string | undefined): RangeFilter {
  if (v === "24h" || v === "7d" || v === "30d" || v === "90d" || v === "all") return v;
  return "30d";
}
