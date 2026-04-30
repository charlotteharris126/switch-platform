// Edge Function: sheet-edit-mirror
//
// Receives onEdit POSTs from the provider-sheet-edit-mirror.gs Apps Script
// trigger. Two channels:
//
//   Channel A (column = "Status")  — deterministic. Maps the sheet dropdown
//     value to crm.enrolments.status, validates the transition, applies it,
//     audits. No owner approval. Anomalies (unmapped value, regression,
//     post-billing override, missing enrolment) email the owner.
//
//   Channel B (column = "Notes") — AI-interpreted. Calls Claude Haiku with the (PII-redacted)
//     the (PII-redacted) note text plus current lead state, gets back a
//     structured suggestion. If a status change is implied, queues a row in
//     crm.pending_updates and emails the owner with HMAC-signed Approve /
//     Reject / Override links pointing at pending-update-confirm. Notes that
//     imply no change are logged as note_only and never bother the owner.
//
//     Channel B is GATED on env CHANNEL_B_ENABLED (default false). While the
//     legal/privacy work (Phase 0) is in progress, edits to the Updates
//     column are logged as note_only with reason "Channel B disabled" and no
//     Claude call is made. Activation is a single env flip.
//
// Auth: Bearer token in Authorization header, matched against
//       SHEETS_APPEND_TOKEN (same secret as the appender). Deploy with
//       --no-verify-jwt; verify_jwt=false in config.toml.
//
// Body: {
//   "lead_id": "123",
//   "provider_id": "ems",
//   "column": "Status" | "Notes",
//   "old_value": string | null,
//   "new_value": string | null,
//   "editor_email": string | null,
//   "edited_at": "2026-04-30T14:32:11Z"
// }
//
// Always returns 200 to the Apps Script (script does not retry; persistent
// failures land in leads.dead_letter inside the function). The body of the
// response describes what happened so the script can surface it on debug.
//
// Related:
//   - platform/docs/sheet-mirror-scoping.md (design)
//   - platform/supabase/migrations/0047_sheet_mirror_tables.sql (schema)
//   - platform/apps-scripts/provider-sheet-edit-mirror.gs (caller)
//   - platform/supabase/functions/pending-update-confirm (Channel B follow-up)
//   - platform/supabase/functions/_shared/pending-update-token.ts (HMAC helpers)

import postgres from "npm:postgres@3";
import { sendBrevoEmail } from "../_shared/brevo.ts";
import { signPendingUpdateToken } from "../_shared/pending-update-token.ts";

// ---- Env ----

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
const SHEETS_APPEND_TOKEN = Deno.env.get("SHEETS_APPEND_TOKEN");
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const PENDING_UPDATE_SECRET = Deno.env.get("PENDING_UPDATE_SECRET");
const OWNER_NOTIFICATION_EMAIL =
  Deno.env.get("OWNER_NOTIFICATION_EMAIL") ?? "hello@switchable.careers";
const CHANNEL_B_ENABLED = Deno.env.get("CHANNEL_B_ENABLED") === "true";
const CONFIRM_BASE_URL =
  Deno.env.get("CONFIRM_BASE_URL") ??
  "https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/pending-update-confirm";

if (!DATABASE_URL) throw new Error("SUPABASE_DB_URL is not set.");
if (!SHEETS_APPEND_TOKEN) throw new Error("SHEETS_APPEND_TOKEN is not set.");
// ANTHROPIC_API_KEY and PENDING_UPDATE_SECRET checked at use time — Channel B
// can be disabled without these set.

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

// ---- Status mapping (Channel A) ----
//
// Maps the provider sheet's existing dropdown vocabulary to crm.enrolments.status
// values. Sheet template (column N) carries: open, enrolled, presumed enrolled,
// cannot reach, lost. We honour all five.

const STATUS_MAP: Record<string, string> = {
  open: "open",
  enrolled: "enrolled",
  "presumed enrolled": "presumed_enrolled",
  "cannot reach": "cannot_reach",
  lost: "lost",
};

// Transition rules (permissive, with three guardrails):
//   1. billed / paid → anything           → anomaly (post-billing override)
//   2. anything → billed / paid           → anomaly (system-only statuses)
//   3. anything → open                    → anomaly (regression)
//   Otherwise: allowed.
function isAllowedTransition(current: string, target: string): boolean {
  if (current === "billed" || current === "paid") return false;
  if (target === "billed" || target === "paid") return false;
  if (target === "open") return false;
  return true;
}

// ---- Types ----

