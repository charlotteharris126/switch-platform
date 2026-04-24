import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
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
import { formatDate, formatDateTime } from "@/lib/format";

export default async function ProviderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: raw } = await params;
  const providerId = decodeURIComponent(raw);

  const supabase = await createClient();

  const { data: provider, error } = await supabase
    .schema("crm")
    .from("providers")
    .select("*")
    .eq("provider_id", providerId)
    .maybeSingle();

  if (error) {
    return <div className="text-[#b3412e]">Error loading provider: {error.message}</div>;
  }
  if (!provider) notFound();

  // Parallel: recent leads routed + provider_courses + enrolments
  const [routingRes, coursesRes, enrolmentsRes] = await Promise.all([
    supabase
      .schema("leads")
      .from("routing_log")
      .select("id,submission_id,routed_at,delivery_method,delivery_status,delivered_at")
      .eq("provider_id", providerId)
      .order("routed_at", { ascending: false })
      .limit(25),
    supabase
      .schema("crm")
      .from("provider_courses")
      .select("*")
      .eq("provider_id", providerId),
    supabase
      .schema("crm")
      .from("enrolments")
      .select("*")
      .eq("provider_id", providerId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  const routing = (routingRes.data ?? []) as Array<{
    id: number;
    submission_id: number;
    routed_at: string;
    delivery_method: string | null;
    delivery_status: string | null;
    delivered_at: string | null;
  }>;
  const courses = (coursesRes.data ?? []) as Array<Record<string, unknown>>;
  const enrolments = (enrolmentsRes.data ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <Link href="/providers" className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#cd8b76] hover:text-[#b3412e]">
          ← Back to providers
        </Link>
        <h1 className="text-[28px] font-extrabold text-[#11242e] mt-2 tracking-tight">{provider.company_name}</h1>
        <div className="flex gap-2 mt-2 items-center">
          {provider.active ? (
            <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Active</Badge>
          ) : (
            <Badge variant="secondary">Inactive</Badge>
          )}
          {provider.pilot_status && <Badge variant="secondary">{provider.pilot_status}</Badge>}
          <span className="text-xs text-[#5a6a72] font-mono">{provider.provider_id}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Contact</CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-2">
            <FieldRow label="Company" value={provider.company_name} />
            <FieldRow label="Contact name" value={provider.contact_name} />
            <FieldRow label="Email" value={provider.contact_email} />
            <FieldRow label="Phone" value={provider.contact_phone} />
            <FieldRow label="CC emails" value={(provider.cc_emails ?? []).join(", ")} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Billing</CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-2">
            <FieldRow label="Pricing model" value={provider.pricing_model} />
            <FieldRow
              label="Per-enrolment fee"
              value={provider.per_enrolment_fee != null ? `£${provider.per_enrolment_fee}` : null}
            />
            <FieldRow
              label="Percent rate"
              value={provider.percent_rate != null ? `${provider.percent_rate}%` : null}
            />
            <FieldRow
              label="Min fee"
              value={provider.min_fee != null ? `£${provider.min_fee}` : null}
            />
            <FieldRow
              label="Max fee"
              value={provider.max_fee != null ? `£${provider.max_fee}` : null}
            />
            <FieldRow label="Free enrolments left" value={String(provider.free_enrolments_remaining ?? "—")} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Integration + dates</CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-2">
            <FieldRow label="Sheet ID" value={provider.sheet_id} />
            <FieldRow label="Sheet webhook" value={provider.sheet_webhook_url} />
            <FieldRow label="CRM webhook" value={provider.crm_webhook_url} />
            <FieldRow label="Agreement signed" value={formatDate(provider.agreement_signed_at)} />
            <FieldRow label="Onboarded" value={formatDate(provider.onboarded_at)} />
            <FieldRow label="Archived" value={formatDate(provider.archived_at)} />
          </CardContent>
        </Card>
      </div>

      {provider.notes && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Notes</CardTitle>
          </CardHeader>
          <CardContent className="text-xs whitespace-pre-wrap text-[#11242e]">
            {provider.notes}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Courses ({courses.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {courses.length === 0 ? (
            <p className="text-xs text-[#5a6a72]">No courses registered.</p>
          ) : (
            <pre className="text-xs bg-[#f4f1ed] p-3 rounded overflow-auto max-h-80">
              {JSON.stringify(courses, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent routing ({routing.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {routing.length === 0 ? (
            <p className="text-xs text-[#5a6a72] p-4">No leads routed yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Routed at</TableHead>
                  <TableHead>Lead</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Delivered</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routing.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatDateTime(r.routed_at)}
                    </TableCell>
                    <TableCell className="text-xs">
                      <Link
                        href={`/leads/${r.submission_id}`}
                        className="text-[#cd8b76] hover:text-[#b3412e] font-semibold font-mono"
                      >
                        #{r.submission_id}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs">{r.delivery_method ?? "—"}</TableCell>
                    <TableCell className="text-xs">{r.delivery_status ?? "—"}</TableCell>
                    <TableCell className="text-xs">{formatDateTime(r.delivered_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Enrolments ({enrolments.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {enrolments.length === 0 ? (
            <p className="text-xs text-[#5a6a72]">No enrolments recorded.</p>
          ) : (
            <pre className="text-xs bg-[#f4f1ed] p-3 rounded overflow-auto max-h-96">
              {JSON.stringify(enrolments, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-[#5a6a72] min-w-32">{label}</span>
      <span className="text-[#11242e] font-mono break-all">{value || "—"}</span>
    </div>
  );
}
