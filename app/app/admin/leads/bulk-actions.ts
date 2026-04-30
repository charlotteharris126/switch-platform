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

// Bulk-fire the SF2 "Provider tried no answer" Brevo chaser for the
// selected submission ids. Stamps crm.enrolments.last_chaser_at for each
// successfully-queued lead. Async on the Brevo side via pg_net inside the
// SQL function; the user gets back the per-id resolution (ok / skipped)
// immediately for UI feedback.
export async function fireProviderChaser(
  submissionIds: number[],
): Promise<FireProviderChaserResult> {
  const supabase = await createClient();

  const { data, error } = await supabase.schema("crm").rpc("fire_provider_chaser", {
    p_submission_ids: submissionIds,
  });

  if (error) {
    return {
      ok: false,
      fired: 0,
      skipped: 0,
      perId: [],
    };
  }

  const rows = (data as Array<{ submission_id: number; email: string | null; status: string; reason: string | null }>) ?? [];
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