interface SheetEdit {
  lead_id: string;
  provider_id: string;
  column: "Status" | "Notes";
  old_value: string | null;
  new_value: string | null;
  editor_email: string | null;
  edited_at: string;
}

interface EnrolmentRow {
  id: number;
  submission_id: number;
  status: string;
}

interface AiSuggestion {
  implied_status: "contacted" | "enrolled" | "not_enrolled" | "disputed" | null;
  confidence: "high" | "medium" | "low";
  summary: string;
  rationale: string;
  should_surface: boolean;
}

const PROMPT_VERSION = "v1";

// ---- Main handler ----

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Auth
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token !== SHEETS_APPEND_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Parse body
  let body: SheetEdit;
  try {
    body = (await req.json()) as SheetEdit;
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (
    !body.lead_id ||
    !body.provider_id ||
    !body.column ||
    !body.edited_at ||
    (body.column !== "Status" && body.column !== "Notes")
  ) {
    return json({ ok: false, error: "missing required fields or unknown column" }, 400);
  }

  const submissionId = parseLeadId(body.lead_id);
  if (submissionId === null) {
    return json({ ok: false, action: "rejected", reason: "lead_id could not be parsed" }, 200);
  }

  // Verify submission exists before any audit log INSERT (the log's
  // submission_id column has a FK to leads.submissions; a non-existent id
  // would 500 the FK constraint).
  const subRows = await sql<Array<{ id: number }>>`
    SELECT id FROM leads.submissions WHERE id = ${submissionId} LIMIT 1
  `;
  const validSubmissionId: number | null = subRows.length > 0 ? submissionId : null;

  // Idempotency: same edit within 60s = duplicate
  const recent = await sql<Array<{ id: number }>>`
    SELECT id FROM crm.sheet_edits_log
    WHERE provider_id = ${body.provider_id}
      AND submission_id IS NOT DISTINCT FROM ${validSubmissionId}
      AND column_name = ${body.column}
      AND coalesce(old_value, '') = ${body.old_value ?? ""}
      AND coalesce(new_value, '') = ${body.new_value ?? ""}
      AND received_at > now() - interval '60 seconds'
    LIMIT 1
  `;
  if (recent.length > 0) {
    return json({ ok: true, duplicate: true }, 200);
  }

  if (validSubmissionId === null) {
    await logEdit({
      body,
      enrolmentId: null,
      submissionId: null,
      action: "rejected",
      reason: `submission id ${submissionId} not found in leads.submissions`,
    });
    await safeSendAnomalyEmail({
      providerId: body.provider_id,
      leadId: body.lead_id,
      column: body.column,
      newValue: body.new_value,
      reason: `Sheet row references a Lead ID that does not exist in the database. Sheet may have been edited manually.`,
    });
    return json({ ok: false, action: "rejected", reason: "lead not found" }, 200);
  }

  // Resolve enrolment row
  const enrolmentRows = await sql<Array<EnrolmentRow>>`
    SELECT id, submission_id, status
    FROM crm.enrolments
    WHERE submission_id = ${validSubmissionId} AND provider_id = ${body.provider_id}
    ORDER BY id DESC
    LIMIT 1
  `;
  const enrolment = enrolmentRows[0];
  if (!enrolment) {
    await logEdit({
      body,
      enrolmentId: null,
      submissionId: validSubmissionId,
      action: "rejected",
      reason: "no enrolment row found",
    });
    await safeSendAnomalyEmail({
      providerId: body.provider_id,
      leadId: body.lead_id,
      column: body.column,
      newValue: body.new_value,
      reason: "No enrolment row exists for this lead+provider — sheet edit ignored.",
    });
    return json({ ok: false, action: "rejected", reason: "no enrolment" }, 200);
  }

  // Branch
  if (body.column === "Status") {
    return await handleStatusEdit(body, enrolment, submissionId);
  }
  return await handleNotesEdit(body, enrolment, submissionId);
});

// ---- Channel A: Status ----

