---
name: Sheet → DB mirror scoping
description: Interim hybrid system that mirrors provider sheet status edits and AI-interprets free-text notes into crm.enrolments so the owner has consolidated lead state without a provider dashboard
type: scoping
---

# Sheet → DB Mirror — Scoping

**Status:** Draft for owner sign-off.
**Created:** 2026-04-30.
**Updated:** 2026-04-30 — hybrid design (Status column deterministic + Updates column AI-interpreted).
**Author:** Claude (platform session).
**Replaces:** nothing yet — new system.
**Retires with:** Phase 4 provider dashboard. Sheet→DB mirror retires; the underlying `crm.enrolments` schema, status vocabulary, audit log, pending-updates table, and tracker view all carry forward.

---

## Problem

Three pilot providers are editing their Google Sheets to mark leads as enrolled, contacted, can't reach, etc. **Crucially, providers update state in two different ways:** sometimes they edit a Status column, sometimes they just write a free-text note ("spoke to her, sounded keen, sending paperwork"). The owner has no consolidated view of state across all three providers, and a deterministic-only design that watches a Status column would miss half the signal.

`crm.enrolments` already exists as the per-routing state table. Migration 0042 (2026-04-30) auto-creates an `open` row at routing time. Today, that row never advances — nothing flows back from the provider sheet.

The Phase 4 provider dashboard (scoped in `admin-dashboard-scoping.md`) replaces sheets entirely with an authenticated web UI per provider. It is not imminent. The owner needs visibility now, captured from both signal channels.

---

## Design (one paragraph)

Every provider sheet gets two watched columns: a `Status` column with a fixed dropdown, and a `Updates` column for free text. An installable Apps Script `onEdit` trigger fires on either column and POSTs the edit to a new Edge Function `sheet-edit-mirror`. **Channel A (Status):** deterministic mapping to the `crm.enrolments` enum, auto-mirrored, no approval, instant. **Channel B (Updates):** Edge Function calls Claude API with the note text plus the lead's current state, gets back a structured suggestion (status change implied or not, confidence, plain-English summary). If a status change is implied, the suggestion is queued in a new `crm.pending_updates` table and the owner gets an HMAC-signed approval email with Approve / Reject / Override buttons (same pattern as routing-confirm). On approve, the status applies. Updates that imply no change are logged as `note_only` and never bother the owner. Both channels write to `crm.sheet_edits_log` for audit. A daily digest summarises the day. The admin tracker view shows consolidated state.

---

## Status vocabulary mapping

Sheet dropdown values (provider-facing) → `crm.enrolments.status` (DB):

| Sheet value | DB status | Trigger |
|---|---|---|
| `Open` | `open` | initial state — no action |
| `Contacted` | `contacted` | mirrored, no billing impact |
| `Enrolled` | `enrolled` | mirrored, queues billing trigger |
| `Not enrolled` | `not_enrolled` | mirrored, no billing |
| `Disputed` | `disputed` | mirrored, blocks billing, opens `crm.disputes` row |

System-only DB statuses (never appear in the sheet dropdown):
- `presumed_enrolled` — set automatically by 14-day timer if status remains `open`
- `billed`, `paid` — set by GoCardless integration

If a provider sets the sheet value to `Enrolled` after the 14-day timer has already flipped to `presumed_enrolled`, the mirror upgrades to `enrolled` (the explicit confirmation is more authoritative than the presumption).

---

## Components

### 1. Sheet column convention
Every provider sheet must have two watched header columns:
- `Status` — Google Sheets data validation: dropdown of the five sheet values above. Anything else triggers anomaly path.
- `Updates` — free text. No validation. AI interpreted.

**Why `Updates` and not `Notes`:** the existing `Notes` column (also referred to as `Comments`) is system-owned. `route-lead.ts` auto-populates it with messages like "Previously applied for X" and "Re-applied — see <parent-id>" via the appender's FIELD_MAP. Reusing `Notes` for provider edits would cause edit-trigger collisions (system writes triggering AI interpretation), confuse the audit trail, and risk the AI interpreting system-generated text as provider intent. `Updates` is a fresh column owned solely by provider edits.

Other columns are not watched (yet). The provider onboarding playbook gets updated to include both columns as required sheet structure.

