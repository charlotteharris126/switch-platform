"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { EnrolmentStatus, LostReason } from "./[id]/actions";

export interface FireProviderChaserResult {
  ok: boolean;
  fired: number;
  skipped: number;
  perId: Array<{ submissionId: number; status: string; reason: string | null }>;
}

// Bulk-fire the "tried no answer" Brevo chaser for the selected submission
// ids. Dispatches by lead_type so each lead routes to its own SQL function
// + Edge Function pair:
//   - learner               → fire_provider_chaser → admin-brevo-chase
//                              (SF2 list-add + chaser_funded/chaser_self
//                              template)
//   - employer_apprenticeship → fire_employer_chaser → admin-brevo-chase-employer
//                              (transactional only, s4b_employer_chaser
//                              template, no list-add)
// Each SQL function audits the chaser-fire intent and async-invokes its
// Edge Function via pg_net; the Edge Function calls sendTransactional
// which writes the canonical crm.email_log row (single source of truth
// post-migration 0086, Phase 4 closeout). Pre-2026-05-19 this function
// only called fire_provider_chaser, which silently swallowed employer
// leads at the Edge Function step (skipped on !funding_category) while
// still reporting status='ok' — sub #496 was the bug that surfaced this.
export async function fireProviderChaser(
  submissionIds: number[],
): Promise<FireProviderChaserResult> {
  if (submissionIds.length === 0) {
    return { ok: true, fired: 0, skipped: 0, perId: [] };
  }

  const supabase = await createClient();

  // Look up lead_type per submission so we can route each to the right
  // chaser SQL function. Submissions missing a lead_type default to
  // learner (matches the historical default + pre-S4B data shape).
  const { data: leadTypeRows, error: lookupError } = await supabase
    .schema("leads")
    .from("submissions")
    .select("id, lead_type")
    .in("id", submissionIds);

  if (lookupError) {
    return { ok: false, fired: 0, skipped: 0, perId: [] };
  }

  const leadTypeById = new Map<number, string>();
  for (const r of (leadTypeRows ?? []) as Array<{ id: number; lead_type: string | null }>) {
    leadTypeById.set(r.id, r.lead_type ?? "learner");
  }

  const learnerIds: number[] = [];
  const employerIds: number[] = [];
  for (const id of submissionIds) {
    const t = leadTypeById.get(id) ?? "learner";
    if (t === "employer_apprenticeship") {
      employerIds.push(id);
    } else {
      learnerIds.push(id);
    }
  }

  type ChaserRow = { submission_id: number; email: string | null; status: string; reason: string | null };

  const [learnerRes, employerRes] = await Promise.all([
    learnerIds.length > 0
      ? supabase.schema("crm").rpc("fire_provider_chaser", { p_submission_ids: learnerIds })
      : Promise.resolve({ data: [] as ChaserRow[], error: null }),
    employerIds.length > 0
      ? supabase.schema("crm").rpc("fire_employer_chaser", { p_submission_ids: employerIds })
      : Promise.resolve({ data: [] as ChaserRow[], error: null }),
  ]);

  if (learnerRes.error || employerRes.error) {
    return { ok: false, fired: 0, skipped: 0, perId: [] };
  }

  const rows: ChaserRow[] = [
    ...((learnerRes.data as ChaserRow[]) ?? []),
    ...((employerRes.data as ChaserRow[]) ?? []),
  ];
  const fired = rows.filter((r) => r.status === "ok").length;
  const skipped = rows.filter((r) => r.status === "skipped").length;

  revalidatePath("/leads");

  return {
    ok: true,
    fired,
    skipped,
    perId: rows.map((r) => ({
      submissionId: r.submission_id,
      status: r.status,
      reason: r.reason,
    })),
  };
}

export interface BulkMarkEnrolmentInput {
  submissionIds: number[];
  status: EnrolmentStatus;
  notes?: string | null;
  lostReason?: LostReason | null;
}

export interface BulkMarkEnrolmentResult {
  ok: boolean;
  succeeded: number;
  failed: number;
  errors: Array<{ submissionId: number; error: string }>;
}

// Bulk version of [id]/actions.ts:markEnrolmentOutcome. Loops the same
// crm.upsert_enrolment_outcome RPC per submission so audit rows are written
// per lead (not per batch). Disputed flag is intentionally not exposed —
// dispute carries a per-lead reason text that doesn't bulk cleanly, so it
// stays on the single-lead form at /admin/leads/[id].
export async function markEnrolmentOutcomeBulk(
  input: BulkMarkEnrolmentInput,
): Promise<BulkMarkEnrolmentResult> {
  const supabase = await createClient();

  let succeeded = 0;
  const succeededIds: number[] = [];
  const errors: Array<{ submissionId: number; error: string }> = [];

  for (const submissionId of input.submissionIds) {
    const { error } = await supabase.schema("crm").rpc("upsert_enrolment_outcome", {
      p_submission_id:    submissionId,
      p_status:           input.status,
      p_notes:            input.notes ?? null,
      p_lost_reason:      input.status === "lost" ? input.lostReason ?? null : null,
      p_disputed:         false,
      p_disputed_reason:  null,
    });

    if (error) {
      errors.push({ submissionId, error: error.message });
    } else {
      succeeded += 1;
      succeededIds.push(submissionId);
    }
  }

  // Single Brevo sync call covering every successfully-updated lead. The
  // Edge Function runs the upserts sequentially with its own throttle so
  // Brevo's contacts API rate limit is respected even on big bulk runs.
  // Best-effort: failures land in leads.dead_letter, don't surface to UI.
  if (succeededIds.length > 0) {
    await supabase.schema("crm").rpc("sync_leads_to_brevo", {
      p_submission_ids: succeededIds,
    });
  }

  revalidatePath("/leads");

  return {
    ok: errors.length === 0,
    succeeded,
    failed: errors.length,
    errors,
  };
}