async function handleStatusEdit(
  body: SheetEdit,
  enrolment: EnrolmentRow,
  submissionId: number,
): Promise<Response> {
  const sheetValue = (body.new_value ?? "").trim().toLowerCase();
  const dbStatus = STATUS_MAP[sheetValue];

  if (!dbStatus) {
    await logEdit({
      body,
      enrolmentId: enrolment.id,
      submissionId,
      action: "queued",
      reason: `unmapped status value: "${body.new_value ?? ""}"`,
    });
    await safeSendAnomalyEmail({
      providerId: body.provider_id,
      leadId: body.lead_id,
      column: "Status",
      newValue: body.new_value,
      reason: `Provider entered an unmapped status value. Sheet may have data validation disabled.`,
    });
    return json({ ok: false, action: "queued", reason: "unmapped status" }, 200);
  }

  if (dbStatus === enrolment.status) {
    await logEdit({
      body,
      enrolmentId: enrolment.id,
      submissionId,
      action: "mirrored",
      appliedStatus: dbStatus,
      reason: "no-op (already at this status)",
    });
    return json({ ok: true, action: "mirrored", noop: true }, 200);
  }

  if (!isAllowedTransition(enrolment.status, dbStatus)) {
    await logEdit({
      body,
      enrolmentId: enrolment.id,
      submissionId,
      action: "queued",
      reason: `invalid transition: ${enrolment.status} → ${dbStatus}`,
    });
    await safeSendAnomalyEmail({
      providerId: body.provider_id,
      leadId: body.lead_id,
      column: "Status",
      newValue: body.new_value,
      reason: `Invalid transition: enrolment is currently "${enrolment.status}", provider tried to set "${dbStatus}". Not auto-applied.`,
    });
    return json({ ok: false, action: "queued", reason: "invalid transition" }, 200);
  }

  // Apply
  await sql`
    UPDATE crm.enrolments
    SET status = ${dbStatus},
        status_updated_at = now(),
        updated_at = now()
    WHERE id = ${enrolment.id}
  `;
  if (dbStatus === "disputed") {
    await sql`
      INSERT INTO crm.disputes (enrolment_id, raised_by, reason)
      VALUES (${enrolment.id}, 'provider', 'Sheet edit: status set to Disputed')
    `;
  }

  await logEdit({
    body,
    enrolmentId: enrolment.id,
    submissionId,
    action: "mirrored",
    appliedStatus: dbStatus,
  });

  return json({ ok: true, action: "mirrored", applied_status: dbStatus }, 200);
}

// ---- Channel B: Notes (AI-interpreted, gated) ----

