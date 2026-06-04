// /admin/preview/[provider_id]/leads/[lead_id] — read-only admin
// impersonation of /provider/leads/[id], scoped to the target provider.
//
// Mirrors the data fan-out from /provider/leads/[id]/page.tsx but uses
// the admin client (bypasses RLS) and manually scopes by
// primary_routed_to. Two defences:
//   - submission query has .eq("primary_routed_to", providerId), so a
//     lead routed to a different provider returns no row → notFound.
//   - Sibling list is also scoped by primary_routed_to so prev/next
//     stays within the target provider's leads.
//
// Action callbacks are NOT passed to <LeadDetailView>, so outcome
// buttons, notes compose, and the auto-mark-admin-notes-read effect
// are all hidden. Preview can never fire a write.

import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminUser } from "@/lib/auth/require-admin";
import { type LeadStatus } from "@/lib/lead-status";
import {
  LeadDetailView,
  type FastrackDetail,
  type LeadDetailEnrolment,
  type LeadDetailSubmission,
} from "@/app/provider/leads/[id]/lead-detail-view";
import { type NoteRow } from "@/app/provider/leads/[id]/notes-log";
import { PreviewHeader } from "../../preview-header";

interface NoteRowRaw {
  id: number;
  body: string;
  created_at: string;
  author_role: "provider" | "admin" | "system";
  author_display_name: string | null;
  read_by_provider_at: string | null;
}

interface SiblingRow {
  id: number;
  routed_at: string | null;
}

interface FastrackParentRow {
  parent_submission_id: number;
}

interface Props {
  params: Promise<{ provider_id: string; lead_id: string }>;
}

