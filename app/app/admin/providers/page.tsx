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
import { formatDate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";

interface ProviderRow {
  provider_id: string;
  company_name: string;
  contact_name: string | null;
  contact_email: string | null;
  pilot_status: string | null;
  pricing_model: string | null;
  per_enrolment_fee: number | null;
  active: boolean;
  onboarded_at: string | null;
  agreement_signed_at: string | null;
  archived_at: string | null;
}

interface BillingRow {
  provider_id: string;
  total_routed: number;
  confirmed_enrolled: number;
  presumed_enrolled: number;
  cannot_reach: number;
  lost: number;
  still_open: number;
  free_enrolments_used: number;
  free_enrolments_remaining: number;
  billable_count: number;
  conversion_rate_pct: number | null;
}

export default async function ProvidersPage() {
  const supabase = await createClient();

  const [providersRes, billingRes] = await Promise.all([
    supabase
      .schema("crm")
      .from("providers")
      .select("provider_id,company_name,contact_name,contact_email,pilot_status,pricing_model,per_enrolment_fee,active,onboarded_at,agreement_signed_at,archived_at")
      .order("company_name"),
    supabase
      .schema("crm")
      .from("vw_provider_billing_state")
      .select("provider_id, total_routed, confirmed_enrolled, presumed_enrolled, cannot_reach, lost, still_open, free_enrolments_used, free_enrolments_remaining, billable_count, conversion_rate_pct"),
  ]);

  const rows = (providersRes.data ?? []) as ProviderRow[];
  const billingByProvider = new Map<string, BillingRow>();
  for (const b of (billingRes.data ?? []) as BillingRow[]) {
    billingByProvider.set(b.provider_id, b);
  }

  return (
    <div>
      <PageHeader
        eyebrow="Partners"
        title="Providers"
        subtitle={
          providersRes.error ? (
            <span className="text-[#b3412e]">Error: {providersRes.error.message}</span>
          ) : (
            <>{rows.length} provider{rows.length === 1 ? "" : "s"} · billing state derived from real enrolments (auto-updates)</>
          )
        }
      />

      <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead className="text-right">Routed</TableHead>
              <TableHead className="text-right">Enrolled</TableHead>
              <TableHead className="text-right">Conversion</TableHead>
              <TableHead className="text-right">Free left</TableHead>
              <TableHead className="text-right">Billable</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Pricing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-[#5a6a72] py-10">
                  No providers yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((p) => {
                const b = billingByProvider.get(p.provider_id);
                const enrolledTotal = (b?.confirmed_enrolled ?? 0) + (b?.presumed_enrolled ?? 0);
                return (
                  <TableRow key={p.provider_id} className={p.archived_at ? "opacity-60" : ""}>
                    <TableCell>
                      <Link
                        href={`/providers/${encodeURIComponent(p.provider_id)}`}
                        className="text-sm font-medium text-[#143643] hover:text-[#cd8b76]"
                      >
                        {p.company_name}
                      </Link>
                      <div className="text-xs text-[#5a6a72]">
                        {p.contact_name ?? "—"}{p.pilot_status ? (
                          <span className="ml-2"><Badge variant="secondary" className="text-[10px]">{p.pilot_status}</Badge></span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-right font-bold">
                      {b?.total_routed ?? 0}
                    </TableCell>
                    <TableCell className="text-xs text-right">
                      <span className="font-bold text-emerald-700">{b?.confirmed_enrolled ?? 0}</span>
                      {(b?.presumed_enrolled ?? 0) > 0 ? (
                        <span className="text-[#5a6a72]"> + {b?.presumed_enrolled} presumed</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs text-right font-bold text-[#143643]">
                      {b?.conversion_rate_pct === null || b?.conversion_rate_pct === undefined
                        ? "—"
                        : `${b.conversion_rate_pct}%`}
                    </TableCell>
                    <TableCell className="text-xs text-right">
                      <span className={b && b.free_enrolments_remaining === 0 ? "font-bold text-[#cd8b76]" : ""}>
                        {b?.free_enrolments_remaining ?? "—"}
                      </span>
                      <span className="text-[10px] text-[#5a6a72]"> / 3</span>
                    </TableCell>
                    <TableCell className="text-xs text-right">
                      {(b?.billable_count ?? 0) > 0 ? (
                        <span className="font-bold text-[#cd8b76]">{b?.billable_count}</span>
                      ) : (
                        <span className="text-[#5a6a72]">0</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {p.active ? (
                        <Badge className="text-xs bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Active</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">Inactive</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {p.pricing_model ?? "—"}
                      {p.per_enrolment_fee != null && (
                        <div className="text-[#5a6a72]">£{p.per_enrolment_fee}/enrol</div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
