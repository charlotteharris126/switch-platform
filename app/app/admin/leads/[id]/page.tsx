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
import { OwnerTestToggle } from "./owner-test-toggle";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { AdminNotesPanel } from "./admin-notes-panel";
import {
  addAdminLeadNoteAction,
  clearCallbackFlagAction,
  testRoutingEmailAction,
} from "./actions";
import { TestEmailButtons } from "./test-email-buttons";
import { CopyableUrl } from "./copyable-url";
import { getDemoProviderIds } from "@/lib/demo";

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

  // Re-application context: if this lead has a parent, fetch it. If this lead
  // IS a parent (re_submission_count > 0), fetch the children.
  const [parentRes, childrenRes] = await Promise.all([
    lead.parent_submission_id
      ? supabase
          .schema("leads")
          .from("submissions")
          .select("id, submitted_at, primary_routed_to")
          .eq("id", lead.parent_submission_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    lead.re_submission_count > 0
      ? supabase
          .schema("leads")
          .from("submissions")
          .select("id, submitted_at, primary_routed_to")
          .eq("parent_submission_id", leadId)
          .order("submitted_at", { ascending: false })
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);

  const parent = (parentRes.data ?? null) as { id: number; submitted_at: string; primary_routed_to: string | null } | null;
  const children = (childrenRes.data ?? []) as Array<{ id: number; submitted_at: string; primary_routed_to: string | null }>;

  // Parallel fetch: routing history, dead letter, partial captures on the same session_id, current enrolment outcome, email log, fastrack child.
  const [routingRes, deadLetterRes, partialsRes, enrolmentRes, emailLogRes, fastrackRes] = await Promise.all([
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
      .select("id, status, notes, status_updated_at, provider_id, lost_reason, disputed_at, disputed_reason, callback_requested_at")
      .eq("submission_id", leadId)
      .order("status_updated_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .schema("crm")
      .from("email_log")
      .select("id, email_type, channel, template_id, status, brevo_message_id, error_text, metadata, triggered_at, sent_at")
      .eq("submission_id", leadId)
      .order("triggered_at", { ascending: false }),
    // Fastrack child row (lead-to-enrol uplift Phase 2). One per parent in the
    // common case — multiple shouldn't happen but limit(1) on the most recent
    // is defensive. Hidden when null AND lead.fastracked_at is null.
    supabase
      .schema("leads")
      .from("fastrack_submissions")
      .select("id, parent_submission_id, schema_version, submitted_at, cohort_confirmed, transport_help_requested, docs_ready, l3_reconfirmed, l3_mismatch_flag, voice_of_learner_intro, terms_accepted, marketing_opt_in, created_at")
      .eq("parent_submission_id", leadId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const enrolment = (enrolmentRes.data ?? null) as
    | {
        id: number;
        status: string;
        notes: string | null;
        status_updated_at: string;
        provider_id: string;
        lost_reason: string | null;
        disputed_at: string | null;
        disputed_reason: string | null;
        callback_requested_at: string | null;
      }
    | null;

  // Demo flag — surfaces a violet DEMO badge so admin can't mistake a
  // demo lead for real client data.
  const demoProviderIds = await getDemoProviderIds(supabase);
  const isDemoLead = lead.primary_routed_to != null
    && demoProviderIds.includes(lead.primary_routed_to);

  // Notes log — provider + admin notes inline. Newest first.
  const { data: leadNotesRaw } = await supabase
    .schema("crm")
    .from("lead_notes")
    .select("id, body, created_at, author_role, author_display_name")
    .eq("submission_id", leadId)
    .order("created_at", { ascending: false })
    .limit(200);
  const leadNotes = ((leadNotesRaw ?? []) as Array<{
    id: number;
    body: string;
    created_at: string;
    author_role: "provider" | "admin" | "system";
    author_display_name: string | null;
  }>).map((n) => ({
    id: n.id,
    body: n.body,
    created_at: n.created_at,
    author: n.author_display_name ?? "Someone",
    author_role: n.author_role,
  }));

  // Audit activity for this lead — every action recorded against the lead's
  // submission or enrolment. Reads via public.vw_audit_actions (migration
  // 0121) so we don't depend on the audit schema being in Supabase Data
  // API exposed schemas.
  const enrolmentIdString = enrolment ? String(enrolment.id) : null;
  let auditQ = supabase
    .from("vw_audit_actions")
    .select("id, created_at, actor_email, surface, action, target_table, target_id, before_value, after_value, context")
    .order("created_at", { ascending: false })
    .limit(100);
  if (enrolmentIdString) {
    auditQ = auditQ.or(
      `context->>submission_id.eq.${leadId},and(target_table.eq.crm.enrolments,target_id.eq.${enrolmentIdString}),and(target_table.eq.crm.lead_notes)`,
    );
  } else {
    auditQ = auditQ.eq("context->>submission_id", String(leadId));
  }
  const { data: auditRowsRaw } = await auditQ;
  type AuditRow = {
    id: number;
    created_at: string;
    actor_email: string | null;
    surface: "provider" | "admin" | "system" | string;
    action: string;
    target_table: string | null;
    target_id: string | null;
    before_value: Record<string, unknown> | null;
    after_value: Record<string, unknown> | null;
    context: Record<string, unknown> | null;
  };
  const auditRows = ((auditRowsRaw ?? []) as AuditRow[]).filter((r) => {
    // Belt and braces: only keep rows that match this lead either by
    // submission_id in context or by target enrolment_id.
    if (r.context && (r.context as { submission_id?: number }).submission_id === leadId) return true;
    if (
      r.target_table === "crm.enrolments" &&
      enrolmentIdString &&
      r.target_id === enrolmentIdString
    ) return true;
    return false;
  });

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

  const emailLog = (emailLogRes.data ?? []) as Array<{
    id: number;
    email_type: string;
    channel: string;
    template_id: string;
    status: string;
    brevo_message_id: string | null;
    error_text: string | null;
    metadata: Record<string, unknown> | null;
    triggered_at: string;
    sent_at: string | null;
  }>;

  const fastrack = (fastrackRes.data ?? null) as
    | {
        id: number;
        parent_submission_id: number;
        schema_version: string;
        submitted_at: string;
        cohort_confirmed: boolean | null;
        transport_help_requested: boolean | null;
        docs_ready: boolean | null;
        l3_reconfirmed: boolean | null;
        l3_mismatch_flag: boolean;
        voice_of_learner_intro: string | null;
        terms_accepted: boolean;
        marketing_opt_in: boolean;
        created_at: string;
      }
    | null;

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
        <div className="flex gap-2 mt-2 items-center flex-wrap">
          {lead.is_dq ? (
            <Badge variant="destructive">DQ{lead.dq_reason ? `: ${lead.dq_reason}` : ""}</Badge>
          ) : lead.primary_routed_to ? (
            <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
              Routed to {lead.primary_routed_to}
            </Badge>
          ) : (
            <Badge variant="secondary">Unrouted</Badge>
          )}
          {isDemoLead && (
            <Badge className="bg-violet-100 text-violet-800 hover:bg-violet-100 uppercase tracking-wider">
              Demo
            </Badge>
          )}
          {lead.fastracked_at && (
            <Badge className="bg-violet-100 text-violet-800 hover:bg-violet-100">
              Fastracked
            </Badge>
          )}
          <span className="text-xs text-[#5a6a72]">
            Submitted {formatDateTime(lead.submitted_at)}
          </span>
          <OwnerTestToggle submissionId={lead.id} dqReason={lead.dq_reason} />
        </div>
      </div>

      {/* Per-lead links the operator might want to paste straight into
          a hand-written email (Gmail etc.) without going through Brevo.
          Each row shows the URL when its source identifier exists on
          the submission, or an inline "not available, here's why" when
          it doesn't. Same wiring as the SW_FASTRACK_URL +
          SW_REFERRAL_URL Brevo attributes (_shared/route-lead.ts). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Per-lead links</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#5a6a72]">
              Fastrack form
            </p>
            <p className="text-xs text-[#5a6a72]">
              Carries submission context so the fastrack form
              pre-fills correctly. Funded leads only.
            </p>
            {lead.client_nonce ? (
              <CopyableUrl
                url={`https://switchable.org.uk/funded/thank-you/?ref=${encodeURIComponent(lead.client_nonce)}${
                  lead.course_id ? `&course=${encodeURIComponent(lead.course_id)}` : ""
                }&m=${lead.marketing_opt_in ? "1" : "0"}`}
              />
            ) : (
              <p className="text-xs text-[#b3412e] bg-[#fbeae5] border border-[#f4d3c8] rounded px-2 py-1.5">
                {lead.funding_category === "self"
                  ? "Not available — this is a self-funded lead; fastrack is funded-only."
                  : "Not available — submission has no client_nonce. Likely a funded submission from before 7 May 2026 (migration 0087)."}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#5a6a72]">
              Personal referral page
            </p>
            <p className="text-xs text-[#5a6a72]">
              Shows this lead their sharing link with their code
              embedded.
            </p>
            {lead.referral_code ? (
              <CopyableUrl
                url={`https://switchable.org.uk/refer/?ref=${encodeURIComponent(lead.referral_code)}`}
              />
            ) : (
              <p className="text-xs text-[#b3412e] bg-[#fbeae5] border border-[#f4d3c8] rounded px-2 py-1.5">
                Not available — no referral_code on this submission. They&apos;ll
                get one assigned next time route-lead.ts touches the row.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

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
            <FieldRow label="Preferred intake" value={lead.preferred_intake_id} />
            <FieldRow
              label="Acceptable intakes"
              value={
                Array.isArray(lead.acceptable_intake_ids) && lead.acceptable_intake_ids.length > 0
                  ? lead.acceptable_intake_ids.join(", ")
                  : null
              }
            />
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

      {/* Re-application banner */}
      {(parent || children.length > 0) && (
        <Card className="border-[#cd8b76]/60 bg-[#fbf9f5]">
          <CardContent className="pt-4">
            {parent && (
              <p className="text-xs text-[#143643]">
                <span className="font-bold uppercase tracking-wide text-[10px] text-[#cd8b76]">Re-application</span>
                <br />
                This is a follow-up of <Link href={`/leads/${parent.id}`} className="font-bold text-[#cd8b76] hover:underline">lead #{parent.id}</Link> ({formatDateTime(parent.submitted_at)}). Originally routed to {parent.primary_routed_to ?? "—"}.
              </p>
            )}
            {children.length > 0 && (
              <p className="text-xs text-[#143643]">
                <span className="font-bold uppercase tracking-wide text-[10px] text-[#cd8b76]">Reapplied {children.length} time{children.length === 1 ? "" : "s"}</span>
                <br />
                Subsequent submissions:{" "}
                {children.map((c, i) => (
                  <span key={c.id}>
                    <Link href={`/leads/${c.id}`} className="font-bold text-[#cd8b76] hover:underline">#{c.id}</Link>
                    {" "}({formatDateTime(c.submitted_at)})
                    {i < children.length - 1 ? ", " : ""}
                  </span>
                ))}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Fastrack submission — appears when the learner completed the
          /funded/thank-you/ Fastrack form. Surfaces cohort/docs/voice-of-
          learner data for the adviser before any outcome decision. */}
      {(fastrack || lead.fastracked_at) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Fastrack submission</CardTitle>
          </CardHeader>
          <CardContent className="text-xs space-y-2">
            {!fastrack ? (
              <p className="text-[#5a6a72]">
                fastracked_at stamped at {formatDateTime(lead.fastracked_at)} but no child row found — investigate (data inconsistency).
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2 mb-1">
                  {fastrack.l3_mismatch_flag && (
                    <Badge variant="destructive">L3 mismatch (self-reported)</Badge>
                  )}
                  {fastrack.cohort_confirmed === false && (
                    <Badge variant="destructive">Cohort declined</Badge>
                  )}
                  {fastrack.docs_ready === false && (
                    <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
                      Docs gathering needed
                    </Badge>
                  )}
                  {fastrack.transport_help_requested === true && (
                    <Badge className="bg-sky-100 text-sky-800 hover:bg-sky-100">
                      Transport help requested
                    </Badge>
                  )}
                </div>
                <FieldRow label="Submitted" value={formatDateTime(fastrack.submitted_at)} />
                <FieldRow
                  label="Cohort confirmed"
                  value={fastrack.cohort_confirmed == null ? null : fastrack.cohort_confirmed ? "Yes" : "No"}
                />
                <FieldRow
                  label="Transport help"
                  value={fastrack.transport_help_requested == null ? null : fastrack.transport_help_requested ? "Yes" : "No"}
                />
                <FieldRow
                  label="Docs ready"
                  value={fastrack.docs_ready == null ? null : fastrack.docs_ready ? "Yes" : "No"}
                />
                <FieldRow
                  label="L3 reconfirmed"
                  value={fastrack.l3_reconfirmed == null ? null : fastrack.l3_reconfirmed ? "Yes" : "No"}
                />
                <FieldRow label="Marketing opt-in (this submission)" value={String(fastrack.marketing_opt_in)} />
                <FieldRow label="Terms accepted" value={String(fastrack.terms_accepted)} />
                {fastrack.voice_of_learner_intro && (
                  <div className="pt-3 mt-2 border-t border-[#e6e0d8]">
                    <span className="text-[#5a6a72] text-[10px] uppercase tracking-wide font-bold">
                      Voice of learner
                    </span>
                    <p className="text-[#11242e] mt-1 italic break-words">
                      &ldquo;{fastrack.voice_of_learner_intro}&rdquo;
                    </p>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Enrolment outcome — only visible for non-DQ routed leads */}
      {!lead.is_dq && (
        <EnrolmentOutcomeForm
          submissionId={lead.id}
          currentStatus={enrolment?.status ?? null}
          currentNotes={enrolment?.notes ?? null}
          currentLostReason={enrolment?.lost_reason ?? null}
          currentDisputedAt={enrolment?.disputed_at ?? null}
          currentDisputedReason={enrolment?.disputed_reason ?? null}
          isRouted={Boolean(lead.primary_routed_to)}
        />
      )}

      {/* Admin notes panel — visible for all leads. Note compose disabled for unrouted leads. */}
      {!lead.is_dq && (
        <AdminNotesPanel
          submissionId={lead.id}
          notes={leadNotes}
          callbackPendingAt={enrolment?.callback_requested_at ?? null}
          isRouted={Boolean(lead.primary_routed_to)}
          onAdd={addAdminLeadNoteAction}
          onClearCallback={clearCallbackFlagAction}
        />
      )}

      {/* Demo-only test-send buttons for provider-facing emails */}
      {!lead.is_dq && lead.primary_routed_to && isDemoLead && (
        <TestEmailButtons
          submissionId={lead.id}
          onTestRouting={testRoutingEmailAction}
        />
      )}

      {/* Audit activity — every action recorded against this lead */}
      {!lead.is_dq && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Activity ({auditRows.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {auditRows.length === 0 ? (
              <p className="text-xs text-[#5a6a72] p-4">No audit events recorded.</p>
            ) : (
              <ul className="divide-y divide-[#dde3e6]">
                {auditRows.map((r) => (
                  <li key={r.id} className="p-3 text-xs flex items-start gap-3">
                    <div className="shrink-0 w-32">
                      <span className="block text-[#5a6a72] tabular-nums">
                        {formatDateTime(r.created_at)}
                      </span>
                      <SurfaceBadge surface={r.surface} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-[#0e1726]">
                        {humaniseAction(r.action)}
                        {r.actor_email && (
                          <span className="ml-2 font-normal text-[#5a6a72]">by {r.actor_email}</span>
                        )}
                      </p>
                      <AuditDiff before={r.before_value} after={r.after_value} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
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

      {/* Email log (Phase 2 of email rearchitecture). Shows transactional sends
          per crm.email_log. While BREVO_SHADOW_MODE=true, rows have
          metadata.shadow=true to mark parallel-run sends. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Email log ({emailLog.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {emailLog.length === 0 ? (
            <p className="text-xs text-[#5a6a72] p-4">No transactional email sends recorded for this lead.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Triggered</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Brevo ID</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {emailLog.map((e) => {
                  const isHealthy = e.status === "sent" || e.status === "delivered" || e.status === "opened" || e.status === "clicked";
                  const isError = e.status === "failed" || e.status === "bounced_hard" || e.status === "bounced_soft" || e.status === "complained";
                  const meta = e.metadata as { shadow?: boolean; shadow_log_only?: boolean; force_resend?: boolean } | null;
                  const shadow = meta?.shadow === true;
                  const shadowLogOnly = meta?.shadow_log_only === true;
                  const forced = meta?.force_resend === true;
                  return (
                    <TableRow key={e.id}>
                      <TableCell className="text-xs whitespace-nowrap">
                        {formatDateTime(e.triggered_at)}
                      </TableCell>
                      <TableCell className="text-xs font-mono">{e.email_type}</TableCell>
                      <TableCell className="text-xs">{e.channel}</TableCell>
                      <TableCell className="text-xs">
                        {isHealthy ? (
                          <Badge className="text-xs bg-emerald-100 text-emerald-800 hover:bg-emerald-100">{e.status}</Badge>
                        ) : isError ? (
                          <Badge variant="destructive" className="text-xs">{e.status}</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">{e.status}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(e.sent_at)}</TableCell>
                      <TableCell className="text-xs font-mono text-[#5a6a72] break-all max-w-[180px]">
                        {e.brevo_message_id ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-[#5a6a72]">
                        {e.error_text ? (
                          <span className="text-[#b3412e]">{e.error_text}</span>
                        ) : (
                          <>
                            {shadowLogOnly ? (
                              <Badge variant="outline" className="text-[10px] mr-1" title="Logged but not sent — old automation handled the actual send during shadow window">log-only</Badge>
                            ) : shadow ? (
                              <Badge variant="outline" className="text-[10px] mr-1">shadow</Badge>
                            ) : null}
                            {forced && <Badge variant="outline" className="text-[10px] mr-1">forced</Badge>}
                            <span>template {e.template_id}</span>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
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

function SurfaceBadge({ surface }: { surface: string }) {
  const palette: Record<string, string> = {
    provider: "bg-amber-100 text-amber-800 border-amber-200",
    admin: "bg-blue-100 text-blue-800 border-blue-200",
    system: "bg-slate-100 text-slate-700 border-slate-200",
  };
  const cls = palette[surface] ?? palette.system;
  return (
    <span className={`mt-1 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${cls}`}>
      {surface}
    </span>
  );
}

const ACTION_LABEL: Record<string, string> = {
  mark_outcome: "Marked outcome",
  mark_outcome_bulk: "Marked outcome (bulk)",
  add_note: "Added note",
  add_admin_note: "Admin added note",
  remove_passkey: "Removed passkey",
  update_display_name: "Updated display name",
  save_notes: "Saved notes",
  upsert_enrolment_outcome: "Set enrolment outcome",
};

function humaniseAction(action: string): string {
  return ACTION_LABEL[action] ?? action.replace(/_/g, " ");
}

function AuditDiff({
  before,
  after,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  const keys = new Set<string>([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  if (keys.size === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {[...keys].map((k) => {
        const bv = before?.[k];
        const av = after?.[k];
        const same = JSON.stringify(bv) === JSON.stringify(av);
        if (same) return null;
        return (
          <li key={k} className="text-[11px] text-[#5a6a72]">
            <span className="font-semibold text-[#11242e]">{k}:</span>{" "}
            {bv != null && (
              <span className="line-through text-[#b3412e]">{stringify(bv)}</span>
            )}
            {bv != null && av != null && <span> → </span>}
            {av != null && <span className="text-emerald-700">{stringify(av)}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}
