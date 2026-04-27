"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Server Actions for individual draft management.
//
// Note on concurrency: the social-publish Edge Function takes a function-level
// advisory lock (pg_try_advisory_lock) AND uses a CAS UPDATE
// (`WHERE status='approved'`) when transitioning to published/failed. If the
// owner edits a draft during a cron tick, the worst case is the cron posts
// the OLD content then fails the CAS (status changed) and leaves the row in
// a failed-or-stuck state, which surfaces in /social/drafts. Acceptable for
// pilot scale (12 posts spread over 4 weeks; cron ticks every 15 min).

export interface EditDraftInput {
  draftId: string;
  content: string;
  scheduledFor: string | null; // ISO timestamp; null = unscheduled
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const MAX_CONTENT_CHARS = 3000;
const EDITABLE_STATUSES = new Set(["pending", "approved", "failed"]);

export async function editDraft(input: EditDraftInput): Promise<ActionResult> {
  if (!input.content || input.content.trim().length === 0) {
    return { ok: false, error: "Content can't be empty." };
  }
  if (input.content.length > MAX_CONTENT_CHARS) {
    return { ok: false, error: `Content is ${input.content.length} chars; LinkedIn personal cap is ${MAX_CONTENT_CHARS}.` };
  }

  const supabase = await createClient();

  // Read current state so we can capture the before-content for edit_history
  // and refuse edits on terminal-state rows.
  const { data: existing, error: readErr } = await supabase
    .schema("social")
    .from("drafts")
    .select("id, status, content, scheduled_for, edit_history")
    .eq("id", input.draftId)
    .maybeSingle();

  if (readErr) return { ok: false, error: readErr.message };
  if (!existing) return { ok: false, error: "Draft not found." };
  if (!EDITABLE_STATUSES.has(existing.status)) {
    return { ok: false, error: `Drafts in status '${existing.status}' can't be edited.` };
  }

  // Append to edit_history for traceability. JSONB append pattern.
  const previousHistory = (existing.edit_history as unknown as Array<Record<string, unknown>>) ?? [];
  const newHistory = [
    ...previousHistory,
    {
      edited_at: new Date().toISOString(),
      before: { content: existing.content, scheduled_for: existing.scheduled_for },
    },
  ];

  // If draft was 'failed', edit resets it to 'approved' so the next cron tick
  // will retry the new content. publish_error cleared.
  const newStatus = existing.status === "failed" ? "approved" : existing.status;

  const { error: updateErr } = await supabase
    .schema("social")
    .from("drafts")
    .update({
      content: input.content,
      scheduled_for: input.scheduledFor,
      status: newStatus,
      publish_error: null,
      edit_history: newHistory,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.draftId);

  if (updateErr) return { ok: false, error: updateErr.message };

  revalidatePath("/social/drafts");
  revalidatePath(`/social/drafts/${input.draftId}`);
  return { ok: true };
}

export async function cancelDraft(draftId: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: existing, error: readErr } = await supabase
    .schema("social")
    .from("drafts")
    .select("id, status")
    .eq("id", draftId)
    .maybeSingle();

  if (readErr) return { ok: false, error: readErr.message };
  if (!existing) return { ok: false, error: "Draft not found." };
  if (existing.status === "published") {
    return { ok: false, error: "Already published — can't cancel a live post. Delete on LinkedIn directly if needed." };
  }
  if (existing.status === "rejected") {
    return { ok: false, error: "Already rejected." };
  }

  const { error: updateErr } = await supabase
    .schema("social")
    .from("drafts")
    .update({
      status: "rejected",
      rejection_reason_category: "other",
      rejection_reason: "Cancelled from /social/drafts.",
      updated_at: new Date().toISOString(),
    })
    .eq("id", draftId);

  if (updateErr) return { ok: false, error: updateErr.message };

  revalidatePath("/social/drafts");
  revalidatePath(`/social/drafts/${draftId}`);
  return { ok: true };
}
