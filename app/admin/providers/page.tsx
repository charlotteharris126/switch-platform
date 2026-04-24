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

export default async function ProvidersPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema("crm")
    .from("providers")
    .select(
      "provider_id,company_name,contact_name,contact_email,pilot_status,pricing_model,per_enrolment_fee,free_enrolments_remaining,active,onboarded_at,agreement_signed_at,archived_at"
    )
    .order("company_name");

  const rows = (data ?? []) as Array<{
    provider_id: string;
    company_name: string;
    contact_name: string | null;
    contact_email: string | null;
    pilot_status: string | null;
    pricing_model: string | null;
    per_enrolment_fee: number | null;
    free_enrolments_remaining: number | null;
    active: boolean;
    onboarded_at: string | null;
    agreement_signed_at: string | null;
    archived_at: string | null;
  }>;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Providers</h1>
        <p className="text-sm text-slate-500 mt-1">
          {error ? (
            <span className="text-rose-600">Error: {error.message}</span>
          ) : (
            <>{rows.length} providers</>
          )}
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Pilot status</TableHead>
              <TableHead>Pricing</TableHead>
              <TableHead>Free left</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>Agreement signed</TableHead>
              <TableHead>Onboarded</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-slate-500 py-10">
                  No providers yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((p) => (
                <TableRow key={p.provider_id} className={p.archived_at ? "opacity-60" : ""}>
                  <TableCell>
                    <Link
                      href={`/providers/${encodeURIComponent(p.provider_id)}`}
                      className="text-sm font-medium text-blue-600 hover:underline"
                    >
                      {p.company_name}
                    </Link>
                    <div className="text-xs text-slate-500 font-mono">{p.provider_id}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    <div>{p.contact_name ?? "—"}</div>
                    <div className="text-slate-500">{p.contact_email ?? ""}</div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {p.pilot_status ? (
                      <Badge variant="secondary" className="text-xs">
                        {p.pilot_status}
                      </Badge>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {p.pricing_model ?? "—"}
                    {p.per_enrolment_fee != null && (
                      <span className="text-slate-500"> · £{p.per_enrolment_fee}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{p.free_enrolments_remaining ?? "—"}</TableCell>
                  <TableCell>
                    {p.active ? (
                      <Badge className="text-xs bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs">
                        Inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {formatDate(p.agreement_signed_at)}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {formatDate(p.onboarded_at)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
