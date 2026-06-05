// Edge Function: task-upsert
// The one front door for capturing a Work Hub task (strategy.tasks). Called by
// agents and by the /handoff cross-project push, so a job never lands silently
// in a doc Charlotte never opens — it lands in her Inbox column with added_by
// stamped. The owner's own "Add task" UI writes via the admin app directly
// (authenticated + admin.is_admin RLS), not this function.
//
// Internal-only: gated by a shared secret (Authorization: Bearer <TASK_UPSERT_SECRET>),
// not public/CORS. Inserts via SET LOCAL ROLE functions_writer (migration 0188).
// verify_jwt=false in config.toml (auth is the bearer secret).
// Related: platform/docs/admin-work-hub-spec.md, migration 0188_strategy_tasks.sql.

import postgres from "npm:postgres@3";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL is not set. Should be auto-injected by Supabase for Edge Functions.");
}

const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, connect_timeout: 10, prepare: false });

const TASK_UPSERT_SECRET = Deno.env.get("TASK_UPSERT_SECRET");

const ALLOWED_STATUS = new Set(["inbox", "this_week", "in_progress", "review", "done"]);
const ALLOWED_SIZE = new Set(["tiny", "small", "big"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Internal-only gate. Fail closed if the secret isn't configured.
  if (!TASK_UPSERT_SECRET) return json({ error: "not_configured" }, 503);
  const auth = req.headers.get("authorization") || "";
  if (auth !== `Bearer ${TASK_UPSERT_SECRET}`) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const title = clip(firstString(body["title"]), 500);
  if (!title) return json({ error: "title_required" }, 400);

  const addedBy = clip(firstString(body["added_by"]), 100);
  if (!addedBy) return json({ error: "added_by_required" }, 400);

  let status = firstString(body["status"]) ?? "inbox";
  if (!ALLOWED_STATUS.has(status)) status = "inbox";

  let size = firstString(body["size"]) ?? "small";
  if (!ALLOWED_SIZE.has(size)) size = "small";

  const notes = clip(firstString(body["notes"]), 5000);
  const areaTag = clip(firstString(body["area_tag"]), 100);

  const roadmapTaskIdRaw = firstString(body["roadmap_task_id"]);
  const roadmapTaskId = roadmapTaskIdRaw && UUID_RE.test(roadmapTaskIdRaw) ? roadmapTaskIdRaw : null;

  const dueRaw = firstString(body["due_date"]);
  const dueDate = dueRaw && DATE_RE.test(dueRaw) ? dueRaw : null;

  const blocked = body["blocked"] === true;
  const blockedReason = blocked ? clip(firstString(body["blocked_reason"]), 500) : null;

  try {
    const [row] = await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      return await trx<Array<{ id: string }>>`
        INSERT INTO strategy.tasks (
          title, notes, status, size, area_tag, roadmap_task_id,
          added_by, due_date, blocked, blocked_reason, schema_version
        ) VALUES (
          ${title}, ${notes}, ${status}, ${size}, ${areaTag}, ${roadmapTaskId},
          ${addedBy}, ${dueDate}, ${blocked}, ${blockedReason}, '1.0'
        )
        RETURNING id
      `;
    });
    return json({ status: "ok", id: row.id });
  } catch (err) {
    console.error("strategy.tasks INSERT failed:", err);
    await persistDeadLetter(body, describeError(err));
    return json({ error: "internal" }, 500);
  }
});

// -------- helpers --------

function firstString(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length === 0 ? null : t;
  }
  return null;
}

function clip(v: string | null, n: number): string | null {
  return v ? v.slice(0, n) : null;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return JSON.stringify(err); } catch { return String(err); }
}

async function persistDeadLetter(rawPayload: unknown, errorContext: string): Promise<void> {
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      await trx`
        INSERT INTO leads.dead_letter (source, raw_payload, error_context)
        VALUES ('edge_function_task_upsert', ${sql.json(rawPayload ?? null)}, ${errorContext})
      `;
    });
  } catch (err) {
    console.error("dead_letter insert failed:", err);
  }
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
