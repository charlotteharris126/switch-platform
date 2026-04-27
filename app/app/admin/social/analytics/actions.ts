"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// Manual engagement input — owner pastes the like + comment counts from
// LinkedIn's native UI once a week. Each save inserts a fresh row into
// social.post_analytics (time-series snapshot, append-only). The
// vw_post_performance view aggregates with MAX() so the page always shows
// the highest seen value.
//
// This is the workaround for LinkedIn's r_member_social being a "Restricted"
// scope (granted to select developers only — see
// `feedback_verify_oauth_scope_availability.md`). Until that lands, the
// platform can't pull the numbers itself; manual paste is the bridge.

export interface LogEngagementInput {
  draftId: string;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export async function logEngagementSnapshot(input: LogEngagementInput): Promise<ActionResult> {
  // Defensive: at least one value must be supplied
  if (input.reactions === null && input.comments === null && input.shares === null) {
    return { ok: false, error: "Enter at least one number before saving." };
  }

  // Validate: non-negative integers only
  for (const [key, val] of Object.entries(input)) {
    if (key === "draftId") continue;
    if (val !== null && (typeof val !== "number" || val < 0 || !Number.isFinite(val))) {
      return { ok: false, error: `Invalid ${key}: must be a non-negative number.` };
    }
  }

  const supabase = await createClient();

  // Confirm the draft exists and is published — engagement on a non-published
  // draft makes no sense and would be a UX error.
  const { data: draft, error: readErr } = await supabase
    .schema("social")
    .from("drafts")
    .select("id, status")
    .eq("id", input.draftId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!draft) return { ok: false, error: "Draft not found." };
  if (draft.status !== "published") {
    return { ok: false, error: `Draft is in '${draft.status}' status — only published posts can have engagement logged.` };
  }

  const { error: insertErr } = await supabase
    .schema("social")
    .from("post_analytics")
    .insert({
      draft_id: input.draftId,
      reactions: input.reactions,
      comments: input.comments,
      shares: input.shares,
    });

  if (insertErr) return { ok: false, error: insertErr.message };

  revalidatePath("/social/analytics");
  return { ok: true };
}
