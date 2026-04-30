# Platform - Changelog

Most recent at top. Every schema change, data migration, access policy change, and significant decision logged here. See `.claude/rules/data-infrastructure.md` for entry format rules.

---

## 2026-04-30: Switchable `data-complaint-switchable` form added to allowlist

**Type:** New Netlify form name registered for the `/data-complaint/` page on switchable.org.uk.

DUAA "How to Complain" section (live in Notion privacy 24 Apr, surfaced as Section 13 in current Notion structure) requires a routable complaint surface on each brand. SwitchLeads version shipped earlier today; Switchable version followed in the same session to bring deployed HTML up to lockstep with Notion. Privacy + Terms HTML also synced end-to-end from Notion as part of the same Mable session — see `switchable/site/docs/current-handoff.md`.

**Form details:**
- `form_name: data-complaint-switchable`
- `webhook_url: null` — Netlify email notification only to legal@switchable.org.uk (not a lead capture, no Edge Function routing)
- Captures user PII (name, email, what_happened, outcome_wanted, brand selection) so carries `terms_accepted` (required), `marketing_opt_in` (optional), `schema_version=1.0`, and honeypot per the PII consent rule
- Page has noindex + og:url to /course-finder/ per transactional-page meta rule

**Owner action items pending (post-deploy, in Netlify dashboard):**
- Forms → data-complaint-switchable → Form notifications → add email notification to legal@switchable.org.uk (no outgoing webhook needed)
- After form is wired and a test submission lands, trigger `POST https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-forms-audit` to verify allowlist alignment

**Files changed:**
- `switchable/site/deploy/deploy/data-complaint/index.html` — new (procedure + form)
- `switchable/site/deploy/deploy/data-complaint-thankyou/index.html` — new
- `switchable/site/deploy/deploy/data/form-allowlist.json` — new entry appended
- `switchable/site/deploy/deploy/privacy/index.html` — full sync from Notion (added: Section 1 apprenticeship paragraph, Section 5 payments + international transfers, Section 6 AI sub-processor + retention table, Section 7 marketing/analytics/advertising expanded, Section 12 DPO line, Section 13 How to Complain). Em dash count 15 → 0.
- `switchable/site/deploy/deploy/terms/index.html` — full sync from Notion (added: Section 2 apprenticeship clarification + statutory rights paragraphs, Section 3 under-18 termination, Section 7 expanded liability bullets). Em dash count 3 → 0.

---

## 2026-04-30: Sheet→DB mirror schema (migration 0047)

**Type:** Two new tables + indexes. Migration 0047. Schema only — Edge Function and Apps Script work follow.

Owner is losing track of pipeline state across three pilot providers because providers update sheets in two different ways: sometimes a Status column, sometimes free-text Notes. `crm.enrolments` exists but never advances — nothing flows back from sheets. This migration adds the schema layer for a hybrid sheet→DB mirror designed in `platform/docs/sheet-mirror-scoping.md`: deterministic mirror for Status edits (Channel A), AI-suggest-then-owner-approve for Notes edits (Channel B).

**Migration 0047:**
- `crm.sheet_edits_log` — audit row per sheet edit captured by the new `provider-sheet-edit-mirror.gs` Apps Script trigger. Covers both channels with extensible action taxonomy (`mirrored | queued | note_only | ai_suggested | ai_approved | ai_rejected | ai_overridden | ai_error | rejected`). Channel B-only fields (`ai_summary`, `ai_implied_status`, `ai_confidence`, `prompt_version`, `pending_update_id`) are nullable. Decoupled from `crm.enrolments` status enum so future enum changes only touch the Edge Function mapping.
- `crm.pending_updates` — queue of AI-suggested status changes awaiting owner approval. Resolved via HMAC-signed Approve / Reject / Override email links (same pattern as `routing-confirm`). Source-tagged for future suggestion sources (learner self-report AI, call transcript AI) sharing the queue.

**Decisions confirmed in design:**
- Channel A auto-mirrors `Enrolled` without owner approval — dispute window is the safety net.
- Channel B always requires owner Approve click, even on high-confidence suggestions.
- Notes are PII-redacted (email + phone stripped) before sending to Anthropic — supports GDPR data minimisation.
- Build both channels in parallel; Channel B activation in production gated on Phase 0 legal sign-off (Switchable privacy policy lists Anthropic as sub-processor + DPA filed). Phase 0 owned by owner + Clara, in progress.
- No backfill — forward-only from go-live.

**Phase 4 retirement:** Apps Script onEdit trigger and `sheet-edit-mirror` Edge Function retire when the provider dashboard ships. `crm.sheet_edits_log` and `crm.pending_updates` carry forward — the suggestion-and-approve pattern applies to other future signal sources regardless of sheets. Status vocabulary, audit log, dashboard view all unchanged.

**Files changed:**
- `platform/supabase/migrations/0047_sheet_mirror_tables.sql` — new
- `platform/docs/data-architecture.md` — `crm.sheet_edits_log` and `crm.pending_updates` sections added
- `platform/docs/sheet-mirror-scoping.md` — new design doc

**Next steps (separate sessions):**
- Edge Function `sheet-edit-mirror` — Channel A path first (log-only, then activate UPDATE)
- Edge Function `pending-update-confirm` — Approve/Reject/Override handler
- Apps Script `provider-sheet-edit-mirror.gs` — onEdit trigger watching Status + Notes columns
- Brevo templates for anomaly emails and AI suggestion emails
- Daily digest cron `sheet-mirror-daily-digest`
- Admin dashboard tiles (Overview headline, Actions drill-through)
- `infrastructure-manifest.md` and `secrets-rotation.md` updates (`ANTHROPIC_API_KEY`)
- `/ultrareview` before each production deploy

---

## 2026-04-30: One-click SF2 chaser button on /admin/leads + last-chaser tracking

**Type:** New column + new RPC + new Edge Function + new UI button. Migration 0046.

Owner needed a one-click way to bulk-trigger the SF2 "Provider tried no answer" Brevo automation from the admin dashboard. Previously a 3-click manual operation in Brevo's UI per lead — at volume that was ~5 minutes of pure friction every time a provider reported they couldn't reach a learner.

**Migration 0046:**
- `crm.enrolments.last_chaser_at TIMESTAMPTZ` column. NULL = never. Stamped by `crm.fire_provider_chaser`. Surfaced on `/admin/leads` to discourage double-firing.
- `crm.fire_provider_chaser(BIGINT[])` RPC. SECURITY DEFINER. For each submission: looks up email, validates eligibility (must have email, not be archived, must have an enrolment row), stamps `last_chaser_at`, audits, queues the email for Brevo. Async-fires `admin-brevo-chase` once with all eligible emails. Returns per-id status (ok / skipped + reason).

**Edge Function `admin-brevo-chase`:** POST endpoint with `x-audit-key` auth. Adds emails to the Brevo internal list specified by `BREVO_LIST_ID_PROVIDER_TRIED_NO_ANSWER` (set to 8 today). 250ms throttle, dead_letter on Brevo failure. Brevo's auto-remove-at-end-of-flow on SF2 means re-adding fires the chaser fresh.

**UI:**
- New "Send chaser" button in the sticky bulk action bar on `/admin/leads`. Smaller secondary visual treatment beneath the status "Apply" button. One toast on success showing fired / skipped counts; skip reasons surface from the RPC.
- New "Last chaser" column showing `—` / `today` / `Xd ago`. Coloured `#b3412e` bold + ≤2 days to discourage rapid re-firing. Hover tooltip carries the exact ISO timestamp.

**Files changed:**
- `platform/supabase/migrations/0046_chaser_tracking.sql` — new
- `platform/supabase/functions/admin-brevo-chase/index.ts` — new
- `platform/supabase/config.toml` — `[functions.admin-brevo-chase]` block (verify_jwt=false)
- `platform/app/app/admin/leads/bulk-actions.ts` — new `fireProviderChaser` Server Action
- `platform/app/app/admin/leads/bulk-selection.tsx` — "Send chaser" button + handler
- `platform/app/app/admin/leads/page.tsx` — "Last chaser" column + colouring

**Owner-side setup done in session:** `BREVO_LIST_ID_PROVIDER_TRIED_NO_ANSWER=8` set via `supabase secrets set`. Edge Function deployed.

---

## 2026-04-30: Brevo auto-sync on enrolment status change (closes U4 trigger gap)

**Type:** New SECURITY DEFINER function + Server Action wiring. No schema change to `crm.enrolments`.

The morning's Brevo work made `SW_ENROL_STATUS` push correctly at routing time and resync time, but did NOT auto-fire when an owner changed a lead's status in `/admin/leads` (single-lead form or bulk action). DB updated, Brevo stayed stale until next manual resync. Email-side U4 (enrolment celebration) and other lifecycle automations rely on SW_ENROL_STATUS attribute changes — without auto-sync they don't fire on owner outcome edits.

**Closed via:**
- Migration `0044_sync_leads_to_brevo.sql` — adds `crm.sync_leads_to_brevo(BIGINT[])` SECURITY DEFINER function. Uses `public.get_shared_secret('AUDIT_SHARED_SECRET')` + `pg_net.http_post` to fire the existing `admin-brevo-resync` Edge Function asynchronously. Returns request_id immediately, doesn't block. Granted to `authenticated`.
- `platform/app/app/admin/leads/[id]/actions.ts` — `markEnrolmentOutcome` calls `crm.sync_leads_to_brevo([submissionId])` after a successful upsert.
- `platform/app/app/admin/leads/bulk-actions.ts` — `markEnrolmentOutcomeBulk` collects successfully-updated submission ids and calls `crm.sync_leads_to_brevo(idArray)` once at the end of the loop, so a 50-lead bulk update fires one Edge Function call (which then loops with its 250ms throttle) rather than 50 parallel calls.

**Failure handling:** best-effort. The DB update is the contract; Brevo sync runs async. If pg_net or the Edge Function fails, the row lands in `leads.dead_letter` and Sasha catches it on Monday.

**Auto-flip cron now also syncs (migration 0045, same day):** `crm.run_enrolment_auto_flip` rewritten to collect every flipped submission_id and fire one `crm.sync_leads_to_brevo` call at the end. Closes the third write path so all status changes (Server Action single-lead, Server Action bulk, cron auto-flip) push to Brevo automatically. Public function shape unchanged — `sample_submission_ids` still returns the first 10; the new `v_flipped_ids` array is internal-only. The 3-4 May presumed_enrolled flips for the ~6 oldest EMS leads will sync to Brevo without intervention.

**Files changed:**
- `platform/supabase/migrations/0044_sync_leads_to_brevo.sql` — new
- `platform/app/app/admin/leads/[id]/actions.ts` — single-lead Server Action
- `platform/app/app/admin/leads/bulk-actions.ts` — bulk Server Action

---

## 2026-04-30: SW_ENROL_STATUS Brevo attribute (lifecycle segmentation)

**Type:** Additive Brevo attribute. No DB schema change.

Marketing automation needs to segment by enrolment lifecycle (open / enrolled / presumed_enrolled / cannot_reach / lost) so re-engagement campaigns can target only open leads, and entry filters can suppress U1 etc. for already-routed contacts. Adds `SW_ENROL_STATUS` (Brevo Category, 16th SW_ attribute) to the contact upsert.

**Source of truth:** `crm.enrolments.status` joined to the submission by `(submission_id, provider_id)`. LEFT JOIN-equivalent: empty string if no row, defensive against any race condition (in practice every routed lead has a row at routing time per migration 0042).

**Behaviour by helper:**
- `upsertLearnerInBrevo` (matched): reads live status from `crm.enrolments`. Always populated post-0042.
- `upsertLearnerInBrevoNoMatch` (no_match / pending): empty string. These contacts aren't in the enrolment lifecycle until routed. Flips to a real status when the lead routes and the matched helper takes over.

**Value mapping:** DB enum and Brevo Category values are pushed verbatim. DB uses `cannot_reach`. The original task spec listed `cannot_contact` as a Brevo Category value — owner to verify Brevo Category options match DB exactly. If Brevo has `cannot_contact`, a 1-line value mapping in the helper closes the gap; if Brevo has `cannot_reach` (most likely — owner said "values aligned"), no further change needed.

**Test plan (run before full backfill):**
1. Owner confirms U1 funded + U1 self automations are paused in Brevo (already in progress per task brief).
2. Run admin-brevo-resync against submission 159 only (Luana Martinez, currently `cannot_reach`, routed to EMS) and confirm her contact in Brevo has `SW_ENROL_STATUS=cannot_reach`. The earlier task spec listed her as `open` — outcome's been updated since, which makes the test more useful (it proves a non-default value pushes through).
3. Verify U1 doesn't fire (expected: paused).
4. If clean, proceed with full backfill across all 166 (53 DQ + 113 routed) submissions.

**Files changed:**
- `platform/supabase/functions/_shared/route-lead.ts` — `upsertLearnerInBrevo` adds the LEFT JOIN-equivalent enrolment status read + `SW_ENROL_STATUS` attribute. `upsertLearnerInBrevoNoMatch` adds `SW_ENROL_STATUS: ""`.
- No netlify-lead-router or admin-brevo-resync change — both inherit via the helpers.

**Owner-side work tracked separately:**
- Brevo dashboard: SW_ENROL_STATUS Category attribute set up with the 5 values.
- U1 funded + U1 self automations paused for the backfill window. Unpause once backfill complete.
- `switchable/email/CLAUDE.md` namespacing list to bump 15 SW_ attrs → 16. Out of platform scope; flagging here.

**Deployed:** netlify-lead-router, routing-confirm, admin-brevo-resync.

---

## 2026-04-30: Brevo 3-state push live (no_match / pending / matched) + historical resync extended

**Type:** Edge Function behaviour change. No schema change.

Closes the gap where `upsertLearnerInBrevo` only fired for matched leads. Now every form submission lands a Brevo contact with `SW_MATCH_STATUS` set:

- `matched` — matched lead routed (auto or owner-confirm), provider attributes populated. Fires from `_shared/route-lead.ts:upsertLearnerInBrevo` inside the routing transaction.
- `pending` — qualified lead with candidate(s) awaiting owner confirm (2+ candidates, or 1 candidate without `auto_route_enabled`). Provider attributes empty. Owner-confirm later flips this contact to `matched` via the same routeLead path.
- `no_match` — DQ lead OR lead with zero candidates. Provider attributes empty, `SW_DQ_REASON` populated when `is_dq=true`.

**Files changed:**
- `platform/supabase/functions/_shared/route-lead.ts` — refactored `upsertLearnerInBrevo` to branch on `funding_category` (self-funded skips matrix, sector pulls from `submission.interest`); added `SW_DQ_REASON` to attribute set; added `composeBrevoCourseContext` helper; added new exported `upsertLearnerInBrevoNoMatch(sql, submissionId, matchStatus)`. `SubmissionRow` interface gains `dq_reason: string | null`; `routeLead`'s SELECT updated to populate it.
- `platform/supabase/functions/netlify-lead-router/index.ts` — fires `upsertLearnerInBrevoNoMatch(..., "no_match")` when DQ or 0 candidates; fires `upsertLearnerInBrevoNoMatch(..., "pending")` in the email-confirm flow before notifying owner.
- `platform/supabase/functions/admin-brevo-resync/index.ts` — DQ leads no longer skipped; pushed as `no_match`. Unrouted qualified leads pushed as `pending` (zero such leads in production today; future-proofing). Routed leads continue through the existing matched path.

**Brevo Automation entry filters (email-side, owned by `switchable/email/`):**
- N1-N7 spine: `SW_MATCH_STATUS=matched AND SW_FUNDING_CATEGORY in (gov, loan)`
- U-track utility: every contact on the utility list (matched + self / pending / no_match)
- SF13 "picking your provider": `SW_MATCH_STATUS=pending`
- SF8 recirc: `SW_MATCH_STATUS=no_match`
- Sector-led self-funded nurture: future workstream, not in this build

**Self-funded path correction:** the matched `upsertLearnerInBrevo` previously called `getMatrixContext` for self-funded leads, which silently returned empty because self-funded `course_id` is a YAML id not a page slug. Self-funded matched leads were landing in Brevo with `SW_COURSE_NAME`/`SW_COURSE_SLUG`/`SW_REGION_NAME`/`SW_SECTOR` all empty. Now self-funded short-circuits the matrix call and reads `SW_SECTOR` directly from `submission.interest`. Course / region / intake stay blank by design.

**Historical reconcile to follow:** with the resync function extended, the next step is to fire it against every active (non-archived) submission so Brevo state matches DB exactly. Owner runs the resync SQL via Supabase SQL editor (audit key stays in vault, never in chat). 166 leads across 53 DQ + 113 routed; 0 unrouted-qualified.

**Deployed:** netlify-lead-router, routing-confirm, admin-brevo-resync.

---

## 2026-04-30: Bulk enrolment outcome update on /admin/leads (Phase 3)

**Type:** Admin app feature.

Checkbox column added to the leads table. Master checkbox in the header toggles all rows on the current page (with indeterminate state when partially selected). When ≥1 row is selected, a sticky action bar appears at the bottom of the viewport: status button group (open / enrolled / presumed_enrolled / cannot_reach / lost), conditional lost-reason buttons that show when "lost" is picked, optional notes textarea (applied to all selected), and an "Apply to N" button. The dispute flag is intentionally not exposed in bulk — disputed enrolments need per-lead reason text and stay on the single-lead form at `/admin/leads/[id]`.

The bulk Server Action `markEnrolmentOutcomeBulk` loops `crm.upsert_enrolment_outcome` per submission so audit rows are written per lead (not per batch), keeping the audit trail granular. Returns succeeded / failed counts and per-row errors.

**Files changed:**
- `platform/app/app/admin/leads/bulk-actions.ts` — new Server Action
- `platform/app/app/admin/leads/bulk-selection.tsx` — new client component (context provider, master + row checkboxes, sticky bar)
- `platform/app/app/admin/leads/page.tsx` — wraps table in `<BulkSelectionProvider>`, adds checkbox column, renders `<BulkActionBar />` at the bottom

Filter the list first (stage pill, provider, date, search), tick the rows you want, set status, click Apply. Selection clears on success.

---

## 2026-04-30: Backfill open enrolment rows for pre-0042 routed leads (Phase 2)

**Type:** One-shot data migration.

Migration `0043_backfill_open_enrolments.sql` walked `leads.routing_log` joined to `leads.submissions` and called `crm.ensure_open_enrolment` for every active routed parent (non-DQ, non-archived, `parent_submission_id IS NULL`). Re-application children stayed row-less by design — outcome lives on the parent.

**Result:** before=17, after=108, inserted=91. The 17 pre-existing rows (12 enrolled + 3 presumed_enrolled + 1 historical open + 1 fresh open from lead 221 routed earlier today) were untouched via `ON CONFLICT DO NOTHING`. Status breakdown after backfill: 93 open, 12 enrolled, 3 presumed_enrolled. Diagnostic gap query (routed parents with no enrolment row) now returns 0.

**14-day auto-flip:** the older EMS leads from 19 April backfilled with their original `sent_to_provider_at` timestamps (sourced from `leads.routing_log.routed_at` inside the function), so the auto-flip schedule is unchanged. The first auto-flip on/around 3 May proceeds as planned.

**Sanity check learned the hard way:** the first attempt at this migration aborted due to a brittle "newly inserted vs already-existing" counter that used a 1-minute `created_at` window. Lead 221 routed during the deploy window and tripped the assertion. Replaced with a simple before/after total comparison. Lead 221 also confirmed Phase 1 was working live before Phase 2 ran — the routing transaction had already created an open row for it without any code path other than `ensure_open_enrolment`.

---

## 2026-04-30: Routed leads now atomically get an open enrolment row (Phase 1: function + Edge Function call)

**Type:** New schema function, Edge Function behaviour change, Apps Script bug fix.

**Context:** Audit on 2026-04-30 found `crm.enrolments` had 16 rows for 113 routed leads. 95 active routed leads (91 parents + 4 re-application children) had no enrolment row at all, so any report joining `leads.submissions` to `crm.enrolments` undercounted by ~85%. Root cause: `route-lead.ts` wrote `leads.routing_log` and updated `leads.submissions.primary_routed_to` but never inserted into `crm.enrolments`. The page comment claiming an open row was inserted at routing time was aspirational and never shipped — rows only landed when the owner used the outcome RPC or the 14-day auto-flip ran.

**Phase 1 changes (this entry):**
- Migration `0042_ensure_open_enrolment.sql` adds `crm.ensure_open_enrolment(BIGINT, BIGINT, TEXT)` SECURITY DEFINER. Idempotent via ON CONFLICT DO NOTHING on the `(submission_id, provider_id)` unique constraint. Returns the enrolment row id (newly inserted or pre-existing). Granted to `functions_writer` and `authenticated`. `functions_writer` itself still has zero direct grants on `crm.enrolments` — all writes route through this RPC or `crm.upsert_enrolment_outcome`.
- `platform/supabase/functions/_shared/route-lead.ts` — write phase now captures the new `routing_log` row id and calls `crm.ensure_open_enrolment` inside the same transaction. Atomic with the routing_log insert and the submissions update; if any step fails, the routing rolls back.
- `platform/app/app/admin/leads/page.tsx` — stale comment fixed; the "no enrolment row" fallback badge now correctly described as covering only pre-0042 historical rows.

**Phase 2 (next session):** migration `0043` will backfill the 91 historical parent rows by walking `leads.routing_log` and calling `crm.ensure_open_enrolment` for any routed lead with no row. The 4 re-application children stay row-less by design (outcome lives on the parent). The 14-day auto-flip end-state is unchanged: open rows reach presumed_enrolled via the same code path.

**Phase 3 (next session):** bulk status update on `/admin/leads` (checkboxes + sticky action bar) operates on the now-complete enrolment denominator.

**Apps Script v2 bug found and patched:** investigation into a separate "missing prior-submission note on EMS sheet" defect (Julie Orange-Benjamin, lead 216 — no "Previously applied for counselling-skills-tees-valley" note) traced to `provider-sheet-appender-v2.gs` FIELD_MAP missing entries for `notes` / `note` / `comment` / `comments`. Each provider's sheet has been silently dropping auto-populated notes since they migrated off v1 (EMS Session 5, Courses Direct + WYK during their onboarding). Canonical source patched.

**Owner action pending:** redeploy the v2 Apps Script source to each provider's bound script copy (EMS, WYK Digital, Courses Direct). The header-driven appender means no FIELD_MAP edits per sheet, but each bound script needs the source pasted in and saved. Edit that landed: 4 lines added under "Cohort intake fields" in `platform/apps-scripts/provider-sheet-appender-v2.gs`.