### 2. Apps Script onEdit handler (`provider-sheet-edit-mirror.gs`)
New canonical script. Sits alongside `provider-sheet-appender-v2.gs` in `platform/apps-scripts/`. Bound to each provider sheet as an installable trigger (separate Apps Script primitive from the existing `doPost` web app — both can coexist on the same sheet).

When fired:
1. Reads the edited cell's row + column.
2. Reads the row's `Lead ID` cell as the join key.
3. Reads the current value, the previous value (from `e.oldValue`), and the column header.
4. POSTs JSON to the `sheet-edit-mirror` Edge Function with: `lead_id`, `provider_id` (hardcoded per script deploy), `column`, `old_value`, `new_value`, `editor_email` (from `e.user.getEmail()` if available), `edited_at` (timestamp).

Filters at the script level: only POSTs when the edited column header matches `Status` or `Updates`. Other column edits ignored.

Token-authed the same way as the appender — `SHEETS_APPEND_TOKEN` constant, matched by the Edge Function.

### 3. Edge Function: `sheet-edit-mirror`
New function in `platform/supabase/functions/sheet-edit-mirror/`. Verb: POST. Auth: bearer token (matches `SHEETS_APPEND_TOKEN`). Deploy with `--no-verify-jwt` per pattern.

On receipt:
1. Validates token, payload shape.
2. Resolves `lead_id` → `enrolment_id` via `crm.enrolments` join on `submission_id` + `provider_id`.
3. Branches by `column`:

