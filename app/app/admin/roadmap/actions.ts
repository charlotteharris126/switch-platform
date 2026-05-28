"use server";

// Server Actions for /admin/roadmap. Wraps the admin-roadmap Edge Function
// with the standard AUDIT_SHARED_SECRET vault-read + isAdmin gate pattern.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/allowlist";

export type RoadmapTask = {
  id: string;
  title: string;
  description: string | null;
  lane: string;
  lane_sort_order: number;
  revenue_model: string;
  phase: string;
  agent_tags: string[];
  status: "to_do" | "in_progress" | "blocked" | "review" | "complete";
  notes: string | null;
  sort_order: number;
  target_milestone: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type ListFilters = {
  lane?: string;
  revenue_model?: string;
  phase?: string;
  status?: string;
  agent?: string;
};

export type UpdatePatch = {
  title?: string;
  description?: string | null;
  lane?: string;
  lane_sort_order?: number;
  status?: RoadmapTask["status"];
  notes?: string | null;
  agent_tags?: string[];
  sort_order?: number;
  target_milestone?: string | null;
};

export type ListResult = { ok: true; tasks: RoadmapTask[]; count: number } | { ok: false; error: string };
export type UpdateResult = { ok: true; task: RoadmapTask } | { ok: false; error: string };
export type CreateResult = { ok: true; task: RoadmapTask } | { ok: false; error: string };

export async function listRoadmapAction(filters?: ListFilters): Promise<ListResult> {
  const result = await callRoadmap({ action: "list", filters: filters ?? {} });
  if (!result.ok) return result;
  return { ok: true, tasks: (result.tasks as RoadmapTask[]) ?? [], count: (result.count as number) ?? 0 };
}

export async function updateRoadmapTaskAction(id: string, patch: UpdatePatch): Promise<UpdateResult> {
  const result = await callRoadmap({ action: "update", id, patch });
  if (!result.ok) return result;
  return { ok: true, task: result.task as RoadmapTask };
}

export async function createRoadmapTaskAction(task: {
  title: string;
  description?: string | null;
  lane: string;
  lane_sort_order: number;
  revenue_model: string;
  phase: string;
  agent_tags?: string[];
  status?: RoadmapTask["status"];
  notes?: string | null;
  sort_order: number;
  target_milestone?: string | null;
}): Promise<CreateResult> {
  const result = await callRoadmap({ action: "create", task });
  if (!result.ok) return result;
  return { ok: true, task: result.task as RoadmapTask };
}

async function callRoadmap(
  body: Record<string, unknown>,
): Promise<{ ok: true; [k: string]: unknown } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user || !isAdmin(userData.user.email)) {
    return { ok: false, error: "Not authorised" };
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    return { ok: false, error: "Server misconfigured: NEXT_PUBLIC_SUPABASE_URL missing" };
  }
  const admin = createAdminClient();
  const { data: secretData, error: secretErr } = await admin.rpc("get_shared_secret", {
    p_name: "AUDIT_SHARED_SECRET",
  });
  if (secretErr || typeof secretData !== "string" || !secretData) {
    return {
      ok: false,
      error: `Could not read AUDIT_SHARED_SECRET from vault: ${secretErr?.message ?? "no value returned"}`,
    };
  }
  let resp: Response;
  try {
    resp = await fetch(`${supabaseUrl}/functions/v1/admin-roadmap`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-audit-key": secretData },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
  const respBody = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    return {
      ok: false,
      error: typeof respBody.error === "string" ? respBody.error : `Edge Function ${resp.status}`,
    };
  }
  return { ok: true, ...respBody };
}
