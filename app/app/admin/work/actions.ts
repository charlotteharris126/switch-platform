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
  status: "inbox" | "agents" | "this_week" | "in_progress" | "review" | "done";
  blocked: boolean;
  blocked_reason: string | null;
  size: "tiny" | "small" | "big";
  priority: "low" | "normal" | "high" | "urgent";
  tags: string[];
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
    "title" | "notes" | "status" | "size" | "priority" | "tags" | "area_tag" | "roadmap_task_id"
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
  priority?: WorkTask["priority"];
  tags?: string[];
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

export type NotifTask = { id: string; title: string; due_date: string | null };
export type NotifBucket = { key: string; label: string; tasks: NotifTask[] };
export type NotifResult =
  | { ok: true; buckets: NotifBucket[]; total: number }
  | { ok: false; error: string };

// The notifications feed: tasks needing attention, bucketed. Poll-on-load
// (no realtime in v1). "New" = agent-added + unseen; "Blocked" is deliberately
// excluded (if the owner marked it blocked they don't need reminding).
export async function getWorkNotificationsAction(): Promise<NotifResult> {
  const r = await listWorkTasksAction();
  if (!r.ok) return r;
  const tasks = r.tasks;

  const DAY = 86400000;
  const startOfToday = new Date(new Date().toDateString()).getTime();
  const now = Date.now();
  const dueMs = (t: WorkTask) => (t.due_date ? new Date(t.due_date).getTime() : null);
  const live = (t: WorkTask) => t.status !== "done";
  const slim = (t: WorkTask): NotifTask => ({ id: t.id, title: t.title, due_date: t.due_date });

  const defs: NotifBucket[] = [
    { key: "new", label: "New", tasks: tasks.filter((t) => !t.seen_by_owner && t.added_by !== "charlotte").map(slim) },
    { key: "overdue", label: "Overdue", tasks: tasks.filter((t) => live(t) && dueMs(t) !== null && dueMs(t)! < startOfToday).map(slim) },
    { key: "today", label: "Due today", tasks: tasks.filter((t) => live(t) && dueMs(t) === startOfToday).map(slim) },
    { key: "soon", label: "Due soon", tasks: tasks.filter((t) => { const d = dueMs(t); return live(t) && d !== null && d > startOfToday && d <= startOfToday + 3 * DAY; }).map(slim) },
    { key: "stalled", label: "Stalled", tasks: tasks.filter((t) => t.status === "in_progress" && now - new Date(t.updated_at).getTime() > 5 * DAY).map(slim) },
    { key: "review", label: "Review waiting", tasks: tasks.filter((t) => t.status === "review").map(slim) },
  ];

  const buckets = defs.filter((b) => b.tasks.length > 0);
  const total = new Set(buckets.flatMap((b) => b.tasks.map((t) => t.id))).size;
  return { ok: true, buckets, total };
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
