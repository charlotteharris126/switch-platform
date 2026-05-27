import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getDemoProviderIds, demoProviderInClause } from "@/lib/demo";
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
  routed?: string;
  /** chased = at least one chaser email or chaser SMS sent (status in
   *  queued/sent/delivered). yes | no. */
  chased?: string;
  q?: string;
  from?: string;
  to?: string;
  page?: string;
  show_children?: string;
  // Granular enrolment outcome filter. Comma-separated for multi-select.
  // Values: see VALID_LEAD_STATUSES below.
  lead_status?: string;
  // Comma-separated list of emails to filter by (e.g. pasted from a provider's
  // outcome report). Case-insensitive, exact match. Empty entries ignored.
  emails?: string;
};

// Status values accepted by the ?lead_status= URL filter. Covers both
// learner and employer state machines.
const VALID_LEAD_STATUSES = [
  // Learner
  "open", "enrolled", "presumed_enrolled", "cannot_reach", "lost",
  "attempt_1_no_answer", "attempt_2_no_answer", "attempt_3_no_answer",
  "enrolment_meeting_booked",
  // Employer (Switchable for Business v1)
  "engaged", "in_progress", "signed", "not_signed", "presumed_employer_signed",
] as const;

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

  const supabase = await createClient();

  // Granular lead_status filter. Multi-select via comma-separated values.
  // Pre-fetch submission ids matching any of the requested enrolment statuses
  // so the main query can filter via .in("id", [...]) without a server-side
  // join.
  let leadStatusIds: number[] | null = null;
  const leadStatusList = sp.lead_status
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

  // Chased filter. "Chased" = at least one chaser email OR chaser SMS sent
  // (queued/sent/delivered) for the submission, any time. Pre-fetch the
  // chased submission_ids; the main query filters via .in("id", [...]) for
  // chased=yes or .not("id", "in", ...) for chased=no.
  let chasedIds: Set<number> | null = null;
  if (sp.chased === "yes" || sp.chased === "no") {
    const HEALTHY = ["queued", "sent", "delivered"];
    const [chasedEmailRes, chasedSmsRes] = await Promise.all([
      supabase
        .schema("crm")
        .from("email_log")
        .select("submission_id")
        .in("email_type", ["chaser_funded", "chaser_self", "s4b_employer_chaser"])
        .in("status", HEALTHY),
      supabase
        .schema("crm")
        .from("sms_log")
        .select("submission_id")
        .eq("comm_type", "chaser_call_attempt")
        .in("status", HEALTHY),
    ]);
    chasedIds = new Set<number>();
    for (const r of (chasedEmailRes.data ?? []) as Array<{ submission_id: number }>) {
      chasedIds.add(r.submission_id);
    }
    for (const r of (chasedSmsRes.data ?? []) as Array<{ submission_id: number }>) {
      chasedIds.add(r.submission_id);
    }
  }

  // Email paste filter: comma OR newline separated, lowercased, exact match.
  // Active at any stage (it's a hard intent: "show me these specific people").
  const emailList = sp.emails
    ? sp.emails
        .split(/[,\n]/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.length > 0)
    : [];

  // Demo-data fence: exclude submissions routed to demo providers from the
  // real lead list. Demo leads are accessible by drilling down from
  // /admin/providers/<demo-provider-id> — see lib/demo.ts.
  const demoIds = await getDemoProviderIds(supabase);
  const demoInClause = demoProviderInClause(demoIds);

  let q = supabase
    .schema("leads")
    .from("submissions")
    .select(
      "id,submitted_at,created_at,first_name,last_name,email,phone,course_id,funding_category,funding_route,primary_routed_to,is_dq,dq_reason,utm_campaign,re_submission_count",
      { count: "exact" }
    )
    .order("submitted_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (demoInClause) {
    q = q.or(`primary_routed_to.is.null,primary_routed_to.not.in.${demoInClause}`);
  }

  // Default: show one row per unique person. Re-application children and
  // waitlist-enrichment children are hidden so the list isn't cluttered with
  // what looks like duplicates. Drill into a parent's lead detail page to
  // see all child submissions in the re-application banner.
  // Pass ?show_children=yes to override for audit / debugging.
  if (sp.show_children !== "yes") {
    q = q.is("parent_submission_id", null);
  }

  // Archived leads are always hidden from this list (pre-pills the only way to
  // see them was the "Archived" stage pill, removed 2026-05-26). If a need for
  // viewing archived leads resurfaces, add an explicit ?archived=yes toggle.
  q = q.is("archived_at", null);

  if (sp.funding_category) q = q.eq("funding_category", sp.funding_category);
  if (sp.funding_route) q = q.eq("funding_route", sp.funding_route);
  if (sp.course_id) q = q.eq("course_id", sp.course_id);
  if (sp.provider) q = q.eq("primary_routed_to", sp.provider);
  if (sp.dq === "yes") q = q.eq("is_dq", true);
  if (sp.dq === "no") q = q.eq("is_dq", false);
  if (sp.routed === "yes") q = q.not("primary_routed_to", "is", null);
  if (sp.routed === "no") q = q.is("primary_routed_to", null);
  if (leadStatusIds !== null) {
    if (leadStatusIds.length > 0) {
      q = q.in("id", leadStatusIds);
    } else {
      q = q.eq("id", -1); // no matching enrolments -> empty result
    }
  }
  if (chasedIds !== null) {
    const ids = Array.from(chasedIds);
    if (sp.chased === "yes") {
      if (ids.length > 0) q = q.in("id", ids);
      else q = q.eq("id", -1);
    } else if (sp.chased === "no" && ids.length > 0) {
      q = q.not("id", "in", `(${ids.join(",")})`);
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

  // Load filter dropdown options + enrolment statuses + email_log status for the rows on this page in parallel.
  const submissionIdsOnPage = (data ?? []).map((r: { id: number }) => r.id);
  const [categoriesRes, routesRes, coursesRes, providersRes, enrolmentsRes, emailLogRes, smsLogRes] = await Promise.all([
    supabase.schema("leads").from("submissions").select("funding_category").not("funding_category", "is", null),
    supabase.schema("leads").from("submissions").select("funding_route").not("funding_route", "is", null),
    supabase.schema("leads").from("submissions").select("course_id").not("course_id", "is", null),
    supabase.schema("crm").from("providers").select("provider_id,company_name").eq("is_demo", false).order("company_name"),
    submissionIdsOnPage.length > 0
      ? supabase
          .schema("crm")
          .from("enrolments")
          .select("submission_id, status, lost_reason, disputed_at")
          .in("submission_id", submissionIdsOnPage)
      : Promise.resolve({ data: [], error: null }),
    submissionIdsOnPage.length > 0
      ? supabase
          .schema("crm")
          .from("email_log")
          .select("submission_id, email_type, status, triggered_at")
          .in("submission_id", submissionIdsOnPage)
          .order("triggered_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    submissionIdsOnPage.length > 0
      ? supabase
          .schema("crm")
          .from("sms_log")
          .select("submission_id, comm_type, status, triggered_at")
          .in("submission_id", submissionIdsOnPage)
          .order("triggered_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);

  // Map submission_id → latest enrolment row for fast lookup in the table render.
  const enrolmentBySubId = new Map<number, { status: string; lost_reason: string | null; disputed_at: string | null }>();
  for (const e of (enrolmentsRes.data ?? []) as Array<{ submission_id: number; status: string; lost_reason: string | null; disputed_at: string | null }>) {
    enrolmentBySubId.set(e.submission_id, { status: e.status, lost_reason: e.lost_reason, disputed_at: e.disputed_at });
  }

  // Maps derived from the email_log query. The query orders triggered_at DESC,
  // so the first row per (sub_id, email_type) is the latest send.
  // - u1StatusBySubId: latest U1 transactional status, surfaced in the
  //   "U1" column. Folds u1_funded / u1_self (learner) and
  //   s4b_employer_u1 (employer) into one badge — the dashboard surface
  //   only cares that a welcome went out, not which audience-specific
  //   template fired.
  // - lastChaserBySubId: latest chaser triggered_at over healthy delivery
  //   statuses, replaces the dropped crm.enrolments.last_chaser_at column
  //   (migration 0086, Phase 4 closeout). chaser_funded / chaser_self
  //   (learner) and s4b_employer_chaser (employer) are all folded into
  //   one timestamp here — the column shows "when did we last chase",
  //   not "which template".
  const HEALTHY_CHASER_STATUSES = new Set(["sent", "delivered", "opened", "clicked"]);
  const u1StatusBySubId = new Map<number, string>();
  const lastEmailChaserBySubId = new Map<number, string>();
  for (const e of (emailLogRes.data ?? []) as Array<{ submission_id: number; email_type: string; status: string; triggered_at: string }>) {
    if (e.email_type === "u1_funded" || e.email_type === "u1_self" || e.email_type === "s4b_employer_u1") {
      if (!u1StatusBySubId.has(e.submission_id)) {
        u1StatusBySubId.set(e.submission_id, e.status);
      }
    }
    if (e.email_type === "chaser_funded" || e.email_type === "chaser_self" || e.email_type === "s4b_employer_chaser") {
      if (HEALTHY_CHASER_STATUSES.has(e.status) && !lastEmailChaserBySubId.has(e.submission_id)) {
        lastEmailChaserBySubId.set(e.submission_id, e.triggered_at);
      }
    }
  }

  // Last SMS chaser timestamp per submission. SMS chaser fires once per learner
  // on attempt_1_no_answer (via crm.sms_log comm_type='chaser_call_attempt').
  // Healthy statuses for SMS are 'sent' / 'delivered' (no opened/clicked
  // equivalent for SMS — webhooks aren't wired for those yet). Mirrors the
  // email-chaser column shape.
  const HEALTHY_SMS_STATUSES = new Set(["sent", "delivered"]);
  const lastSmsChaserBySubId = new Map<number, string>();
  for (const s of (smsLogRes.data ?? []) as Array<{ submission_id: number; comm_type: string; status: string; triggered_at: string }>) {
    if (s.comm_type === "chaser_call_attempt"
      && HEALTHY_SMS_STATUSES.has(s.status)
      && !lastSmsChaserBySubId.has(s.submission_id)
    ) {
      lastSmsChaserBySubId.set(s.submission_id, s.triggered_at);
    }
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

      <LeadFilters
        fundingCategories={fundingCategories}
        fundingRoutes={fundingRoutes}
        courseIds={courseIds}
        providers={providers}
        current={sp}
      />

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
              <TableHead>U1</TableHead>
              <TableHead>Last email chaser</TableHead>
              <TableHead>Last SMS chaser</TableHead>
              <TableHead>Campaign</TableHead>
              <TableHead>Matched to</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={13} className="text-center text-[#5a6a72] py-10">
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
                  <TableCell className="text-xs">
                    {(() => {
                      // Phase 2 U1 parity at-a-glance.
                      // - Routed learner leads should have a u1_funded /
                      //   u1_self row; routed employer leads s4b_employer_u1.
                      // - Pre-Phase-2 leads (anyone routed before 2026-05-05)
                      //   never had a transactional U1 sent. Showing "—" for
                      //   them is the right answer; "missing" would be a false
                      //   positive.
                      // - DQ + unrouted leads correctly never get a U1.
                      const u1 = u1StatusBySubId.get(r.id);
                      if (u1) {
                        const healthy = u1 === "sent" || u1 === "delivered" || u1 === "opened" || u1 === "clicked";
                        const cls = healthy
                          ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100"
                          : "bg-[#b3412e] text-white hover:bg-[#b3412e]";
                        return <Badge className={`text-xs ${cls}`} title={`U1 status: ${u1}`}>{u1}</Badge>;
                      }
                      if (r.is_dq) return <span className="text-[#5a6a72]">—</span>;
                      if (!r.primary_routed_to) return <span className="text-[#5a6a72]">—</span>;
                      // Routed, non-DQ, no U1 row. Pre-2026-05-05 leads land here legitimately.
                      const isPrePhase2 = new Date(r.submitted_at).getTime() < new Date("2026-05-05T12:00:00Z").getTime();
                      if (isPrePhase2) return <span className="text-[#5a6a72]" title="Pre-Phase-2 lead, no transactional U1 expected">—</span>;
                      return <Badge className="text-xs bg-[#b3412e] text-white hover:bg-[#b3412e]" title="Routed Phase-2 lead with no U1 send recorded">missing</Badge>;
                    })()}
                  </TableCell>
                  <TableCell className="text-xs text-[#5a6a72] whitespace-nowrap">
                    {renderRelativeDayCell(lastEmailChaserBySubId.get(r.id))}
                  </TableCell>
                  <TableCell className="text-xs text-[#5a6a72] whitespace-nowrap">
                    {renderRelativeDayCell(lastSmsChaserBySubId.get(r.id))}
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

// Render a relative-day cell for the "Last email chaser" / "Last SMS chaser"
// columns. Compares UK calendar days (not elapsed hours) so "today" means same
// calendar day, not "within last 24h". 0-2 days renders bold red as a stale
// signal; older days render plain. Empty input = em-dash.
function renderRelativeDayCell(triggeredAtIso: string | undefined) {
  if (!triggeredAtIso) return "—";
  const d = new Date(triggeredAtIso);
  const ukKey = (date: Date) =>
    date.toLocaleDateString("en-GB", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "Europe/London",
    });
  const parseEnGb = (s: string) => {
    const [dd, mm, yyyy] = s.split("/").map((p) => Number(p));
    return Date.UTC(yyyy, mm - 1, dd);
  };
  const days = Math.round((parseEnGb(ukKey(new Date())) - parseEnGb(ukKey(d))) / 86_400_000);
  const label = days === 0 ? "today" : days === 1 ? "1d ago" : `${days}d ago`;
  const cls = days <= 2 ? "text-[#b3412e] font-semibold" : "";
  return <span className={cls} title={d.toISOString()}>{label}</span>;
}