async function handleNotesEdit(
  body: SheetEdit,
  enrolment: EnrolmentRow,
  submissionId: number,
): Promise<Response> {
  const noteText = (body.new_value ?? "").trim();
  if (noteText.length === 0) {
    await logEdit({
      body,
      enrolmentId: enrolment.id,
      submissionId,
      action: "note_only",
      reason: "empty update text (cleared cell)",
    });
    return json({ ok: true, action: "note_only", reason: "empty" }, 200);
  }

  if (!CHANNEL_B_ENABLED) {
    await logEdit({
      body,
      enrolmentId: enrolment.id,
      submissionId,
      action: "note_only",
      reason: "Channel B disabled (CHANNEL_B_ENABLED=false)",
    });
    return json({ ok: true, action: "note_only", reason: "channel B disabled" }, 200);
  }

  if (!ANTHROPIC_API_KEY || !PENDING_UPDATE_SECRET) {
    await logEdit({
      body,
      enrolmentId: enrolment.id,
      submissionId,
      action: "ai_error",
      reason: "missing ANTHROPIC_API_KEY or PENDING_UPDATE_SECRET",
    });
    await safeSendAnomalyEmail({
      providerId: body.provider_id,
      leadId: body.lead_id,
      column: "Notes",
      newValue: body.new_value,
      reason: "Channel B is enabled but a required secret is missing. Provider note not interpreted.",
    });
    return json({ ok: false, action: "ai_error", reason: "secret missing" }, 200);
  }

  // PII redact (decision 3 in scoping doc, confirmed 2026-04-30)
  const redactedNote = redactPII(noteText);

  // Lead context for the prompt
  const ctxRows = await sql<
    Array<{
      first_name: string | null;
      course_id: string | null;
      provider_name: string | null;
    }>
  >`
    SELECT
      s.first_name,
      s.course_id,
      (SELECT company_name FROM crm.providers WHERE provider_id = ${body.provider_id}) AS provider_name
    FROM leads.submissions s
    WHERE s.id = ${submissionId}
    LIMIT 1
  `;
  const ctx = ctxRows[0] ?? { first_name: null, course_id: null, provider_name: null };

  let suggestion: AiSuggestion;
  try {
    suggestion = await callClaude({
      leadName: ctx.first_name ?? "Unknown",
      courseId: ctx.course_id ?? "unknown-course",
      providerName: ctx.provider_name ?? body.provider_id,
      currentStatus: enrolment.status,
      previousNote: redactPII(body.old_value ?? ""),
      currentNote: redactedNote,
    });
  } catch (err) {
    console.error("Claude API error:", String(err));
    await logEdit({
      body,
      enrolmentId: enrolment.id,
      submissionId,
      action: "ai_error",
      reason: `Claude API error: ${String(err).slice(0, 200)}`,
    });
    await safeSendAnomalyEmail({
      providerId: body.provider_id,
      leadId: body.lead_id,
      column: "Notes",
      newValue: body.new_value,
      reason: "AI interpretation failed (API error). Owner should review the raw update manually.",
    });
    return json({ ok: false, action: "ai_error" }, 200);
  }

  // No status implication — log and move on
  if (suggestion.implied_status === null || suggestion.implied_status === enrolment.status) {
    await logEdit({
      body,
      enrolmentId: enrolment.id,
      submissionId,
      action: "note_only",
      aiSummary: suggestion.summary,
      aiImpliedStatus: suggestion.implied_status,
      aiConfidence: suggestion.confidence,
      promptVersion: PROMPT_VERSION,
    });
    // Append the original (un-redacted) note to crm.enrolments.notes for the dashboard
    await sql`
      UPDATE crm.enrolments
      SET notes = coalesce(notes, '') || ${`\n[${body.edited_at}] ${noteText}`},
          updated_at = now()
      WHERE id = ${enrolment.id}
    `;
    return json({ ok: true, action: "note_only", summary: suggestion.summary }, 200);
  }

  // Status change implied — queue for owner approval
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [pending] = await sql<Array<{ id: number }>>`
    INSERT INTO crm.pending_updates (
      enrolment_id, source, source_payload,
      current_status, suggested_status,
      ai_summary, ai_rationale, ai_confidence, prompt_version,
      resolver_token_expires_at
    )
    VALUES (
      ${enrolment.id}, 'sheet_note_ai',
      ${sql.json({
        provider_id: body.provider_id,
        lead_id: body.lead_id,
        column: body.column,
        old_value: body.old_value,
        new_value: redactedNote,
        editor_email: body.editor_email,
        edited_at: body.edited_at,
      })},
      ${enrolment.status}, ${suggestion.implied_status},
      ${suggestion.summary}, ${suggestion.rationale}, ${suggestion.confidence}, ${PROMPT_VERSION},
      ${expiresAt.toISOString()}
    )
    RETURNING id
  `;

  const logRow = await logEdit({
    body,
    enrolmentId: enrolment.id,
    submissionId,
    action: "ai_suggested",
    aiSummary: suggestion.summary,
    aiImpliedStatus: suggestion.implied_status,
    aiConfidence: suggestion.confidence,
    promptVersion: PROMPT_VERSION,
    pendingUpdateId: pending.id,
  });

  // Backfill source_log_id on the pending row
  if (logRow) {
    await sql`
      UPDATE crm.pending_updates SET source_log_id = ${logRow} WHERE id = ${pending.id}
    `;
  }

  // Build signed URLs for the email buttons
  const approveToken = await signPendingUpdateToken(pending.id, "approve", PENDING_UPDATE_SECRET!);
  const rejectToken = await signPendingUpdateToken(pending.id, "reject", PENDING_UPDATE_SECRET!);
  const overrideToken = await signPendingUpdateToken(pending.id, "override", PENDING_UPDATE_SECRET!);

  await safeSendAiSuggestionEmail({
    leadName: ctx.first_name ?? "Unknown",
    courseId: ctx.course_id ?? "unknown",
    providerName: ctx.provider_name ?? body.provider_id,
    currentStatus: enrolment.status,
    suggestedStatus: suggestion.implied_status,
    confidence: suggestion.confidence,
    summary: suggestion.summary,
    noteText, // original, un-redacted, sent only to the owner's inbox
    approveUrl: `${CONFIRM_BASE_URL}?token=${approveToken}`,
    rejectUrl: `${CONFIRM_BASE_URL}?token=${rejectToken}`,
    overrideUrl: `${CONFIRM_BASE_URL}?token=${overrideToken}`,
  });

  return json({ ok: true, action: "ai_suggested", pending_update_id: pending.id }, 200);
}

// ---- PII redaction ----