**Channel A — `Status` column (deterministic):**
4A. Maps sheet value to DB status using the table above. Unmappable value → anomaly path.
5A. Validates the transition:
   - `open` → any (allowed)
   - `contacted` → `enrolled` / `not_enrolled` / `disputed` (allowed)
   - `enrolled` → `disputed` (allowed)
   - `billed` / `paid` → anything (anomaly — provider can't override post-billing state)
   - Regression (e.g. `enrolled` → `open`) → anomaly
6A. If valid: UPDATE `crm.enrolments.status`, `status_updated_at`. INSERT into `crm.sheet_edits_log` with `action='mirrored'`. If new status is `disputed`, also INSERT into `crm.disputes` (raised_by='provider').
7A. If anomaly: INSERT into `crm.sheet_edits_log` with `action='queued'` + reason. Send anomaly email to owner via Brevo.

**Channel B — `Updates` column (AI-interpreted):**
4B. Builds a context payload for Claude: lead name, course, current `crm.enrolments.status`, previous note text (`old_value`), new note text (`new_value`), provider name. Last 3 historical notes from `crm.sheet_edits_log` for context if any exist.
5B. Calls Claude (Haiku 4.5 — cheapest model that handles this well) with a structured prompt (see Prompt Spec below). System prompt is cached via prompt caching to keep cost minimal across rapid edits. Returns:
   ```json
   {
     "implied_status": "contacted" | "enrolled" | "not_enrolled" | "disputed" | null,
     "confidence": "high" | "medium" | "low",
     "summary": "Provider spoke with learner; learner is keen and paperwork being sent.",
     "rationale": "Note describes a successful contact event.",
     "should_surface": true
   }
   ```
6B. If `implied_status` is null OR equals current status: log as `action='note_only'` with the AI summary. Owner is not pinged. Note text is preserved in `crm.enrolments.notes` (appended) for the dashboard.
7B. If `implied_status` differs from current status: INSERT into `crm.pending_updates` (new table — see schema below). INSERT into `crm.sheet_edits_log` with `action='ai_suggested'` and the suggestion JSON. Send approval email to owner via Brevo with HMAC-signed Approve / Reject / Override links pointing at a new `pending-update-confirm` Edge Function.
8B. If Claude API errors or returns malformed JSON: log as `action='ai_error'`, send anomaly email, do not mirror. Note text is still preserved.

**Idempotency:** same `(lead_id, column, old_value, new_value, edited_at)` tuple within a 60-second window is treated as a duplicate (Apps Script can fire onEdit twice on rapid edits).

**Always ack 200** to the Apps Script (script doesn't retry; failures land in `leads.dead_letter` if the function itself errors).

### 3a. Edge Function: `pending-update-confirm`
Companion to `sheet-edit-mirror`. Handles the Approve / Reject / Override clicks from the AI suggestion email. Same HMAC-signed token pattern as `routing-confirm`.

- **Approve:** UPDATE `crm.pending_updates.status='approved'`, `applied_at=now()`. UPDATE `crm.enrolments.status` to the suggested value. INSERT `crm.sheet_edits_log` row with `action='ai_approved'`. Returns confirmation page.
- **Reject:** UPDATE `crm.pending_updates.status='rejected'`. No change to enrolment. Returns confirmation page.
- **Override:** Returns a small page with the five status options as buttons. Owner picks one. UPDATE `crm.pending_updates.status='overridden'`, `override_status=<chosen>`, `applied_at=now()`. UPDATE `crm.enrolments.status` to chosen value.

Deploy with `--no-verify-jwt`.

### 3b. Prompt Spec for Claude (Channel B)
System prompt (cached, ~500 tokens):
- Role: interpret a single freshly-added provider note about a lead.
- Inputs schema: lead name, course, current status, current note, previous note, provider name, recent notes.
- Output schema: strict JSON matching the shape above.
- Rules:
  - Only suggest a status change if the note clearly implies one. Default `implied_status: null`.
  - "spoke to her", "called", "left voicemail" → `contacted` if current is `open`.
  - "enrolled", "starting Monday", "paperwork signed" → `enrolled`.
  - "not interested", "not eligible", "ineligible", "won't enrol" → `not_enrolled`.
  - "disputing", "wrong details", "can't verify" → `disputed`.
  - Ambiguous / informational → `null`, but include a useful `summary`.
  - Never escalate beyond what the note actually says.
  - If unsure: `confidence: "low"`, surface anyway so owner decides.

Prompt versioned in `platform/supabase/functions/sheet-edit-mirror/prompt.ts` and bumped on any change. Per `.claude/rules/schema-versioning.md`, prompt outputs are a data contract — output schema gets a `prompt_version` field.

### 4. Audit table: `crm.sheet_edits_log` (new — migration 0047)
```sql
CREATE TABLE crm.sheet_edits_log (
  id              BIGSERIAL PRIMARY KEY,
  enrolment_id    BIGINT REFERENCES crm.enrolments(id),
  submission_id   BIGINT REFERENCES leads.submissions(id),
  provider_id     TEXT NOT NULL REFERENCES crm.providers(provider_id),
  column_name     TEXT NOT NULL, -- 'Status' | 'Updates'
  old_value       TEXT,
  new_value       TEXT,
  editor_email    TEXT,
  edited_at       TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  action          TEXT NOT NULL, -- 'mirrored' | 'queued' | 'note_only' | 'ai_suggested' | 'ai_approved' | 'ai_rejected' | 'ai_overridden' | 'ai_error' | 'rejected'
  applied_status  TEXT, -- the crm.enrolments.status set, if applied
  ai_summary      TEXT, -- Claude's plain-English summary, if Channel B
  ai_implied_status TEXT, -- what Claude suggested, if Channel B
  ai_confidence   TEXT, -- 'high' | 'medium' | 'low', if Channel B
  prompt_version  TEXT, -- prompt schema version, if Channel B
  pending_update_id BIGINT, -- FK to crm.pending_updates, if Channel B
  reason          TEXT, -- why queued / rejected, if applicable
  notes           TEXT
);

CREATE INDEX ON crm.sheet_edits_log (provider_id, received_at DESC);
CREATE INDEX ON crm.sheet_edits_log (action, received_at DESC) WHERE action NOT IN ('mirrored', 'note_only', 'ai_approved');
```

### 4a. Pending updates table: `crm.pending_updates` (new — migration 0047)
```sql
CREATE TABLE crm.pending_updates (
  id                BIGSERIAL PRIMARY KEY,
  enrolment_id      BIGINT NOT NULL REFERENCES crm.enrolments(id),
  source            TEXT NOT NULL, -- 'sheet_note_ai' (others later)
  current_status    TEXT NOT NULL, -- snapshot at time of suggestion
  suggested_status  TEXT NOT NULL,
  ai_summary        TEXT,
  ai_rationale      TEXT,
  ai_confidence     TEXT,
  prompt_version    TEXT,
  source_payload    JSONB, -- the raw note text + context
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  status            TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected' | 'overridden' | 'expired'
  override_status   TEXT, -- chosen status if overridden
  applied_at        TIMESTAMPTZ,
  resolver_token    TEXT NOT NULL, -- HMAC-signed for the email buttons
  resolver_token_expires_at TIMESTAMPTZ NOT NULL -- 7 days
);

CREATE INDEX ON crm.pending_updates (status, created_at DESC) WHERE status = 'pending';
CREATE INDEX ON crm.pending_updates (enrolment_id);
```

### 5. Anomaly emails
Sent via existing Brevo transactional pattern. Template includes: provider, lead ID, what changed, why it didn't mirror, link to the audit log row. Fires for: unknown column, unmapped status value, status regression, post-billing override attempt, lead ID not found, AI error.

### 5a. AI suggestion approval emails (Channel B)
Separate Brevo template. One email per pending update at suggestion time. Contains: lead name, course, provider, current status, the new note text, Claude's plain-English summary, suggested new status, three signed buttons (Approve / Reject / Override). Tokens expire after 7 days; expired tokens auto-mark the row `status='expired'` via a daily cron sweep.

### 6. Daily digest email (cron job)
New scheduled function `sheet-mirror-daily-digest`. Runs 09:00 UK daily. Reads `crm.sheet_edits_log` and `crm.pending_updates` for the past 24 hours. Groups by provider. Sends one email to the owner with three sections:
1. **Auto-mirrored status changes** ("EMS: 3 enrolled, 1 not enrolled. Courses Direct: 2 contacted.")
2. **AI-approved suggestions** (suggestions you approved yesterday + their effect)
3. **Pending suggestions awaiting your call** (count + link to a bulk-review page)
4. **Anomalies still unresolved**

Skips the email if zero items in all four sections.

### 7. Tracker view
Already partially scoped in `admin-dashboard-scoping.md`. Confirm the existing admin dashboard surfaces `crm.enrolments` joined to `leads.submissions` joined to `crm.providers` with filters by status, provider, age. Add a "Pending suggestions" tile (count + drill-through to per-provider list, each with Approve / Reject / Override inline). If the join view exists, only the pending-suggestions tile is new work. If not, this scoping doc adds the full tracker view as a dependency.

---

## What this does NOT do (deliberately)

- **No AI on the Status column.** Channel A is deterministic only. The dropdown is small and authoritative; AI has no place there.
- **No auto-write from AI.** Channel B always queues a suggestion for owner approval. Even high-confidence suggestions wait for a click. This protects against AI misinterpretation of provider notes hitting billing.
- **No owner approval for Status column changes.** Channel A is fully automated for the five mapped values. The 7-day post-billing dispute window is the safety net.
- **No write access for agents.** The mirror is a system, not an agent. Per `.claude/rules/data-infrastructure.md` section 11, agents still cannot write. Provider edits are treated as authoritative third-party data, identical in trust model to the inbound lead webhook. Claude API calls inside the Edge Function are bounded by deterministic post-processing (output schema validated) and the human-in-the-loop approval flow.
- **No retroactive state.** Pre-existing sheet rows that already have a status set or notes will not be back-mirrored at deploy time. Owner can either backfill manually or run a one-off data-ops script (`platform/supabase/data-ops/`).
- **No batch-edit interpretation.** Each note edit is interpreted in isolation. If a provider edits Status and Updates in the same save, both fire as separate onEdit events; Status wins on conflict (provider's explicit choice beats AI inference of their own note).

---

## Phase 4 retirement plan

When the provider dashboard ships:
- Apps Script `onEdit` trigger: removed from each sheet.
- `sheet-edit-mirror` Edge Function: deprecated, kept for 30 days, then deleted.
- `sheet-mirror-daily-digest` cron: deleted.
- `crm.sheet_edits_log`: kept indefinitely as historical audit. Renamed to `crm.legacy_sheet_edits_log` if confusing.
- Sheet `Status` column: kept in the sheet (sheets become read-only audit copies during Phase 4 transition, or providers stop using sheets entirely).
- Status vocabulary, `crm.enrolments` schema, tracker view: unchanged. Dashboard writes directly via authenticated UI.

The Phase 4 dashboard cutover is one Edge Function deletion plus removing the Apps Script trigger per sheet. No migration, no schema change.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Provider edits sheet but webhook fails | `leads.dead_letter` row + paste-manually email, same pattern as appender |
| Provider sets wrong status accidentally (Channel A) | Anomaly path catches regressions; daily digest gives owner a chance to spot wrong-direction changes within 24h; 7-day dispute window catches anything else |
| Provider disables data validation and free-texts Status column | Anomaly email fires immediately; mirror does nothing |
| Claude misinterprets a note (Channel B) | All Channel B suggestions go to owner approval; nothing applies until owner clicks Approve. Owner can Override to a different status. Prompt is versioned; if a class of note misfires, the prompt is updated and re-tested. |
| Claude API outage | Channel B note edits are logged with `action='ai_error'` and an anomaly email fires — owner reviews the raw note manually until API recovers. Channel A unaffected. |
| Apps Script `onEdit` doesn't fire for programmatic edits | Acceptable — only the appender writes programmatically, and it only writes to new rows |
| Two providers race-edit the same sheet | Not a concern — sheets are per-provider |
| Token leak | `SHEETS_APPEND_TOKEN` rotation pattern already in `secrets-rotation.md`; new `ANTHROPIC_API_KEY` rotates on the same cadence |
| Schema regression from a future migration | `crm.sheet_edits_log` is decoupled from `crm.enrolments` enum — if the enum changes, only the mapping table in the Edge Function needs updating |
| AI cost runaway | At pilot volume (~5-10 leads/week × 3 providers × ~2 note edits per lead = ~50-60 calls/month), Haiku 4.5 cost is pence per month. Set a Supabase Edge Function timeout of 10 seconds and a hard monthly spend alarm in Anthropic console as belt-and-braces. |

---

## Privacy and data flow note

**Channel B sends provider notes to the Anthropic API for interpretation.** Provider notes can contain learner PII (name, what the learner said on a call, personal context, contact attempts).

**Anthropic is not a new sub-processor in this data flow.** Switchable's owner already discusses lead data with Claude conversationally as part of day-to-day operations. This system formalises what is already happening, with the benefit that the data flow is now documented, scoped, audit-logged, and bounded.

**Required prerequisites (Mira / legal, not code):**

1. Confirm the Switchable privacy policy lists Anthropic as a sub-processor for AI-assisted operations (covers both this system and ad-hoc owner conversations with Claude). If it does not, update it. This is needed regardless of whether this scoping ships.
2. Confirm the learner consent text covers "AI-assisted analysis of provider notes about you" — most policies that already cover "third-party processors used for service operations" cover this without further wording, but verify.
3. If the privacy policy needs updating, log it in `accounts-legal/changelog.md` and update the Notion page (Legal → Switchable → Privacy Policy) per workspace rules.
4. Consider a Data Processing Addendum (DPA) with Anthropic — they publish one publicly. Sign and file in Notion.

**Operational guardrails (this system, in code):**
- No data retention beyond what's needed: each Claude API call is independent, system prompt cached but no persistent context across calls.
- Anthropic API does not train on API traffic by default — verify in current Anthropic terms.
- Optional belt-and-braces: redact email and phone from the note text before sending to Claude (name + course + note body is enough for status inference). Cheap to implement; recommended as v1 default.

**Decision needed:** redact email/phone from notes before AI call (default in this doc: yes), or send raw (faster setup, slightly more inferential signal).

---

## Implementation order (parallel build, gated activation)

Three workstreams run in parallel. Channel A ships to production as soon as it passes verification. Channel B is built end-to-end but its Claude API calls stay behind a `CHANNEL_B_ENABLED` env flag (default `false` in production) until Phase 0 is signed off.

### Workstream P0 — Legal/privacy (owner + Clara, in progress)
P0a. Audit Switchable privacy policy for Anthropic / sub-processor language. Update if missing.
P0b. File Anthropic DPA in Notion.
P0c. Confirm learner consent text covers AI-assisted analysis.
P0d. Log in `accounts-legal/changelog.md`.
**Gate:** Channel B activation in production blocked until P0a–d are complete.

### Workstream A — Channel A (Status column, deterministic)
A1. **Migration 0047** — `crm.sheet_edits_log` + `crm.pending_updates` + indexes. `data-architecture.md` updates. Changelog entry. Reversible.
A2. **Edge Function `sheet-edit-mirror`** — Channel A path, log-only at first. Deploy with `--no-verify-jwt`.
A3. **Apps Script `provider-sheet-edit-mirror.gs`** — canonical script, both `Status` and `Updates` watched (filter at function level so unused channel is ignored). Onboarding playbook updated.
A4. **Owner step:** add `Status` column with dropdown validation to all three pilot sheets.
A5. **Owner step:** add `Updates` column to all three pilot sheets (used by Workstream B once enabled).
A6. **Deploy Apps Script + onEdit trigger to all three sheets.**
A7. **Activate Channel A UPDATE path** — Edge Function flips from log-only to log-plus-mirror for Status edits. Verify five status transitions per provider.
A8. **Channel A anomaly Brevo template** — tested with an invalid status value.
**Ship:** as soon as A1–A8 verify clean. Independent of Workstream B and Workstream P0.

### Workstream B — Channel B (Updates column, AI-interpreted)
Built in parallel with Workstream A. Stays flagged off in production until Workstream P0 completes.

B1. **Edge Function `pending-update-confirm`** — Approve / Reject / Override handler. HMAC-signed token pattern. Tested against a hand-crafted pending row.
B2. **Channel B logic in `sheet-edit-mirror`** — Claude API integration (Haiku 4.5), prompt v1, output schema validation, PII redaction, idempotency. Behind `CHANNEL_B_ENABLED` flag (default `false` in production).
B3. **AI suggestion Brevo template** — Approve/Reject/Override email.
B4. **Channel B anomaly Brevo template** — AI error / API outage path.
B5. **Add `ANTHROPIC_API_KEY` secret to Supabase Edge Function env.**
B6. **End-to-end test in dev** — flag on, fire test note edits per provider, click each of Approve / Reject / Override.
B7. **Activation (gated on P0):** flip `CHANNEL_B_ENABLED=true` in production. Re-verify with one note edit per provider.

### Workstream D — Owner-facing surfaces
D1. **Tracker view** confirmed / extended in admin dashboard (consolidates `crm.enrolments` × `leads.submissions` × `crm.providers`).
D2. **Overview tile** on admin dashboard — headline counts (this week's mirrored, AI suggestions pending, anomalies open).
D3. **Actions tile** on admin dashboard — drill-through to pending AI suggestions with inline Approve / Reject / Override.
D4. **Daily digest cron** — `sheet-mirror-daily-digest`, 09:00 UK. Email + writes to a snapshot table read by D2/D3 tiles.

### Workstream H — House-keeping (last)
H1. **Update `infrastructure-manifest.md`** — new functions, tables, cron, secrets.
H2. **Update `secrets-rotation.md`** — `ANTHROPIC_API_KEY` rotation cadence.
H3. **Run `/ultrareview`** before deploying Workstream A migration, Workstream B Edge Function changes, and Workstream D dashboard changes.

No big-bang deploy. Each workstream verifies and ships independently. Channel A delivers consolidated state visibility ahead of Channel B's gated activation.

---

## Decisions (confirmed 2026-04-30)

1. ✅ **Channel A — auto-mirror `Enrolled` without approval.** Dispute window is the safety net.
2. ✅ **Channel B — every AI suggestion requires owner Approve click.** Even high-confidence. AI never auto-applies.
3. ✅ **PII redaction before Claude calls.** Strip email and phone from note text. Keep name + course + note body. Implemented as `redactPII(text)` helper in the Edge Function. Supports GDPR data minimisation.
4. ✅ **Daily digest: email + dashboard tiles.** Email pings owner. Two dashboard tiles: one in Overview (counts/headline), one in Actions (drill-through pending suggestions for review).
5. ✅ **Anomaly emails: one per anomaly initially.** Switch to throttled (daily roll-up) if volume warrants.
6. ✅ **No backfill.** Forward-only from go-live. Owner is up to date on existing leads; any manual cleanup is owner-driven.
7. ✅ **Phase 0 (legal/privacy) owned by owner + Clara.** In progress as of 2026-04-30.
8. ✅ **Parallel build, gated activation.** Build Channel A and Channel B in parallel. Channel A ships to production as soon as ready. Channel B is built end-to-end but Claude API calls stay disabled in production until Clara signs off Phase 0; until then, Channel B can run in a flagged-off state in dev/staging only.

---

## Cross-references

- `platform/docs/data-architecture.md` — `crm.enrolments` source of truth
- `platform/docs/admin-dashboard-scoping.md` — Phase 4 dashboard design (the long-term replacement)
- `platform/docs/provider-onboarding-playbook.md` — adds the Status column step + onEdit trigger step
- `platform/docs/infrastructure-manifest.md` — new function and cron rows added on deploy
- `platform/docs/secrets-rotation.md` — `SHEETS_APPEND_TOKEN` already covers the new function
- `platform/apps-scripts/provider-sheet-appender-v2.gs` — sibling script, coexists on the same sheet
- `.claude/rules/data-infrastructure.md` — governance binding
- `.claude/rules/schema-versioning.md` — migration 0047 is additive, no payload schema bump needed
