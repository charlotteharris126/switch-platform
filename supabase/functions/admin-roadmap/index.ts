// Edge Function: admin-roadmap
//
// Owner-only CRUD on strategy.roadmap_tasks. One endpoint, action-discriminated.
// Called from the /admin/roadmap admin dashboard page (Mable's frontend).
//
// Actions:
//   - { action: "list", filters?: { revenue_model?, phase?, status?, agent? } }
//       Returns all tasks (filtered if filters supplied), grouped by client.
//
//   - { action: "update", id, patch: { status?, notes?, ... } }
//       Updates one task. The DB trigger handles updated_at + completed_at.
//
//   - { action: "create", task: { title, description, revenue_model, phase,
//       agent_tags, sort_order, ... } }
//       Inserts a new task. Mira-side mostly (Charlotte rarely adds).
//
// Auth: same x-audit-key / AUDIT_SHARED_SECRET pattern as admin-brevo-* functions.
// The dashboard's Server Actions sit in front and authenticate via Supabase Auth
// (admin.is_admin()) before calling this endpoint with the audit key.
//
// config.toml has verify_jwt=false; deploy with --no-verify-jwt.

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL is not set.");
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

type ListFilters = {
  revenue_model?: string;
  phase?: string;
  status?: string;
  agent?: string;
};