**Files changed:**
- `platform/supabase/migrations/0042_ensure_open_enrolment.sql` — new
- `platform/supabase/functions/_shared/route-lead.ts` — write phase updated
- `platform/app/app/admin/leads/page.tsx` — fallback comment fixed
- `platform/apps-scripts/provider-sheet-appender-v2.gs` — FIELD_MAP notes entries added

**Verification after deploy:**
- New routed lead (any path) creates a `crm.enrolments` row with `status='open'` in the same transaction. Sanity SQL: `SELECT COUNT(*) FROM crm.enrolments WHERE status='open' AND created_at >= now() - interval '1 hour';`
- Existing 16 enrolment rows untouched (insert-only, `ON CONFLICT DO NOTHING`).
- Once at least one new lead routes post-deploy and an open row appears, Phase 2 backfill can ship.

**Signed off:** Owner (session 2026-04-30)

---

## 2026-04-30: Multi-cohort picker reverted to single-pick; "Acceptable intakes" column retired from provider sheets

**Type:** Page UX revert + provider sheet decluttering. No schema change.

The funded-course multi-cohort start_date step was briefly upgraded to multi-pick (cohort buttons toggle, Continue button advances) earlier today. Reverted same session: under pilot scale (~45 leads/week, no funnel analytics) the extra click was likely a small drop-off cost we couldn't measure or justify, and most learners realistically commit to one start date anyway. The page is back to single-pick auto-advance with truthful singular wording: "Which start date works for you?" / "There's more than one start date for this course. Pick the one that works best for you."

