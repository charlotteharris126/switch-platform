import { createClient } from "@/lib/supabase/server";

// Wrapper around the audit.log_action() Postgres function (migration 0020).
// Every Server Action that writes to leads.* or crm.* must call this after a
// successful write. Append-only is enforced at the function layer — there is
// no UPDATE or DELETE counterpart, and direct INSERT into audit.actions is
// blocked by RLS. This is the only sanctioned write path.
//
// Usage from a Server Action:
//   await logAction({
//     action: "mark_enrolment_outcome",
//     targetTable: "crm.enrolments",
//     targetId: String(enrolmentId),
//     before: { status: previousStatus },
//     after: { status: newStatus, notes },
//   });
//
// Convention for the action name: snake_case verb_noun. Read by the audit
// view in Session E. Don't get creative — keep verbs from a small set
// (route, mark, edit, replay, archive).

export type AuditAction =
  | "route_lead"
  | "mark_enrolment_outcome"
  | "edit_provider"
  | "replay_error"
  | "archive_lead"
  | "unarchive_lead";

interface LogActionInput {
  action: AuditAction;
  targetTable?: string;
  targetId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
}

export async function logAction(input: LogActionInput): Promise<number> {
  const supabase = await createClient();
  // public.log_action is a thin wrapper around audit.log_action — see
  // migration 0021. We call it via the public schema because the audit
  // schema is not exposed in the Supabase Data API.
  const { data, error } = await supabase.rpc("log_action", {
    p_action: input.action,
    p_target_table: input.targetTable ?? null,
    p_target_id: input.targetId ?? null,
    p_before: input.before ?? null,
    p_after: input.after ?? null,
    p_context: input.context ?? null,
    p_surface: "admin",
  });

  if (error) {
    // Surface the SQL error verbatim. Server Actions wrap this in their own
    // try/catch and decide what to show the owner. Don't swallow.
    throw new Error(`audit.log_action failed: ${error.message}`);
  }

  return data as number;
}
