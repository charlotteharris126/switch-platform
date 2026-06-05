"use server";

// Server Actions for /admin/work (the Work Hub board). Wraps the work-tasks
// Edge Function with the standard AUDIT_SHARED_SECRET vault-read + isAdmin gate,
// mirroring /admin/roadmap.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/allowlist";

export type WorkTask = {
  id: string;
  title: string;
  notes: string | null;
  status: "inbox" | "this_week" | "in_progress" | "review" | "done";
  blocked: boolean;
  blocked_reason: string | null;
  size: "tiny" | "small" | "big";
  area_tag: string | null;
  roadmap_task_id: string | null;
  roadmap_title: string | null;
  added_by: string;
  due_date: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  seen_by_owner: boolean;
};

export type TaskPatch = Partial<
  Pick<
    WorkTask,
    "title" | "notes" | "status" | "size" | "area_tag" | "roadmap_task_id"
    | "due_date" | "blocked" | "blocked_reason" | "sort_order" | "seen_by_owner"
  >
>;

export type ListResult = { ok: true; tasks: WorkTask[] } | { ok: false; error: string };
export type TaskResult = { ok: true; task: WorkTask } | { ok: false; error: string };
export type OkResult = { ok: true } | { ok: false; error: string };

export async function listWorkTasksAction(filters?: { area_tag?: string; status?: string }): Promise<ListResult> {
  const r = await callWorkTasks({ action: "list", filters: filters ?? {} });
  if (!r.ok) return r;
  return { ok: true, tasks: (r.tasks as WorkTask[]) ?? [] };
}

export async function createWorkTaskAction(task: {
  title: string;
  notes?: string | null;
  status?: WorkTask["status"];
  size?: WorkTask["size"];
  area_tag?: string | null;
  roadmap_task_id?: string | null;
  due_date?: string | null;
  sort_order?: number;
}): Promise<TaskResult> {
  const r = await callWorkTasks({ action: "create", task });
  if (!r.ok) return r;
  return { ok: true, task: r.task as WorkTask };
}

export async function updateWorkTaskAction(id: string, patch: TaskPatch): Promise<TaskResult> {
  const r = await callWorkTasks({ action: "update", id, patch });
  if (!r.ok) return r;
  return { ok: true, task: r.task as WorkTask };
}

export async function deleteWorkTaskAction(id: string): Promise<OkResult> {
  const r = await callWorkTasks({ action: "delete", id });
  if (!r.ok) return r;
  return { ok: true };
}

async function callWorkTasks(
  body: Record<string, unknown>,
): Promise<{ ok: true; [k: string]: unknown } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user || !isAdmin(userData.user.email)) {
    return { ok: false, error: "Not authorised" };
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return { ok: false, error: "Server misconfigured: NEXT_PUBLIC_SUPABASE_URL missing" };

  const admin = createAdminClient();
  const { data: secretData, error: secretErr } = await admin.rpc("get_shared_secret", {
    p_name: "AUDIT_SHARED_SECRET",
  });
  if (secretErr || typeof secretData !== "string" || !secretData) {
    return { ok: false, error: `Could not read AUDIT_SHARED_SECRET from vault: ${secretErr?.message ?? "no value"}` };
  }

  let resp: Response;
  try {
    resp = await fetch(`${supabaseUrl}/functions/v1/work-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-audit-key": secretData },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }
  const respBody = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    return { ok: false, error: typeof respBody.error === "string" ? respBody.error : `Edge Function ${resp.status}` };
  }
  return { ok: true, ...respBody };
}
