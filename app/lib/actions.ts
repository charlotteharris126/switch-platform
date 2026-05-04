// Shared types and helpers for Server Actions in the admin app.
//
// `ActionResult<T>` is the canonical return shape for any new server action
// that fits "do thing, return ok or error". Use it as the default; only
// invent a custom return shape when the action genuinely needs to return
// richer information (e.g. bulk operations that report per-item status).
//
// The convention: Server Actions never throw to the client — errors land
// in `result.error` so the calling client component can render them
// inline next to the trigger button without an error boundary catch.
// Server Actions DO let infrastructure errors (DB unreachable, etc.)
// throw naturally to Next.js's error.tsx, since those aren't recoverable
// inline.
//
// Existing actions that pre-date this convention (markEnrolmentOutcome,
// fireProviderChasers, markFlagResolved, etc.) keep their bespoke shapes
// where those shapes carry meaningful extra data. Don't refactor for
// cosmetic consistency — refactor only if the existing shape is actively
// confusing or missing real signal.
//
// Examples:
//
//   // Simple: use ActionResult
//   export async function archiveLead(input: { id: number }): Promise<ActionResult> {
//     const supabase = await createClient();
//     const { error } = await supabase.schema("leads").from("submissions")
//       .update({ archived_at: new Date().toISOString() }).eq("id", input.id);
//     if (error) return { ok: false, error: error.message };
//     revalidatePath(`/leads/${input.id}`);
//     return { ok: true };
//   }
//
//   // With returned data
//   export async function getLeadCount(): Promise<ActionResult<{ count: number }>> {
//     ... returns { ok: true, data: { count: 42 } } or { ok: false, error: "..." }
//   }
//
//   // Bulk: invent a custom shape (this convention does not apply)
//   export async function bulkRoute(input: ...): Promise<{ ok: boolean; succeeded: number;
//     errors: Array<{ submissionId: number; error: string }>; }> { ... }

export interface ActionSuccess<T> {
  ok: true;
  data?: T;
}

export interface ActionFailure {
  ok: false;
  error: string;
}

export type ActionResult<T = void> = T extends void
  ? { ok: true } | ActionFailure
  : ActionSuccess<T> | ActionFailure;
