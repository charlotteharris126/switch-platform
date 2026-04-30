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
import { formatDateTime, truncate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { LeadFilters } from "./filters";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import {
  BulkSelectionProvider,
  BulkSelectionMasterCheckbox,
  BulkSelectionRowCheckbox,
  BulkActionBar,
} from "./bulk-selection";

const PAGE_SIZE = 50;

type SearchParams = {
  funding_category?: string;
  funding_route?: string;
  course_id?: string;
  provider?: string;
  dq?: string;
  has_phone?: string;
  routed?: string;
  q?: string;
  from?: string;
  to?: string;
  page?: string;
  show_children?: string;
  // Lifecycle pill filter. Drives the high-level "where in the funnel" view.
  // Values: all | qualified | routed | awaiting | enrolled | lost | dq | archived
  stage?: string;
  // Granular enrolment outcome filter. Only honoured when stage='all' (so it
  // doesn't double-narrow stage views). Values: open | enrolled |
  // presumed_enrolled | cannot_reach | lost. Comma-separated for multi-select.
  lead_status?: string;
  // Comma-separated list of emails to filter by (e.g. pasted from a provider's
  // outcome report). Case-insensitive, exact match. Empty entries ignored.
  emails?: string;
};

const VALID_LEAD_STATUSES = ["open", "enrolled", "presumed_enrolled", "cannot_reach", "lost"] as const;

type Stage = "all" | "qualified" | "routed" | "awaiting" | "enrolled" | "lost" | "dq" | "archived";

const STAGE_LABELS: Record<Stage, string> = {
  all: "All",
  qualified: "Qualified",
  routed: "Routed",
  awaiting: "Awaiting outcome",
  enrolled: "Enrolled",
  lost: "Lost",
  dq: "DQ",
  archived: "Archived",
};

const STAGE_ORDER: Stage[] = ["all", "qualified", "routed", "awaiting", "enrolled", "lost", "dq", "archived"];

function normaliseStage(v: string | undefined): Stage {
  return (STAGE_ORDER as string[]).includes(v ?? "") ? (v as Stage) : "all";
}

type LeadRow = {
  id: number;
  submitted_at: string;
  created_at: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  course_id: string | null;
  funding_category: string | null;
  funding_route: string | null;
  primary_routed_to: string | null;
  is_dq: boolean;
  dq_reason: string | null;
  utm_campaign: string | null;
  re_submission_count: number;
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const stage = normaliseStage(sp.stage);

  const supabase = await createClient();

  // Stages that need a join with crm.enrolments (awaiting / enrolled / lost)
  // pre-fetch the relevant submission IDs so the main query can filter via
  // .in("id", [...]) without a server-side join.
  let stageIdFilter: { in?: number[]; notIn?: number[] } | null = null;
  if (stage === "awaiting" || stage === "enrolled" || stage === "lost") {
    const statuses = stage === "awaiting"
      ? ["enrolled", "presumed_enrolled", "lost", "cannot_reach"]
      : stage === "enrolled"
        ? ["enrolled", "presumed_enrolled"]
        : ["lost"];
    const { data: enrolForStage } = await supabase
      .schema("crm")
      .from("enrolments")
      .select("submission_id")
      .in("status", statuses);
    const ids = ((enrolForStage ?? []) as Array<{ submission_id: number }>).map((r) => r.submission_id);
    if (stage === "awaiting") {
      stageIdFilter = { notIn: ids };
    } else {
      stageIdFilter = { in: ids };
    }
  }

  // Granular lead_status filter (only active when stage='all'). Multi-select
  // via comma-separated values. Pre-fetch submission ids matching any of the
  // requested enrolment statuses.
  let leadStatusIds: number[] | null = null;
  const leadStatusList = stage === "all" && sp.lead_status
    ? sp.lead_status
        .split(",")
        .map((s) => s.trim())
        .filter((s) => (VALID_LEAD_STATUSES as readonly string[]).includes(s))
    : [];
  if (leadStatusList.length > 0) {
    const { data: enrolForLeadStatus } = await supabase
      .schema("crm")
      .from("enrolments")
      .select("submission_id")
      .in("status", leadStatusList);
    leadStatusIds = ((enrolForLeadStatus ?? []) as Array<{ submission_id: number }>).map(
      (r) => r.submission_id,
    );
  }

  // Email paste filter: comma OR newline separated, lowercased, exact match.
  // Active at any stage (it's a hard intent: "show me these specific people").
  const emailList = sp.emails
    ? sp.emails
        .split(/[,\n]/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0)
    : [];

  let q = supabase
    .schema("leads")
    .from("submissions")
    .select(
      "id,submitted_at,created_at,first_name,last_name,email,phone,course_id,funding_category,funding_route,primary_routed_to,is_dq,dq_reason,utm_campaign,re_submission_count",
      { count: "exact" }
    )
    .order("submitted_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  // Default: show one row per unique person. Re-application children and
  // waitlist-enrichment children are hidden so the list isn't cluttered with
  // what looks like duplicates. Drill into a parent's lead detail page to
  // see all child submissions in the re-application banner.
  // Pass ?show_children=yes to override for audit / debugging.
  if (sp.show_children !== "yes") {
    q = q.is("parent_submission_id", null);
  }

  // Stage pill filter. Each value is a self-contained translation into the
  // submissions/enrolments shape. Pills are NOT additive on top of the legacy
  // dq/routed filters.
  if (stage === "qualified") {
    q = q.eq("is_dq", false).is("archived_at", null);
  } else if (stage === "routed") {
    q = q.not("primary_routed_to", "is", null).is("archived_at", null);
  } else if (stage === "awaiting") {
    q = q.not("primary_routed_to", "is", null).is("archived_at", null);
    // exclude submission IDs that already have a terminal-status enrolment row
    if (stageIdFilter?.notIn && stageIdFilter.notIn.length > 0) {
      q = q.not("id", "in", `(${stageIdFilter.notIn.join(",")})`);
    }
  } else if (stage === "enrolled" || stage === "lost") {
    if (stageIdFilter?.in && stageIdFilter.in.length > 0) {
      q = q.in("id", stageIdFilter.in);
    } else {
      // No matching enrolments. Return empty result without throwing.
      q = q.eq("id", -1);
    }
  } else if (stage === "dq") {
    q = q.eq("is_dq", true).is("archived_at", null);
  } else if (stage === "archived") {
    q = q.not("archived_at", "is", null);
  }

  // Legacy (LeadFilters component) only applied when stage is "all" so the
  // pill view doesn't get further narrowed by an unrelated dropdown selection.
  if (stage === "all") {
    if (sp.funding_category) q = q.eq("funding_category", sp.funding_category);
    if (sp.funding_route) q = q.eq("funding_route", sp.funding_route);
    if (sp.course_id) q = q.eq("course_id", sp.course_id);
    if (sp.provider) q = q.eq("primary_routed_to", sp.provider);
    if (sp.dq === "yes") q = q.eq("is_dq", true);
    if (sp.dq === "no") q = q.eq("is_dq", false);
    if (sp.has_phone === "yes") q = q.not("phone", "is", null);
    if (sp.has_phone === "no") q = q.is("phone", null);
    if (sp.routed === "yes") {
      q = q.not("primary_routed_to", "is", null).is("archived_at", null);
    }
    if (sp.routed === "no") {
      q = q.is("primary_routed_to", null).is("archived_at", null);
    }
    if (leadStatusIds !== null) {
      if (leadStatusIds.length > 0) {
        q = q.in("id", leadStatusIds);
      } else {
        q = q.eq("id", -1); // no matching enrolments -> empty result
      }
    }
  }

  if (sp.from) q = q.gte("submitted_at", sp.from);
  if (sp.to) q = q.lte("submitted_at", sp.to);
  if (sp.q) {
    const needle = sp.q.trim();
    q = q.or(
      `email.ilike.%${needle}%,first_name.ilike.%${needle}%,last_name.ilike.%${needle}%`
    );
  }

  // Email paste list: case-insensitive exact match against lower(email).
  // Honoured at every stage so the owner can grab a list from anywhere.
  if (emailList.length > 0) {
    // Supabase doesn't expose ilike-IN; fall back to a series of OR ilike
    // matches. Each value already lowercased; ilike is case-insensitive on
    // the column too.
    const orClauses = emailList.map((e) => `email.ilike.${e}`).join(",");
    q = q.or(orClauses);
  }

  const { data, count, error } = await q;

  // Load filter dropdown options + enrolment statuses for the rows on this page in parallel.
  const submissionIdsOnPage = (data ?? []).map((r: { id: number }) => r.id);
  const [categoriesRes, routesRes, coursesRes, providersRes, enrolmentsRes] = await Promise.all([
    supabase.schema("leads").from("submissions").select("funding_category").not("funding_category", "is", null),
    supabase.schema("leads").from("submissions").select("funding_route").not("funding_route", "is", null),
    supabase.schema("leads").from("submissions").select("course_id").not("course_id", "is", null),
    supabase.schema("crm").from("providers").select("provider_id,company_name").order("company_name"),
    submissionIdsOnPage.length > 0
      ? supabase
          .schema("crm")
          .from("enrolments")
          .select("submission_id, status, lost_reason, disputed_at, last_chaser_at")
          .in("submission_id", submissionIdsOnPage)
      : Promise.resolve({ data: [], error: null }),
  ]);

  // Map submission_id → latest enrolment row for fast lookup in the table render.
  const enrolmentBySubId = new Map<number, { status: string; lost_reason: string | null; disputed_at: string | null; last_chaser_at: string | null }>();
  for (const e of (enrolmentsRes.data ?? []) as Array<{ submission_id: number; status: string; lost_reason: string | null; disputed_at: string | null; last_chaser_at: string | null }>) {
    enrolmentBySubId.set(e.submission_id, { status: e.status, lost_reason: e.lost_reason, disputed_at: e.disputed_at, last_chaser_at: e.last_chaser_at });
  }

  const fundingCategories = Array.from(
    new Set((categoriesRes.data ?? []).map((r: { funding_category: string | null }) => r.funding_category).filter(Boolean))
  ) as string[];
  const fundingRoutes = Array.from(
    new Set((routesRes.data ?? []).map((r: { funding_route: string | null }) => r.funding_route).filter(Boolean))
  ) as string[];
  const courseIds = Array.from(
    new Set((coursesRes.data ?? []).map((r: { course_id: string | null }) => r.course_id).filter(Boolean))
  ) as string[];
  const providers = (providersRes.data ?? []) as { provider_id: string; company_name: string }[];

  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const rows = (data ?? []) as LeadRow[];

  return (
    <div>
      <RealtimeRefresh tables={[{ schema: "leads", table: "submissions" }]} />
      <PageHeader
        eyebrow="Leads"
        title="Lead submissions"
        subtitle={
          error ? (
            <span className="text-[#b3412e]">Error: {error.message}</span>
          ) : (
            <>
              {totalCount.toLocaleString()} total · showing {rows.length} on page {page} of {totalPages}
            </>
          )
        }
      />

      <StagePills active={stage} />

      {stage === "all" ? (
        <LeadFilters
          fundingCategories={fundingCategories}
          fundingRoutes={fundingRoutes}
          courseIds={courseIds}
          providers={providers}
          current={sp}
        />
      ) : null}

      <BulkSelectionProvider rowIds={rows.map((r) => r.id)}>
      <div className="mt-6 bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <BulkSelectionMasterCheckbox />
              </TableHead>
              <TableHead className="w-16">ID</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Course</TableHead>
              <TableHead>Funding</TableHead>
              <TableHead>Lead status</TableHead>
              <TableHead>Last chaser</TableHead>
              <TableHead>Campaign</TableHead>
              <TableHead>Routed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={11} className="text-center text-[#5a6a72] py-10">
                  No leads match these filters.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id} className="hover:bg-[#f4f1ed]/60">
                  <TableCell className="w-10">
                    <BulkSelectionRowCheckbox id={r.id} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/leads/${r.id}`} className="text-[#cd8b76] hover:text-[#b3412e] font-semibold">
                      {r.id}
                    </Link>
                  </TableCell>
                  <TableCell className="text-xs text-[#5a6a72] whitespace-nowrap">
                    {formatDateTime(r.submitted_at)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {[r.first_name, r.last_name].filter(Boolean).join(" ") || "—"}
                  </TableCell>
                  <TableCell className="text-xs text-[#5a6a72]">{truncate(r.email, 30)}</TableCell>
                  <TableCell className="text-xs">{truncate(r.course_id, 28)}</TableCell>
                  <TableCell className="text-xs">
                    {r.funding_category ? (
                      <span>
                        <span className="font-semibold uppercase tracking-wide text-[10px] text-[#143643]">{r.funding_category}</span>
                        {r.funding_route && r.funding_route !== r.funding_category ? (
                          <span className="text-[#5a6a72]"> · {r.funding_route}</span>
                        ) : null}
                      </span>
                    ) : (
                      r.funding_route ?? "—"
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {r.is_dq ? (
                        <Badge variant="destructive" className="text-xs">
                          DQ{r.dq_reason ? `: ${truncate(r.dq_reason, 18)}` : ""}
                        </Badge>
                      ) : r.primary_routed_to ? (
                        // Routed leads: enrolment status badge from crm.enrolments.
                        // Post-0043 every active routed parent has a row; the
                        // fallback below is now dead-code defence for any edge
                        // case (children, race conditions, manual deletes).
                        (() => {
                          const enrol = enrolmentBySubId.get(r.id);
                          if (!enrol) {
                            return (
                              <Badge className="text-xs bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                                Open
                              </Badge>
                            );
                          }
                          const cls = enrolmentBadgeClass(enrol.status);
                          const label = enrol.status.replace(/_/g, " ");
                          return (
                            <>
                              <Badge className={`text-xs ${cls}`}>{label}</Badge>
                              {enrol.disputed_at ? (
                                <Badge className="text-xs bg-[#cd8b76] text-white hover:bg-[#cd8b76]">DISPUTED</Badge>
                              ) : null}
                            </>
                          );
                        })()
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          Unrouted
                        </Badge>
                      )}
                      {r.re_submission_count > 0 && (
                        <Badge className="text-xs bg-[#cd8b76] text-white hover:bg-[#cd8b76]">
                          Reapplied {r.re_submission_count}×
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-[#5a6a72] whitespace-nowrap">
                    {(() => {
                      const enrol = enrolmentBySubId.get(r.id);
                      if (!enrol?.last_chaser_at) return "—";
                      const d = new Date(enrol.last_chaser_at);
                      const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
                      const label = days === 0 ? "today" : days === 1 ? "1d ago" : `${days}d ago`;
                      const cls = days <= 2 ? "text-[#b3412e] font-semibold" : "";
                      return <span className={cls} title={d.toISOString()}>{label}</span>;
                    })()}
                  </TableCell>
                  <TableCell className="text-xs text-[#5a6a72]">{truncate(r.utm_campaign, 20)}</TableCell>
                  <TableCell className="text-xs">{r.primary_routed_to ?? "—"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-[#5a6a72]">
          <span>
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link
                href={buildPageHref(sp, page - 1)}
                className="inline-flex items-center h-8 px-4 rounded-full border border-[#dad4cb] bg-white text-[11px] font-bold uppercase tracking-[0.08em] text-[#143643] hover:bg-[#f4f1ed] hover:border-[#cd8b76]/50"
              >
                Previous
              </Link>
            )}
            {page < totalPages && (
              <Link
                href={buildPageHref(sp, page + 1)}
                className="inline-flex items-center h-8 px-4 rounded-full border border-[#dad4cb] bg-white text-[11px] font-bold uppercase tracking-[0.08em] text-[#143643] hover:bg-[#f4f1ed] hover:border-[#cd8b76]/50"
              >
                Next
              </Link>
            )}
          </div>
        </div>
      )}
      <BulkActionBar />
      </BulkSelectionProvider>
    </div>
  );
}

function StagePills({ active }: { active: Stage }) {
  return (
    <div className="flex flex-wrap gap-2 mb-4">
      {STAGE_ORDER.map((s) => {
        const isActive = s === active;
        const href = s === "all" ? "/leads" : `/leads?stage=${s}`;
        return (
          <Link
            key={s}
            href={href}
            className={
              isActive
                ? "px-3 h-7 inline-flex items-center text-[10px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#cd8b76] text-white border border-[#cd8b76]"
                : "px-3 h-7 inline-flex items-center text-[10px] font-bold uppercase tracking-[0.08em] rounded-full bg-white text-[#143643] border border-[#dad4cb] hover:border-[#cd8b76]/60"
            }
          >
            {STAGE_LABELS[s]}
          </Link>
        );
      })}
    </div>
  );
}

function enrolmentBadgeClass(status: string): string {
  switch (status) {
    // Enrolled = a real win. Bold deep green so it stands out from the routed
    // pale-green and from anything else on the page.
    case "enrolled":          return "bg-emerald-600 text-white hover:bg-emerald-600";
    case "presumed_enrolled": return "bg-[#143643] text-white hover:bg-[#143643]";
    case "cannot_reach":      return "bg-[#cd8b76]/20 text-[#143643] hover:bg-[#cd8b76]/20";
    case "lost":              return "bg-[#dad4cb] text-[#143643] hover:bg-[#dad4cb]";
    // Open = routed, awaiting outcome. Pale green to read as 'in progress'.
    case "open":              return "bg-emerald-100 text-emerald-800 hover:bg-emerald-100";
    default:                  return "bg-[#f4f1ed] text-[#5a6a72] hover:bg-[#f4f1ed]";
  }
}

function buildPageHref(sp: SearchParams, page: number): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k !== "page" && v) params.set(k, v);
  }
  params.set("page", String(page));
  return `/leads?${params.toString()}`;
}
