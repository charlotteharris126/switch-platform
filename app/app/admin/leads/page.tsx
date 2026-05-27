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
  /** Chaser filter, split per channel. Values:
   *    email_yes | email_no | sms_yes | sms_no
   *  "yes" = at least one healthy chaser of that channel sent. "no" = none. */
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
  /** Sort mode. submitted (default, newest first) | last_email_chaser |
   *  last_sms_chaser. The chaser sorts order oldest-first with never-chased
   *  leads at the top — chase priority. App-side sort: pre-fetches matching
   *  IDs, orders by chaser timestamp, paginates in JS. Fine at pilot scale. */
  sort?: string;
};

type SortMode = "submitted" | "last_email_chaser" | "last_sms_chaser";
const VALID_SORTS: ReadonlyArray<SortMode> = ["submitted", "last_email_chaser", "last_sms_chaser"];

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

  // Chaser filter. Multi-select, comma-separated list, AND across selected
  // criteria. Values: email_yes (has healthy chaser email) | email_no (none)
  // | sms_yes (has healthy chaser SMS) | sms_no (none). Picking email_yes +
  // sms_no = leads we email-chased but never SMS-chased.
  const VALID_CHASED = ["email_yes", "email_no", "sms_yes", "sms_no"] as const;
  type ChasedCriterion = typeof VALID_CHASED[number];
  const chasedCriteria: ChasedCriterion[] = sp.chased
    ? (sp.chased
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is ChasedCriterion => (VALID_CHASED as readonly string[]).includes(s)))
    : [];
  let emailChasedIds: Set<number> | null = null;
  let smsChasedIds: Set<number> | null = null;
  const needsEmailChased = chasedCriteria.includes("email_yes") || chasedCriteria.includes("email_no");
  const needsSmsChased = chasedCriteria.includes("sms_yes") || chasedCriteria.includes("sms_no");
  if (needsEmailChased || needsSmsChased) {
    // Count ANY log row regardless of status. A failed chaser attempt is
    // still a chase — it means we tried. Treating failed as "not chased"
    // creates a closed loop where leads with bad phones / bounced emails
    // never leave "No chased" because the retry always fails. Charlotte's
    // chase queue stays accurate: she only ever sees leads we haven't tried.
    const [chasedEmailRes, chasedSmsRes] = await Promise.all([
      needsEmailChased
        ? supabase
            .schema("crm")
            .from("email_log")
            .select("submission_id")
            .in("email_type", ["chaser_funded", "chaser_self", "s4b_employer_chaser"])
        : Promise.resolve({ data: [] as Array<{ submission_id: number }>, error: null }),
      needsSmsChased
        ? supabase
            .schema("crm")
            .from("sms_log")
            .select("submission_id")
            .eq("comm_type", "chaser_call_attempt")
        : Promise.resolve({ data: [] as Array<{ submission_id: number }>, error: null }),
    ]);
    if (needsEmailChased) {
      emailChasedIds = new Set<number>();
      for (const r of (chasedEmailRes.data ?? []) as Array<{ submission_id: number }>) {
        emailChasedIds.add(r.submission_id);
      }
    }
    if (needsSmsChased) {
      smsChasedIds = new Set<number>();
      for (const r of (chasedSmsRes.data ?? []) as Array<{ submission_id: number }>) {
        smsChasedIds.add(r.submission_id);
      }
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

  const sort: SortMode = (VALID_SORTS as readonly string[]).includes(sp.sort ?? "")
    ? (sp.sort as SortMode)
    : "submitted";

  // Apply every filter (except pagination and ordering) to a query builder.
  // Reused for the main paginated query AND the all-filtered-ids query that
  // drives chaser-sort.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function applyFilters<T extends { eq: any; is: any; not: any; in: any; or: any; gte: any; lte: any }>(query: T): T {
    let qq: T = query;
    if (demoInClause) {
      qq = (qq as { or: (s: string) => T }).or(`primary_routed_to.is.null,primary_routed_to.not.in.${demoInClause}`);
    }
    if (sp.show_children !== "yes") qq = (qq as { is: (c: string, v: null) => T }).is("parent_submission_id", null);
    qq = (qq as { is: (c: string, v: null) => T }).is("archived_at", null);

    if (sp.funding_category) qq = (qq as { eq: (c: string, v: string) => T }).eq("funding_category", sp.funding_category);
    if (sp.funding_route)    qq = (qq as { eq: (c: string, v: string) => T }).eq("funding_route", sp.funding_route);
    if (sp.course_id)        qq = (qq as { eq: (c: string, v: string) => T }).eq("course_id", sp.course_id);
    if (sp.provider)         qq = (qq as { eq: (c: string, v: string) => T }).eq("primary_routed_to", sp.provider);
    if (sp.dq === "yes")     qq = (qq as { eq: (c: string, v: boolean) => T }).eq("is_dq", true);
    if (sp.dq === "no")      qq = (qq as { eq: (c: string, v: boolean) => T }).eq("is_dq", false);
    if (sp.routed === "yes") qq = (qq as { not: (c: string, op: string, v: null) => T }).not("primary_routed_to", "is", null);
    if (sp.routed === "no")  qq = (qq as { is: (c: string, v: null) => T }).is("primary_routed_to", null);

    if (leadStatusIds !== null) {
      if (leadStatusIds.length > 0) {
        qq = (qq as { in: (c: string, v: number[]) => T }).in("id", leadStatusIds);
      } else {
        qq = (qq as { eq: (c: string, v: number) => T }).eq("id", -1);
      }
    }
    // Each chaser criterion AND-chains as its own filter clause.
    function applyChaserCriterion(qIn: T, ids: Set<number> | null, want: "yes" | "no"): T {
      if (ids === null) return qIn;
      const arr = Array.from(ids);
      if (want === "yes") {
        if (arr.length > 0) return (qIn as { in: (c: string, v: number[]) => T }).in("id", arr);
        return (qIn as { eq: (c: string, v: number) => T }).eq("id", -1);
      }
      if (arr.length > 0) return (qIn as { not: (c: string, op: string, v: string) => T }).not("id", "in", `(${arr.join(",")})`);
      return qIn;
    }
    if (chasedCriteria.includes("email_yes")) qq = applyChaserCriterion(qq, emailChasedIds, "yes");
    if (chasedCriteria.includes("email_no"))  qq = applyChaserCriterion(qq, emailChasedIds, "no");
    if (chasedCriteria.includes("sms_yes"))   qq = applyChaserCriterion(qq, smsChasedIds, "yes");
    if (chasedCriteria.includes("sms_no"))    qq = applyChaserCriterion(qq, smsChasedIds, "no");

    if (sp.from) qq = (qq as { gte: (c: string, v: string) => T }).gte("submitted_at", sp.from);
    if (sp.to)   qq = (qq as { lte: (c: string, v: string) => T }).lte("submitted_at", sp.to);
    if (sp.q) {
      const needle = sp.q.trim();
      qq = (qq as { or: (s: string) => T }).or(
        `email.ilike.%${needle}%,first_name.ilike.%${needle}%,last_name.ilike.%${needle}%`
      );
    }
    if (emailList.length > 0) {
      const orClauses = emailList.map((e) => `email.ilike.${e}`).join(",");
      qq = (qq as { or: (s: string) => T }).or(orClauses);
    }
    return qq;
  }

  const SUBMISSION_COLS =
    "id,submitted_at,created_at,first_name,last_name,email,phone,course_id,funding_category,funding_route,primary_routed_to,is_dq,dq_reason,utm_campaign,re_submission_count";

  let data: LeadRow[] | null = null;
  let count: number | null = null;
  let error: { message: string } | null = null;

  if (sort === "submitted") {
    // Default path: SQL ORDER BY submitted_at DESC + range pagination.
    const q = applyFilters(
      supabase
        .schema("leads")
        .from("submissions")
        .select(SUBMISSION_COLS, { count: "exact" })
        .order("submitted_at", { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1)
    );
    const res = await q;
    data = (res.data ?? null) as LeadRow[] | null;
    count = res.count ?? null;
    error = res.error ? { message: res.error.message } : null;
  } else {
    // Chaser-sort path: fetch all matching IDs, order by chaser timestamp
    // (nulls first → never-chased at the top = needs chasing soonest),
    // paginate in JS, then fetch full submission rows for the page slice.
    const idsRes = await applyFilters(
      supabase.schema("leads").from("submissions").select("id", { count: "exact" })
    );
    const allIds = ((idsRes.data ?? []) as Array<{ id: number }>).map((r) => r.id);

    if (allIds.length === 0) {
      data = [];
      count = 0;
    } else {
      // Latest chaser triggered_at per submission across healthy statuses.
      const HEALTHY = ["queued", "sent", "delivered"];
      const chaserAtBySubId = new Map<number, string>();
      if (sort === "last_email_chaser") {
        const { data: rows } = await supabase
          .schema("crm")
          .from("email_log")
          .select("submission_id, triggered_at")
          .in("submission_id", allIds)
          .in("email_type", ["chaser_funded", "chaser_self", "s4b_employer_chaser"])
          .in("status", HEALTHY)
          .order("triggered_at", { ascending: false });
        for (const r of (rows ?? []) as Array<{ submission_id: number; triggered_at: string }>) {
          if (!chaserAtBySubId.has(r.submission_id)) {
            chaserAtBySubId.set(r.submission_id, r.triggered_at);
          }
        }
      } else {
        const { data: rows } = await supabase
          .schema("crm")
          .from("sms_log")
          .select("submission_id, triggered_at")
          .in("submission_id", allIds)
          .eq("comm_type", "chaser_call_attempt")
          .in("status", HEALTHY)
          .order("triggered_at", { ascending: false });
        for (const r of (rows ?? []) as Array<{ submission_id: number; triggered_at: string }>) {
          if (!chaserAtBySubId.has(r.submission_id)) {
            chaserAtBySubId.set(r.submission_id, r.triggered_at);
          }
        }
      }

      // ascending order with nulls first: never-chased at the top, then
      // oldest chaser, then newest. Ties broken by id ascending for stability.
      const sortedIds = [...allIds].sort((a, b) => {
        const ta = chaserAtBySubId.get(a);
        const tb = chaserAtBySubId.get(b);
        if (!ta && !tb) return a - b;
        if (!ta) return -1;
        if (!tb) return 1;
        if (ta === tb) return a - b;
        return ta < tb ? -1 : 1;
      });

      const pageIds = sortedIds.slice(offset, offset + PAGE_SIZE);
      const { data: subData, error: subErr } = await supabase
        .schema("leads")
        .from("submissions")
        .select(SUBMISSION_COLS)
        .in("id", pageIds);

      const bySubId = new Map<number, LeadRow>();
      for (const r of (subData ?? []) as LeadRow[]) bySubId.set(r.id, r);
      data = pageIds.map((id) => bySubId.get(id)).filter((r): r is LeadRow => !!r);
      count = sortedIds.length;
      error = subErr ? { message: subErr.message } : null;
    }
  }

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
      <RealtimeRefresh
        tables={[
          { schema: "leads", table: "submissions" },
          { schema: "crm",   table: "enrolments" },
          { schema: "crm",   table: "email_log" },
          { schema: "crm",   table: "sms_log" },
        ]}
      />
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
              <TableHead>
                <SortHeader currentSort={sort} target="submitted" sp={sp}>Submitted</SortHeader>
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Course</TableHead>
              <TableHead>Funding</TableHead>
              <TableHead>Lead status</TableHead>
              <TableHead>U1</TableHead>
              <TableHead>
                <SortHeader currentSort={sort} target="last_email_chaser" sp={sp}>Last email chaser</SortHeader>
              </TableHead>
              <TableHead>
                <SortHeader currentSort={sort} target="last_sms_chaser" sp={sp}>Last SMS chaser</SortHeader>
              </TableHead>
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

function SortHeader({
  currentSort,
  target,
  sp,
  children,
}: {
  currentSort: SortMode;
  target: SortMode;
  sp: SearchParams;
  children: React.ReactNode;
}) {
  const isActive = currentSort === target;
  // Clicking an active sort returns to default (submitted). Otherwise switches.
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k !== "page" && k !== "sort" && v) params.set(k, v);
  }
  if (!isActive && target !== "submitted") params.set("sort", target);
  const href = params.toString() ? `/leads?${params.toString()}` : "/leads";
  return (
    <Link
      href={href}
      className={
        isActive
          ? "inline-flex items-center gap-1 text-[#cd8b76] font-semibold"
          : "inline-flex items-center gap-1 hover:text-[#cd8b76]"
      }
    >
      {children}
      <span className="text-[10px]">{isActive ? "▲" : "↕"}</span>
    </Link>
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