export default async function PreviewLeadDetailPage({ params }: Props) {
  await requireAdminUser();
  const { provider_id: rawProviderId, lead_id: rawLeadId } = await params;
  const providerId = decodeURIComponent(rawProviderId);
  const submissionId = parseInt(rawLeadId, 10);
  if (Number.isNaN(submissionId)) notFound();

  const admin = createAdminClient();

  const { data: provider } = await admin
    .schema("crm")
    .from("providers")
    .select("provider_id, company_name, is_demo")
    .eq("provider_id", providerId)
    .maybeSingle<{ provider_id: string; company_name: string; is_demo: boolean }>();
  if (!provider) notFound();

  // Same fan-out as /provider/leads/[id]/page.tsx but with admin client +
  // manual primary_routed_to scoping. The submission query enforces
  // cross-provider isolation: a lead routed elsewhere returns nothing.
  const [
    submissionResult,
    enrolResult,
    notesResult,
    siblingsResult,
    fastrackResult,
    fastrackDetailResult,
    reapplyResult,
  ] = await Promise.all([
    admin
      .schema("leads")
      .from("submissions")
      .select(
        "id,routed_at,first_name,last_name,email,phone,lead_type," +
        "age_band,employment_status,course_id,funding_category,funding_route,prior_level_3_or_higher,can_start_on_intake_date,preferred_intake_id,acceptable_intake_ids,start_when,start_timing,outcome_interest,la,postcode,region," +
        "company_name,role_title,company_size_band,sector,levy_status,urgency,interest,candidate_in_mind,existing_apprentices,headcount_estimate,standards_interested,additional_notes",
      )
      .eq("id", submissionId)
      .eq("primary_routed_to", providerId)
      .maybeSingle<LeadDetailSubmission>(),
    admin
      .schema("crm")
      .from("enrolments")
      .select("status,outcome_note,status_updated_at,callback_requested_at")
      .eq("submission_id", submissionId)
      .eq("provider_id", providerId)
      .maybeSingle<LeadDetailEnrolment>(),
    admin
      .schema("crm")
      .from("lead_notes")
      .select("id, body, created_at, author_role, author_display_name, read_by_provider_at")
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: false })
      .limit(200),
    admin
      .schema("leads")
      .from("submissions")
      .select("id,routed_at")
      .eq("primary_routed_to", providerId)
      .not("routed_at", "is", null)
      .is("archived_at", null)
      .is("parent_submission_id", null)
      .order("routed_at", { ascending: false })
      .limit(500),
    admin
      .schema("leads")
      .from("fastrack_submissions")
      .select("parent_submission_id, parent:submissions!inner(primary_routed_to)")
      .eq("parent.primary_routed_to", providerId),
    admin
      .schema("leads")
      .from("fastrack_submissions")
      .select(
        "id, submitted_at, cohort_confirmed, transport_help_requested, docs_ready, l3_reconfirmed, l3_mismatch_flag, voice_of_learner_intro, terms_accepted, marketing_opt_in",
      )
      .eq("parent_submission_id", submissionId)
      .order("submitted_at", { ascending: false })
      .limit(1)
      .maybeSingle<FastrackDetail>(),
    // Re-application history: later submissions from the same learner (children
    // of this lead), oldest first. Mirrors /provider/leads/[id]/page.tsx.
    admin
      .schema("leads")
      .from("submissions")
      .select("created_at")
      .eq("parent_submission_id", submissionId)
      .eq("primary_routed_to", providerId)
      .order("created_at", { ascending: true }),
  ]);

  const submission = submissionResult.data;
  if (!submission) notFound();
  const enrol = enrolResult.data;
  const status = (enrol?.status ?? "open") as LeadStatus;

  const reapplications = ((reapplyResult.data ?? []) as Array<{ created_at: string }>).map(
    (r) => r.created_at,
  );

  const fastrackParentIds = new Set<number>(
    (fastrackResult.data ?? []).map((r: FastrackParentRow) => r.parent_submission_id),
  );
  const hasFastrack = fastrackParentIds.has(submission.id);
  const fastrackDetail = fastrackDetailResult.data;

  const siblings = (siblingsResult.data ?? []) as SiblingRow[];
  siblings.sort((a, b) => {
    const aFast = fastrackParentIds.has(a.id) ? 1 : 0;
    const bFast = fastrackParentIds.has(b.id) ? 1 : 0;
    if (aFast !== bFast) return bFast - aFast;
    const aT = a.routed_at ? new Date(a.routed_at).getTime() : 0;
    const bT = b.routed_at ? new Date(b.routed_at).getTime() : 0;
    return bT - aT;
  });
  const idx = siblings.findIndex((s) => s.id === submission.id);
  const prevId = idx > 0 ? siblings[idx - 1].id : null;
  const nextId = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1].id : null;
  const positionLabel = idx >= 0 ? `${idx + 1} of ${siblings.length}` : null;

  const noteRowsRaw = (notesResult.data ?? []) as unknown as NoteRowRaw[];
  const notes: NoteRow[] = noteRowsRaw.map((n) => ({
    id: n.id,
    body: n.body,
    created_at: n.created_at,
    author: n.author_display_name ?? "Someone",
    author_role: n.author_role,
  }));
  const hasUnreadAdminNote = noteRowsRaw.some(
    (n) => n.author_role === "admin" && n.read_by_provider_at == null,
  );

  const encoded = encodeURIComponent(providerId);

  return (
    <>
      <PreviewHeader
        providerId={providerId}
        companyName={provider.company_name}
        isDemo={provider.is_demo}
        active="leads"
      />
      <div className="bg-slate-50 min-h-screen">
        <LeadDetailView
          submission={submission}
          enrol={enrol}
          notes={notes}
          fastrackDetail={fastrackDetail}
          hasFastrack={hasFastrack}
          hasUnreadAdminNote={hasUnreadAdminNote}
          status={status}
          lastChaserAt={null}
          reapplications={reapplications}
          prevId={prevId}
          nextId={nextId}
          positionLabel={positionLabel}
          leadsListHref={`/preview/${encoded}/leads`}
          leadDetailPrefix={`/preview/${encoded}/leads/`}
          // Action callbacks intentionally omitted — read-only.
        />
      </div>
    </>
  );
}