type RoadmapTask = {
  id: string;
  title: string;
  description: string | null;
  lane: string;
  lane_sort_order: number;
  revenue_model: string;
  phase: string;
  agent_tags: string[];
  status: string;
  notes: string | null;
  sort_order: number;
  target_milestone: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type UpdatePatch = {
  title?: string;
  description?: string | null;
  lane?: string;
  lane_sort_order?: number;
  status?: string;
  notes?: string | null;
  agent_tags?: string[];
  sort_order?: number;
  target_milestone?: string | null;
};

type CreateTask = {
  title: string;
  description?: string | null;
  lane: string;
  lane_sort_order: number;
  revenue_model: string;
  phase: string;
  agent_tags?: string[];
  status?: string;
  notes?: string | null;
  sort_order: number;
  target_milestone?: string | null;
};

const VALID_LANES = [
  "per-enrolment-scale",
  "provider-os",
  "affiliate-stack",
  "audience-build",
  "operational-backbone",
  "deferred-phase-2",
  "complete",
] as const;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Auth
  const providedKey = req.headers.get("x-audit-key");
  if (!providedKey) {
    return new Response("Unauthorized", { status: 401 });
  }
  let expectedKey: string;
  try {
    const [row] = await sql<Array<{ secret: string }>>`
      SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
    `;
    expectedKey = row?.secret ?? "";
    if (!expectedKey) throw new Error("AUDIT_SHARED_SECRET not in vault");
  } catch (err) {
    console.error("vault secret fetch failed:", String(err));
    return json({ error: "AUDIT_SHARED_SECRET not retrievable from vault" }, 500);
  }
  if (providedKey !== expectedKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Body
  let body: { action?: string; [k: string]: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = body.action;
  if (action !== "list" && action !== "update" && action !== "create") {
    return json({ error: "Unknown action; must be 'list' | 'update' | 'create'" }, 400);
  }

  try {
    if (action === "list") {
      const filters = (body.filters ?? {}) as ListFilters;
      return await handleList(filters);
    }
    if (action === "update") {
      const id = body.id;
      const patch = body.patch as UpdatePatch | undefined;
      if (typeof id !== "string" || !patch || typeof patch !== "object") {
        return json({ error: "update requires {id: string, patch: object}" }, 400);
      }
      return await handleUpdate(id, patch);
    }
    if (action === "create") {
      const task = body.task as CreateTask | undefined;
      if (!task || typeof task !== "object") {
        return json({ error: "create requires {task: object}" }, 400);
      }
      return await handleCreate(task);
    }
    return json({ error: "unreachable" }, 500);
  } catch (err) {
    console.error("admin-roadmap action failed:", String(err));
    return json({ error: String(err) }, 500);
  }
});

async function handleList(filters: ListFilters): Promise<Response> {
  const rows = await sql<RoadmapTask[]>`
    SELECT id, title, description, lane, lane_sort_order, revenue_model, phase,
           agent_tags, status, notes, sort_order, target_milestone,
           created_at, updated_at, completed_at
    FROM strategy.roadmap_tasks
    WHERE ${filters.revenue_model ? sql`revenue_model = ${filters.revenue_model}` : sql`TRUE`}
      AND ${filters.phase ? sql`phase = ${filters.phase}` : sql`TRUE`}
      AND ${filters.status ? sql`status = ${filters.status}` : sql`TRUE`}
      AND ${filters.agent ? sql`${filters.agent} = ANY(agent_tags)` : sql`TRUE`}
    ORDER BY lane_sort_order, revenue_model, phase, sort_order
  `;
  return json({ tasks: rows, count: rows.length });
}

async function handleUpdate(id: string, patch: UpdatePatch): Promise<Response> {
  const allowedKeys = [
    'title', 'description', 'lane', 'lane_sort_order',
    'status', 'notes', 'agent_tags', 'sort_order', 'target_milestone',
  ] as const;
  const updates: Record<string, unknown> = {};
  for (const k of allowedKeys) {
    if (k in patch) updates[k] = (patch as Record<string, unknown>)[k];
  }
  if (Object.keys(updates).length === 0) {
    return json({ error: "patch contains no allowed fields" }, 400);
  }

  // Validate status if provided
  if (updates.status !== undefined) {
    const validStatuses = ['to_do', 'in_progress', 'blocked', 'review', 'complete'];
    if (typeof updates.status !== 'string' || !validStatuses.includes(updates.status)) {
      return json({ error: `invalid status; must be one of ${validStatuses.join(', ')}` }, 400);
    }
  }

  // Validate lane if provided. If lane changes and lane_sort_order is not
  // supplied, derive it from the canonical mapping so the row sorts correctly.
  if (updates.lane !== undefined) {
    if (typeof updates.lane !== 'string' || !(VALID_LANES as readonly string[]).includes(updates.lane)) {
      return json({ error: `invalid lane; must be one of ${VALID_LANES.join(', ')}` }, 400);
    }
    if (updates.lane_sort_order === undefined) {
      const sortMap: Record<string, number> = {
        "per-enrolment-scale": 1,
        "provider-os": 2,
        "affiliate-stack": 3,
        "audience-build": 4,
        "operational-backbone": 5,
        "deferred-phase-2": 99,
        "complete": 100,
      };
      updates.lane_sort_order = sortMap[updates.lane as string];
    }
  }

  const [row] = await sql<RoadmapTask[]>`
    UPDATE strategy.roadmap_tasks
    SET ${sql(updates)}
    WHERE id = ${id}
    RETURNING id, title, description, lane, lane_sort_order, revenue_model, phase,
              agent_tags, status, notes, sort_order, target_milestone,
              created_at, updated_at, completed_at
  `;
  if (!row) {
    return json({ error: "task not found" }, 404);
  }
  return json({ task: row });
}

async function handleCreate(task: CreateTask): Promise<Response> {
  // Validate required fields
  if (typeof task.title !== 'string' || !task.title.trim()) {
    return json({ error: "task.title required" }, 400);
  }
  const validModels = ['foundation', 'provider', 'apprenticeship', 'affiliate', 'ppl',
                       'app', 'newsletter-sponsorship', 'placements', 'report',
                       'whitelabel', 'whitelabel-consumer-tools', 'whitelabel-provider-os'];
  if (!validModels.includes(task.revenue_model)) {
    return json({ error: `invalid revenue_model; must be one of ${validModels.join(', ')}` }, 400);
  }
  const validPhases = ['p1', 'p2', 'p3', 'p4'];
  if (!validPhases.includes(task.phase)) {
    return json({ error: `invalid phase; must be one of ${validPhases.join(', ')}` }, 400);
  }
  if (typeof task.lane !== 'string' || !(VALID_LANES as readonly string[]).includes(task.lane)) {
    return json({ error: `invalid lane; must be one of ${VALID_LANES.join(', ')}` }, 400);
  }
  if (typeof task.lane_sort_order !== 'number') {
    return json({ error: "task.lane_sort_order required (number)" }, 400);
  }
  if (typeof task.sort_order !== 'number') {
    return json({ error: "task.sort_order required (number)" }, 400);
  }

  const [row] = await sql<RoadmapTask[]>`
    INSERT INTO strategy.roadmap_tasks
      (title, description, lane, lane_sort_order, revenue_model, phase,
       agent_tags, status, notes, sort_order, target_milestone)
    VALUES (
      ${task.title},
      ${task.description ?? null},
      ${task.lane},
      ${task.lane_sort_order},
      ${task.revenue_model},
      ${task.phase},
      ${task.agent_tags ?? []},
      ${task.status ?? 'to_do'},
      ${task.notes ?? null},
      ${task.sort_order},
      ${task.target_milestone ?? null}
    )
    RETURNING id, title, description, lane, lane_sort_order, revenue_model, phase,
              agent_tags, status, notes, sort_order, target_milestone,
              created_at, updated_at, completed_at
  `;
  return json({ task: row });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
