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
import { formatDateTime } from "@/lib/format";
import { EnrolmentOutcomeForm } from "./enrolment-outcome-form";
import { RealtimeRefresh } from "@/components/realtime-refresh";

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const leadId = Number(id);
  if (!Number.isFinite(leadId)) notFound();

  const supabase = await createClient();

  const { data: lead, error } = await supabase
    .schema("leads")
    .from("submissions")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();

  if (error) {
    return (
      <div className="text-[#b3412e]">
        Error loading lead: {error.message}
      </div>
    );
  }
  if (!lead) notFound();

  // Parallel fetch: routing history, dead letter, partial captures on the same session_id, current enrolment outcome.
  const [routingRes, deadLetterRes, partialsRes, enrolmentRes] = await Promise.all([
    supabase
      .schema("leads")
      .from("routing_log")
      .select("*")
      .eq("submission_id", leadId)
      .order("routed_at", { ascending: false }),
    supabase
      .schema("leads")
      .from("dead_letter")
      .select("*")
      .eq("replay_submission_id", leadId)
      .order("received_at", { ascending: false }),
    lead.session_id
      ? supabase
          .schema("leads")
          .from("partials")
          .select("*")
          .eq("session_id", lead.session_id)
          .order("last_seen_at", { ascending: false })
      : Promise.resolve({ data: [] as unknown[], error: null }),
    supabase
      .schema("crm")
      .from("enrolments")
      .select("id, status, notes, status_updated_at, provider_id")
      .eq("submission_id", leadId)
      .order("status_updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const enrolment = (enrolmentRes.data ?? null) as
    | { id: number; status: string; notes: string | null; status_updated_at: string; provider_id: string }
    | null;

  const routing = (routingRes.data ?? []) as Array<{
    id: number;
    provider_id: string;
    routed_at: string;
    delivery_method: string | null;
    delivery_status: string | null;
    delivered_at: string | null;
    route_reason: string | null;
    error_message: string | null;
  }>;

  const deadLetters = (deadLetterRes.data ?? []) as Array<{
    id: number;
    source: string;
    received_at: string;
    error_context: string | null;
    replayed_at: string | null;
  }>;

  const partials = (partialsRes.data ?? []) as Array<{
    id: number;
    form_name: string | null;
    step_reached: number | null;
    is_complete: boolean | null;
    upsert_count: number | null;
    first_seen_at: string;
    last_seen_at: string;
  }>;

  const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "—";

  return (
    <div className="max-w-6xl space-y-6">
      <RealtimeRefresh
        tables={[
          { schema: "leads", table: "submissions" },
          { schema: "leads", table: "routing_log" },
          { schema: "crm", table: "enrolments" },
        ]}
        channel={`rt-lead-${lead.id}`}
      />
      <div>
        <Link href="/leads" className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#cd8b76] hover:text-[#b3412e]">
          ← Back to leads
        </Link>
        <h1 className="text-[28px] font-extrabold text-[#11242e] mt-2 tracking-tight">
          Lead #{lead.id} — {fullName}
        </h1>
        <div className="flex gap-2 mt-2 items-center">
          {lead.is_dq ? (
            <Badge variant="destructive">DQ{lead.dq_reason ? `: ${lead.dq_reason}` : ""}</Badge>
          ) : lead.primary_routed_to ? (
            <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
              Routed to {lead.primary_routed_to}
            </Badge>
          ) : (
            <Badge variant="secondary">Unrouted</Badge>
          )}
          <span className="text-xs text-[#5a6a72]">
            Submitted {formatDateTime(lead.submitted_at)}
          </span>
        </div>
      </div>

      {/* Core fields + routing + attribution in three columns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Contact</CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-2">
            <FieldRow label="First name" value={lead.first_name} />
            <FieldRow label="Last name" value={lead.last_name} />
            <FieldRow label="Email" value={lead.email} />
            <FieldRow label="Phone" value={lead.phone} />
            <FieldRow label="Postcode" value={lead.postcode} />
            <FieldRow label="LA" value={lead.la} />
            <FieldRow label="Region" value={lead.region} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Course + qualification</CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-2">
            <FieldRow label="Course ID" value={lead.course_id} />
            <FieldRow label="Funding category" value={lead.funding_category} />
            <FieldRow label="Funding scheme" value={lead.funding_route} />
            <FieldRow label="Age band" value={lead.age_band} />
            <FieldRow label="Employment" value={lead.employment_status} />
            <FieldRow
              label="Prior L3+"
              value={lead.prior_level_3_or_higher == null ? null : String(lead.prior_level_3_or_higher)}
            />
            <FieldRow
              label="Can start"
              value={lead.can_start_on_intake_date == null ? null : String(lead.can_start_on_intake_date)}
            />
            <FieldRow label="Why this course" value={lead.why_this_course} />
            <FieldRow label="Outcome interest" value={lead.outcome_interest} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Attribution + consent</CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-2">
            <FieldRow label="UTM source" value={lead.utm_source} />
            <FieldRow label="UTM medium" value={lead.utm_medium} />
            <FieldRow label="UTM campaign" value={lead.utm_campaign} />
            <FieldRow label="UTM content" value={lead.utm_content} />
            <FieldRow label="fbclid" value={lead.fbclid} />
            <FieldRow label="gclid" value={lead.gclid} />
            <FieldRow label="Referrer" value={lead.referrer} />
            <FieldRow label="Session ID" value={lead.session_id} />
            <FieldRow label="Terms accepted" value={String(lead.terms_accepted)} />
            <FieldRow label="Marketing opt-in" value={String(lead.marketing_opt_in)} />
          </CardContent>
        </Card>
      </div>

      {/* Enrolment outcome — only visible for non-DQ routed leads */}
      {!lead.is_dq && (
        <EnrolmentOutcomeForm
          submissionId={lead.id}
          currentStatus={enrolment?.status ?? null}
          currentNotes={enrolment?.notes ?? null}
          isRouted={Boolean(lead.primary_routed_to)}
        />
      )}

      {/* Routing log */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Routing history ({routing.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {routing.length === 0 ? (
            <p className="text-xs text-[#5a6a72] p-4">No routing events yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Routed at</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Delivered</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routing.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatDateTime(r.routed_at)}
                    </TableCell>
                    <TableCell className="text-xs">{r.provider_id}</TableCell>
                    <TableCell className="text-xs">{r.delivery_method ?? "—"}</TableCell>
                    <TableCell className="text-xs">
                      {r.delivery_status === "delivered" ? (
                        <Badge className="text-xs bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                          {r.delivery_status}
                        </Badge>
                      ) : r.delivery_status ? (
                        <Badge variant="secondary" className="text-xs">
                          {r.delivery_status}
                        </Badge>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{formatDateTime(r.delivered_at)}</TableCell>
                    <TableCell className="text-xs text-[#5a6a72]">{r.route_reason ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Dead letter */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Error replays ({deadLetters.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {deadLetters.length === 0 ? (
            <p className="text-xs text-[#5a6a72] p-4">No error history for this lead.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Error context</TableHead>
                  <TableHead>Replayed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deadLetters.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatDateTime(d.received_at)}
                    </TableCell>
                    <TableCell className="text-xs">{d.source}</TableCell>
                    <TableCell className="text-xs text-[#5a6a72]">{d.error_context ?? "—"}</TableCell>
                    <TableCell className="text-xs">{formatDateTime(d.replayed_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Partial captures */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Partial captures (same session) ({partials.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!lead.session_id ? (
            <p className="text-xs text-[#5a6a72] p-4">No session_id on this lead.</p>
          ) : partials.length === 0 ? (
            <p className="text-xs text-[#5a6a72] p-4">No partial captures for this session.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>First seen</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Form</TableHead>
                  <TableHead>Step reached</TableHead>
                  <TableHead>Complete</TableHead>
                  <TableHead>Upserts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {partials.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatDateTime(p.first_seen_at)}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatDateTime(p.last_seen_at)}
                    </TableCell>
                    <TableCell className="text-xs">{p.form_name ?? "—"}</TableCell>
                    <TableCell className="text-xs">{p.step_reached ?? "—"}</TableCell>
                    <TableCell className="text-xs">{p.is_complete ? "Yes" : "No"}</TableCell>
                    <TableCell className="text-xs">{p.upsert_count ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Raw payload — collapsed by default */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Raw payload</CardTitle>
        </CardHeader>
        <CardContent>
          <details>
            <summary className="text-xs text-[#5a6a72] cursor-pointer hover:text-[#11242e]">
              Show JSON
            </summary>
            <pre className="text-xs bg-[#11242e] text-[#f4f1ed] p-4 rounded-md mt-2 overflow-auto max-h-96">
              {JSON.stringify(lead.raw_payload, null, 2)}
            </pre>
          </details>
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