`acceptable_intake_ids` continues to be emitted by the page (mirroring `preferred_intake_id` under single-pick) so schema 1.2 stays intact and a future multi-pick re-introduction is cheap. The corresponding `Acceptable intakes` column on provider sheets is now duplicate noise — to be removed from the EMS sheet (the only sheet currently carrying it; Courses Direct and WYK are single-cohort and don't have either intake column). FIELD_MAP entry stays in the canonical Apps Script v2 as a no-op, ready if multi-pick ships later.

**Owner action pending:** delete the "Acceptable intakes" column header from the EMS provider sheet. Header-driven appender means no script redeploy needed.

**Files changed:**
- `switchable/site/deploy/template/funded-course.html` — multi-cohort step copy, `handleIntakePick`, `setQualMultiIntake` reverted to auto-advance
- `switchable/site/deploy/data/form-copy.yml` — `q4_multi.question` reverted to singular
- `switchable/site/deploy/deploy/tools/form-matrix/index.html` — simulator labels reverted to singular
- `platform/docs/provider-onboarding-playbook.md` — added guidance on Preferred intake (optional, multi-cohort only); explicitly flagged Acceptable intakes as dormant

---

## 2026-04-29: admin-brevo-resync Edge Function

**Type:** New Edge Function (operational tool, not a runtime dependency).

POST endpoint at `/functions/v1/admin-brevo-resync` that re-fires `upsertLearnerInBrevo` for an arbitrary list of already-routed submission ids. Auth via `x-audit-key` header. Skips DQ leads, archived leads, never-routed leads. Does not touch `leads.routing_log` or `leads.submissions.primary_routed_to` — routing already committed, only the downstream Brevo side-effect is refreshed.

Built triggered by a real need: lead 206 (Hilda Gething, real production lead) was routed to EMS before today's Brevo enrichment fix landed and its contact held stale attributes. `upsertLearnerInBrevo` is now exported from `_shared/route-lead.ts` so this tool reuses the canonical attribute composition.

Permanent operational tool, not a one-off. Future use: any time Brevo attribute composition or matrix.json shape changes leave existing contacts stale (provider trust line edits, sector taxonomy changes, future schema additions).

Registered in `infrastructure-manifest.md`. `verify_jwt = false` in `config.toml`. AUDIT_SHARED_SECRET in vault, same source as `netlify-leads-reconcile` and `netlify-forms-audit`.

---

## 2026-04-29: SW_COURSE_INTAKE_DATE ISO format follow-up

**Type:** Edge Function bug fix in `_shared/route-lead.ts` (no schema change). Follow-up to the Brevo enrichment fix below.

Synthetic test 207 (post-deploy) confirmed 6 of 7 fixes landed clean. `SW_COURSE_INTAKE_DATE` was still empty in Brevo. `SW_COURSE_INTAKE_ID` resolved correctly to `tees-valley-2026-06-02`, so the helper found the matched intake — but Brevo's Date attribute type silently nulls anything that isn't ISO 8601 YYYY-MM-DD. The helper was reading `intake.dateFormatted` ("2 June 2026"), which Brevo rejected.

**Fix:** `readRoute` now reads `intake.date` (ISO) instead of `intake.dateFormatted`, and falls back to `route.nextIntake` instead of `route.nextIntakeFormatted`. `MatrixContext.intakeDate` comment updated to call out the ISO-only constraint.

Both `netlify-lead-router` and `routing-confirm` redeployed. Existing Brevo contacts created post-Session-17 with empty `SW_COURSE_INTAKE_DATE` will get corrected on their next routing event (upserts overwrite).

---

## 2026-04-29: Brevo learner enrichment fix — matrix lookup + atomic list adds

**Type:** Edge Function bug fix in `_shared/route-lead.ts` (no schema change). Triggered by a synthetic test that surfaced 7 separate defects on the same submission.

Six attribute-mapping bugs traced to one root cause: `getCourseFromMatrix` indexed `matrix.json` route entries by `entry.courseId`, which doesn't exist in the published JSON. Routes use `slug` as the key. Lookup silently failed for every lead since the helper landed (Session 16, item 9), so every attribute that depended on the matrix fell through to the page-slug fallback. Plus one race-condition bug on the marketing list-add.

**What changed in `_shared/route-lead.ts`:**

- Renamed `getCourseFromMatrix` → `getMatrixContext`. Now indexes by `slug` (matches `submission.course_id`).
- Returns the full enrichment context: course-only slug, course title, region name, resolved intake (id + formatted date), and both interest tags. Intake resolution prefers `submission.preferred_intake_id` matched against `route.intakes[]`, falls back to first intake, then to legacy `nextIntake`.
- Brevo attributes corrected: `SW_COURSE_NAME` reads `courseTitle` (not page slug), `SW_COURSE_SLUG` reads new `courseId` field (course-only slug, not page slug), `SW_REGION_NAME` reads `regionName` (not `submission.la`).
- New attributes added: `SW_COURSE_INTAKE_ID`, `SW_COURSE_INTAKE_DATE` (replaces `SW_COURSE_START_DATE`), `SW_SECTOR` (resolves to `ffInterest` for funded leads, `cfInterest` otherwise).
- Marketing list-add collapsed into the same upsert call as the utility list-add. Single `upsertBrevoContact({listIds: [...]})` call replaces the previous `upsert + addBrevoContactToList` two-call sequence that surfaced misleading Brevo 400 "Contact already in list and/or does not exist" errors under race conditions.
- Removed unused `addBrevoContactToList` import (helper retained in `_shared/brevo.ts` for genuine later-opt-in use cases).

**What changed in the site (separate commit on `switchable/site/deploy`):**

- `scripts/build-funded-pages.js`: matrix.json route entries gain a `courseId` field (the course-only YAML id, e.g. `smm-for-ecommerce`). Purely additive — simulator already keys by `slug`.
- `deploy/data/matrix.json` regenerated.

**Impact:** Both `netlify-lead-router` and `routing-confirm` redeploy because they share `_shared/route-lead.ts`. No schema change, no migration, no consumer breakage. Existing Brevo contacts created with the wrong attributes will get corrected on their next routing event (upserts overwrite). Site deploy must land first so live matrix.json has `courseId` before the Edge Function reads it; if Edge Function deploys first, `SW_COURSE_SLUG` returns empty for ~5 minutes (cache window) before catching up.

**Owner action:** verify `BREVO_LIST_ID_SWITCHABLE_MARKETING` is set in Supabase secrets (env var was renamed from `BREVO_LIST_ID_SWITCHABLE_NURTURE` in Session 16 — if the rename didn't pick up, marketing list-add still no-ops even with the race-condition fix). Then re-test with a fresh non-owner email on the SMM Tees Valley page to verify the full 13-attribute set + both list memberships.

**Signed off:** Owner (session 2026-04-29 evening).

---

## 2026-04-29: Migration 0041 — cohort intake capture (lead payload v1.2)

**Type:** Additive schema change + Edge Function ingest update.

`leads.submissions` gains `preferred_intake_id TEXT` and `acceptable_intake_ids TEXT[]`. `_shared/ingest.ts` extracts the new fields from the form payload (form schema 1.2 hidden inputs `preferred_intake_id`, `acceptable_intake_ids`). `_shared/route-lead.ts` includes them in the sheet append payload so Apps Script v2 surfaces them on the provider sheet under header columns "Preferred intake" / "Acceptable intakes" once the owner adds those columns.

Site shipped the form template + matrix.json + page YAML changes for two multi-cohort pages (Counselling Tees Valley 6 May + 2 Jun, SMM Tees Valley 21 May + 26 May) as part of the same coordinated push. Single-cohort and rolling-intake forms send NULL for these fields and pass through cleanly.

**Deferred (not part of this migration):** `leads.routing_log.confirmed_intake_id` (no surface for owner override at confirm time yet) and `crm.enrolments.intake_id` (per-cohort enrolment reporting not yet needed). Both flagged in `platform/docs/data-architecture.md`.

**Owner action:** add "Preferred intake" and "Acceptable intakes" columns to each provider sheet that runs multi-cohort courses. Apps Script v2 reads the header row, so existing Apps Script deploys don't need redeployment.

**Correction (2026-04-29 later):** the "no redeploy needed" line above is wrong on two counts. Caught when a test lead `email@ignoreem.com` landed on the EMS sheet with the two new columns blank.

1. **FIELD_MAP gap.** `platform/apps-scripts/provider-sheet-appender-v2.gs` had no entries for `preferred_intake_id` or `acceptable_intake_ids`. Two new keys added (`preferredintake` → `preferred_intake_id`, `acceptableintakes` → `acceptable_intake_ids`). Every v2 deployment needs a New Version push (NOT New Deployment — see playbook step 3.8).
2. **Worse: EMS is still on v1.** The original session that shipped the multi-cohort form changes never checked that the EMS sheet (the only provider currently running multi-cohort courses) is on v1 hardcoded, not v2 header-driven. v1 has no FIELD_MAP and no notion of dynamic columns — it appends to fixed positions 1-17. Per `infrastructure-manifest.md` line 125, EMS migration to v2 was previously labelled "optional"; cohort fields make it necessary. Action: migrate EMS sheet to v2 in lockstep with confirming row 1 headers match FIELD_MAP-recognised names.

WYK Digital and Courses Direct are on v2 already; FIELD_MAP update + redeploy applies to them too (harmless until they have multi-cohort columns, but keeps the canonical script in lockstep with git).

**Lesson:** any time a new header is added to provider sheets, (a) the FIELD_MAP entry ships in the same change, (b) every sheet running v2 redeploys, AND (c) every sheet still on v1 either gets a hardcoded patch OR migrates to v2. Pre-flight should always check `infrastructure-manifest.md` Apps Script deployments table for the version each sheet runs.

---

## 2026-04-29: Migrations 0037-0040 + email + agents page + LinkedIn scope correction + trust-edit dashboard surface

**Type:** Three migrations, Edge Function extension, dashboard addition, doc corrections.

### Migration 0037 — `social` schema reads for `readonly_analytics`

Grants USAGE on `social` and SELECT on five tables (`drafts`, `engagement_targets`, `engagement_queue`, `post_analytics`, `engagement_log`) plus six views (`vw_pending_drafts`, `vw_post_performance`, `vw_engagement_queue_active`, `vw_targets_due_review`, `vw_rejection_patterns`, `vw_channel_status`) to `readonly_analytics`. Adds matching SELECT-only RLS policies because the existing `social.*` policies are scoped `FOR ALL TO authenticated USING admin.is_admin()` and would otherwise block the analytics role at the row filter.

**Excluded:** `social.oauth_tokens` (LinkedIn refresh tokens) and `social.push_subscriptions` (per-user push endpoint URLs). Both stay locked to authenticated/admin only.

**Why:** Thea's MCP queries against `social.*` were failing with "permission denied for schema social" — migration 0029 only granted privileges to `authenticated`. Sasha's and Mira's queries via the same role were also blocked.

### Migration 0038 — provider trust content columns on `crm.providers`

Adds `trust_line TEXT`, `funding_types TEXT[]`, `regions TEXT[]`, `voice_notes TEXT` to `crm.providers` and backfills the three signed providers verbatim from the existing YAML files (EMS, WYK Digital, Courses Direct).

**Why:** reverses the 2026-04-28 Path 4 (YAML-native) decision. That decision assumed Edge Functions could read `switchable/site/deploy/data/providers/*.yml` at runtime. They cannot — Edge Functions run on Supabase serverless with no filesystem access to the Switchable site repo on Netlify. The three options surfaced in the cross-project session were (a) HTTP-fetch the YAMLs, (b) bundle into Edge Function deploy, (c) move into `crm.providers`. Option (c) chosen as cleanest single source of truth.

**Schema versioning:** additive change to `crm.providers` (new columns, all NULL-able). Per `.claude/rules/schema-versioning.md` additive changes are free — no `schema_version` bump required. The lead payload from the form is unchanged.

**Consumers updated:** `routing-confirm` Edge Function (now reads new columns + composes Brevo attributes). `/new-course-page` skill needs an update to write DB rows as canonical (with optional YAML mirror for git history) — flagged for next session in skill scope, not implemented today.

**Doc updates:** `platform/docs/data-architecture.md` "Provider trust content" section rewritten to reflect the reversal. `switchable/email/CLAUDE.md` "Provider trust content" section rewritten. Provider YAML files (`enterprise-made-simple.yml`, `wyk-digital.yml`, `courses-direct.yml`) remain in `switchable/site/deploy/data/providers/` as version-controlled mirrors / audit history; not read at runtime by any system.

### Migration 0039 — `public.admin_cron_status()` for the dashboard

SECURITY DEFINER function returning `(jobname TEXT, schedule TEXT, active BOOLEAN)`. Gates at function body via `admin.is_admin()`. EXECUTE granted to `authenticated`.

**Why:** the new `/admin/agents` page (Tools sidebar) needs to show live cron health alongside each agent's listed automations. `public.vw_cron_jobs` was revoked from API roles in 0015 (Supabase security scanner false-positive). A SECURITY DEFINER function avoids re-triggering that warning while keeping access tight via the admin allowlist. Function lives in `public` so PostgREST exposes it via the default Data API schemas (admin schema is internal and not auto-exposed).

**Command column omitted** deliberately — some legacy crons still have plaintext shared secrets in their command bodies (see migration 0008). Function returns name/schedule/active only.

### Edge Function — `_shared/brevo.ts` extension

Added: `BrevoBrand` type (`switchleads | switchable`), brand-aware sender selection in `sendBrevoEmail` (defaults to switchleads for backward compatibility), `upsertBrevoContact(email, attributes, listIds)`, `addBrevoContactToList(email, listId)`. Existing `sendBrevoEmail` callers (netlify-lead-router, netlify-leads-reconcile, routing-confirm) untouched.

**Triggers via attribute updates, not events.** Brevo Automations watch `MATCH_STATUS` attribute (`matched` | `no_match`) plus list membership. Avoids the separate Marketing Automation Track API which needs its own `ma-key` and tracker ID. Documented in the helper's header comment.

### Edge Function — `_shared/route-lead.ts` Brevo hook + `routing-confirm` consolidation

After successful routing-log INSERT + submissions UPDATE (and before sheet append), `routeLead` now upserts the learner as a Brevo contact with 14 attributes — `FIRSTNAME` and `LASTNAME` (unprefixed Brevo defaults) plus 12 Switchable-namespaced attributes (`SW_COURSE_NAME`, `SW_COURSE_SLUG`, `SW_COURSE_START_DATE`, `SW_REGION_NAME`, `SW_PROVIDER_NAME`, `SW_PROVIDER_TRUST_LINE`, `SW_FUNDING_CATEGORY`, `SW_FUNDING_ROUTE`, `SW_EMPLOYMENT_STATUS`, `SW_OUTCOME_INTEREST`, `SW_CONSENT_MARKETING`, `SW_MATCH_STATUS`). Namespacing convention added 2026-04-29: SW_ for Switchable, SL_ for SwitchLeads (future), unprefixed for Brevo built-ins. Avoids cross-brand attribute collisions on shared contact records (one email = one Brevo contact). `SW_AGE_BAND` and `SECTOR` deliberately not pushed at v1 — the form age-question is being redesigned (under 19 / 19-23 / 24-34 / 35+) for v2 nurture branching, and SECTOR is only used by v2 nurture sector deep-dives. Adds the contact to the Switchable utility list (always); if `marketing_opt_in=true`, adds to nurture list as a separate call.

**Hook lives in `_shared/route-lead.ts`, not in any single caller.** Auto-route (`netlify-lead-router`) and manual-confirm (`routing-confirm`) both go through `routeLead`, so the Brevo trigger fires identically on both paths. Earlier in this session the upsert was wrongly placed in `routing-confirm` only — that would have skipped Brevo on the default auto-route path (all three pilot providers have `auto_route_enabled=true`). Spotted via the cross-project audit memory `feedback_owner_routes_leads.md`. Fixed by moving to the shared helper.

**Best-effort:** failure logs `leads.dead_letter` with source `edge_function_brevo_upsert` and continues. Routing is committed before this fires; Brevo is a downstream side-effect on the same footing as sheet append + provider notification.

**`routing-confirm` consolidation (no-patchwork follow-up).** The audit also surfaced that `routing-confirm` had its own duplicate routing pipeline (sheet append + provider notification + dead-letter logging) that pre-dated `routeLead` and never converged with it. As a result the manual-confirm path lacked audit logging and the prior-submission "previously applied" sheet note that the auto-route path has had since data-ops 010. Refactored `routing-confirm` to call `routeLead("owner_confirm")` and removed ~670 lines of duplicate code. File now: token verify → small `submitted_at` lookup for HTML lead-id formatting → `routeLead` call → render HTML based on `RouteOutcome`. Behaviour parity verified against the existing outcome shapes; both paths now identical except for trigger label and HTML response surface.

**Course attribute resolution:** COURSE_NAME and COURSE_START_DATE resolve via a matrix.json fetch from `https://switchable.org.uk/data/matrix.json` (the same file the Switchable form-matrix simulator and funded course pages already use). 5-minute in-module cache, 3-second timeout, slug-fallback on any failure. Per the email project's spec: COURSE_NAME is needed at launch (every utility email's opening line); COURSE_START_DATE is needed for cohort-based courses (FCFJ, LIFT) and absent on rolling-intake self-funded; SECTOR is deferred entirely (only used by v2 nurture sector deep-dives, post-launch). No `crm.courses` migration needed — course content stays in YAML where the site build authors it. Fail-safe: any matrix fetch error falls back to using `course_id` slug as COURSE_NAME and omits COURSE_START_DATE, mirroring the existing best-effort sheet/email patterns.

**New env required for go-live:** `BREVO_SENDER_EMAIL_SWITCHABLE`, `BREVO_LIST_ID_SWITCHABLE_UTILITY`, `BREVO_LIST_ID_SWITCHABLE_MARKETING`. Until set, the function silently skips the upsert (no error, no dead_letter spam). Owner sets these once Brevo dashboard configuration is complete. **Note (later same day 2026-04-29):** consolidated nurture + monthly lists into a single marketing list at email-project's request — list-membership flag is consent (`CONSENT_MARKETING=true`), cadence/branching is Brevo Automation logic. Renamed env var was originally `BREVO_LIST_ID_SWITCHABLE_NURTURE`.

### `/admin/agents` page (Tools sidebar)

New static + live-cron-status directory at `/admin/agents`. Static columns: agent name, role, project folder, cadence. Live column: automations cross-referenced against `cron.job` via `public.admin_cron_status()`. Green dot = active, rose dot = scheduled but disabled, red dot = listed but missing from cron.

**Why:** quick-glance health view for "are the agent automations actually firing?" without needing Sasha's Monday report. Sasha's report stays the deep dive (last-run, errors, drift); this page is the at-a-glance.

### LinkedIn submission scope correction

The Stage 2 Marketing Developer Platform submission doc at `switchleads/social/docs/linkedin-developer-app-submission.md` previously listed `r_member_social` as the scope for member-side post analytics. Per current LinkedIn Community Management API docs (verified 2026-04-29):

- `r_member_social` is currently a **closed** scope. LinkedIn FAQ #6 on the Community Management overview page: "We're not accepting access requests at this time due to resource constraints."
- The correct scope for member post analytics is `r_member_postAnalytics`, gating the `memberCreatorPostAnalytics` endpoint.

**Fix applied:** removed `r_member_social` from the submission doc, added `r_member_postAnalytics` with full justification text. Charlotte's existing Stage 1 app verified (by owner via developer.linkedin.com) to carry only `openid`, `profile`, `email`, `w_member_social` — no analytics scope at all.

**Knock-on:** the `social-analytics-sync-daily` cron was already paused in migration 0034 (2026-04-27) on the same basis. Thea's `CLAUDE.md` and current handoff still described an "already-granted r_member_social scope" partial-analytics fallback — both updated to reflect reality (no API analytics until Stage 2 approval lands; manual screenshots into `Debugging/Screenshots/` in the meantime).

### Migration 0040 + trust-edit dashboard surface

After the initial recommendation that `/new-course-page` skill should draft SQL UPDATE blocks for Charlotte to paste into Supabase SQL Editor was correctly flagged as patchwork, built the proper write path:

- **Migration 0040** — `crm.update_provider_trust(p_provider_id, p_trust_line, p_funding_types, p_regions, p_voice_notes)`. SECURITY DEFINER, gated by `admin.is_admin()`, validates `funding_types` against the allowed set (`gov`, `self`, `loan`), writes audit row via `audit.log_action('edit_provider_trust', ...)`. Same pattern as `crm.update_provider` (migration 0024) but scoped to the four trust columns only.
- **`/admin/providers/[id]/trust` route** — new tab on provider detail page ("Trust content"). Renders an `EditTrustForm` client component with: trust line textarea, funding types as multi-select pill buttons (gov/self/loan), regions comma-separated input, voice notes textarea. Server Action `editProviderTrust` calls the RPC; toast feedback on success/failure; revalidates `/providers` and `/providers/[id]` paths. Form pre-fills from the existing row so it doubles as edit + initial-set surface.
- **`/new-course-page` skill flow becomes:** during the trust-content interview, after capturing the four fields, the skill outputs the dashboard URL (`https://admin.switchleads.co.uk/admin/providers/<id>/trust`) and tells Charlotte to open it, paste the values, save. No raw SQL paste, validation enforced at both the form and the DB function, audit row written automatically. Skill side-effect (writing the YAML mirror file in `switchable/site/deploy/data/providers/`) stays optional for git history.

### Signed off

Owner approval in handoff order ("ok option c it is" → corrected to no-patchwork: built admin endpoint properly) + LinkedIn scope fixes confirmed via developer.linkedin.com OAuth scopes panel.

---

## 2026-04-28: data-ops 011 DB tidy

**Type:** One-off data cleanup. No schema change.

Three deletions + nine dead_letter resolutions in one transaction. Owner instruction: single source of truth + tidy DB before building further.

1. **Deleted routing_log entries for archived test submissions** (sid 29 charliemarieharris, sid 30 test7@testing.com). Both pre-date `applyOwnerTestOverrides` (which shipped 22 Apr) so they slipped past the test-row guard. One-off cleanup; no policy change needed because the guard prevents recurrence.
2. **Deleted Anita's orphan routing_log entry** (sid 184). Per data-ops/010 her submission is now is_dq=true with primary_routed_to=NULL. Owner direction: this was a DQ lead on the waitlist, should not be in routing_log at all. Audit trail of the misroute lives in the data-ops/010 file + this changelog.
3. **Marked 9 dead_letter rows resolved with explanatory notes**:
   - id 85 (sheet_append fail for sid 29): archived test, no real failure.
   - id 89 (Jodie Mccafferty sid 90 sheet_append fail): owner added to Courses Direct sheet manually 23 Apr; lead routed in DB.
   - id 90 (Lesley-Ann Cawsey sid 109 sheet_append fail): same as above.
   - ids 91-96 (six reconcile_backfill audit rows): cron found leads missing from DB and back-filled them; all six leads are present and routed correctly. Verified via unique-people count reconciliation.

**Post-state:**
- `leads.routing_log`: 94 rows (was 97).
- `leads.dead_letter`: 0 unresolved (was 9).
- Reconciliation: 94 routing-log = 89 unique people + 5 same-email duplicates (3 linked re-applications with same email as parent; 2 Jade Millward rapid-fire submissions). Closes cleanly.

**Idempotency:** Each DELETE has WHERE clauses that match zero rows on a second run. UPDATE on dead_letter is guarded by `replayed_at IS NULL`. Safe to retry.

**Signed off:** Owner (Session 14, 2026-04-28 morning).

---

## 2026-04-27: Migration 0036 + awaiting-outcome fix

**Type:** View redefinition + UI data fix.

1. **Migration 0036** (`0036_provider_billing_state_distinct_emails.sql`): redefines `crm.vw_provider_billing_state.total_routed` from `COUNT(*) FROM leads.routing_log GROUP BY provider_id` to `COUNT(DISTINCT lower(trim(email))) FROM leads.submissions WHERE primary_routed_to = ... AND archived_at IS NULL`. Matches the overview KPI definition. Conversion-rate denominator updated to match.

   **Why:** the old definition counted every routing-log row, including archived test rows, the Anita orphan from data-ops/010, and multi-routings of the same person. Sum across providers was 97 vs the overview's 89. Confusing when comparing the two pages. Now: EMS 60, CD 15, WYK 15 (sum 90; 1 person, Jade, overlaps EMS+CD so global = 89).

2. **`/admin` Awaiting outcome tile**: was querying `crm.enrolments WHERE status='open'`, which only catches the rare case of an explicitly-set "open" row. Most routed leads have NO enrolments row (provider hasn't given an outcome yet, "implicitly open"). Tile was showing 1; should show ~84. Fixed by computing as routed-in-period IDs minus IDs with a terminal-status enrolment row (enrolled, presumed_enrolled, lost, cannot_reach). The other status tiles (cannot_reach, lost) stay as-is because those statuses always have explicit enrolments rows.

**Impact:** providers page total_routed now reconciles with overview KPI. Awaiting Outcome tile shows the real point-in-time number rather than 0/1 of explicit-open rows.

**Signed off:** Owner (session 14).

---

## 2026-04-27: DQ leak fix in lead router (ticket 869d2rxap)

**Type:** Edge Function fix + downstream-data backfill.

**What changed:**

1. **Form** (`switchable/site`): added a `dq_reason` hidden input to the `switchable-self-funded` form on `/find-your-course/`. `showHolding(reason)` now populates it; `restartForm()` and the submit handler clear it whenever the user is no longer in the DQ flow. Belt-and-braces against back-navigation edge cases.
2. **Edge Function `_shared/ingest.ts`**: added `applyDqOverride()` to `normaliseAndOverride()` so any client-flagged DQ row has its `provider_ids` forced to `[]`. Mirrors `applyOwnerTestOverrides`. The routing branch already short-circuits on `is_dq=true`; this just makes the row state honest. Both `netlify-lead-router` and `netlify-leads-reconcile` redeployed.
3. **Form-matrix simulator** (`/tools/form-matrix/`): updated FYC outcome blocks to reflect the corrected behaviour. The DQ holding panel + "keep me on the list" path captures the lead but flags it `is_dq=true` with no provider routing.

**Why:** before this fix, a self-funded learner who was DQ'd by the qualifier (qualification = `professional-body` or budget = `under-200` / `no-invest`) and then clicked "keep me on the list" landed in `leads.submissions` with `is_dq=false` and a real `primary_routed_to` value. They were routed to a provider as if qualified. Real example: Anita Bucpapaj (id 184) sent to Courses Direct on 2026-04-27 18:41 UTC. The form already redirected DQ submissions to `/waitlist/` instead of the thank-you page, but the form payload itself never carried the DQ marker, so the Edge Function couldn't tell.

**Backfill (pending owner action):**

```sql
UPDATE leads.submissions
   SET is_dq = true,
       dq_reason = 'qual',
       primary_routed_to = NULL,
       routed_at = NULL,
       provider_ids = '{}'::text[]
 WHERE id = 184;
```

Routing log entry #97 left in place as audit trail of the historical (now-corrected) misroute. Charlotte to email Marty separately so he doesn't waste effort on the lead.

**Impact:** every consumer of `leads.submissions` now correctly sees Anita as DQ once the backfill SQL runs. Reconciliation card on `/admin/errors` will show a 1-row drift between routing-log count and unique-people count until that routing_log row ages out of the active set; that's the deliberate "we corrected a misroute" trace.

**Schema_version:** unchanged. `dq_reason` is an existing optional field on the lead payload schema (already used by funded waitlist forms). Self-funded form starting to send it is additive per `.claude/rules/schema-versioning.md`.

**Signed off:** Owner (session 14, ticket 869d2rxap).

---

## 2026-04-27: Admin dashboard correctness fixes (Session 14 batch 2)

**Type:** UI/data fixes only. No schema or migration changes.

1. **`/admin` overview:** "Routed" KPI switched from `COUNT(*)` of routed parent rows (was 89) to `COUNT(DISTINCT lower(trim(email)))` of all live routed rows including children (now 88). Matches the owner's per-sheet count. Same change feeds both conversion rates (potential incl. presumed; confirmed only).
2. **`/admin/leads`:** enrolment-status badge for `enrolled` now `bg-emerald-600 text-white` (deep green) instead of pale `emerald-100`, so it's visually distinct from the routed badge.
3. **`/admin/providers`:** new "Total enrolled" column (confirmed + presumed combined). Conversion split into two columns, "Potential %" (incl. presumed) and "Confirmed %" (enrolled only). Replaces the previous single conversion column.
4. **`/admin/errors`:** major rewrite. Top-of-page DB reconciliation card surfaces routing_log_rows vs unique-people-routed and breaks down the gap (archived test rows + linked re-applications + rapid-fire same-email duplicates). Each unresolved error row now shows the linked lead's name, email, current state in plain English (pulls from `raw_payload.submission_id` for `reconcile_backfill` rows). Source-group headlines plain English, "What this is / What to do" per source, plus an explanatory card explaining what "Mark resolved" actually does.
5. **`/admin/account` topbar dropdown:** replaced the shadcn DropdownMenu (Base UI render-prop pattern) with a self-contained `UserMenu` component using vanilla button + click-outside `useEffect`. The render-prop indirection with nested `<form>` + `<Link>` was breaking inner click events.

**Signed off:** Owner (session 14).

---

## 2026-04-26 — Social schema launch (migration 0029) — Session G.1

**Type:** Schema migration. Multi-brand organic social automation — 7 tables, 6 views, RLS, Vault setup. Foundation for Session G.2 (OAuth + `/social/settings`) and Session G.3 (publish Edge Function + drafts UI).

**Migration 0029 — `0029_social_schema.sql`:**

1. **Extensions:** `pgsodium` (Supabase Vault primitives) and `pgcrypto` (defensive — `gen_random_uuid()`).
2. **Schema:** `social` namespace, with `GRANT USAGE ... TO authenticated`.
3. **Defensive:** `REVOKE ALL ON vault.decrypted_secrets FROM authenticated, anon` — Edge Functions read tokens through a SECURITY DEFINER helper added in G.3 (mirrors the `public.get_shared_secret()` pattern from migration 0019).
4. **Tables (7):** `drafts`, `engagement_targets`, `engagement_queue`, `post_analytics`, `engagement_log`, `oauth_tokens`, `push_subscriptions`.
5. **Views (6):** `vw_pending_drafts`, `vw_post_performance`, `vw_engagement_queue_active`, `vw_targets_due_review`, `vw_rejection_patterns`, `vw_channel_status`. All set `WITH (security_invoker = true)` so they inherit underlying-table RLS rather than running as the view owner.
6. **RLS:** Every table has RLS enabled. `FOR ALL` policies via `admin.is_admin()` (the existing helper from migration 0014). `push_subscriptions` adds row-scope: admin can only see/manage their own subscriptions.
7. **Append-only tables:** `post_analytics` and `engagement_log` ship with SELECT/INSERT/UPDATE grants only — DELETE deliberately not granted (audit preservation). UPDATE remains for typo correction.
8. **`post_analytics.draft_id` ON DELETE RESTRICT:** deleting a draft does not silently destroy its analytics history.
9. **`engagement_queue.expires_at` NOT NULL DEFAULT (now() + 48h):** active-queue view filter no longer silently drops NULLs.
10. **OAuth token storage:** `social.oauth_tokens` holds metadata + `access_token_secret_id` / `refresh_token_secret_id` UUIDs referencing `vault.secrets`. Ciphertext lives in Vault; admin UI never surfaces plaintext. Per `(brand, channel)` is the unique posting surface key.
11. **Idempotent:** `IF NOT EXISTS` on tables, `OR REPLACE` on views, `DROP POLICY IF EXISTS` before each policy. Deploy retry safe.
12. **Real DOWN block:** drops every object — schema is brand new, fully reversible.

**Why:** Multi-brand organic social automation per `platform/docs/admin-dashboard-scoping.md` § Session G. Designed multi-brand (SwitchLeads + Switchable) and multi-channel (LinkedIn personal/company, Meta facebook/instagram, TikTok) from day one.

**Review process:** `/ultrareview` not available in the local Claude Code build. Used three in-session multi-agent reviews instead — SQL correctness, security/RLS, spec compliance. Reviewers found two critical issues (missing `security_invoker` on views, missing GRANT SELECT on views) and several non-critical items. All addressed before applying. Future migrations should use `/ultrareview` once it's available; in the meantime the multi-agent in-session review is the substitute. See ClickUp ticket (to be created) on getting `/ultrareview` working.

**Repo restructure prerequisite (same session):** `platform/` is now a single git repo (was just `platform/app/`). Migrations 0001-0029, Edge Functions, governance docs all tracked. `netlify.toml` at repo root with `base = "app"` keeps the dashboard deploying from its subfolder. This was a precondition for `/ultrareview` to ever work on migrations.

**Impact assessment per `.claude/rules/data-infrastructure.md` §8:**

1. **What changes:** new `social` namespace + 7 tables + 6 views + RLS + Vault adoption. No changes to existing schemas.
2. **Reads:** none today. `/social/*` admin dashboard pages (Session G.2/G.3) will read these tables. Sasha's monitoring queries don't reference `social.*`; she'll see the new schema transparently when she next runs Monday checks.
3. **Writes:** none today. OAuth callback (G.2) writes `oauth_tokens` + `vault.secrets`. Cron Edge Functions (G.3) write `drafts`, `engagement_queue`, `post_analytics`. Admin UI writes `engagement_log`, draft approvals, dispute flags.
4. **Schema bump:** none. `social.drafts.schema_version` introduces a new internally-managed schema versioned at `'1.0'`; not a payload-side bump.
5. **Data migration:** none — schema is brand new, no existing rows.
6. **New role / RLS:** new RLS policies on all 7 tables via `admin.is_admin()`. No new role.
7. **Rollback:** DOWN block drops every object cleanly. Vault entries created post-G.2 would need separate cleanup.
8. **Sign-off:** owner approved 2026-04-26 in platform Session 10.

**Repo state at apply time:** commit `969a662` on `main`, GitHub repo `charlotteharris126/switch-platform`, all migration files now tracked.

---

## 2026-04-26 — Enrolment status taxonomy refactor (migration 0028)

**Type:** Schema migration. Replaces the `crm.enrolments.status` enum with a redesigned set, adds three new columns, and rewrites the two SECURITY DEFINER functions that operate on the table. Data migration in the same file (in-place rewrite of existing rows).

**Migration 0028 — `0028_enrolment_status_taxonomy_refactor.sql`:**

1. **Status set replaced.** Old: `open / contacted / enrolled / not_enrolled / presumed_enrolled / disputed`. New: `open / enrolled / presumed_enrolled / cannot_reach / lost`. Disputes are now a flag on presumed-enrolled rows, not a status.
2. **Data migration (in-place):**
   - `contacted` rows → `open` (we never surfaced 'contacted' on the dashboard, lossless from user view)
   - `not_enrolled` rows → `lost` with `lost_reason` NULL (no signal to retrofit; new rows will carry a reason)
   - `disputed` rows → `presumed_enrolled` + `disputed_at` snapshot from `status_updated_at` + `disputed_reason` copied from `notes`
3. **New columns:**
   - `lost_reason TEXT` — required when `status = 'lost'`. CHECK constraint: `not_interested | wrong_course | funding_issue | other`.
   - `disputed_at TIMESTAMPTZ` — set when a dispute is raised. Preserved as audit evidence even if status moves on to `enrolled` or `lost`.
   - `disputed_reason TEXT` — provider's stated reason for the dispute.
4. **`crm.upsert_enrolment_outcome()` rewrite.** Old 3-arg signature dropped, new 6-arg signature: `(submission_id, status, notes, lost_reason, disputed, disputed_reason)`. Validates the new status set, enforces lost_reason on lost rows, only accepts dispute flag on `presumed_enrolled`. Atomic with audit row.
5. **`crm.run_enrolment_auto_flip()` rewrite.** Drops `'contacted'` from the early-state filter — only `'open'` rows are eligible for the 14-day auto-flip now.

**Why:** Owner reframed the model 2026-04-26 in platform Session 9 catch-up-page scoping. The old taxonomy lumped two operationally distinct outcomes ("provider couldn't reach" and "provider reached them, learner said no") into one `not_enrolled` bucket, hiding which type of leak was actually happening. Cannot-reach is fixed by better numbers / preferred call time / automated nudges; lost is fixed by qualification / course-fit / funding clarity. Splitting them means the catch-up page (in build) can tell Charlotte which conversation to have with each provider. Disputed-as-status was redundant — it was always a flag on presumed-enrolled in practice.

**Producer + consumer changes (shipped same session):**

- **Outcome form** (`app/admin/leads/[id]/enrolment-outcome-form.tsx`) — buttons match new statuses; conditional Lost-reason radio (4 buttons) appears when status=Lost; conditional dispute checkbox + reason textarea appears when status=Presumed enrolled. Optimistic UI + sonner toast preserved.
- **Server Action** (`app/admin/leads/[id]/actions.ts`) — `EnrolmentOutcome` type renamed to `EnrolmentStatus`, new `LostReason` type, RPC params extended.
- **Lead detail page** (`app/admin/leads/[id]/page.tsx`) — fetches `lost_reason / disputed_at / disputed_reason` and passes to form.
- **Admin overview** (`app/admin/page.tsx`) — `Routed (active)` query drops 'contacted'; `Not enrolled` tile replaced by `Lost`; new `Cannot reach` tile added; `Disputed` tile now counts rows where `disputed_at IS NOT NULL` (independent of status). Lifecycle breakdown is now 10 tiles.
- **Actions page** (`app/admin/actions/page.tsx`) — approaching-flip query drops 'contacted'; presumed-enrolled section displays disputed badge + reason inline.

**Impact assessment per `.claude/rules/data-infrastructure.md` §8:**

1. **What changes:** status enum redefined, columns added, two SECURITY DEFINER functions replaced.
2. **Reads:** admin dashboard pages above (all updated). No agents, no Metabase yet, no n8n flows. Sasha's monitoring queries don't reference enrolment status today; she'll see new values transparently when she next runs Monday checks.
3. **Writes:** `crm.upsert_enrolment_outcome` (admin form), `crm.run_enrolment_auto_flip` (cron). Both rewritten in this migration.
4. **Schema bump:** payload `schema_version` unchanged. This is internal CRM state, not a data contract with an external producer.
5. **Data migration:** in-place UPDATE statements in the migration. Existing rows transformed safely. Old status values unrecoverable from row data alone — audit trail (`audit.actions`) is the only canonical history of pre-migration state.
6. **New role / RLS:** none. Existing admin RLS policies cover the new columns transparently.
7. **Rollback:** Forward-only in practice. DOWN section documents the structural reversal but the original `contacted / not_enrolled / disputed` values cannot be restored from the migrated rows. Restore from a pre-migration backup if a true revert is required.
8. **Sign-off:** owner approved 2026-04-26 in platform Session 9 scoping. Direct quote: "lets get it done".

**Catch-up page dependency:** the new `lost_reason` field is the data source for the "common lost reasons" section on the per-provider catch-up page (build queue item #3, in progress this session). Without this migration that section would have nothing to count — free-text notes are not analysable. The Otter.ai transcript-parsing path was considered as an alternative but deferred: the dropdown gives clean structured data from today, transcript parsing layers richer qualitative context on top later. They complement, not compete.

---

## 2026-04-25 — Add `funding_category` (migration 0017): top-level funding split (gov / self / loan)

**Type:** Schema migration. Additive only — new column on `leads.submissions` and `leads.partials`, plus backfill of historical rows. Per `.claude/rules/schema-versioning.md` § "Additive change: no version bump needed", lead payload `schema_version` stays at 1.1.

**Migration 0017 — `0017_add_funding_category.sql`:**

1. `leads.submissions.funding_category TEXT` — top-level category (`gov` | `self` | `loan`). `funding_route` continues to hold the specific scheme name (`free_courses_for_jobs`, `lift_futures`, etc.).
2. `leads.partials.funding_category TEXT` — mirrors the above for funnel parity.
3. Backfill: existing `funding_route` values mapped to category. `'free_courses_for_jobs' / 'lift_futures' / 'switchable-funded'` → `gov`. `'self' / 'switchable-self-funded'` → `self`. `'switchable-loan'` → `loan`. Anything else → NULL.
4. Indexes: `submissions_funding_category_idx` (with `submitted_at DESC`), `partials_funding_category_idx`.

**Why:** Today `funding_route` holds a mix of category-ish values (`'self'`) and specific scheme names. The dashboard filter is unreadable, and reporting (Session I) needs a clean top-level category split. Owner surfaced 2026-04-25 in platform Session D scoping.

**Producer + consumer changes (shipped same session):**

- **Switchable site:** new optional YAML field `funding.category` on the three live course YAMLs (`counselling-skills.yml`, `smm-for-ecommerce.yml`, `lift-digital-marketing-futures.yml`); template `funded-course.html` and `find-your-course/index.html` now emit a `funding_category` hidden field; `partial-tracker.js` reads `data-funding-category` data attribute and sends it in the partials payload; build script `build-funded-pages.js` emits the new `{{FUNDING_CATEGORY}}` token; `funded-funnel-architecture.md` payload schema doc updated with note explaining no version bump (additive).
- **Platform:** `_shared/ingest.ts` reads `funding_category` from payload and sets per-form defaults (funded → `gov`, self-funded → `self`); `netlify-partial-capture/index.ts` parses + upserts; `netlify-lead-router/index.ts` shows category in the owner-notification email; `provider-sheet-appender-v2.gs` recognises `fundingcategory` / `category` headers; admin dashboard adds Funding category filter dropdown + Funding column shows category prominently; lead detail page shows both category and scheme.
- **Skill:** `/new-course-page` skill updated to ask for funding category in Phase 1 (still pending — see Session D handoff).

**Impact assessment per `.claude/rules/data-infrastructure.md` §8:**

1. **What changes:** new column + backfill + producer/consumer wiring.
2. **Reads:** dashboard `app/admin/leads/page.tsx`, `app/admin/leads/[id]/page.tsx`, `app/admin/leads/filters.tsx` (all updated this session). Reporting (Session I) will read this column once built. No agents, no Metabase yet, no n8n flows.
3. **Writes:** `netlify-lead-router` via `_shared/ingest.ts`, `netlify-partial-capture` via direct upsert.
4. **Schema bump:** none required — additive optional field per the rule.
5. **Data migration:** backfill UPDATE in same migration. Idempotent (only sets where NULL).
6. **New role / RLS:** none. Existing admin RLS policies cover the new column transparently.
7. **Rollback:** DOWN section in migration drops the indexes + columns. Reversible until live data starts using the new column meaningfully.
8. **Sign-off:** owner approved 2026-04-25 in platform Session D scoping conversation.

**Next live lead test:** confirm new lead from any of the three funded courses lands with `funding_category = 'gov'` in `leads.submissions`. Confirm next self-funded lead from find-your-course lands with `funding_category = 'self'`. If either is null, payload is not reaching the column — investigate ingest path.

**Deploy 2026-04-25:**
- Migration tracking repair: `supabase migration repair --status applied 0001..0016` ran first (production had every migration applied but `supabase_migrations.schema_migrations` was empty — same drift `869d1yeyq` flagged). One-shot fix; future deploys clean.
- `supabase db push` then applied 0017. Backfill verified via Postgres MCP: `gov` 78 rows (61 FCFJ + 17 LIFT), `self` 9 rows, `null` 38 rows (all DQ waitlist + tests, expected).
- `supabase functions deploy netlify-lead-router netlify-partial-capture netlify-leads-reconcile routing-confirm` shipped all four updated functions.
- Switchable site: commit `99bece3` pushed to `charlotteharris126/switchable-site` main; Netlify auto-deploys.

---

## 2026-04-25 (post-incident hardening) — Migration 0019: AUDIT_SHARED_SECRET → Supabase Vault as single source of truth

**Type:** Infrastructure / governance change. Adopts Supabase Vault for one shared secret (the one with cross-component drift risk). Closes the bug class behind today's silent cron failure.

**Problem class:** `AUDIT_SHARED_SECRET` was used by both pg_cron command text (sent as `x-audit-key` header) and Edge Function env (read by `netlify-leads-reconcile` + `netlify-forms-audit` to validate the header). Two stores, manual sync at every rotation. The cron command in production had a literal `<REPLACE_WITH_AUDIT_SHARED_SECRET>` placeholder — never substituted — so cron auth had been failing silently since setup, masked by the live webhook covering the gap.

**Migration 0019 (`0019_vault_helper_for_shared_secrets.sql`):**
- `public.get_shared_secret(name TEXT) RETURNS TEXT SECURITY DEFINER` — locked search_path, allowlist-restricted (only `AUDIT_SHARED_SECRET` retrievable; extending to other secrets requires a migration). Returns `vault.decrypted_secrets.decrypted_secret` for the named entry.
- `GRANT EXECUTE` on the helper to `functions_writer` and `postgres` only.
- `cron.alter_job(...)` for jobid 4 (`netlify-leads-reconcile-hourly`) and jobid 5 (`netlify-forms-audit-hourly`) — both now read auth via `public.get_shared_secret('AUDIT_SHARED_SECRET')` in their command text.
- DOWN section restores prior (broken) cron state and drops the helper.

**Vault seed (one-off, not committed):**
- Rotated `AUDIT_SHARED_SECRET` to a fresh `openssl rand -hex 32` value.
- `vault.create_secret(...)` inserted it as Vault entry id `9029dd19-90da-4165-9d43-416522958c60`.
- Verified `public.get_shared_secret('AUDIT_SHARED_SECRET')` returns a 64-char value.

**Edge Function changes (deployed):**
- `_shared` not modified — only the two cron-triggered functions (`netlify-leads-reconcile`, `netlify-forms-audit`) needed updates.
- Both replace the module-level `const AUDIT_SHARED_SECRET = Deno.env.get(...)` with an `async getAuditSharedSecret()` that reads Vault via `public.get_shared_secret('AUDIT_SHARED_SECRET')` on each request. ~10ms extra per call, negligible at cron-only volume. Cache-free so rotations propagate instantly.
- Re-deployed both with `--no-verify-jwt` (also persisted in `supabase/config.toml`).
- `AUDIT_SHARED_SECRET` removed from Edge Function Secrets via `supabase secrets unset`. Vault is now the only place this secret exists.

**Verification:**
- Cron-style `net.http_post(...)` triggered both functions via the new path — both returned 200, reconcile body shows `status: "ok"`, audit body shows `status: "clean"`.
- After unsetting the env var, both functions still return 200 — proving the Vault path is genuinely the only auth source.

**Impact assessment per `.claude/rules/data-infrastructure.md` §8:**
1. Changes: one new function, two cron rewrites, two Edge Function deploys, one secret store change.
2. Reads: cron jobs (jobid 4, 5), reconcile function, audit function. All updated.
3. Writes: rotation now via `vault.update_secret(...)` only. No env to keep in sync.
4. Schema bump: N/A.
5. Data migration: secret value migrated via one-off `supabase db query --linked` (not committed per `.claude/rules/data-infrastructure.md` §5 — secrets never in iCloud-synced files in plaintext).
6. New role / RLS: no new role; helper grants are tight (allowlist function returns one specific secret to two specific roles).
7. Rollback: DOWN section in migration restores prior cron and drops helper. Vault entry would need `vault.delete_secret(...)`. Edge Functions would need redeploy with env-based read restored.
8. Sign-off: owner approved scoping in Session 9 conversation.

**Deliberately not migrated to Vault:** `ROUTING_CONFIRM_SHARED_SECRET` (single-component — only used by `netlify-lead-router` to sign and `routing-confirm` to verify; no cron, no drift class), `SHEETS_APPEND_TOKEN` (also used by Google Apps Scripts which can't read Vault, and retires with Phase 4 Sheets retirement).

**Rotation runbook (new — `platform/docs/secrets-rotation.md` updated):**
1. `SELECT vault.update_secret(id, '<new value>', 'AUDIT_SHARED_SECRET', '<description>');`
2. Done. Cron and Edge Functions pick up new value on their next call automatically.

---

## 2026-04-25 (late) — Auto-routing v1 LIVE + Realtime auto-refresh + UX polish pass

**Type:** Feature shipment + infra change (Realtime publication) + Edge Function deploy.

### Auto-routing v1
Per `platform/docs/auto-routing-design.md`. Single-candidate provider with `auto_route_enabled = true` → routes immediately on lead arrival. Multi-provider, DQ, or auto_route_enabled=false → existing email-confirm flow. Every routing event (auto OR owner-confirm) writes a system-actor audit row.

- New shared helper `_shared/route-lead.ts` containing the full routing pipeline (DB writes + sheet append + provider notification + audit). Used by `netlify-lead-router` (auto-route mode) — `routing-confirm` refactor to use it deferred to next session.
- `netlify-lead-router` updated: after `insertSubmission`, checks single-candidate eligibility, calls `routeLead(... 'auto_route')` for eligible leads, sends FYI email to owner instead of confirm-button email. Falls back to email-confirm path on auto-route failure.
- Owner FYI email: terse "Auto-routed: SL-26-04-NNNN → Provider Co" with link to the lead detail page and a callout for any side-effect failures (sheet append failed / provider email failed).
- Owner toggles `auto_route_enabled` per-provider via the Provider edit form (live since earlier today). All 3 pilot providers currently ON.
- Smoke-tested with synthetic owner-test payload — function returned 200, lead correctly DQ'd via owner_test_submission rule, did NOT auto-route (correct: DQ leads never route).
- **Verification pending:** the next real funded lead will be the first auto-route. EMS has 1 candidate per course (counselling-skills + smm), so any new lead from those courses fires the auto-route path. Owner should watch for the FYI email.

### Realtime auto-refresh
- Migration 0025 adds `leads.submissions`, `leads.routing_log`, `crm.enrolments`, `leads.dead_letter` to the `supabase_realtime` publication.
- New client component `components/realtime-refresh.tsx` subscribes to `postgres_changes` for the listed tables and triggers `router.refresh()` with a 600ms debounce.
- Mounted on Overview, Leads list, Lead detail, Actions tab. RLS still applies — only admin users (`admin.is_admin() = true`) receive events for the rows they can SELECT.
- Result: when a new lead lands, when an outcome is marked, when an error logs, the dashboard updates within ~1 second across all admin tabs you have open.

### UX polish pass
- Replaced inline form feedback with sonner toast notifications (saving an outcome or provider edit slides in a toast in the corner).
- Optimistic UI on enrolment outcome form: clicking Save updates the displayed status immediately, reverts only on error.
- Tightened button styles across button groups: clearer selected-state shadow, hover translate-up, active scale-down, smooth 150ms transitions.
- Save buttons now have shadow + active-scale for tactile feel.
- Added `loading.tsx` files for /, /leads, /leads/[id], /actions, /providers — uses new `components/loading-skeleton.tsx` primitives so navigation no longer flashes blank.

### Commits
- platform/app `376bd6a` — UX polish + realtime client wrapper + loading skeletons
- platform Edge Functions deployed: `netlify-lead-router` (with auto-route) — done via `supabase functions deploy --no-verify-jwt`

### Risks
- First real auto-route hasn't fired yet. If `_shared/route-lead.ts` has a bug, the auto-route path fails → fallback `notifyOwnerOfRoutableLead` runs → owner gets the email-confirm email and routes manually. Lead won't be lost.
- Routing-confirm still has its own (now duplicated) routing logic. Refactor to use `_shared/route-lead.ts` is a follow-up so we have a single source of truth across both paths.

---

## 2026-04-25 (incident) — Edge Functions deployed without `--no-verify-jwt`, all Netlify webhooks 401'd for ~4h

**Type:** Production incident. ~4 hours of leads queued in Netlify, none reached the DB. Resolved.

**Symptom:** Owner reported leads coming in but no router emails and nothing in DB. Last successful submission was id 132 Kate Williams 06:46:44 BST. Partials showed step_reached=91 (form completion) at 06:54:34 with `is_complete=false` — meaning user submitted, but the lead-router INSERT never ran. `leads.dead_letter` empty for the period — error was happening BEFORE the function code, at the auth gate.

**Root cause:** When deploying the Edge Functions earlier today (`supabase functions deploy netlify-lead-router netlify-partial-capture netlify-leads-reconcile routing-confirm`), I omitted the `--no-verify-jwt` flag. Default became JWT verification ENABLED. Every Netlify webhook arrived without a JWT and was rejected by Supabase's gateway with 401 before the function code ran. Same for browser-side partial-capture calls (which also don't carry JWTs). Every Edge Function README documents `--no-verify-jwt` as essential — I missed every one.

This is the textbook "verify infrastructure end-to-end" failure (memory `feedback_end_to_end_setup`). After the deploy, I should have curl-tested an unauth POST to the function and confirmed 200, not just trusted the deploy log.

**Fix:**
1. Redeployed with the flag: `supabase functions deploy netlify-lead-router netlify-partial-capture netlify-leads-reconcile routing-confirm --no-verify-jwt`
2. Made the setting sticky in `supabase/config.toml` so future deploys cannot regress this:
   ```
   [functions.netlify-lead-router]
   verify_jwt = false
   ```
   Same block added for `netlify-partial-capture`, `netlify-leads-reconcile`, `netlify-forms-audit`, `routing-confirm`.

**Verified:** unauth POST to `/functions/v1/netlify-lead-router` now returns 200 with submission_id. Form submissions will land going forward.

**Sub-fix (not the bug, but flagged during diagnosis):** Migration 0018 added column-level GRANT on `funding_category` to `functions_writer` and `readonly_analytics`. Diagnostic test confirmed `functions_writer` can INSERT funding_category — turned out the original grants covered the new column inheritance correctly, so 0018 was belt-and-braces. Kept for clarity.

**Backfill:** Real Netlify form submissions queued during the 4h window should auto-redeliver via Netlify's webhook retry policy (~24h retry window). Reconcile cron pulls from Netlify Forms API every 30 min as a safety net. If any leads are missing after the next cron cycle, manual backfill via netlify-leads-reconcile manual call required.

**Lesson worth remembering:** when redeploying multiple Edge Functions, always re-pass per-function CLI flags. CLI does not retain previous deploy settings. Now enforced via `config.toml`.

---

## 2026-04-25 (post-deploy audit) — Data-ops 009: routing-state cleanup + dashboard archived-row exclusion

**Type:** Data fix + code change. Single source of truth fix — making DB routed counts match the providers' sheets.

**Trigger:** Owner audit found EMS dashboard showed 43 routed leads but the EMS sheet had only 41. Investigation showed two retroactively-archived test rows (id 29 charliemarieharris@icloud.com, id 30 test7@testing.com) had `primary_routed_to` set despite `is_dq=true` and `archived_at` set. Plus one duplicate routing_log entry (id 8) for Lana Ayres (submission 21) — same lead routed to EMS twice on 2026-04-20 (manual_sheet + manual_email separately logged).

**Data-ops `009_archive_routing_cleanup.sql`:**
- `UPDATE leads.submissions SET primary_routed_to = NULL, routed_at = NULL WHERE id IN (29, 30) AND is_dq AND archived_at IS NOT NULL`
- `DELETE FROM leads.routing_log WHERE id = 8` (Lana duplicate)
- Applied via `supabase db query --linked --file ...`

**Code changes:**
- `app/admin/leads/page.tsx` — Routed/Unrouted filters now require `archived_at IS NULL`. Prevents archived test rows from inflating routed counts.
- `supabase/functions/routing-confirm/index.ts` — Refuses to route a submission with `archived_at` set. Defends against the same drift recurring (a stale confirm-button click on an archived row would otherwise re-pollute the sheet). Deployed via `supabase functions deploy routing-confirm`.

**Result:** DB active routed count now 65 (EMS 41 + WYK 15 + CD 9), matching the three providers' sheets exactly. routing_log: 68 → 67 events (Lana duplicate removed).

**Commits:** platform/app `07a7486`. Data-ops file at `platform/supabase/data-ops/009_archive_routing_cleanup.sql`.

---

## 2026-04-24 (evening) — Session C: schema additions for admin dashboard write surfaces (migration 0016)

**Type:** Schema migration. Additive only — new columns, new tables, new views. No destructive changes. Plus catch-up application of migration 0013 (`audit.actions`) which was recorded as applied in the Session A handoff but was found missing in production during Session C pre-flight.

**Migration 0016 — `0016_session_c_schema_additions.sql`:**

1. **`audit.actions` catch-up.** Idempotent re-application of migration 0013 (schema, table, indexes, RLS policy). Production pre-flight via `information_schema.tables` showed the table missing despite the Session A handoff recording it as applied. Bundled into 0016 with `CREATE IF NOT EXISTS` so the historical numbering stays intact even though 0013 was never run.
2. **`crm.providers` — new columns.**
   - `first_lead_received_at TIMESTAMPTZ` (backfilled from `leads.routing_log` for the three pilot providers)
   - `auto_route_enabled BOOLEAN NOT NULL DEFAULT false` (per-provider opt-in for future auto-routing)
   - `billing_model crm.billing_model NOT NULL DEFAULT 'retrospective_per_enrolment'` (enum: `retrospective_per_enrolment | prepaid_credits | per_lead`)
3. **`crm.routing_config`** — new single-row table holding global routing mode (`manual|monitor|auto`) plus scoring weights for future auto-routing.
4. **`crm.provider_credits`** — new table, dormant until a credits-model provider signs.
5. **`crm.billing_events`** — new table, model-agnostic billable event log. One row per `enrolment_confirmed | lead_delivered | credit_debit | credit_topup | manual_adjustment` event.
6. **`audit.erasure_requests`** — new table, GDPR right-to-erasure log (used by Session F).
7. **Views.**
   - `crm.vw_provider_performance` (30-day rolling enrolment ratio per active provider)
   - `leads.vw_needs_status_update` (routed leads older than 14 days with no non-open enrolment outcome)
   - `public.vw_admin_health` (one-row snapshot of headline health counters for the topbar + on-demand audit)
   - All views use `security_invoker = true` so RLS is enforced at the underlying table level.
8. **RLS + grants.** Every new table gets:
   - `admin_*` SELECT policy using `admin.is_admin()` (from migration 0014)
   - `analytics_*` SELECT policy for `readonly_analytics`
   - Explicit `GRANT SELECT` to both roles
   - `GRANT USAGE ON SCHEMA audit` to both (new — `audit` was previously read-only to the superuser only).

**Impact assessment (per `.claude/rules/data-infrastructure.md` §8):**

1. **Change.** Additive DDL across the `crm`, `audit`, `public`, `leads` schemas. No ALTER on existing columns, no DROP, no type changes.
2. **Reads.** The admin dashboard (Session B) already reads `crm.providers`, `leads.submissions`, `leads.routing_log`, `leads.dead_letter` — adding columns doesn't affect those SELECTs because they use explicit column lists. Metabase, Sasha MCP, Mira MCP use `readonly_analytics` which retains full SELECT. No consumer breaks.
3. **Writes.** No producers write to the new tables yet. Session D writes `crm.routing_config`, `audit.actions`, `crm.billing_events`; Session F writes `audit.erasure_requests`.
4. **Schema version bump.** No payload bumps required — nothing in this migration touches an ingested data contract. `leads.submissions.schema_version` stays at `1.0`.
5. **Data migration.** One UPDATE: backfill `crm.providers.first_lead_received_at` from `MIN(leads.routing_log.routed_at)` per `provider_id`. Three rows affected (EMS 2026-04-19, Courses Direct 2026-04-21, WYK Digital 2026-04-21). Deterministic — re-running the UPDATE is idempotent (WHERE clause gates on `first_lead_received_at IS NULL`).
6. **Roles / RLS.** New tables each get admin + analytics SELECT. No new roles. Schema `audit` was previously inaccessible to `authenticated`; this migration grants `USAGE` on it so the dashboard can read `audit.actions` and `audit.erasure_requests` — both RLS-gated to `admin.is_admin()`.
7. **Rollback.** The `-- DOWN` block at the bottom of 0016 drops each object in reverse order. The `audit.actions` drop is commented out — only drop if the table was first created by 0016 (not by a future re-run of 0013). In practice we fix forward, not roll back.
8. **Sign-off.** Owner (paste-and-run via Supabase SQL Editor).

**Discovery and correction — 0013 status:** Session A (2026-04-24 morning) recorded `audit.actions` as applied to production. Session C pre-flight via `SELECT FROM information_schema.tables WHERE table_schema = 'audit'` returned zero rows. Best guess: the Session A paste either failed silently, was rolled back, or landed on a non-production project. Correction lives inside 0016 (catch-up). Memory / handoff for future sessions: always verify migrations in production via an MCP query at session start, do not trust prior-session "applied" claims.

**Follow-ups for next session (D):**
- Write Server Actions for lead routing, enrolment outcome, provider edit, error replay — each one writes an `audit.actions` row.
- Build "Needs status update" panel backed by `leads.vw_needs_status_update`.
- Route the `audit.actions` write through a dedicated insert function (not the application role directly) so the table stays append-only at the RLS level.

---

## 2026-04-22 (mid-morning) - Session 5.2: SHEETS_APPEND_TOKEN rotated in lockstep; true root cause of WYK sheet append failure identified

**Type:** Secret rotation + incident root-cause correction. No schema change, no migration, no code change.

**What happened:**
- A fourth WYK lead (Naomi, submission 58) failed sheet append with the same "unauthorized" error hours after the Session 5.1 clean-slate redeploy. The redeploy clearly hadn't fixed the underlying issue.
- Diagnosis via `supabase secrets list --project-ref igvlngouxcirqhlsrhga` (CLI, authoritative) showed the stored digest of `SHEETS_APPEND_TOKEN` was `0d30cea30642a599b2958e4b9223381e72c24abc702f69a05ca5906546a83659`.
- SHA-256 of the token the owner believed was in env (`60e13b...d74968`, the value visible in WYK Apps Script) computed to `2c98d4c1927f25540fec1fa3facc94f8b40b1847002134b39d998b5597d4fd2f`.
- Digests did not match → env had a DIFFERENT value from what the owner saw in both the Supabase dashboard hover tooltip AND the WYK Apps Script. The Supabase UI had been showing a stale/cached value through every earlier "compare tokens" check this session.

**True root cause of the WYK incident (Session 5.1 + 5.2 combined):** the Supabase env value and the WYK Apps Script TOKEN have never matched since WYK was first deployed. EMS worked because EMS's script TOKEN happened to match the real env value (by coincidence of how each was seeded). The Session 5.1 deployment tangle narrative (archived deployment serving stale code) was plausible but not the actual cause. The clean-slate redeploy didn't fix it because the redeploy carried the same mismatched TOKEN forward.

**Fix applied (Session 5.2):**
1. Generated new token via `openssl rand -hex 32` on owner's machine.
2. Pasted new value into WYK Apps Script v2 (`const TOKEN = '...'`), saved, Deploy → Manage deployments → pencil → New version → Deploy.
3. Same into EMS Apps Script v1.
4. Pasted new value into Supabase Edge Functions → Manage secrets → `SHEETS_APPEND_TOKEN`. Dashboard hover continued to show old value post-save (confirmed UI bug), but CLI digest changed to reflect new value.
5. Verified lockstep alignment: hash of new token matched Supabase CLI digest, and owner confirmed identical token in both Apps Scripts.

**Impact assessment (per `.claude/rules/data-infrastructure.md` §8):**

1. **Change:** credential rotation across 3 places (Supabase env + WYK v2 script + EMS v1 script). No code change, no schema change.
2. **Reads:** `routing-confirm` reads env `SHEETS_APPEND_TOKEN` per request. Apps Scripts compare inbound `body.token` vs local `TOKEN` constant. Immediate effect on next lead.
3. **Writes:** none beyond the rotation itself.
4. **Schema versions:** unchanged.
5. **Data migration:** none.
6. **New roles / RLS:** none.
7. **Rollback plan:** revert TOKEN in each script to prior value + revert Supabase env to prior value. Old value still recoverable from owner's terminal history if needed within 30 days.
8. **Sign-off:** Owner (session 2026-04-22 mid-morning).

**Follow-ups:**
- ClickUp ticket `869d0erj2` (token rotation backlog) closed as done.
- `platform/docs/secrets-rotation.md` updated: `SHEETS_APPEND_TOKEN` last-rotated 2026-04-22, next-due 2027-04-22.
- `BREVO_API_KEY` and `ROUTING_CONFIRM_SHARED_SECRET` still flagged as overdue from Session 3.
- Dashboard hover tooltip found unreliable for confirming secret values. Going forward, verify via `supabase secrets list` CLI digest + local `shasum` on expected value. Worth surfacing to Sasha's Monday scan: dashboard UI alone is not a trustable signal of what's actually stored.

**Files changed:**
- Modified: `platform/docs/secrets-rotation.md` (SHEETS_APPEND_TOKEN row + tracker changelog)
- Modified: `platform/docs/changelog.md` (this entry + correction appended to earlier 2026-04-22 early-morning incident entry)
- Rotated secrets (not version-controlled): Supabase env `SHEETS_APPEND_TOKEN`, WYK Apps Script v2 TOKEN constant, EMS Apps Script v1 TOKEN constant

**Signed off:** Owner (session 2026-04-22 mid-morning).

---

## 2026-04-22 (morning) - Data reconciliation: Katy form_name patch, id 30 test cleanup, DUMMY_TEST_DOMAINS added to ingest

**Type:** Two ad-hoc data fixes + one small Edge Function code change. No migration, no schema change.

**Trigger:** Owner reconciled DB qualified counts against Netlify form submissions. DB showed 21 qualified, Netlify showed 20 (19 funded + 1 self-funded). Two root causes:

1. Katy Franklin (id 11) — real funded lead, SQL-backfilled during the 2026-04-21 webhook-disabled incident with `raw_payload` missing the top-level `form_name` key, so every `raw_payload->>'form_name'` query returned NULL for her. She was uncounted in funded totals.
2. "tst 7" (id 30, `test7@testing.com`) — owner test that slipped past the `OWNER_TEST_DOMAINS` allowlist (domain `testing.com` not covered) and got routed to EMS as a real lead.

**What shipped:**

1. **Katy form_name patch** via one-off UPDATE: `jsonb_set(raw_payload, '{form_name}', '"switchable-funded"')` on id 11. Now queryable as switchable-funded.
2. **id 30 DQ cleanup** via UPDATE: `is_dq = true`, `dq_reason = 'test_submission_non_allowlisted_email'`, `archived_at = now()`. EMS sheet row was already correct (no stray test row in it, per owner check).
3. **`DUMMY_TEST_DOMAINS` constant added** to `platform/supabase/functions/_shared/ingest.ts`. List: `example.com`, `example.org`, `example.net`, `test.com`, `testing.com`. Tagged with distinct `dq_reason = 'dummy_test_email'` to keep audit separation between deliberate owner tests and inadvertent placeholder-email submissions.
4. **Refactored `isOwnerTestEmail` → `classifyTestEmail`** returning `'owner_test_submission' | 'dummy_test_email' | null`. `applyOwnerTestOverrides` updated to consume the new function. Flow: normalise → override (if classifier returns a reason, DQ with that reason + archive) → insert.

**Reconciliation after fixes:**

| Bucket | DB | Netlify |
|---|---|---|
| Funded qualified | 19 | 19 ✓ |
| Self-funded qualified | 1 | 1 ✓ |
| Waitlist real | 7 | 7 ✓ |
| Waitlist enrichment | 1 | 1 ✓ |

Exact match. DB total unchanged at 50 rows; reconciliation changed the qualified/DQ split from 21/29 to 20/30.

**Impact assessment (per `.claude/rules/data-infrastructure.md` §8):**

1. **Change:** two data fixes (single-row each) + one Edge Function code change (shared ingest module, additive constant, one function renamed and its caller updated).
2. **Reads:** any future query using `raw_payload->>'form_name'` now correctly sees Katy as switchable-funded. Any future query filtering by `is_dq` correctly excludes id 30. Any future submission from a dummy-domain email gets DQ'd at insert.
3. **Writes:** future `netlify-lead-router` and `netlify-leads-reconcile` runs will flag `dummy_test_email` at insert. Existing rows unchanged except ids 11, 30.
4. **Schema versions:** unchanged.
5. **Data migration:** none.
6. **New roles / RLS:** none.
7. **Rollback plan:** Katy patch reverts with `jsonb_delete(raw_payload, 'form_name')`. id 30 reverts via UPDATE clearing is_dq/dq_reason/archived_at. Edge Function code reverts via git to the pre-edit revision.
8. **Sign-off:** Owner (session 2026-04-22 morning).

**Files changed:**
- Modified: `platform/supabase/functions/_shared/ingest.ts` (DUMMY_TEST_DOMAINS constant, classifyTestEmail function, applyOwnerTestOverrides updated)
- Modified: this changelog
- DB UPDATEs (not version-controlled): id 11 raw_payload form_name patch, id 30 DQ cleanup

**Deploy required:** `netlify-lead-router` and `netlify-leads-reconcile` (both import `_shared/ingest.ts`). `routing-confirm` unaffected.

**Signed off:** Owner (session 2026-04-22 morning).

---

## 2026-04-22 (early morning) - Incident: WYK sheet append failing "unauthorized"; two leads delayed; deployment tangle resolved

**Type:** Live incident during pilot. Two WYK leads routed correctly in DB but sheet append failed; owner-fallback paste email fired as designed. Root cause was WYK Apps Script deployment state, not code or token. Resolved by clean-slate redeploy + `crm.providers.sheet_webhook_url` UPDATE. No migration, no code change, no schema change.

**Affected leads (sheet append failed, routing recorded correctly in DB):**
- Submission 53 - Raveena A Pillay - routed to wyk-digital 2026-04-22 05:10:44 UTC - dead_letter row 86
- Submission 56 - Zoya M - routed to wyk-digital 2026-04-22 06:03:44 UTC - dead_letter row 87

Both back-filled manually into Heena's sheet post-fix. Dead letter rows 86 + 87 marked `replayed_at = 2026-04-22 06:30:06 UTC`, `replay_submission_id = 53 / 56`. Heena emailed about delay.

**Not part of this incident:** Submissions 49 (Ruby) and 51 (Laura) landed during Session 5 deploy window on 2026-04-21 evening and were back-filled via data-ops/008 - different root cause (deploy-propagation), logged in the Session 5 entry.

**Root cause:** WYK Apps Script had multiple deployments:
- Active "Untitled" deployment on a URL the DB did NOT point at (running current code)
- Archived "SwitchLeads lead appender v2" deployment on the URL the DB DID point at (running stale code with a pre-edit TOKEN)

Archived Apps Script deployments continue to respond to POSTs for some time, serving the code that was live at archive-time. Owner's earlier "New version" redeploy created a new Active deployment with a new URL instead of updating the existing one's version, so `crm.providers.sheet_webhook_url` kept pointing at the archived URL running old code. TOKEN mismatch between the Edge Function payload and the archived deployment's frozen TOKEN value = "unauthorized" response. EMS unaffected - EMS v1 deployment had never been touched, its URL in DB matched its single Active deployment, and it accepted the live `SHEETS_APPEND_TOKEN` fine (proven by submission 54 Tony Hindhaugh routing successfully at 05:10:24 UTC, 29 seconds before Raveena's failure).

**Fix applied:**
1. Archive all existing WYK deployments (the stale Active + the already-Archived one).
2. Deploy fresh: Deploy → New deployment → Web app, Execute as Me, Who has access Anyone. Single active deployment, new URL.
3. `UPDATE crm.providers SET sheet_webhook_url = '<new URL>' WHERE provider_id = 'wyk-digital'`. No data-ops file because incident scope and single-row fix.
4. Dead letter cleanup: `UPDATE leads.dead_letter SET replayed_at = now(), replay_submission_id = (raw_payload->>'submission_id')::bigint WHERE id IN (86, 87)`.

End-to-end fix not yet proven on a live lead - next organic WYK submission verifies.

**Impact assessment (per `.claude/rules/data-infrastructure.md` §8):**

1. **Change:** single-field UPDATE to `crm.providers` (sheet_webhook_url for wyk-digital) + single UPDATE to `leads.dead_letter` (replayed_at on rows 86, 87). No schema change, no function change, no migration.
2. **Reads:** `routing-confirm` reads `sheet_webhook_url` per routing. Immediate effect on next WYK lead. No other consumer.
3. **Writes:** none beyond the incident UPDATEs themselves.
4. **Schema versions:** unchanged.
5. **Data migration:** none.
6. **New roles / RLS:** none.
7. **Rollback plan:** restore prior URL via UPDATE. Prior archived deployment would need unarchiving in Apps Script. Not expected to be needed.
8. **Sign-off:** Owner (session 2026-04-22 early morning).

**Follow-ups (tracked in session handoff):**
- ~~Rotate `SHEETS_APPEND_TOKEN`~~ → done in same session, see Session 5.2 entry below (2026-04-22 mid-morning).
- Provider onboarding playbook updated with a deployment-verification step (see `platform/docs/provider-onboarding-playbook.md` step 3.8 + token rotation callout). Intended to catch this trap for Courses Direct's setup tomorrow.
- `routing_log.delivery_status` wart: the column is written `'sent'` at the moment of routing intent, before the sheet append is attempted. For submissions 53 + 56 the column reads `'sent'` despite the append having failed. Left as-is to avoid retrospective edits; proper fix is a Session 6-era refactor to populate `delivery_status` post-attempt. Sasha's Monday scan reads `leads.dead_letter` for delivery health, so the misleading column is not currently load-bearing.

**Post-session correction — true root cause:** the incident was narrated at the time as a deployment-tangle issue (archived deployment serving stale TOKEN on a URL the DB was pointing at). The clean-slate redeploy + URL update appeared to work, but a third lead (Naomi, submission 58) failed the same way hours later. Diagnosis via `supabase secrets list` CLI revealed the SHA-256 digest of the env value did not match the digest of the token the owner believed was in env. The Supabase dashboard hover tooltip had been showing a stale/cached value, misleading every earlier "compare tokens" check. **The actual mismatch was env vs WYK Apps Script from day one; EMS worked because EMS's script TOKEN matched the real env value by coincidence of how each was originally seeded.** Full rotation to a fresh value in lockstep across all three places (env + WYK + EMS) resolved it. See Session 5.2 entry below.

**Files added / changed:**
- Modified: `platform/docs/provider-onboarding-playbook.md` (new verification step + callout)
- Modified: this changelog (incident entry at top)
- DB UPDATEs (not checked in): `crm.providers.sheet_webhook_url`, `leads.dead_letter.replayed_at` + `replay_submission_id`

**Signed off:** Owner (session 2026-04-22 early morning).

---

## 2026-04-21 (evening) - Session 5: multi-provider routing architecture; migrations 0011 + 0012; Apps Script v2; payload schema 1.0 → 1.1

**Type:** Two additive schema migrations + Edge Function refactors (router + routing-confirm) + new Apps Script (v2, canonical) + payload schema bump (additive) + docs update + data-ops seeds (backfill + provider seeds). Driven by the owner decision logged in the 2026-04-21 morning entry: "Ship Session 5 as a proper multi-provider architecture before the second self-funded lead." Also unblocks WYK Digital (third pilot provider, signed 2026-04-21 earlier in the day) ahead of the LIFT Digital Marketing Futures cohort starting 2026-04-27.

**Background:** Session 3 (2026-04-20) shipped owner-confirm routing automation but hardcoded the EMS funded-shape columns into the routing-confirm → Apps Script payload and the Apps Script itself. The 2026-04-21 morning Courses Direct lead (Sam Stevens, submission 34) surfaced the gap - replicating EMS for Courses Direct would have pushed EMS-shape fields into self-funded-shape sheet headers. Manually handled that day; Session 5 is the proper fix. See 2026-04-21 morning entry for the interim decision.

**What shipped:**

1. **Migration 0011 - `leads.submissions` self-funded canonical columns.** Additive: `postcode`, `region`, `reason`, `interest`, `situation`, `qualification`, `start_when`, `budget`, `courses_selected TEXT[]`. `region` stays NULL until Session 5.1 loads `reference.postcodes`. No indexes yet - pilot volume doesn't justify them.
2. **Migration 0012 - `crm.providers.cc_emails TEXT[] NOT NULL DEFAULT '{}'`.** Additive. Carries the per-provider CC list (Ranjit at Courses Direct is the first use). `routing-confirm` reads it and CCs on every provider notification.
3. **`netlify-lead-router` refactor** (via shared `_shared/ingest.ts`):
   - `CanonicalSubmission` interface extended with the new self-funded fields.
   - `normalise()` extracts the new fields generically at the base (applies to any form shape) - so the WYK funded form with a postcode field populates `postcode` alongside the funded cluster, and self-funded forms populate the self-funded cluster. One code path, both shapes.
   - `insertSubmission()` INSERT statement extended with the new columns.
   - `schema_version` default stays `"1.0"` to match what the live forms send as a hidden input. Session 5 is a docs-only contract bump to 1.1; the DB column reflects producer intent, not router opinion. A follow-up switchable/site deploy will bump the form's hidden `schema_version` input to `"1.1"` once the contract label catches up with the columns.
   - Router accepts hyphenated aliases (`start-when`, `courses-selected`) for two fields where the form uses hyphens while the rest use underscores. Round-trip tolerant until the form unifies on underscores.
   - `courses_selected` separator - `parseStringArray()` now splits on both `,` and `|` because the form joins selected courses with ` | `.
   - `postcode` normalised to uppercase, no-whitespace form via `normalisePostcode()` so the Session 5.1 JOIN on `reference.postcodes` has a stable key.
   - `courses_selected` extracted via a new generic `parseStringArray()` helper (reuses the pattern from `parseProviderIds`).
   - Owner notification email `composeOwnerEmailHtml` extended to render both funded and self-funded field clusters; null/empty fields are filtered by the existing `renderKeyValueList`, so a funded-only lead shows only funded fields and vice versa.
4. **`routing-confirm` refactor:**
   - `ProviderRow` gains `cc_emails: string[]`. `SubmissionRow` gains all Session 5 canonical fields plus `funding_route`, `outcome_interest`, `why_this_course`.
   - Provider SELECT adds `cc_emails`. Submission SELECT adds all new fields.
   - **Full-fat payload to Apps Script.** The POST body now carries every canonical field; Apps Script v2 on the receiving sheet picks what it needs via header FIELD_MAP. Pre-Session-5 v1 scripts are forward-compatible: they read only the keys they care about via positional `appendRow`; extra keys are harmless.
   - `buildCcList()` helper - dedupes owner + provider.cc_emails case-insensitively; returns `[]` if no CCs needed (Brevo treats `undefined` and `[]` differently).
   - `sendOwnerSheetFailureEmail` paste block rewritten from EMS-shape tab-separated row to a generic key-value table - owner picks whichever rows their sheet needs.
5. **`provider-sheet-appender-v2.gs` - new canonical Apps Script.** Single deployment per sheet serves every provider regardless of header layout. Reads row 1, looks up each header in FIELD_MAP, writes the corresponding payload field (or empty cell for manual columns). FIELD_MAP covers every Session 5 payload key with case- and punctuation-insensitive lookup. v1 file kept as reference until EMS migrates.
6. **data-ops/006 - backfill submission 34 (Sam Stevens).** Two-step: SELECT to inspect `raw_payload` values, then commented UPDATE to apply. Owner verifies the raw_payload key names match the form's hidden-input keys before uncommenting. Idempotent (single row, deterministic extract).
7. **data-ops/007 - Session 5 provider seeds.**
   - Part 1: INSERT WYK Digital into `crm.providers` (ON CONFLICT DO NOTHING). Agreement signed 2026-04-21. Pilot status, £150/enrolment flat, 3 free enrolments, LIFT programme context in notes. `cc_emails = '{}'`.
   - Part 2 (commented): UPDATE Courses Direct with `sheet_id`, `sheet_webhook_url`, `cc_emails = ARRAY['ranjit@courses-direct.co.uk']`.
   - Part 3 (commented): UPDATE WYK Digital with `sheet_id`, `sheet_webhook_url`.
   Parts 2+3 apply after owner creates the two Google Sheets and deploys Apps Script v2.
8. **Lead payload schema bump 1.0 → 1.1** in `switchable/site/docs/funded-funnel-architecture.md`. Additive per `.claude/rules/schema-versioning.md`. Old consumers reading 1.0 fields continue to work.
9. **`platform/docs/provider-onboarding-playbook.md` - new.** Generic playbook covering sheet creation, Apps Script v2 deploy, crm.providers seeding, end-to-end test, token rotation, and sheet retirement. Replaces the provider-specific `memory/project_courses_direct_routing_followup.md` (retired).
10. **Docs updated:** `platform/docs/data-architecture.md` (Status refreshed, new columns documented, reference.postcodes section added as Session 5.1 placeholder, sheet-integration-flow paragraph rewritten for header-driven Apps Script v2), `platform/docs/infrastructure-manifest.md` (Apps Script deployments table extended with Courses Direct + WYK rows, v2 canonical noted, manifest changelog extended).

### Lead payload contract - 1.0 → 1.1 diff

Additive only. Under `learner`:
- New: `postcode`, `reason`, `interest`, `situation`, `qualification`, `start_when`, `budget`, `courses_selected` (array).

No removals, no renames, no retypes. Old funded fields (`la`, `age_band`, `employment_status`, etc.) unchanged.

### Impact assessment (per `.claude/rules/data-infrastructure.md` §8)

1. **Change:** two additive DDL migrations, two Edge Function refactors, one new Apps Script variant, two data-ops seeds (one INSERT + four UPDATE templates for owner to run), payload schema minor bump, four doc updates, one new doc, one memory retirement.
2. **Reads of affected tables:**
   - `leads.submissions` - Sasha's Monday scan (via `readonly_analytics`), Metabase (future), agents via MCP, the reconcile Edge Function, the router's owner-notification email. None of these reference the new columns yet; adding them is a no-op for existing queries.
   - `crm.providers` - `netlify-lead-router` (reads provider rows for the owner notification), `routing-confirm` (reads full row including new `cc_emails`). Sasha's scan reads provider state. No behaviour change for readers that don't reference `cc_emails`.
3. **Writes to affected tables:**
   - `leads.submissions` - `netlify-lead-router` (refactored Session 5 to write new columns), `netlify-leads-reconcile` (automatically writes new columns via the shared `_shared/ingest.ts` module; no reconcile code change needed), owner ad-hoc via SQL editor.
   - `crm.providers` - owner ad-hoc only. Functions_writer role does not have UPDATE on `crm.providers`.
4. **Schema versions:** lead payload contract bumped 1.0 → 1.1 in documentation only (additive, minor bump per `.claude/rules/schema-versioning.md`). Router default stays `"1.0"` to match what the switchable-* forms send as a hidden input. New rows will carry `"1.1"` in the column once a follow-up switchable/site deploy bumps the form's hidden `schema_version` input. Mixed values on rows are expected and harmless - the column is documentation, not dispatch (router dispatches on `form_name`).
5. **Data migration:** single-row backfill for submission 34 (data-ops/006), optional and gated on owner running the UPDATE after reviewing the SELECT. No dual-write window needed - the new columns are write-only from Session 5 onwards; nothing reads them in prod until Metabase or the provider dashboard does, both future.
6. **New roles / RLS policies:** none. Existing RLS on `leads.submissions` and `crm.providers` covers the new columns automatically (PostgreSQL column-level defaults).
7. **Rollback plan:**
   - Code rollback - redeploy prior git revision of `_shared/ingest.ts`, `netlify-lead-router`, `routing-confirm`. Apps Script v2 deployments stay; their behaviour on the pre-Session-5 payload is empty cells for the Session 5 fields (non-breaking). v1 is unaffected by a code rollback.
   - Schema rollback - the DOWN blocks in migrations 0011 + 0012 drop the new columns. Safe only if no consumer has come to rely on them (pilot window: yes, anyone's safe to drop). Migration files themselves are additive; leaving the columns and reverting the code is also safe and simpler.
   - Data rollback - the Sam backfill can be reverted with a single UPDATE setting the new columns to NULL for id 34; `raw_payload` still holds the source values.
8. **Sign-off:** Owner (session 2026-04-21 evening). Ultrareview requested before deploy per `platform/CLAUDE.md` rule for any non-trivial platform change.

### Files added / changed

- Added: `platform/supabase/migrations/0011_add_self_funded_canonical_cols.sql`
- Added: `platform/supabase/migrations/0012_add_providers_cc_emails.sql`
- Added: `platform/supabase/data-ops/006_backfill_sam_self_funded_canonical.sql`
- Added: `platform/supabase/data-ops/007_session_5_provider_seeds.sql`
- Added: `platform/apps-scripts/provider-sheet-appender-v2.gs`
- Added: `platform/docs/provider-onboarding-playbook.md`
- Modified: `platform/supabase/functions/_shared/ingest.ts` (CanonicalSubmission interface, normalise(), INSERT, helpers)
- Modified: `platform/supabase/functions/netlify-lead-router/index.ts` (composeOwnerEmailHtml learner-fields block)
- Modified: `platform/supabase/functions/routing-confirm/index.ts` (ProviderRow + SubmissionRow interfaces, provider SELECT, submission SELECT, appendToProviderSheet full-fat payload, sendProviderNotification cc list, sendOwnerSheetFailureEmail generic key-value block, new buildCcList helper)
- Modified: `platform/docs/data-architecture.md` (Status, leads.submissions schema, crm.providers schema, sheet integration flow paragraph, new reference.postcodes planned section, schemas table)
- Modified: `platform/docs/infrastructure-manifest.md` (Last verified, SHEETS_APPEND_TOKEN reference, Apps Script deployments table, manifest changelog)
- Modified: `switchable/site/docs/funded-funnel-architecture.md` (Last updated, lead payload schema v1.1, by-form-shape split section, 1.0 → 1.1 changelog paragraph)
- Modified: this changelog (Session 5 entry at top)
- Retired: `memory/project_courses_direct_routing_followup.md` (superseded by Session 5; index entry removed from MEMORY.md)

### Deploy sequence (owner + Claude)

Platform deploy batching per owner preference (memory `feedback_deploy_batching.md`) - everything tested locally, deploys clustered at end of session.

1. Owner applies migration 0011 via Supabase SQL editor. Verify: `\d leads.submissions` shows the new columns.
2. Owner applies migration 0012. Verify: `\d crm.providers` shows `cc_emails`.
3. Claude deploys `netlify-lead-router` (`supabase functions deploy netlify-lead-router --no-verify-jwt`).
4. Claude deploys `routing-confirm` (`supabase functions deploy routing-confirm --no-verify-jwt`).
5. Owner applies data-ops/007 Part 1 (WYK Digital INSERT).
6. Owner creates Courses Direct Google Sheet (headers agreed per playbook step 1) and WYK Digital Google Sheet.
7. Owner deploys Apps Script v2 on each sheet; captures Web app URLs.
8. Owner pastes sheet IDs + webhook URLs into data-ops/007 Parts 2 + 3 and applies.
9. End-to-end test per `provider-onboarding-playbook.md` step 6, once per provider.
10. Owner runs data-ops/006 inspect step for Sam; if raw_payload key names match, applies the UPDATE; optionally sets `region = 'East of England'` for id 34 ahead of Session 5.1.

### Session 5.1 (follow-up, deferred)

Scoped but not shipped today because the ONS postcode directory is ~200MB and needs an owner download + apply step:

- Migration 0013: new `reference` schema + `reference.postcodes` table.
- data-ops/008: load ONS Postcode Directory CSV (quarterly refresh cadence).
- Router update: derive `region` at capture via JOIN on `reference.postcodes` keyed by normalised postcode.
- Backfill existing rows' `region` where `postcode` is populated (one-off UPDATE).
- Optional: `(region, submitted_at DESC)` index on `leads.submissions` once Iris's regional reporting needs it.

Until Session 5.1 ships, `leads.submissions.region` stays NULL for submissions not manually backfilled. Owner can run a single-row UPDATE to set region for specific leads if a provider sheet shows the gap materially.

### Follow-up switchable/site change (not in this session)

Two items surfaced during the Session 5 review that belong in a future switchable/site session (not platform scope):

1. **Unify self-funded form hidden-input names on underscores.** `find-your-course/index.html` currently uses `start-when` and `courses-selected` (hyphens) while the rest of the preference fields use underscores. The router is tolerant to both forms as of Session 5 (`_shared/ingest.ts` reads both, `parseStringArray` splits on `,` and `|`). Aligning the form removes the ambiguity. Simulator and `matrix.json` already use underscores; form is the odd one out.
2. **Bump form `schema_version` hidden input to `"1.1"`.** Thirteen+ places in `switchable/site/deploy/template/` and generated course pages still declare `value="1.0"`. Bumping matches what the Session 5 contract documentation now says and makes the `leads.submissions.schema_version` column accurate going forward. Do this AFTER item 1 (so the bumped contract genuinely matches the underscored payload).

**Signed off:** Owner (session 2026-04-21 evening). Pre-deploy: `/ultrareview` still to run.

---

## 2026-04-21 (late afternoon) - Session 3.3: router decoupled from email, reconcile loop shipped, audit cron timeout fixed

**Type:** Edge Function rearchitecture + new Edge Function + schema migration + cron changes + shared module extraction. Substantial multi-file change; driven by a live incident (Melanie Watson, SMM course, SL-26-04-0044) where Netlify auto-disabled the outgoing webhook for the second time in two days.

**Incident summary:**

- 2026-04-21 ~11:00–15:00 UTC: Netlify recorded 6 consecutive non-2xx responses from `netlify-lead-router` and auto-disabled the site-wide outgoing webhook. Mechanism: the router `await`-ed the Brevo email send, which occasionally takes 10–30s; Netlify's webhook timeout is ~10s, so slow Brevo calls presented as webhook failures even though the DB insert had already committed. Six timeouts → auto-disable.
- 15:35 UTC: Melanie Watson completed `switchable-funded` submission on the SMM course (EMS / Andy Fay). Submission landed in Netlify's store but the webhook was disabled, so never reached `leads.submissions`. Owner noticed at ~16:10 UTC.
- Immediate response: Melanie manually pasted into Andy's sheet + PII-free provider email sent. Webhook recreated by owner after router was redeployed with the fix.
- Root-cause fix + defence-in-depth shipped as Session 3.3 (this entry).

**What shipped:**

1. **`netlify-lead-router` rearchitecture** - router now responds 200 to Netlify the instant the DB insert commits. Owner notification email moved into a post-response background task via `EdgeRuntime.waitUntil()`. Netlify no longer waits on Brevo; a slow Brevo call can no longer degrade the webhook response.
2. **`_shared/brevo.ts` hard timeout** - all Brevo calls now use an `AbortSignal` with a 5s cap. Prior behaviour: no timeout, a slow Brevo response could hold the caller for the full 25s Edge Function budget.
3. **`_shared/ingest.ts` extracted** - single-source-of-truth module for `normaliseAndOverride()` + `insertSubmission()`. Both the router and the new reconcile function import it. Prevents drift between the webhook fast path and the reconcile safety net.
4. **Migration 0010** - unique partial index `leads_submissions_netlify_id_uniq` on `((raw_payload->>'id'))`. Enforces idempotency: reconcile back-fills can't produce duplicates if the webhook recovers mid-gap. Verified no existing duplicates before applying.
5. **`netlify-leads-reconcile` (new Edge Function)** - hourly independent cross-check. Reads the last 24h of submissions from Netlify's REST API, back-fills anything missing into `leads.submissions` via the shared ingest pipeline, writes a `leads.dead_letter` row per back-fill with `source='reconcile_backfill'`, and emails the owner if any back-fill was needed. Webhook failure becomes observable within 60 min instead of days.
6. **`netlify-leads-reconcile-hourly` cron** - `30 * * * *` (offset from the audit cron). 10000ms HTTP timeout. Scheduled via `platform/supabase/data-ops/004_reconcile_cron_and_audit_timeout.sql`.
7. **`netlify-forms-audit-hourly` cron replaced** - the original was scheduled via Supabase dashboard UI (Session 2.5) with a 1000ms timeout. That was far below the audit function's actual response latency, so every pg_net call was aborting before the audit's response returned. Confirmed via `net._http_response`: every run from 2026-04-21 13:00 onwards shows `timed_out=true`. Rescheduled in data-ops/004 at the same cron expression but with a 10000ms timeout.

**Files:**

- `platform/supabase/functions/netlify-lead-router/index.ts` - rewritten to use shared ingest + waitUntil
- `platform/supabase/functions/_shared/brevo.ts` - added AbortSignal timeout
- `platform/supabase/functions/_shared/ingest.ts` - new file
- `platform/supabase/functions/netlify-leads-reconcile/index.ts` - new file
- `platform/supabase/migrations/0010_unique_netlify_submission_id.sql` - new migration
- `platform/supabase/data-ops/004_reconcile_cron_and_audit_timeout.sql` - new data-ops
- `platform/docs/infrastructure-manifest.md` - updated (new function row, new cron row, retired-timeout note)
- `platform/docs/data-architecture.md` - updated (unique index note in leads.submissions section; reconcile mentioned alongside router)

**§8 Impact assessment:**

1. **What does this change?** Three independent edges: (a) the router now responds 200 before Brevo completes, (b) a new hourly reconcile job back-fills any lead the webhook misses, (c) a new unique constraint enforces idempotency across both paths.
2. **What reads from `leads.submissions`?** `vw_funnel_dropoff`, `vw_attribution`, agent queries via `readonly_analytics`, Metabase (when live). None affected: the row shape is unchanged; only the insertion discipline changed (ON CONFLICT DO NOTHING on the Netlify id).
3. **What writes to `leads.submissions`?** `netlify-lead-router` (unchanged behaviour except email now async) and the new `netlify-leads-reconcile` (writes via the same shared ingest path, guaranteed identical row shape). No other writer.
4. **Does this bump a schema_version?** No. Lead payload schema stays at 1.0. The unique index is an enforcement change, not a payload change.
5. **Data migration?** None. The partial index is created over existing data with no transform; backfill is none-needed because reconcile only acts on the last 24h window.
6. **New scoped role or RLS policy?** No. `functions_writer` role unchanged; reconcile uses `SET LOCAL ROLE functions_writer` via the shared module, identical to the router.
7. **Rollback plan.** Router: redeploy prior version (git history). Reconcile: `cron.unschedule('netlify-leads-reconcile-hourly')` + optionally delete the function. Migration 0010: `DROP INDEX leads.leads_submissions_netlify_id_uniq`. Reconcile's `ON CONFLICT` still compiles without the index (no-op), so the order can be: drop index first, redeploy router/reconcile without ON CONFLICT second.
8. **Signed off:** Owner (live session 2026-04-21).

**Defence now looks like:**

- Fast path: Netlify webhook → `netlify-lead-router` → `leads.submissions` (200 returned immediately, email in background).
- Safety net: `netlify-leads-reconcile-hourly` → Netlify API → shared ingest → `leads.submissions`. Independent of the webhook. Maximum lead-loss window = 60 minutes, not infinite.
- Alerting: any reconcile back-fill emails the owner with the list of affected leads.
- Observability: audit cron no longer times out, so drift detection is functional again.

**Open item carried forward:** router's `OWNER_TEST_EMAILS` midday deploy was suspected as the regression trigger earlier in the investigation - current evidence (test submissions pre-deploy succeeded; Claire Lazar post-deploy succeeded; Melanie failed several hours after deploy) is consistent with the Brevo-timeout theory instead. No regression in that deploy found on review. Confirmation via Edge Function logs is optional since the new architecture prevents recurrence regardless.

**Curl test row (id 43):** created during verification of the refactored router + ON CONFLICT syntax. Auto-DQ'd as `owner_test_submission` (email `curltest@switchable.careers` matches `OWNER_TEST_DOMAINS`). Safe to delete but inert as-is; cleanup in a follow-up data-ops file.

---

## 2026-04-21 (midday) - Backfill Lucy routing + retroactive DQ on two owner test rows

**Type:** Data fix, three rows in `leads.submissions` + one insert into `leads.routing_log`. No schema change.

**Script:** `platform/supabase/data-ops/003_backfill_lucy_and_test_rows.sql` (one transaction, executed via `supabase db query --linked`).

**What changed:**

- **Lucy Hizmo (id 25):** `primary_routed_to` = `enterprise-made-simple`, `routed_at` = `2026-04-20 08:31:14 UTC` (submitted_at + 5 min as proxy - owner confirmed manual-email routing but could not recall exact time). Inserted matching `routing_log` row (`delivery_method='manual_email'`, `delivery_status='sent'`). 14-day presumed-enrolment clock now starts from 2026-04-20 08:31 UTC → auto-flip window 2026-05-04.
- **id 28, id 37:** retroactively set `is_dq=true`, `dq_reason='owner_test_submission'`, `provider_ids='{}'`, `archived_at=now()`. Both were owner GTM/form tests that predated the `OWNER_TEST_EMAILS` filter.

**Why this was needed:** Lucy had already been routed to EMS via an out-of-band path (per owner). DB divergence would have meant Sasha's weekly scan flagged her as un-routed and the enrolment-3 clock never fired. id 28/37 were polluting the active-lead view.

**Open investigation:** why Lucy's original routing skipped the automated `routing-confirm` transaction remains unresolved. Sibling leads id 30/31/32 on the same morning went through `sheet_webhook` cleanly. Edge Function logs for 2026-04-20 08:26–09:00 UTC need dashboard (Logflare) access to pull - not exposed via `readonly_analytics` or `supabase functions` CLI. Flag to Sasha next Monday if not resolved earlier.

**Signed off:** Owner (live session).

---

## 2026-04-21 (late morning) - Owner test filter extended to personal emails

**Type:** Edge Function logic change. No schema change.

**What changed:** `netlify-lead-router` now checks a new `OWNER_TEST_EMAILS` exact-match list alongside the existing `OWNER_TEST_DOMAINS` list. First entry: `charliemarieharris@icloud.com`. Match is case-insensitive.

**Why:** Owner GTM/form tests submitted from iCloud were landing with `is_dq=false`, leaking past the domain filter and appearing as candidate-real leads (e.g. id 28, id 37). Personal-provider domains can't be blanket-added because real learners use them.

**Impact:**
- Future submissions from `charliemarieharris@icloud.com` land with `is_dq=true`, `dq_reason='owner_test_submission'`, `provider_ids=[]`, `archived_at=now()`. Dropped from active-lead views automatically.
- Reversible: remove from list if a real person with that address starts submitting.
- No consumers to notify - `is_dq`/`archived_at` are already filter fields every view respects.

**Signed off:** Owner (live session).

---

## 2026-04-21 (morning) - First Courses Direct lead handled manually; self-funded routing architecture gap surfaced, Session 5 scoped

**Type:** Process decision + manual data handling. No schema change today. Triggers Session 5 (multi-provider self-funded routing) as the next platform build.

**What happened:**

- First self-funded lead for Courses Direct landed: submission id 34 (`SL-26-04-0034`), Sam Stevens, `saamm3194@gmail.com`, postcode PE16 6LS, 7 courses selected (animal care / grooming / psychology certificates). Owner notification email from `netlify-lead-router` fired correctly with a confirm button for `courses-direct`.
- Setting up Courses Direct's sheet + Apps Script per `memory/project_courses_direct_routing_followup.md` surfaced an architecture gap: the canonical Apps Script and `routing-confirm` are hardcoded to EMS-funded-shape fields (`la | region_scheme | age_band | employment | prior_l3 | start_date_checked`). Self-funded form fields (`reason | interest | situation | qualification | start_when | budget | postcode | courses_selected`) are not normalised into canonical columns by `netlify-lead-router` - they live only in `raw_payload`. Owner-proposed sheet headers for Courses Direct (Interest, Reason, Budget, Situation, Qualification seeking, Readiness, Region) are self-funded-shape, not EMS-shape.
- Replicating the EMS setup as-is for Courses Direct would have pushed EMS-shape fields (mostly NULL for this lead) into columns labelled for self-funded data. Wrong data, wrong columns.

**Owner decision:** Handle Sam manually today. Do NOT ship a Courses-Direct-specific patch. Ship Session 5 as a proper multi-provider architecture before the second self-funded lead.

**Manual handling applied (today):**

1. Row pasted into Courses Direct's Google Sheet with the self-funded headers (lead id, submitted at, courses selected, name, email, phone, region, Interest, Reason, Budget, Situation, Qualification seeking, Readiness, Provider, Status). Region for PE16 6LS entered as `East of England` (ONS).
2. Sheet shared with Marty (`marty@courses-direct.co.uk`) and Ranjit (`ranjit@courses-direct.co.uk`) as Editors.
3. PII-free email sent to Marty (CC Ranjit, CC Charlotte) - lead ID + sheet link + SLA reminder. Complies with `memory/feedback_provider_email_no_pii.md`.
4. Apps Script intentionally **deleted** from Courses Direct's sheet by owner as belt-and-braces: accidental confirm click would not append anything.
5. DB state set manually via one CTE block:
   ```sql
   WITH sam AS (
     UPDATE leads.submissions
        SET primary_routed_to = 'courses-direct',
            routed_at         = now(),
            updated_at        = now()
      WHERE email = 'saamm3194@gmail.com'
        AND primary_routed_to IS NULL
     RETURNING id
   )
   INSERT INTO leads.routing_log (submission_id, provider_id, route_reason, delivery_method, delivery_status)
   SELECT id, 'courses-direct', 'primary', 'manual_sheet', 'sent' FROM sam;
   ```
   `delivery_method = 'manual_sheet'` is a new value on `leads.routing_log` - no CHECK constraint on the column, so additive in practice. Session 5 will rationalise the value set.
6. Owner will NOT click the confirm button in the `routing-confirm` notification email for this lead. The manual SQL above replaces what the confirm click would have done.

**Impact assessment (per `.claude/rules/data-infrastructure.md` §8):**

1. Change: one row in `leads.submissions` and one row in `leads.routing_log` updated/inserted for a single lead. No schema change, no role change, no migration file.
2. Reads of affected tables: Sasha's Monday scan counts this as one routed lead to `courses-direct` with `delivery_method = 'manual_sheet'`. She should flag this as unusual and find this changelog entry.
3. Writes: one-off CTE executed via Supabase SQL editor, scoped by email. Idempotency guard (`AND primary_routed_to IS NULL`) means re-running is safe.
4. Schema versions: none bumped today. Payload schema version bump to 1.1 is in Session 5 scope.
5. Data migration: none.
6. New role or RLS policy: none.
7. Rollback: trivial - DELETE the `routing_log` row + NULL the `primary_routed_to` on submission 34. No reason to roll back.
8. Sign-off: Owner (2026-04-21 morning).

**Session 5 scope (agreed, not started):**

Multi-provider, multi-form-shape routing. Target: any new provider onboarded with any header preference requires zero Edge Function changes and zero new Apps Script variants - just a sheet creation and a one-line `crm.providers` update.

1. **Migration 0010:** extend `leads.submissions` with canonical self-funded / generic fields - `postcode`, `region`, `reason`, `interest`, `situation`, `qualification`, `start_when`, `budget`, `courses_selected TEXT[]`. Additive, no existing consumer breaks.
2. **Migration 0011:** extend `crm.providers` with `cc_emails TEXT[]` for per-provider notification CCs (Ranjit for Courses Direct is the first use case).
3. **Migration 0012:** new `reference` schema with a `reference.postcodes` table loaded from the ONS Postcode Directory. Local postcode → region lookup, zero external dependency, serves future Iris/Mira regional analytics. One-off data-ops load script, refreshed quarterly.
4. **`netlify-lead-router` update:** extract self-funded canonical fields from `switchable-self-funded` submissions; derive `region` via local JOIN on `reference.postcodes` at capture.
5. **`routing-confirm` update:** send a full-fat payload to the Apps Script webhook (every useful field, both shapes), pull `cc_emails` from the provider row.
6. **Apps Script v2 (canonical, single version):** reads the sheet's header row, maps each header to a known payload field via a `FIELD_MAP` alias table. Adding a provider with new header preferences = editing the sheet. Deploying a new sheet = copy the script, deploy, done.
7. **Backfill submission 34** from `raw_payload` into the new canonical columns.
8. **Lead payload schema:** bump 1.0 → 1.1 in `switchable/site/docs/funded-funnel-architecture.md` (additive change; old consumers unaffected).
9. **Retire `memory/project_courses_direct_routing_followup.md`** and replace with a generic "onboard a new provider sheet" playbook.

Estimated effort: ~3-4 hrs focused. Blocked on nothing; ready to start any time the owner chooses.

**Follow-ups (today):**

- `current-handoff.md` Next steps updated: Session 5 replaces the "Courses Direct routing replication" step 9 and becomes the next platform build of substance.
- Courses Direct sheet permissions stay as-is (Editor for Marty and Ranjit). Re-deploying the Apps Script to it is a Session 5 task, not manual.

---

## 2026-04-20 (late morning) - EMS provider notifications silently failing: `contact_email` was a placeholder; owner-CC code never deployed

**Type:** Incident + data fix + deploy catch-up. No schema change.

**What happened:**

- Owner flagged that no CC of Andy's notification emails was arriving in her inbox, meaning she could not verify Andy was receiving them at all.
- Investigation found two root causes stacked on each other:
  1. The owner-CC code added mid-Session 3 (`routing-confirm/index.ts:332-338`) was written to source but never redeployed. Flagged explicitly at the top of Next steps in `current-handoff.md` but not yet actioned.
  2. More importantly, `crm.providers.contact_email` for `enterprise-made-simple` was the literal placeholder string `<ANDY_EMAIL>`, not Andy's real address. The Session 3 post-test cleanup restored the column to a placeholder rather than the real value. Every provider notification since automation went live had been sent to that bogus address and silently rejected by Brevo (the function logs `console.error` but routing still persists; `leads.routing_log.delivery_status` = `'sent'` reflects sheet-append success, not email delivery).
- Brevo tracking confirmed: zero transactional sends to any `enterprisemadesimple.co.uk` address in the relevant window. Real leads affected (no email, sheet rows present): submission 31 (Jade, 10:08), submission 32 (Claire, 14:01).

**Fix:**

1. Redeployed `routing-confirm` with `--no-verify-jwt` (CC-owner code now live).
2. Owner ran:
   ```sql
   UPDATE crm.providers
      SET contact_email = 'andy.fay@enterprisemadesimple.co.uk', updated_at = now()
    WHERE provider_id = 'enterprise-made-simple';
   ```
   Verified via `readonly_analytics` MCP. `updated_at = 2026-04-20T14:11:18Z`.
3. No backfill email to Andy - owner confirmed Andy is already aware of the affected leads via other channels.

**Impact assessment (per .claude/rules/data-infrastructure.md §8):**

1. Change: (a) Edge Function redeploy (code already in git; source of truth unchanged), (b) one-row UPDATE on `crm.providers.contact_email`. No schema change, no role change, no migration file (data fix, rule §2 "data fixes still log").
2. Reads of affected tables: every read of `crm.providers` now returns the correct email. Sasha's Monday scan, the `routing-confirm` function, and any future dashboard view benefit equally.
3. Writes: UPDATE executed as owner via Supabase SQL editor. Not reproducible as a migration (one-off correction of a production data error).
4. Schema versions: none bumped.
5. Data migration: none - single-row fix.
6. New role or RLS policy: none.
7. Rollback: trivial - `UPDATE crm.providers SET contact_email = '<previous value>' WHERE provider_id = 'enterprise-made-simple';` No reason to roll back.
8. Sign-off: Owner (session 2026-04-20 late morning).

**Follow-ups (process):**

- `routing-confirm` does not update `leads.routing_log.delivery_status` based on Brevo's actual response. Today "sent" means "function wrote the row and tried to send"; it does not mean "Brevo accepted" or "provider received". Candidate improvement: write Brevo's returned `messageId` + HTTP status into a new column on `leads.routing_log` so Sasha's weekly scan can flag failed provider emails without needing a separate Brevo log check. Not fixed today - adds a migration.
- Handoffs that mark a cleanup as "restored to real value" should paste the actual value in the entry OR link to the source record, to prevent a placeholder round-tripping into production.
- Before the next end-to-end test that swaps production data: script the swap + restore as a repeatable data-ops file, not an ad-hoc UPDATE, so the restore cannot land a typo.

---

## 2026-04-20 (Session 3) - Owner confirm-link routing automation shipped (Brevo + Apps Script)

**Type:** Schema additive (migration 0009) + data seed (data-ops 002) + new Edge Function + extension to existing Edge Function + two new external tool dependencies + four new Edge Function secrets.

**What shipped:**

1. **Migration 0009 - add `crm.providers.sheet_id` + `sheet_webhook_url`.** Two nullable TEXT columns. Populated for EMS by data-ops/002; NULL for Courses Direct until their sheet is created. NULL on `sheet_webhook_url` means "skip sheet append for this provider". Schema-only per `.claude/rules/data-infrastructure.md` §3.

2. **data-ops/002 - seed EMS's sheet_id and webhook URL.** Sheet ID `1ABX9p_5OQUS3kLD1ztvFYSccozoTOmt7RiiDBg4IOuU`. Web app URL from the Apps Script deployment. Courses Direct left NULL per memory `project_courses_direct_routing_followup.md`.

3. **New Edge Function `routing-confirm`** at `platform/supabase/functions/routing-confirm/`. One-click handler for confirm links embedded in the owner notification email. Verifies HMAC-signed token (14-day TTL) → inserts `leads.routing_log` + updates `leads.submissions.primary_routed_to` + `routed_at` under `functions_writer` role → POSTs the lead row to the provider's Apps Script webhook → on success sends a PII-free provider notification email via Brevo. On sheet-append failure: writes `leads.dead_letter` (source=`edge_function_sheet_append`) and sends the owner a paste-manually email. Deployed with `--no-verify-jwt` (auth is the signed token in the query string).

4. **Extension to `netlify-lead-router`.** After a non-DQ insert with non-empty `provider_ids`, composes a rich owner notification email via Brevo containing all lead fields plus one signed confirm button per candidate provider. Errors are logged but never fail the webhook response (Netlify must not retry a successful insert).

5. **New shared code folder `platform/supabase/functions/_shared/`:**
   - `routing-token.ts` - HMAC-SHA256 sign + verify for confirm-link tokens, base64url encoded, constant-time signature compare
   - `brevo.ts` - Brevo transactional send helper, stripped-HTML textContent fallback

6. **New canonical Apps Script reference** at `platform/apps-scripts/provider-sheet-appender.gs`. Deployed on each provider's sheet as a Web app (Execute as owner, Who has access Anyone). Accepts POST with `SHEETS_APPEND_TOKEN` verification in the body (web apps strip custom headers). One shared token across all provider deployments; rotated annually.

7. **Four new Edge Function secrets:**
   - `BREVO_API_KEY` - transactional send
   - `BREVO_SENDER_EMAIL` - verified From address, currently `charlotte@switchleads.co.uk`
   - `SHEETS_APPEND_TOKEN` - shared with each provider's deployed Apps Script
   - `ROUTING_CONFIRM_SHARED_SECRET` - HMAC signing key
   All registered in `platform/docs/secrets-rotation.md` with annual rotation cadence.

**Scope:** platform only (no changes to switchable/site or switchleads/site). Lead payload schema version unchanged - the internal DB gains optional columns only.

**Impact assessment (per .claude/rules/data-infrastructure.md §8):**

1. Change: additive schema (two nullable columns on `crm.providers`), one new Edge Function, one modified Edge Function, two new external dependencies (Brevo, Google Apps Script), four new secrets. No data transformation.
2. Reads of affected tables: existing consumers (Sasha, Metabase when it lands, agents via `readonly_analytics`) unaffected - new columns are nullable and existing queries don't reference them.
3. Writes: the two Edge Functions under `functions_writer` role only. `functions_writer` already had INSERT on `leads.routing_log` and UPDATE on `leads.submissions` - no role change needed. `functions_writer` does NOT have UPDATE on `crm.providers`; the data-ops seed ran as owner.
4. Schema version bump: none. Lead payload contract unchanged.
5. Data migration: none. Existing `crm.providers` rows get NULL on the new columns; EMS seeded via UPDATE in data-ops/002.
6. Rollback: drop the two columns (migration DOWN), unbind `routing-confirm` (`supabase functions delete routing-confirm`), revert `netlify-lead-router` to prior git SHA. No data loss - leads continue to land in `leads.submissions` regardless. Sheet rows already appended stay; routing_log rows already written stay.
7. New RLS policies: none (no new tables; existing policies cover the added columns via CREATE POLICY ALL pattern).
8. Signed off: owner (session 2026-04-20, real-time end-to-end test pass).

**Bugs caught and fixed during the session:**

- **`--no-verify-jwt` regression.** First deploy of `netlify-lead-router` didn't carry the flag, Supabase re-enabled JWT verification by default, Netlify webhook hit 401s, submissions silently didn't land. Root cause: each `supabase functions deploy` call resets the flag. Fix: always pass `--no-verify-jwt` for webhook-invoked functions. Mitigation for future: Sasha's manifest verification should check `verify_jwt` state per function.
- **Netlify webhook auto-pause.** After enough 401s during the JWT-on window, Netlify silently stopped firing the webhook. UI still showed "enabled". Fix: delete + re-add the notification in Netlify → Site configuration. Captured as a known failure mode in the handoff.
- **postgres.js BIGINT → string coercion.** `insertedId` returned from `RETURNING id` is a string (postgres.js default, to preserve precision on INT8). Was passed to `signRoutingToken` typed as `number`; JSON payload encoded `submission_id` as a string; verifier's `typeof … !== "number"` check rejected tokens as "malformed". Fix: explicit `Number(submissionIdRaw)` coercion at the top of `notifyOwnerOfRoutableLead`. Safe for our id range (pilot ids are 2-3 digits; way under 2^53).
- **Apps Script redirect handling.** Initial implementation manually followed 302 with POST-preserve-method, which hit `script.googleusercontent.com/macros/echo` - an endpoint that only accepts GET, so returned 405 and looked like the whole append had failed. Root cause: Apps Script `/exec` processes the POST body on the initial call and returns 302 pointing at a separate GET-only endpoint that serves the response. Fix: let Deno's default `redirect: "follow"` do its thing (POST→GET conversion is exactly the expected flow here).
- **Misleading error page.** `routing-confirm` collapsed `bad_signature` and `malformed` token errors into one HTML message ("invalid, tampered, or rotated"), which masked the real BIGINT-coercion bug. Kept as-is for now; cosmetic fix deferred.

**Test evidence (2026-04-20):** Test Lead submitted at switchable.org.uk/funded/counselling-skills-tees-valley/ → row landed in `leads.submissions` → rich Brevo email arrived at `charlotte@switchleads.co.uk` with a "Confirm → Enterprise Made Simple" button → click routed lead, appended to EMS sheet, fired PII-free provider notification email. End-to-end verified.

**Cleanup after test:**
- EMS `contact_email` had been temporarily swapped to `charliemarieharris@icloud.com` during testing and restored to Andy's real email via UPDATE in-session.
- Test rows (submission ids 24, 26, 27, 28, 29, and the final successful test row) archived with `is_dq=true`, `dq_reason IN ('post_deploy_end_to_end_test', 'curl_direct_test')`, `archived_at=now()`. They drop out of active-lead views automatically.
- Test rows manually deleted from the EMS Google Sheet.

**Transcript hygiene - secrets to rotate:**
The session transcript contains plaintext values for `BREVO_API_KEY`, `SHEETS_APPEND_TOKEN`, and two iterations of `ROUTING_CONFIRM_SHARED_SECRET`. All four are production Edge Function secrets. Blast radius is small per secret (email send only; sheet write only; confirm-link signing only) but hygiene requires rotation. Flagged in `platform/docs/secrets-rotation.md` with target rotation date next platform session.

**Files added / changed:**
- Added: `platform/supabase/migrations/0009_add_provider_sheet_refs.sql`
- Added: `platform/supabase/data-ops/002_provider_sheet_info.sql`
- Added: `platform/supabase/functions/_shared/routing-token.ts`
- Added: `platform/supabase/functions/_shared/brevo.ts`
- Added: `platform/supabase/functions/routing-confirm/index.ts`
- Added: `platform/supabase/functions/routing-confirm/README.md`
- Added: `platform/apps-scripts/provider-sheet-appender.gs`
- Added: `platform/docs/session-3-scope.md`
- Modified: `platform/supabase/functions/netlify-lead-router/index.ts` (imports + notifyOwnerOfRoutableLead path)
- Updated: `platform/docs/data-architecture.md` (new columns documented)
- Updated: `platform/docs/infrastructure-manifest.md` (routing-confirm entry, new secrets, Brevo dep, Apps Script dep)
- Updated: `platform/docs/secrets-rotation.md` (four new rows)
- Updated: `master-plan.md` (Brevo: setup pending → live)
- Updated: this changelog
- Notion: Tech Stack updated with Brevo + Google Apps Script entries

**Signed off:** Owner (session 2026-04-20, real-time test passed).

---

## 2026-04-19 (Session 2.5) - INCIDENT: Netlify outgoing webhook disabled, one lead lost + back-filled; governance hardening shipped

**Type:** Production incident + data migration (manual back-fill of one lead) + migration 0006 + two new governance documents. Additive only.

**What happened:**
- ~15:29 UTC on 2026-04-19, a real lead ("Katy", counselling-skills-tees-valley, Darlington, 24+, FCFJ, non-DQ) submitted via switchable.org.uk's `switchable-funded` form.
- The submission reached Netlify's form inbox but did NOT reach `leads.submissions`. `leads.dead_letter` was empty - the Edge Function never ran.
- Root cause: the site-wide Netlify outgoing webhook (`Any form → https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-lead-router`) was **disabled**. When or how it became disabled is unknown - owner confirmed they did not knowingly disable it. Netlify retains form submissions locally but does not retry disabled outbound webhooks.
- Diagnosed during the platform session when owner reported a Netlify submission email with no corresponding DB row. Owner re-enabled the webhook; two subsequent test submissions (ids 12, 13) landed cleanly, confirming the pipe itself was healthy.

**Why no safety net caught it:**
- The daily `netlify-forms-audit` cron *did* exist in pg_cron (SQL-scheduled somewhere in Session 2). But it had never successfully run - every invocation returned 401 Unauthorized because the cron's `x-audit-key` header carried the OLD `AUDIT_SHARED_SECRET` while the Edge Function held the NEW one (this is the mismatch flagged as open item #4 in the Session 2 handoff, "Rotate AUDIT_SHARED_SECRET"). Because the HTTP call failed at auth, no rows were written to `leads.dead_letter`, so the "audit running but finding nothing" state was indistinguishable from "audit never finding anything".
- Owner could not see the daily cron in the Supabase Dashboard UI - the Dashboard's Cron Jobs page appears to only list jobs created through that UI; SQL-scheduled jobs are invisible there. This led to owner correctly reporting "there is no cron job" while a broken one existed in pg_cron.
- Sasha's Monday scan was supposed to verify cron presence. But (a) the first Monday had not yet occurred, and (b) `readonly_analytics` had no read access to the `cron` schema - so even once Sasha ran, the check would have silently failed.
- Net effect: a critical piece of infrastructure (the webhook) had a runtime monitor that was silently broken, AND no weekly verifier capable of detecting either the broken monitor or the disabled webhook.

**Change summary:**
1. **Manual back-fill of Katy** - SQL-INSERTed into `leads.submissions` (id 11) from the Netlify email content, with `raw_payload` marked `source=manual_backfill, reason=netlify_webhook_disabled`. Routed to EMS via the shared Google Sheet the same pattern as Susan (id 7) and Lesley (id 10). Routing logged in `leads.routing_log` (id 3). Provider-facing reference: `SL-26-04-0011`.
2. **`netlify-forms-audit-hourly` cron created** (Supabase Dashboard UI → Database → Cron Jobs; HTTP Request type; schedule `0 * * * *`; header `x-audit-key` with fresh `AUDIT_SHARED_SECRET`). Triggered `Run now`; returned `status: clean`. Closes the "no scheduled audit" gap and the maximum drift window drops from "forever" to 60 minutes.
3. **`AUDIT_SHARED_SECRET` rotated** during cron creation. Old value had a known mismatch per Session 2 open items; regenerated with `openssl rand -hex 32`, updated in Edge Functions → Manage secrets AND in the cron job's header.
4. **Migration 0006 - grant `readonly_analytics` SELECT on `cron.job` and `cron.job_run_details`** - so Sasha (and any future agent with `readonly_analytics`) can actually verify cron state as her Monday scan requires.
5. **New file: `platform/docs/infrastructure-manifest.md`** - living checklist of every piece of critical production infrastructure (Edge Functions, cron jobs, Netlify webhooks, Edge Function secrets, Postgres roles, RLS state, allowlist, backups). Every critical row has a verification command. Intended for session-start verification AND Sasha's Monday scan, closing the "silent drift" gap that allowed today's incident.
6. **New file: `platform/docs/secrets-rotation.md`** - tracker of every production secret with `Last rotated` and `Next due` dates. Fills the gap where `platform/CLAUDE.md` referred to a rotation tracker that did not exist as a file. `AUDIT_SHARED_SECRET` marked rotated 2026-04-19.

**Scope:** platform only. No changes to switchable/site or switchleads/site. No schema_version bump required (no data contract changed).

**Impact assessment (per data-infrastructure.md §8):**
1. Back-fill inserted one row into `leads.submissions` and one into `leads.routing_log`. `raw_payload` explicitly annotated so future readers know the row did not flow through the normal pipe.
2. Migration 0006 is additive - grants SELECT on cron metadata to a role that already reads every business table. Nothing is exposed that a postgres user couldn't already see.
3. No existing consumer affected. Sasha can now run the cron verification queries the CLAUDE.md spec already describes. Mira's Monday audit gains a valid data path.
4. No data transformation. No dual-write. No schema_version bump.
5. Rollback for the migration is trivial (REVOKEs documented in DOWN block). Rollback for the back-filled row is `DELETE FROM leads.routing_log WHERE id = 3; DELETE FROM leads.submissions WHERE id = 11;` - but doing so loses a real lead, do not rollback absent cause.
6. No RLS change. Existing policies unchanged.
7. Owner signed off in-session.

**Files changed:**
- Added: `platform/supabase/migrations/0006_grant_analytics_cron_read.sql`
- Added: `platform/docs/infrastructure-manifest.md`
- Added: `platform/docs/secrets-rotation.md`
- Updated: this changelog
- Manual SQL: one INSERT into `leads.submissions` (id 11, Katy), one INSERT into `leads.routing_log` (id 3), one UPDATE on `leads.submissions.primary_routed_to` + `routed_at` for id 11
- Supabase Dashboard: created cron job `netlify-forms-audit-hourly`; rotated `AUDIT_SHARED_SECRET` in Edge Functions secrets

**Remaining to close this incident (tracked as follow-ups):**
- Apply migration 0006 in Supabase SQL Editor (owner action)
- Verify with `SELECT * FROM cron.job` as `readonly_analytics` after migration applied
- Add "verify infrastructure-manifest.md critical rows" to `.claude/skills/prime-project/SKILL.md` as a session-start step when opened in `platform/`
- Extend `netlify-forms-audit` function to ALSO alert by email (not just write to `dead_letter`) - depends on Session 3 transactional email provider pick
- Investigate how/why the webhook was disabled in the first place (Netlify audit log if available)
- Re-verify all three critical Edge Functions are deployed AND reachable - do this before end of every platform session
- The handoff accuracy failure itself is a process issue - future handoffs should distinguish "shipped" (deployed + verified reaching production state) from "scoped" (designed but not yet operational). Surfaced to owner as a governance recommendation.

**Signed off:** Owner (session 2026-04-19, real-time)

**Lesson:** any critical piece of production infrastructure that lives in a UI (webhook config, cron schedule, secret) with no git-backed definition and no automated verifier is invisible drift waiting to happen. The fix is the manifest + session-start verifier + hourly audit - not more code.

---

## 2026-04-19 (Session 2.5 continuation) - Owner-test auto-flag in `netlify-lead-router`

**Type:** Edge Function change + retroactive data cleanup. Additive only - existing real-lead flow unchanged.

**What changed:**
Added an owner-test auto-flag to `netlify-lead-router`. On every submission, the function now checks the email's domain against an `OWNER_TEST_DOMAINS` list. If matched, the row is inserted with `is_dq=true`, `dq_reason='owner_test_submission'`, `archived_at=now()`, and an empty `provider_ids`. Real leads unaffected.

**Domain list** (exact-match, lowercased, owner decision 2026-04-19):
- `switchable.org.uk`
- `switchable.careers`
- `switchable.com`
- `switchleads.co.uk`

**Why:**
Charlotte was manually archiving every test submission after the fact (five rows in one day during Session 2.5 alone). The auto-flag removes that toil, guarantees consistent classification, and prevents test submissions from ever being routable to providers. Applied server-side rather than client-side for robustness - client JS could be bypassed, domain check in the Edge Function cannot.

**Files changed:**
- Updated: `platform/supabase/functions/netlify-lead-router/index.ts` - added `OWNER_TEST_DOMAINS` constant, `isOwnerTestEmail()` + `applyOwnerTestOverrides()` helpers, `archived_at` column to CanonicalSubmission + INSERT

**Retroactive cleanup:**
Two existing rows matched the pattern and were not yet archived:
- id 6 (`hello@switchable.careers`, 2026-04-19 09:18 UTC) - was DQ'd as `age_below_min` from the form's client-side gate. Reclassified as owner test. The raw_payload retains the age data for gate analysis.
- id 16 (`hello@switchable.org.uk`, 2026-04-19 19:08 UTC) - fresh test submitted by Charlotte while planning the auto-flag work. Flagged per same rule.

Both updated via a single in-session UPDATE: `is_dq=true, dq_reason='owner_test_submission', archived_at=now(), provider_ids='{}'`.

**Schema_version note:** no bump. The data contract (form payload) did not change - the flag is derived from an existing field (email).

**Impact assessment (per data-infrastructure.md §8):**
1. New behaviour in `netlify-lead-router` only. No other consumer affected.
2. Real leads (non-owner domains) flow identically. Tests that previously landed as real leads + required manual cleanup now land pre-archived.
3. `archived_at` is already in the schema - the INSERT adds it to the column list but no migration needed.
4. No RLS change. No new role. No new secret.
5. Rollback: revert the Edge Function code and redeploy. No data migration to undo.
6. Owner signed off in-session.

**Deploy:**
`supabase functions deploy netlify-lead-router --no-verify-jwt` (owner action from local CLI).

**Signed off:** Owner (session 2026-04-19, real-time).

---

## 2026-04-19 Partial submissions capture - `leads.partials` + `netlify-partial-capture`

**Type:** Schema additions (migrations 0004 + 0005) + new Edge Function + client tracker + `netlify-lead-router` update. Additive only; no existing behaviour removed.

**Goal:** track drop-off on the Switchable multi-step forms (`switchable-self-funded`, `switchable-funded`) to identify where learners abandon and which traffic sources / answer patterns correlate with drop-off. Powers Iris's ad optimisation and Mira's weekly KPI narrative.

**Change summary:**
- **Migration 0004** - `leads.partials` table (session_id UUID UNIQUE, form_name, step_reached, answers JSONB, utm_*, device_type, is_complete, upsert_count, timestamps). RLS on; `functions_writer` ALL, `readonly_analytics` SELECT. `pg_cron` job `purge-stale-partials` runs 03:00 UTC daily, deletes incomplete rows older than 90 days.
- **Migration 0005** - `leads.submissions.session_id` UUID nullable + partial index; `public.vw_funnel_dropoff` view joining partials→submissions on session_id for funnel-to-conversion analysis.
- **New Edge Function** `netlify-partial-capture` - called directly from the browser (not via Netlify Forms webhook). Upserts `leads.partials` with `ON CONFLICT (session_id) DO UPDATE SET step_reached = GREATEST(...)` to prevent out-of-order races regressing step. Rate-limited at 50 upserts per session via `upsert_count` column. CORS enabled. Dead-letter on failure with `source='edge_function_partial_capture'`.
- **`netlify-lead-router` updated** - reads `session_id` hidden field, writes to `leads.submissions.session_id`, and flips `leads.partials.is_complete = true` on matching session in the same transaction. No-op if no matching partial exists.
- **Client tracker** `switchable/site/deploy/deploy/js/partial-tracker.js` - generates UUID into sessionStorage, syncs to hidden `session_id` input, captures utm_* and device_type, debounced 500ms, `keepalive: true` fetch so the final step survives navigation.
- **Form wiring** - `find-your-course/index.html` (switchable-self-funded, 8 steps) + `template/funded-course.html` (switchable-funded, variable steps based on `qualifier_steps`) both include tracker + hidden session_id + trackPartial hooks in `goTo` / `showStep` / `showGateway` / `showHolding` / `skipCourses`.

**Scope:** only the two multi-step forms. Waitlist and enrichment skipped - short forms, low drop-off value.

**GDPR posture:** session_id is a random UUID not tied to identity. `answers` column is non-PII (preference data: reason, interest, budget, etc.) - PII stays on `leads.submissions` after final submit. Belt-and-braces: the Edge Function blocks `first_name/last_name/email/phone/address/postcode/dob` keys from the answers object. `user_agent + fbclid` together are quasi-identifying in aggregate, hence the 90-day purge on incomplete rows. No consent message required - sessionStorage is functional-necessary, no PII is processed pre-submit.

**Impact assessment (per data-infrastructure.md §8):**
1. New table + nullable column + new view + new Edge Function. No existing column changed or removed.
2. Readers: `readonly_analytics` gains `leads.partials` and `public.vw_funnel_dropoff`. Existing queries unaffected.
3. Writers: `functions_writer` gets new grants on `leads.partials`. `netlify-partial-capture` + `netlify-lead-router` write to the new surface.
4. Schema_version: form payload contract adds one optional hidden field (`session_id`). Additive per `.claude/rules/schema-versioning.md` - no version bump required. Funded funnel payload stays v1.0.
5. Data migration: none.
6. New role / policy: none. Two new RLS policies scoped to existing roles.
7. Rollback: DOWN blocks in both migrations; trivial since no downstream consumer depends on new surfaces yet.
8. Sign-off: Owner (session 2026-04-19). Mira architectural review APPROVE-WITH-CHANGES - all seven recommendations adopted (split migrations, UTM column comments, view shipped alongside, 90-day purge, GREATEST upsert, rate-limit, scope confirmed).

**Owner to action after these files land:**
1. Apply migration `0004_add_leads_partials.sql` in Supabase SQL editor. Verify pg_cron is enabled on the project (Supabase Pro: on by default; free tier: enable via Database → Extensions).
2. Apply migration `0005_add_submissions_session_id.sql`.
3. Deploy the new Edge Function: `cd platform && supabase functions deploy netlify-partial-capture --no-verify-jwt`.
4. Redeploy the updated `netlify-lead-router`: `cd platform && supabase functions deploy netlify-lead-router --no-verify-jwt`.
5. `git push` the Switchable site changes (Netlify auto-deploys from GitHub).
6. End-to-end test: open `/find-your-course/`, step through to step 3, reload (don't submit). Verify a row in `leads.partials` with `step_reached=3`, `is_complete=false`. Then submit a test lead via a generated funded page - verify the matching row flips to `is_complete=true` and `leads.submissions` has the matching `session_id`.

**New forms introduced?** No. `netlify-partial-capture` is not a Netlify form - it's called directly by the browser via fetch. `form-allowlist.json` unchanged.

**Signed off:** Owner (session 2026-04-19), Mira architectural (session 2026-04-19).

---

## 2026-04-19 `netlify-lead-router` handles `switchable-waitlist-enrichment`

**Type:** Edge Function update (additive branch, no schema change, no migration).

**Change:** Added an explicit branch in `platform/supabase/functions/netlify-lead-router/index.ts` for `switchable-waitlist-enrichment`. Enrichment rows land in `leads.submissions` with `is_dq=true` and `dq_reason='waitlist_enrichment'` (distinguishable from the original waitlist row whose `dq_reason='waitlist'`). The `email` column is populated from `data.email` OR `data.ref_token` so the link back to the original row works regardless of which field the form sends. `ref_token` and `source_form` stay in `raw_payload` for audit.

**Why:** New form `switchable-waitlist-enrichment` shipped from switchable/site (commit 4bfe359) and added to `deploy/data/form-allowlist.json`. Without an explicit branch, enrichment submissions would have landed with `dq_reason='unknown_form:switchable-waitlist-enrichment'`. Functional but noisy, and obscures the intent.

**Link pattern for downstream readers:** to find enrichment rows for a given waitlist learner, query by email across both `dq_reason` values:

```sql
SELECT * FROM leads.submissions
WHERE email = :learner_email
AND dq_reason IN ('waitlist', 'waitlist_enrichment')
ORDER BY submitted_at;
```

Original waitlist row plus any subsequent enrichment rows come back in order.

**Webhook wiring:** none needed. The site-wide "Any form" Netlify webhook already captures this form (set up in Session 2). Allowlist entry in `switchable/site/deploy/deploy/data/form-allowlist.json` points at the same `netlify-lead-router` URL.

**Owner still to action:**
1. Run the platform audit to confirm clean state (command below).
2. Submit one enrichment form end-to-end to verify a row lands with the correct `dq_reason` and email linkage.

**Signed off:** Owner (delegated via cross-project handoff, 2026-04-19).

---

## 2026-04-19 First real learner lead captured + Sasha platform agent activated

**Type:** Milestone + infrastructure (agent addition). No schema change.

**Milestone:** First real learner lead landed via the new funnel. `leads.submissions` row id 7, submitted 12:11 UTC 2026-04-19. Susan Waldby, Stockton-on-Tees, 24+, unemployed, no prior Level 3, Counselling Skills Tees Valley, funded route (Free Courses for Jobs), provider = enterprise-made-simple. Fully eligible. Terms accepted, marketing opt-in true. £6 paid for this lead (well below the £10 historic benchmark). Routing (`primary_routed_to`, `routed_at`) null because `routing-confirm` endpoint not yet built; interim manual forward to Andy via a Google Sheet.

**Observed gaps (non-blocking for first forward, address in Session 3):**
- `fbclid` arrived in the `referrer` URL but was not extracted into the `fbclid` column. Function is not pulling the query string apart.
- `utm_source` / `utm_medium` / `utm_campaign` / `utm_content` all null. Either the ad URL is missing utm params, or the function is not extracting them from the referrer. Both need checking before more ad spend flows.
- `primary_routed_to` / `routed_at` unpopulated because manual routing is not yet closing the loop. `routing-confirm` endpoint (Session 3) closes this.

**Infrastructure change, Sasha agent activated:**
- Config added to `platform/CLAUDE.md` as "Sasha, Platform Steward" (read-only via `readonly_analytics`, Monday task writes to `platform/weekly-notes.md`).
- Roster row + Monday sequence entry added to `agents/CLAUDE.md` (8th in order, before Mira).
- Master plan row added.
- `strategy/CLAUDE.md` inputs list extended to include `platform/weekly-notes.md` (Mira consumes it).
- Top-level `CLAUDE.md` Monday session-start block and `.claude/skills/prime-project/SKILL.md` updated to name Sasha (prime-project was also missing Nell, fixed inline).

**Sasha scope (pilot):**
- Weekly: read `leads.dead_letter`, `cron.job`, `leads.submissions` volume, Edge Function inventory; check migration drift vs changelog; check secrets rotation tracker; check growth triggers.
- Per-session: surface new leads + new dead_letter rows in last 24h, any unrouted lead older than 48h.
- No DB write access. Flags only. Owner implements.

**Why Sasha now, not at "Metabase dashboards live":** the daily `netlify-forms-audit` cron is already producing `leads.dead_letter` rows that nobody reads on a schedule, and the first real lead just landed. Monitoring surfaces exist; they need a steward.

**Signed off:** Owner (session 2026-04-19, in-session approval).

---

## 2026-04-19 (Session 2 close) - Second Edge Function `netlify-forms-audit` + single form-name design + allowlist SSOT

**Type:** Reliability / defensive monitoring (no schema change). Extends the lead-routing pipe delivered on 2026-04-18 with prevention and detection against silent drift.

**Why this exists:** Charlotte spotted that the lead-routing design assumed a webhook per Netlify form, which (a) required manual webhook-wiring every time a new course page was added, and (b) had no mechanism to catch a webhook that was accidentally deleted or misconfigured after initial setup. Both are silent-lead-loss risks. Patching later was not acceptable - the audit sits at the foundation of the routing layer's trust.

**Change set:**

1. **Template form name drift fixed** (done in the parallel switchable/site session): `deploy/template/funded-course.html` now emits a single form name `switchable-funded` for all funded courses. Course identified via the pre-existing hidden `course_id` field. Restores original intent of `switchable/site/docs/funded-funnel-architecture.md` capture-layer section.
2. **Single source of truth for allowed form names**: `switchable/site/deploy/data/form-allowlist.json` (v1.0) lists every live Netlify form name with its expected webhook URL and purpose. Deployed at `https://switchable.org.uk/data/form-allowlist.json` (public) so the platform audit can fetch it over HTTPS.
3. **Build-time allowlist enforcement** in `switchable/site/deploy/scripts/audit-site.js`: `npm run build` fails as `critical` if HTML introduces a form name not in the allowlist.
4. **Hard checklist in switchable/site/CLAUDE.md** for introducing or removing a form name. Owner approval → allowlist entry → Netlify webhook wiring → manual audit trigger → changelog entry → THEN code change. `npm run build` blocks if skipped.
5. **Platform Edge Function `netlify-forms-audit` deployed**. Fetches allowlist over HTTPS, queries Netlify API, compares, writes any discrepancies into `leads.dead_letter` with `source = 'netlify_audit'`. Auth via shared-secret header (`x-audit-key`). Runs daily via Supabase Cron (owner to schedule after setting secrets).
6. **Platform Edge Function `netlify-lead-router` updated** to prefer `course_id` from payload's hidden field (the new single-form-name path). Retains slug-parsing fallback for legacy `switchable-funded-<slug>` form names to stay resilient during the transition (remove fallback next cleanup pass once the allowlist check confirms no legacy names live).

**Files added/changed this session:**
- Added: `platform/supabase/functions/netlify-forms-audit/index.ts`
- Added: `platform/supabase/functions/netlify-forms-audit/README.md`
- Updated: `platform/supabase/functions/netlify-lead-router/index.ts` (funded branch prefers hidden `course_id`)
- (in switchable/site session): `deploy/data/form-allowlist.json` (new), `deploy/scripts/audit-site.js` (new check), `deploy/template/funded-course.html` (form name fix), `docs/CHANGELOG.md` (entry), `CLAUDE.md` (hard-wiring rule)

**Owner actions pending before routing layer is fully trusted:**

1. Netlify Personal Access Token generated + saved.
2. Set 3 secrets in Supabase Edge Functions: `NETLIFY_API_TOKEN`, `NETLIFY_SITE_ID`, `AUDIT_SHARED_SECRET` (any long random string). Full steps in `platform/supabase/functions/netlify-forms-audit/README.md`.
3. Schedule the audit via Supabase Cron: `0 7 * * *` (07:00 UTC daily), POST to the function URL with the `x-audit-key` header set to `AUDIT_SHARED_SECRET`.
4. Wire the 3 Netlify outgoing webhooks (`switchable-funded`, `switchable-self-funded`, `switchable-waitlist`), all pointing at `https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-lead-router`.
5. End-to-end test: submit a real form → confirm `leads.submissions` row → manually trigger audit → confirm `"status":"clean"`.
6. Negative test: delete one webhook → trigger audit → confirm `"status":"discrepancies_found"` + dead_letter row → re-add webhook.

**Signed off:** Owner (session 2026-04-19)

---

## 2026-04-18 (Session 2, final) - Migration 0002: rename `n8n_writer` → `functions_writer`, `n8n_execution_id` → `execution_id`

**Type:** Schema migration (rename only - no data change). Forward-only with trivial DOWN.

**Change:**
- `ALTER ROLE n8n_writer RENAME TO functions_writer`
- `ALTER TABLE leads.routing_log RENAME COLUMN n8n_execution_id TO execution_id`

**Why:** Names were legacy from the reversed n8n tool choice (see the "Architectural reversal" entry below). Earlier in the session I argued to defer the rename to avoid a cosmetic-only migration. That was wrong - the legacy names caused active confusion within the same session (owner asked "thought we weren't using n8n?" after seeing `n8n_writer` referenced in a dashboard setup step). The cost of ~5 minutes of migration work is trivially less than the ongoing cost of the name mismatch. This invalidates the "rename deferred" note in the reversal entry below.

**Impact:**
- No active consumers - the `n8n_writer` role had exactly one prepared user (the Edge Function `netlify-lead-router`, deployed the same session and waiting on its secret to be set). The function was redeployed in the same session reading a new simpler secret key `DATABASE_URL` (was `DATABASE_URL_N8N_WRITER`).
- Column `leads.routing_log.execution_id` is empty; rename is safe.
- `platform/supabase/README.md` credential table updated to the new role name; LastPass entry rename flagged for Charlotte (cosmetic).
- `.env.example` variable renamed to `SUPABASE_FUNCTIONS_WRITER_PASSWORD`.
- ClickUp ticket `869cytje9` - role/column rename scope marked complete inline in this session; remaining doc sweep still outstanding in the ticket.

**Files changed this session to ship the rename:**
- Added: `platform/supabase/migrations/0002_rename_n8n_legacy_names.sql`
- Updated: `platform/supabase/README.md`, `platform/supabase/.env.example`
- Updated: `platform/supabase/functions/netlify-lead-router/index.ts` (secret env var name + connection string role)
- Updated: `platform/supabase/functions/netlify-lead-router/README.md` (deployment instructions)
- Function redeployed via `supabase functions deploy netlify-lead-router --no-verify-jwt`

**Signed off:** Owner (session 2026-04-18)

**Next:** Charlotte to apply migration 0002 in Supabase SQL Editor (paste-and-run pattern, 5 lines of SQL), then set the new `DATABASE_URL` function secret with the `functions_writer` connection string.

---

## 2026-04-18 (Session 2) - Architectural reversal: n8n → Supabase Edge Functions for the data-layer routing workflow

**Type:** Architectural decision reversal (no schema change). Invokes the infrastructure change rule in `CLAUDE.md`.

**Decision:** Supabase Edge Functions (Deno/TypeScript) handles the Netlify form webhook → Supabase → owner-routed lead flow. n8n is not used for this.

**Change from:** Session 1's design named n8n (cloud tier, ~£240/year) as the workflow engine for the funded-funnel routing layer. That choice was inherited from an earlier planning decision (business.md, funded-funnel-architecture.md) without being fresh-tested against the current stack.

**Change to:** Supabase Edge Functions. In-stack with the database (no extra signup, no subscription), code versioned in git alongside migrations (same audit trail as schema changes), TypeScript/Deno runtime Claude can author natively, deploys via `supabase functions deploy`. Charlotte is not a visual-workflow-editor user - every advantage n8n has over code-based orchestration (drag-and-drop UI, non-developer editing) is unused in our case.

**Triggered by:** Charlotte asked "are you saying we don't need n8n?" when I mentioned Edge Functions in passing as an alternative. Honest re-evaluation showed Edge Functions is the better fit for this workflow; n8n was a prior-decision carryover.

**Scope of the reversal:** ONLY the data-layer workflow (Netlify forms → Supabase → owner notification). The separate **cold-email outreach pipeline** (prospect list building via Apollo + email sequencing via Instantly/Smartlead) still has n8n as a candidate tool - that decision is not re-scoped here and remains in `.claude/rules/business.md` provider-acquisition section.

**Rule reference - owner-gated routing:** A standing rule was also formalised this session: every lead captured during pilot is delivered to Charlotte, never auto-routed to a provider. Provider delivery is a manual step until explicitly enabled per-provider. The Edge Function emails Charlotte with the lead, suggested provider, and a pre-drafted forward body; Charlotte forwards manually; a confirmation endpoint writes `leads.routing_log` on her action. See `memory/feedback_owner_routes_leads.md` for the full rule.

**Docs updated this session (load-bearing):**
- `platform/CLAUDE.md` - stack section now names Supabase Edge Functions; folder structure notes `supabase/functions/`; removed the stale `n8n/` folder block
- `.claude/rules/business.md` - Lead matching section (Next / Eventual paragraphs) describes the Edge Function workflow, owner-in-the-loop rule
- `switchable/site/docs/funded-funnel-architecture.md` - routing layer diagram + "Tool" + "Scenario shape" + Phase 4 notes + scope section all rewritten to Edge Functions
- `platform/docs/data-architecture.md` - routing_log notes, dead_letter context, n8n_writer role row, open-questions cron note

**Docs NOT yet updated (tracked as a cleanup ticket):** 20 more files across the workspace (agent configs, older handoffs, rules files, backlog notes, etc.) still mention n8n in a way that needs review. Some are valid (outreach pipeline context); some need rewording. ClickUp ticket created to sweep methodically across a future session rather than racing through them now and losing nuance per file.

**Role `n8n_writer`:** legacy name retained. The role's permission set (write access to `leads.*`, `crm.enrolments` status transitions, `leads.dead_letter`) is unchanged and is still the right fit for Edge Functions. Renaming would require migration 0002 with one ALTER ROLE statement - cosmetic churn with no functional benefit while the role has no active users. Plan: rename to `functions_writer` in a future cleanup migration that batches other cosmetic fixes, not in isolation.

**Column `leads.routing_log.n8n_execution_id`:** legacy name retained. Will be populated with the Edge Function's request_id for traceback. Column rename follows the same logic as the role - batch into a future cleanup migration.

**Notion Tech Stack page (`3393628f-e4a2-8184-8824-c17962d91826`):** two entries need owner update in the Notion UI (Notion MCP update-block tool has a schema bug I couldn't work around this session):
1. Supabase entry (`3463628f-e4a2-8192-b747-ce1e9d2af605`) - change region from `eu-west-2` to `eu-west-1` (West EU / Ireland). Add a sentence: "Supabase Edge Functions (Deno/TypeScript) is the serverless layer for webhook handling and scheduled jobs; code in platform/supabase/functions/."
2. Planned entry (`3393628f-e4a2-8188-b79e-ec395e6bcb06`) - currently reads "Make.com or n8n - automation (outreach pipeline, Notion sync, lead routing)". Change to remove "lead routing" from scope: "Make.com or n8n - automation for cold-email outreach pipeline and prospect list sync (not for lead routing or DB workflows - those use Supabase Edge Functions, see Supabase entry)."

**Impact:**
- Zero running code affected (Edge Functions have not been written yet; n8n was never installed).
- Future agents reading the load-bearing docs will see the correct tool choice on first read.
- Secrets strategy (ticket `869cyrr02`) drops an n8n-specific credential requirement - one less secret to migrate.
- `platform/n8n/workflows/` folder was planned in `platform/CLAUDE.md` - now removed from the intended folder structure. No existing files affected.

**Signed off:** Owner (session 2026-04-18)

**Next:** build the first Edge Function - `netlify-lead-router` - that receives a Netlify form webhook, normalises the payload, INSERTs to `leads.submissions`, looks up the suggested provider, and emails Charlotte with the forward-ready body. Starts later this session.

---

## 2026-04-18 (Session 2 kickoff) - MCP install fixed + region correction + Supabase CLI linked

**Type:** Bug fix + documentation correction (no schema change)

**Change:**
- Postgres MCP re-registered at user scope with two corrections vs Session 1's command:
  1. DB URL now passed as a **positional CLI argument** to `@modelcontextprotocol/server-postgres`, not via `POSTGRES_URL` env var. The package requires positional; env-var form silently registered but failed at query time with "Please provide a database URL as a command-line argument."
  2. Connection string now uses the **Session Pooler** (`aws-0-eu-west-1.pooler.supabase.com:5432`) with the `<role>.<project_ref>` username format, instead of the direct host `db.<ref>.supabase.co`. Direct host is IPv6-only and unreachable from this Mac (no public IPv6 route; `getaddrinfo ENOTFOUND`).
- `platform/supabase/README.md` updated: region corrected to `eu-west-1`, project name annotated (Supabase-default name pending rename), MCP install command rewritten with the correct form, new "Connection string notes" block documenting all three traps (positional vs env, IPv6 direct, region).
- `platform/supabase/.env.example` updated: `SUPABASE_DB_URL` template now uses pooler form.
- Supabase CLI installed via Homebrew (`brew install supabase/tap/supabase`, v2.90.0), logged in, `supabase init` added `config.toml` to `platform/supabase/`, `supabase link --project-ref igvlngouxcirqhlsrhga` connected local to remote. Enables `supabase db push` / `db diff` for future migrations.

**MCP end-to-end verification (passed):**
- `SELECT count(*) FROM leads.submissions` → 0 (expected, empty table)
- `SELECT count(*) FROM public.vw_weekly_kpi` → 0 (expected)
- `INSERT INTO leads.submissions (...)` → rejected: `cannot execute INSERT in a read-only transaction`. The MCP wraps every query in a read-only transaction, so writes are blocked at the transport layer even before RLS/role permissions would kick in. Belt AND braces.
- 9 tables enumerated across 4 schemas, matching migration 0001.

**Region correction:**
Session 1's handoff and the original README both stated the project was in `eu-west-2` (London). That was wrong - the project was created in `eu-west-1` (West EU / Ireland) from the outset. eu-west-2 was a notes error, not a setup error. Every pooler permutation tested against eu-west-2 returned `XX000 Tenant or user not found` because the tenant does not exist on that region's Supavisor cluster. Session 1's handoff entry left unchanged as a historical record; README and .env.example are forward-facing and corrected. Supabase does not yet offer a London region, so eu-west-1 is the closest option for UK latency.

**Why:** Session 2 begins with the Session 1 deferred MCP verification. The verification surfaced the two bugs (env var vs positional, direct vs pooler) plus the region note error. Fixing docs before any further build prevents the same bugs being re-introduced on the other Mac or during the hosted-secrets migration.

**Impact:**
- MCP now functional on this Mac for any agent with DB read needs.
- Other Mac: when set up, will follow the corrected README - no further MCP issues expected.
- LastPass entries still reference the broken direct hostname. Owner needs to update the DB URL entries for all roles to the pooler form before migrating credentials to the hosted secrets manager.
- No schema changed. No data changed. No n8n/Metabase yet to affect.

**LastPass entries to update (owner action):**
- `Supabase - DB connection string`: direct host → `postgresql://postgres.igvlngouxcirqhlsrhga:<PASSWORD>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`
- Add/update per-role connection strings with the same pooler host + `<role>.<project_ref>` user format, for `readonly_analytics`, `n8n_writer`, and `ads_ingest`. Store alongside each role's password entry.
- Optional: rename the Supabase project in the dashboard from `charlotte@switchleads.co.uk's Project` to `Switchable Ltd` for clarity.

**Signed off:** Owner (session 2026-04-18)

**Next:** Session 2 continues - manually insert EMS + Courses Direct into `crm.providers`, create `n8n_writer` credential in n8n (using the same pooler format), build the Netlify → Supabase routing workflow.

---

## 2026-04-18 - Migration 0001 - Pilot schemas live

**Type:** Initial schema migration (forward only, empty DB)

**Change:**
- Supabase project `Switchable Ltd` provisioned (region `eu-west-2`, free tier, Postgres 15+, Data API disabled, automatic RLS on `public` enabled)
- Migration `0001_init_pilot_schemas.sql` applied via Supabase SQL editor
- 4 schemas created: `ads_switchable`, `ads_switchleads`, `leads`, `crm`
- 9 tables: `leads.submissions`, `leads.routing_log`, `leads.gateway_captures`, `leads.dead_letter`, `crm.providers`, `crm.provider_courses`, `crm.enrolments`, `crm.disputes`, `ads_switchable.meta_daily` (ads_switchleads stubbed - no tables yet)
- 2 views in `public`: `vw_attribution`, `vw_weekly_kpi` (both with `security_invoker = true`)
- 3 scoped roles: `readonly_analytics` (SELECT only), `n8n_writer` (SELECT/INSERT/UPDATE on leads.* and crm.enrolments), `ads_ingest` (SELECT/INSERT/UPDATE on ads_* schemas)
- RLS enabled on all 9 tables with 17 explicit policies (one per role per table as applicable); no policy = deny by default
- Postgres MCP `@modelcontextprotocol/server-postgres` registered at user scope on this Mac, using `readonly_analytics` credentials

**Fixes during migration:**
- `vw_weekly_kpi` initially failed with "subquery uses ungrouped column" error (correlated subqueries referenced an ungrouped column). Restructured to use CTEs. Fix mirrored in `docs/data-architecture.md`.

**Why:** Priority 1 of the platform implementation kickoff (per `docs/current-handoff.md` written 2026-04-18 morning). Stands up the foundation for closed-loop attribution. No automation wired up yet - Sessions 2-6 build the pipes.

**Impact:**
- Empty DB - no consumers yet writing data
- Postgres MCP will read `readonly_analytics` views/tables once Claude Code restarts (verification deferred to next session)
- Downstream consumers (n8n, Metabase) get wired up in Sessions 2 and 4
- No existing infrastructure affected this session - interim manual lead handling continues until Session 2 ships

**Secrets:** Service role key, 3 scoped role passwords, and DB connection string live in LastPass (folder `Supabase - Switchable Ltd`) and in a local `.env` at `~/Switchable/platform/.env` (outside iCloud). Device-scoped per the approved plan; migrates to hosted secrets manager as part of the separate "Business-wide secrets and portability strategy" ticket.

**Signed off:** Owner (session 2026-04-18)

**Next:** Session 2 - n8n Netlify → `leads.submissions` + routing email + dead-letter alerts. Urgent (EMS and Courses Direct provider ads launching today).

---

## 2026-04-18 - Platform project initialised

**Type:** Project creation + architectural decision

**Change:**
- Created `platform/` as the home for Switchable Ltd's business data layer
- Selected Supabase (managed Postgres) as the database
- Selected Metabase as interim dashboard tool; planned absorption into custom dashboard in Phase 2-3
- Designed four pilot schemas: `ads_switchable`, `ads_switchleads`, `leads`, `crm` - full design in `docs/data-architecture.md`
- Drafted `.claude/rules/data-infrastructure.md` governance rule
- Extended `.claude/rules/schema-versioning.md` with Postgres addendum
- Extended top-level `CLAUDE.md` infrastructure rule to cover DB layer and secrets
- Added Data architecture section to `.claude/rules/business.md`
- Brought Supabase storage forward from Phase 4 to now in `switchable/site/docs/funded-funnel-architecture.md`
- Retired `switchleads/crm/` placeholder in `master-plan.md` - absorbed into `platform/`
- Updated Iris's access model in `switchable/ads/CLAUDE.md`

**Why:** Sheets cannot support closed-loop attribution (ad spend → lead → enrolment → revenue). Phase 4 always committed to Postgres. Bringing it forward now avoids a migration 6-12 months into the pilot. Two providers onboarding this week means the first real data will flow into whichever storage we land on - choosing Supabase from day one preserves that data for analysis.

**Impact:**
- Funded funnel routing rewritten to write to Supabase tables
- Provider data migrates from Google Sheet to `crm.providers` (dual-write transition)
- New governance rule binds all DB changes going forward
- No infrastructure installed this session - scaffolding and design only

**Signed off:** Owner (session 2026-04-18), Mira (strategic review)

**Next action:** Next session opens `platform/` and runs Priority 1 from `docs/current-handoff.md` - Supabase account creation and first migration.