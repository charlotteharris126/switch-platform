// /provider/leads/[id]. lead detail + outcome marking + notes log.
//
// All routed payload fields are visible to the provider (RLS-scoped to
// their primary_routed_to). Rendering is delegated to <LeadDetailView>
// so the admin "View as provider" preview can render the same UI with
// action callbacks omitted (read-only).

import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireProviderUser } from "@/lib/auth/require-provider";
import { ProviderShell } from "../../provider-shell";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { markOutcomeAction, addLeadNoteAction, markAdminNotesReadAction } from "./actions";
import { type LeadStatus } from "@/lib/lead-status";
import {
  LeadDetailView,
  type FastrackDetail,
  type LeadDetailEnrolment,
  type LeadDetailSubmission,
} from "./lead-detail-view";
import { type NoteRow } from "./notes-log";

interface NoteRowRaw {
  id: number;
  body: string;
  created_at: string;
  author_role: "provider" | "admin" | "system";
  author_display_name: string | null;
  provider_user_id: number | null;
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
  params: Promise<{ id: string }>;
}

export default async function ProviderLeadDetailPage({ params }: Props) {
  const { id: idRaw } = await params;
  const submissionId = parseInt(idRaw, 10);
  if (Number.isNaN(submissionId)) notFound();

  const ctx = await requireProviderUser();
  const supabase = await createClient();

  // Fetch in one wave: this submission, this enrolment, notes for this
  // lead, all routed siblings (id + routed_at) and fastrack parent ids
  // for prev/next ordering. The fastrack-detail row only fires after
  // hasFastrack is known — saves the extra round-trip on the ~80% of
  // leads with no fastrack. RLS-scoped throughout.
  const [
    submissionResult,
    enrolResult,
    notesResult,
    siblingsResult,
    fastrackResult,
    lastChaserResult,
  ] = await Promise.all([
    supabase
      .schema("leads")
      .from("submissions")
      .select(
        "id,routed_at,first_name,last_name,email,phone,lead_type," +
        "age_band,employment_status,course_id,funding_category,funding_route,prior_level_3_or_higher,can_start_on_intake_date,preferred_intake_id,acceptable_intake_ids,start_when,start_timing,outcome_interest,la,postcode,region," +
        "company_name,role_title,company_size_band,sector,levy_status,urgency,interest,candidate_in_mind,existing_apprentices,headcount_estimate,standards_interested,additional_notes",
      )
      .eq("id", submissionId)
      .maybeSingle<LeadDetailSubmission>(),
    supabase
      .schema("crm")
      .from("enrolments")
      .select("status,outcome_note,status_updated_at,callback_requested_at")
      .eq("submission_id", submissionId)
      .maybeSingle<LeadDetailEnrolment>(),
    supabase
      .schema("crm")
      .from("lead_notes")
      .select("id, body, created_at, author_role, author_display_name, provider_user_id, read_by_provider_at")
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .schema("leads")
      .from("submissions")
      .select("id,routed_at")
      .eq("primary_routed_to", ctx.providerId)
      .not("routed_at", "is", null)
      .is("archived_at", null)
      .is("parent_submission_id", null)
      .order("routed_at", { ascending: false })
      .limit(500),
    supabase
      .schema("leads")
      .from("fastrack_submissions")
      .select("parent_submission_id"),
    // Latest chaser email sent for this lead. Read from crm.email_log
    // (canonical record, same source the admin /admin/leads "Last chaser"
    // column uses). Both manual admin bulk-fire and the portal auto-fire
    // write here, so this single field reflects every chaser path. The
    // filter covers learner (chaser_funded/chaser_self) AND employer
    // (s4b_employer_chaser) types — the label in the view branches by
    // submission.lead_type.
    supabase
      .schema("crm")
      .from("email_log")
      .select("triggered_at,status")
      .eq("submission_id", submissionId)
      .in("email_type", ["chaser_funded", "chaser_self", "s4b_employer_chaser"])
      .order("triggered_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ triggered_at: string; status: string }>(),
  ]);

  const submission = submissionResult.data;
  if (!submission) notFound();
  const enrol = enrolResult.data;
  const status = (enrol?.status ?? "open") as LeadStatus;

  const fastrackParentIds = new Set<number>(
    (fastrackResult.data ?? []).map((r: FastrackParentRow) => r.parent_submission_id),
  );
  const hasFastrack = fastrackParentIds.has(submission.id);
  const fastrackDetail = hasFastrack
    ? (await supabase
        .schema("leads")
        .from("fastrack_submissions")
        .select(
          "id, submitted_at, cohort_confirmed, transport_help_requested, docs_ready, l3_reconfirmed, l3_mismatch_flag, voice_of_learner_intro, terms_accepted, marketing_opt_in",
        )
        .eq("parent_submission_id", submissionId)
        .order("submitted_at", { ascending: false })
        .limit(1)
        .maybeSingle<FastrackDetail>()).data
    : null;

  // Build the same ordering the leads list uses: fastrack first, then
  // routed_at desc.
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

  return (
    <ProviderShell active="leads">
      <RealtimeRefresh
        tables={[
          { schema: "crm", table: "enrolments", filter: `provider_id=eq.${ctx.providerId}` },
          { schema: "crm", table: "lead_notes", filter: `provider_id=eq.${ctx.providerId}` },
        ]}
        channel={`rt-provider-lead-${submission.id}`}
      />
      <LeadDetailView
        submission={submission}
        enrol={enrol}
        notes={notes}
        fastrackDetail={fastrackDetail}
        hasFastrack={hasFastrack}
        hasUnreadAdminNote={hasUnreadAdminNote}
        status={status}
        lastChaserAt={lastChaserResult.data?.triggered_at ?? null}
        prevId={prevId}
        nextId={nextId}
        positionLabel={positionLabel}
        leadsListHref="/provider/leads"
        leadDetailPrefix="/provider/leads/"
        onMarkOutcome={markOutcomeAction}
        onAddNote={addLeadNoteAction}
        onMarkAdminNotesRead={markAdminNotesReadAction}
      />
    </ProviderShell>
  );
}