function redactPII(text: string): string {
  if (!text) return text;
  // Email
  let out = text.replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    "[email redacted]",
  );
  // UK phone numbers (simplified: any run of 10+ digits with optional separators / +44 prefix)
  out = out.replace(
    /(\+?\d[\d\s().-]{8,}\d)/g,
    (match) => {
      const digits = match.replace(/\D/g, "");
      return digits.length >= 10 ? "[phone redacted]" : match;
    },
  );
  return out;
}

// ---- Claude API ----

async function callClaude(args: {
  leadName: string;
  courseId: string;
  providerName: string;
  currentStatus: string;
  previousNote: string;
  currentNote: string;
}): Promise<AiSuggestion> {
  const systemPrompt = `You interpret a single freshly-added provider note about a lead in a UK education lead-routing system. Your job is to determine whether the note implies a change to the lead's enrolment status.

Status values you may suggest:
- "contacted": provider has reached the learner (call, voicemail, text)
- "enrolled": learner has confirmed enrolment, paperwork signed, course start booked
- "not_enrolled": learner declined, ineligible, lost, or won't proceed
- "disputed": data error, provider disputing eligibility, conflict with system record

Rules:
- Default implied_status to null. Only suggest a change if the note CLEARLY implies one.
- "spoke to her", "called", "left voicemail", "tried to reach" → contacted (only if current status is "open")
- "enrolled", "starting Monday", "paperwork signed", "course confirmed" → enrolled
- "not interested", "not eligible", "ineligible", "won't enrol", "declined" → not_enrolled
- "disputing", "wrong details", "can't verify identity", "data error" → disputed
- Informational / scheduling / generic ("course starts Monday", "good fit") → null
- Never escalate beyond what the note actually says.
- If unsure, set confidence "low" and surface anyway so the owner decides.

Return STRICT JSON matching this schema, nothing else:
{
  "implied_status": "contacted" | "enrolled" | "not_enrolled" | "disputed" | null,
  "confidence": "high" | "medium" | "low",
  "summary": string (one short sentence in plain English about what the note says),
  "rationale": string (one short sentence explaining your status pick),
  "should_surface": boolean
}`;

  const userMessage = `Lead: ${args.leadName}
Course: ${args.courseId}
Provider: ${args.providerName}
Current status: ${args.currentStatus}
Previous update text: ${args.previousNote || "(none)"}
New update text: ${args.currentNote}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: [
        { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userMessage }],
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Anthropic ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data?.content?.[0]?.text ?? "";
  let parsed: AiSuggestion;
  try {
    // Claude sometimes wraps JSON in code fences; strip them
    const cleaned = content.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    parsed = JSON.parse(cleaned) as AiSuggestion;
  } catch {
    throw new Error(`Claude returned non-JSON: ${content.slice(0, 200)}`);
  }

  // Validate shape
  const validStatuses = ["contacted", "enrolled", "not_enrolled", "disputed", null];
  const validConfidence = ["high", "medium", "low"];
  if (
    !validStatuses.includes(parsed.implied_status as string | null) ||
    !validConfidence.includes(parsed.confidence) ||
    typeof parsed.summary !== "string" ||
    typeof parsed.rationale !== "string"
  ) {
    throw new Error(`Claude output failed schema validation: ${content.slice(0, 200)}`);
  }

  return parsed;
}

// ---- Audit log helper ----

async function logEdit(args: {
  body: SheetEdit;
  enrolmentId: number | null;
  submissionId: number | null;
  action: string;
  appliedStatus?: string | null;
  aiSummary?: string;
  aiImpliedStatus?: string | null;
  aiConfidence?: string;
  promptVersion?: string;
  pendingUpdateId?: number | null;
  reason?: string | null;
}): Promise<number | null> {
  try {
    const [row] = await sql<Array<{ id: number }>>`
      INSERT INTO crm.sheet_edits_log (
        enrolment_id, submission_id, provider_id, column_name,
        old_value, new_value, editor_email, edited_at,
        action, applied_status,
        ai_summary, ai_implied_status, ai_confidence, prompt_version,
        pending_update_id, reason
      )
      VALUES (
        ${args.enrolmentId}, ${args.submissionId}, ${args.body.provider_id}, ${args.body.column},
        ${args.body.old_value}, ${args.body.new_value}, ${args.body.editor_email}, ${args.body.edited_at},
        ${args.action}, ${args.appliedStatus ?? null},
        ${args.aiSummary ?? null}, ${args.aiImpliedStatus ?? null}, ${args.aiConfidence ?? null}, ${args.promptVersion ?? null},
        ${args.pendingUpdateId ?? null}, ${args.reason ?? null}
      )
      RETURNING id
    `;
    return row?.id ?? null;
  } catch (err) {
    console.error("sheet_edits_log INSERT failed:", String(err));
    return null;
  }
}

// ---- Anomaly + AI suggestion emails ----

async function safeSendAnomalyEmail(args: {
  providerId: string;
  leadId: string;
  column: string;
  newValue: string | null;
  reason: string;
}): Promise<void> {
  try {
    const html = `
      <p>Sheet edit anomaly — needs a look.</p>
      <ul>
        <li><strong>Provider:</strong> ${escapeHtml(args.providerId)}</li>
        <li><strong>Lead ID:</strong> ${escapeHtml(args.leadId)}</li>
        <li><strong>Column:</strong> ${escapeHtml(args.column)}</li>
        <li><strong>New value:</strong> ${escapeHtml(args.newValue ?? "")}</li>
        <li><strong>Reason:</strong> ${escapeHtml(args.reason)}</li>
      </ul>
      <p>The edit was logged in <code>crm.sheet_edits_log</code> but not auto-applied. Open the provider sheet or admin dashboard to resolve.</p>
    `;
    await sendBrevoEmail({
      brand: "switchleads",
      to: [{ email: OWNER_NOTIFICATION_EMAIL }],
      subject: `[Sheet anomaly] ${args.providerId} lead ${args.leadId}: ${args.reason.slice(0, 60)}`,
      htmlContent: html,
    });
  } catch (err) {
    console.error("anomaly email failed:", String(err));
  }
}

async function safeSendAiSuggestionEmail(args: {
  leadName: string;
  courseId: string;
  providerName: string;
  currentStatus: string;
  suggestedStatus: string;
  confidence: string;
  summary: string;
  noteText: string;
  approveUrl: string;
  rejectUrl: string;
  overrideUrl: string;
}): Promise<void> {
  try {
    const html = `
      <p>Provider added an update — Claude thinks it implies a status change.</p>
      <ul>
        <li><strong>Lead:</strong> ${escapeHtml(args.leadName)}</li>
        <li><strong>Course:</strong> ${escapeHtml(args.courseId)}</li>
        <li><strong>Provider:</strong> ${escapeHtml(args.providerName)}</li>
        <li><strong>Current status:</strong> ${escapeHtml(args.currentStatus)}</li>
        <li><strong>Suggested:</strong> <strong>${escapeHtml(args.suggestedStatus)}</strong> (${escapeHtml(args.confidence)} confidence)</li>
      </ul>
      <p><strong>The update:</strong></p>
      <blockquote style="border-left: 3px solid #ccc; padding-left: 12px; color: #555;">${escapeHtml(args.noteText)}</blockquote>
      <p><strong>Claude's read:</strong> ${escapeHtml(args.summary)}</p>
      <p style="margin-top: 24px;">
        <a href="${args.approveUrl}" style="background: #2e7d32; color: #fff; padding: 10px 18px; border-radius: 4px; text-decoration: none; margin-right: 8px;">Approve</a>
        <a href="${args.rejectUrl}" style="background: #b3412e; color: #fff; padding: 10px 18px; border-radius: 4px; text-decoration: none; margin-right: 8px;">Reject</a>
        <a href="${args.overrideUrl}" style="background: #555; color: #fff; padding: 10px 18px; border-radius: 4px; text-decoration: none;">Choose different</a>
      </p>
      <p style="color: #888; font-size: 12px;">Links expire in 7 days.</p>
    `;
    await sendBrevoEmail({
      brand: "switchleads",
      to: [{ email: OWNER_NOTIFICATION_EMAIL }],
      subject: `[Status suggestion] ${args.leadName} — ${args.suggestedStatus} (${args.confidence})`,
      htmlContent: html,
    });
  } catch (err) {
    console.error("AI suggestion email failed:", String(err));
  }
}

// ---- Helpers ----

// Lead IDs in provider sheets use the formatted shape "SL-YY-MM-NNNN" where
// NNNN is the zero-padded submission_id (see _shared/route-lead.ts
// formatLeadId). This helper accepts either the formatted string or a raw
// numeric id and returns the underlying submission_id.
function parseLeadId(raw: string): number | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (/^\d+$/.test(trimmed)) {
    const direct = Number.parseInt(trimmed, 10);
    return Number.isFinite(direct) ? direct : null;
  }
  const match = trimmed.match(/(\d+)\s*$/);
  if (match) {
    const id = Number.parseInt(match[1], 10);
    return Number.isFinite(id) ? id : null;
  }
  return null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
