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
};

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

  let q = supabase
    .schema("leads")
    .from("submissions")
    .select(
      "id,submitted_at,created_at,first_name,last_name,email,phone,course_id,funding_category,funding_route,primary_routed_to,is_dq,dq_reason,utm_campaign",
      { count: "exact" }
    )
    .order("submitted_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (sp.funding_category) q = q.eq("funding_category", sp.funding_category);
  if (sp.funding_route) q = q.eq("funding_route", sp.funding_route);
  if (sp.course_id) q = q.eq("course_id", sp.course_id);
  if (sp.provider) q = q.eq("primary_routed_to", sp.provider);
  if (sp.dq === "yes") q = q.eq("is_dq", true);
  if (sp.dq === "no") q = q.eq("is_dq", false);
  if (sp.has_phone === "yes") q = q.not("phone", "is", null);
  if (sp.has_phone === "no") q = q.is("phone", null);
  // "Routed" / "Unrouted" exclude archived rows. Archived rows are owner-test
  // submissions or other deliberately-removed leads that should never appear in
  // active counts. Without this exclusion, retroactively-archived test rows
  // that had primary_routed_to set inflate the routed count above what reaches
  // the providers' sheets.
  if (sp.routed === "yes") {
    q = q.not("primary_routed_to", "is", null).is("archived_at", null);
  }
  if (sp.routed === "no") {
    q = q.is("primary_routed_to", null).is("archived_at", null);
  }
  if (sp.from) q = q.gte("submitted_at", sp.from);
  if (sp.to) q = q.lte("submitted_at", sp.to);
  if (sp.q) {
    const needle = sp.q.trim();
    q = q.or(
      `email.ilike.%${needle}%,first_name.ilike.%${needle}%,last_name.ilike.%${needle}%`
    );
  }

  const { data, count, error } = await q;

  // Load filter dropdown options in parallel with the main query.
  const [categoriesRes, routesRes, coursesRes, providersRes] = await Promise.all([
    supabase.schema("leads").from("submissions").select("funding_category").not("funding_category", "is", null),
    supabase.schema("leads").from("submissions").select("funding_route").not("funding_route", "is", null),
    supabase.schema("leads").from("submissions").select("course_id").not("course_id", "is", null),
    supabase.schema("crm").from("providers").select("provider_id,company_name").order("company_name"),
  ]);

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

      <div className="mt-6 bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">ID</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Course</TableHead>
              <TableHead>Funding</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Routed to</TableHead>
              <TableHead>Campaign</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-[#5a6a72] py-10">
                  No leads match these filters.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id} className="hover:bg-[#f4f1ed]/60">
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
                    {r.is_dq ? (
                      <Badge variant="destructive" className="text-xs">
                        DQ{r.dq_reason ? `: ${truncate(r.dq_reason, 18)}` : ""}
                      </Badge>
                    ) : r.primary_routed_to ? (
                      <Badge className="text-xs bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                        Routed
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs">
                        Unrouted
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{r.primary_routed_to ?? "—"}</TableCell>
                  <TableCell className="text-xs text-[#5a6a72]">{truncate(r.utm_campaign, 20)}</TableCell>
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
    </div>
  );
}

function buildPageHref(sp: SearchParams, page: number): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k !== "page" && v) params.set(k, v);
  }
  params.set("page", String(page));
  return `/leads?${params.toString()}`;
}
