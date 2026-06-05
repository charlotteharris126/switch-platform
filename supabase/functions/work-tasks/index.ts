// Edge Function: work-tasks
//
// Owner-only operations on strategy.tasks (the Work Hub "Run" board). One
// endpoint, action-discriminated. Called from /admin/work server actions, which
// authenticate via Supabase Auth (isAdmin) before calling with the x-audit-key.
// Mirrors admin-roadmap exactly (same auth + shape).
//
// Actions:
//   - { action: "list", filters?: { area_tag?, status? } }
//       All Run tasks, each with its linked rock title (roadmap_title).
//   - { action: "create", task: { title, ... } }  -> owner "Add task" (added_by='charlotte')
//   - { action: "update", id, patch: { status?, sort_order?, ... } }  -> drag-move + edits
//   - { action: "delete", id }
//
// The agent/handoff capture front door is the SEPARATE task-upsert EF (secret-gated).
// config.toml has verify_jwt=false.
// Related: platform/docs/admin-work-hub-spec.md, migration 0188_strategy_tasks.sql.

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL is not set.");

const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, connect_timeout: 10, prepare: false });

const VALID_STATUS = ["inbox", "this_week", "in_progress", "review", "done"];
const VALID_SIZE = ["tiny", "small", "big"];
const TASK_COLS = sql`
  t.id, t.title, t.notes, t.status, t.blocked, t.blocked_reason, t.size,
  t.area_tag, t.roadmap_task_id, t.added_by, t.due_date, t.sort_order,
  t.created_at, t.updated_at, t.completed_at, t.seen_by_owner,
  r.title AS roadmap_title
`;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Auth — x-audit-key vs AUDIT_SHARED_SECRET in the vault (same as admin-roadmap).
  const providedKey = req.headers.get("x-audit-key");
  if (!providedKey) return new Response("Unauthorized", { status: 401 });
  let expectedKey: string;
  try {
    const [row] = await sql<Array<{ secret: string }>>`SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret`;
    expectedKey = row?.secret ?? "";
    if (!expectedKey) throw new Error("AUDIT_SHARED_SECRET not in vault");
  } catch (err) {
    console.error("vault secret fetch failed:", String(err));
    return json({ error: "AUDIT_SHARED_SECRET not retrievable from vault" }, 500);
  }
  if (providedKey !== expectedKey) return new Response("Unauthorized", { status: 401 });

  let body: { action?: string; [k: string]: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = body.action;
  try {
    if (action === "list") return await handleList(body.filters as ListFilters ?? {});
    if (action === "create") return await handleCreate(body.task as CreateTask);
    if (action === "update") {
      if (typeof body.id !== "string" || !body.patch || typeof body.patch !== "object") {
        return json({ error: "update requires {id: string, patch: object}" }, 400);
      }
      return await handleUpdate(body.id, body.patch as Record<string, unknown>);
    }
    if (action === "delete") {
      if (typeof body.id !== "string") return json({ error: "delete requires {id: string}" }, 400);
      await sql`DELETE FROM strategy.tasks WHERE id = ${body.id}`;
      return json({ ok: true });
    }
    return json({ error: "Unknown action; must be list | create | update | delete" }, 400);
  } catch (err) {
    console.error("work-tasks action failed:", String(err));
    return json({ error: String(err) }, 500);
  }
});

type ListFilters = { area_tag?: string; status?: string };
type CreateTask = {
  title: string; notes?: string | null; status?: string; size?: string;
  area_tag?: string | null; roadmap_task_id?: string | null; added_by?: string;
  due_date?: string | null; sort_order?: number;
};

async function handleList(filters: ListFilters): Promise<Response> {
  const rows = await sql`
    SELECT ${TASK_COLS}
    FROM strategy.tasks t
    LEFT JOIN strategy.roadmap_tasks r ON r.id = t.roadmap_task_id
    WHERE ${filters.area_tag ? sql`t.area_tag = ${filters.area_tag}` : sql`TRUE`}
      AND ${filters.status ? sql`t.status = ${filters.status}` : sql`TRUE`}
    ORDER BY t.status, t.sort_order, t.created_at
  `;
  return json({ tasks: rows, count: rows.length });
}

async function handleCreate(task: CreateTask): Promise<Response> {
  if (!task || typeof task.title !== "string" || !task.title.trim()) {
    return json({ error: "task.title required" }, 400);
  }
  const status = VALID_STATUS.includes(task.status ?? "") ? task.status : "inbox";
  const size = VALID_SIZE.includes(task.size ?? "") ? task.size : "small";
  const [row] = await sql`
    INSERT INTO strategy.tasks
      (title, notes, status, size, area_tag, roadmap_task_id, added_by, due_date, sort_order)
    VALUES (
      ${task.title.trim()}, ${task.notes ?? null}, ${status}, ${size},
      ${task.area_tag ?? null}, ${task.roadmap_task_id ?? null},
      ${task.added_by ?? "charlotte"}, ${task.due_date ?? null}, ${task.sort_order ?? 0}
    )
    RETURNING id
  `;
  const [full] = await sql`
    SELECT ${TASK_COLS} FROM strategy.tasks t
    LEFT JOIN strategy.roadmap_tasks r ON r.id = t.roadmap_task_id
    WHERE t.id = ${row.id}
  `;
  return json({ task: full });
}

async function handleUpdate(id: string, patch: Record<string, unknown>): Promise<Response> {
  const allowed = [
    "title", "notes", "status", "size", "area_tag", "roadmap_task_id",
    "due_date", "blocked", "blocked_reason", "sort_order", "seen_by_owner",
  ];
  const updates: Record<string, unknown> = {};
  for (const k of allowed) if (k in patch) updates[k] = patch[k];
  if (Object.keys(updates).length === 0) return json({ error: "patch has no allowed fields" }, 400);

  if (updates.status !== undefined && !VALID_STATUS.includes(String(updates.status))) {
    return json({ error: `invalid status; must be one of ${VALID_STATUS.join(", ")}` }, 400);
  }
  if (updates.size !== undefined && !VALID_SIZE.includes(String(updates.size))) {
    return json({ error: `invalid size; must be one of ${VALID_SIZE.join(", ")}` }, 400);
  }

  const [row] = await sql`UPDATE strategy.tasks SET ${sql(updates)} WHERE id = ${id} RETURNING id`;
  if (!row) return json({ error: "task not found" }, 404);
  const [full] = await sql`
    SELECT ${TASK_COLS} FROM strategy.tasks t
    LEFT JOIN strategy.roadmap_tasks r ON r.id = t.roadmap_task_id
    WHERE t.id = ${id}
  `;
  return json({ task: full });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
