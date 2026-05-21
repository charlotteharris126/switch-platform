# Platform - Changelog

Most recent at top. Every schema change, data migration, access policy change, and significant decision logged here. See `.claude/rules/data-infrastructure.md` for entry format rules.

---

## 2026-05-21 — SMS utility Chunk 3: Trigger A (fastrack-link cron) — full SMS workstream complete

**Scope.** Final chunk of the SMS utility build. Adds Trigger A — the every-minute pg_cron that fires the fastrack-link prompt SMS to matched funded leads 10 minutes after routing if they haven't fastracked yet. With this chunk shipped, all three triggers from `switchable/email/docs/sms-utility-design.md` are live.

**What landed:**
- **Migration 0158:** `cron.schedule('sms-fastrack-prompt-cron', '* * * * *', ...)` — every-minute pg_cron POSTing to the new EF with audit-key auth. Idempotent re-schedule pattern (unschedule first if present, then schedule).
- **`sms-fastrack-prompt-cron` (new EF):** auth via `AUDIT_SHARED_SECRET`. Per minute, queries `leads.submissions` joined to `crm.enrolments` + `crm.providers` for candidates where: matched funded, `crm.enrolments.sent_to_provider_at` is 10-60 minutes ago, no `fastracked_at`, no prior `call_reminder_fastrack_link` row in `crm.sms_log`, provider has `sms_utility_enabled=true`, status `open`, has phone. LIMIT 50 per run (pilot volume nowhere near). Per-row loads full SubmissionRow + ProviderRow and calls `fireFastrackLinkSms`. Returns `{scanned, sent, skipped, failed, skipped_reasons}` summary for cron-runs visibility.
- **`_shared/sms-utility.ts`:** new `fireFastrackLinkSms(args)` helper + new `FASTRACK_LINK_BODY_TEMPLATE`. Lighter gate than B/C — no regional-rep-phone requirement (this body cites only provider company name + URL, no rep phone). Inline `buildFastrackUrlForSms` mirrors the existing `buildFastrackUrl` in route-lead.ts (intentional copy — when the shortener ships, only this callsite updates; email contexts keep the long URL).
- **`config.toml`:** `verify_jwt = false` for `sms-fastrack-prompt-cron`.

**Known shipping debt (deferred to Mable):**
- **Short URL `/f/{token}` on switchable.org.uk.** Body template uses the full fastrack URL (~150 chars) until Mable ships the shortener. Worst-case SMS render is currently ~240 chars (2 segments — 2x send cost during the interim). Acceptable for pilot volume; revisit when volume grows. Push to Mable's handoff for switchable/site work.

**Impact assessment** (per `.claude/rules/data-infrastructure.md` §8): logged in migration 0158 header. One pg_cron schedule, no DDL, no schema_version bump, single new EF consumer of existing tables. Owner sign-off only.

**Verification path:**
- Apply migration, deploy `sms-fastrack-prompt-cron` EF.
- First fire happens at the next clock-minute boundary. Within 60 seconds of deploy, a `cron.job_run_details` row should land for `sms-fastrack-prompt-cron` (visible via `public.vw_cron_runs`).
- For empty candidate set (most minutes), response is `{scanned: 0, sent: 0, ...}` — no `crm.sms_log` row written.
- Next real funded lead routed → 10 minutes later → SMS lands (shadow mode currently ON, so log row only). Verify `crm.sms_log` row with `comm_type='call_reminder_fastrack_link'` lands.
- Flip `BREVO_SMS_SHADOW_MODE=false` to start real fastrack-link sends. Recommend leaving shadow ON for first 24h to confirm cron behavior on real lead flow before going live.

**Diagnosed + specced:** Wren 2026-05-18 (deferred S17), locked 2026-05-21. **Built:** Sasha (Chunks 1 + 2 + 3 in single session). **Sign-off:** Owner 2026-05-21.

---

## 2026-05-21 — SMS utility Chunk 2: Triggers B + C wired, SW_PROVIDER_REP_FIRST_NAME live

**Scope.** Chunk 2 of three for the SMS utility build (see Chunk 1 entry below for foundation context). Wires the two event-based triggers into existing code paths:
- **Trigger B (save-number on qualify-PASS)** — fires from `fastrack-receive` at step 8.7, sister to the `u-fastrack-qualified` email at step 8.6. Same gate condition (`cohort_confirmed=true AND l3_reconfirmed=false`), independent idempotency on `(submission_id, 'call_reminder_save_number')`.
- **Trigger C (chaser on attempt_1_no_answer)** — fires from the server action `markOutcomeAction` (provider portal) via new RPC `crm.fire_sms_chaser_attempt_1` → new EF `sms-chaser-attempt-1` → `fireChaserSms`. Fires ONCE per learner on attempt_1 only; attempt_2 / attempt_3 / cannot_reach still get the email chaser unchanged. Learner-funded only (not employer-apprenticeship).

**What landed:**
- **`_shared/route-lead.ts`:** new exported helper `resolveRepFirstName(provider, submission)` — dual fallback regional rep → provider contact_name first word → empty string. Added `SW_PROVIDER_REP_FIRST_NAME` to `buildLearnerBrevoAttributes` (23 attrs total now, up from 22). Exported `getMatrixContext` and `renderProviderContactValues` so the shared SMS module can call them.
- **`_shared/sms-utility.ts` (new):** `fireSaveNumberSms(args)` + `fireChaserSms(args)`. Body templates inline (per spec — not Brevo-templated). Worst-case render lengths 134 (save-number) / 127 (chaser) chars, both well under 160 single-segment. Gates: funding_category in (gov, loan), submission phone present, matched provider, provider opt-out flag check, regional rep phone resolves. Idempotency handled inside `sendSms` via `crm.sms_log`. UK phone normalisation to E.164 (07xxx → +447xxx). Returns `{kind: "skipped", reason}` or `{kind: "sent", result}`.
- **`fastrack-receive/index.ts`:** new step 8.7 inside the qualify-PASS branch. Loads full submission + provider rows, calls `fireSaveNumberSms`. Best-effort; failures land in `leads.dead_letter` via `sendSms`'s persist path. Email step 8.6 doesn't roll back if SMS fails.
- **`sms-chaser-attempt-1` (new EF):** auth via `AUDIT_SHARED_SECRET`, takes `{submission_id}`, loads submission + provider, calls `fireChaserSms`. `verify_jwt = false` added to config.toml.
- **Migration 0157:** `crm.fire_sms_chaser_attempt_1(BIGINT)` RPC. SECURITY DEFINER, mirrors `crm.fire_provider_chaser` (migration 0086) dispatch pattern — light gating + audit row + `net.http_post` to the EF using vault-stored audit secret. GRANT EXECUTE to authenticated.
- **`app/app/provider/leads/[id]/actions.ts`:** `markOutcomeAction` calls the new RPC alongside the existing `fire_provider_chaser` email-chaser RPC, gated on `targetStatus === 'attempt_1_no_answer' && leadType !== 'employer_apprenticeship'`. Fire-and-forget pattern matches the sibling RPC call.

**Voice / framing notes (S18 supersedes spec doc):**
- Chaser body: "{{REP_FIRST_NAME}} tried calling about your {{COURSE_NAME}} place. They'll try again, keep an eye out." — "prime-the-pickup" framing per Wren S18 decision, NOT the call-back CTA the original spec doc body had. Providers retain control of calling cadence.
- Save-number body: keeps "Save their number: {{PROVIDER_PHONE}}" CTA per spec — fires BEFORE first contact, sets the expectation.
- Sign-off "Switchable" not "The Switchable team" — keeps every worst-case render single-segment.

**What's intentionally untouched:**
- Trigger A (fastrack-link cron) — Chunk 3.
- Short URL `/f/{token}` infra — Chunk 3.
- Brevo backfill of `SW_PROVIDER_REP_FIRST_NAME` for existing contacts — needed before any marketing template references the new attribute. Per `platform/CLAUDE.md` Brevo attribute wiring rule, the attribute is populated on next contact upsert (routing or `crm.sync_leads_to_brevo` call) but existing contacts hold a NULL until then. No template references it today (Wren uses split filter on `SW_PROVIDER_CONTACT_BEFORE` for the email chaser); Chunk 2 only feeds the SMS path, which renders the attribute live from the DB via `fireChaserSms` not from Brevo.

**Impact assessment** (per `.claude/rules/data-infrastructure.md` §8): logged in migration 0157 header. Single new SECURITY DEFINER RPC, no table change. Schema_version unaffected. Owner sign-off only — no cross-brand impact.

**Verification path:**
- Migration applied + 2 new EFs deployed (admin-test-sms remains valid for unit testing the helper).
- Trigger B: real fastrack submit via `/funded/thank-you/` with `cohort_confirmed=true AND l3_reconfirmed=false` on an EMS Tees Valley lead. Email lands AND SMS lands. `crm.sms_log` row with comm_type `call_reminder_save_number`, brevo_message_id populated.
- Trigger C: provider portal user clicks "1st no answer" on an EMS Tees Valley lead. Email chaser fires (existing path) AND SMS chaser fires. `crm.sms_log` row with comm_type `chaser_call_attempt`.
- Idempotency: repeat the trigger on the same submission, sendSms returns `skipped_duplicate` (sms_log row stays as-is, no new row).

**Diagnosed + specced:** Wren 2026-05-18 (deferred S17), locked 2026-05-21. **Built:** Sasha. **Sign-off:** Owner 2026-05-21.

---

## 2026-05-21 — SMS utility Chunk 1: crm.sms_log + provider opt-out flags + sendSms helper + admin-test-sms

**Scope.** Chunk 1 of three for the SMS utility build per `switchable/email/docs/sms-utility-design.md` (Wren, locked same day after Brevo sender went LIVE at 16:35 UK). Foundation only — no triggers wired in this chunk. Chunk 2 wires Triggers B (save-number on qualify) + C (chaser on attempt_1) into existing Edge Functions; Chunk 3 ships Trigger A (fastrack-link cron) + short URL infra.

**What landed:**
- **Migration 0156:** new `crm.sms_log` table (mirrors `crm.email_log` shape) with three comm_types (`call_reminder_fastrack_link`, `call_reminder_save_number`, `chaser_call_attempt`). Idempotency via partial UNIQUE on `(submission_id, comm_type)` filtered to non-terminal statuses — same posture as `crm.email_log`. Two new BOOLEAN columns on `crm.providers`: `sms_utility_enabled` (gates A + B) and `sms_chaser_enabled` (gates C), both NOT NULL DEFAULT true so live providers opt in automatically.
- **`_shared/brevo.ts`:** new `sendSms(args)` helper. Mirrors `sendTransactional` discipline: idempotency check, queued-row-first insert, Brevo Transactional SMS API call with 250/1000/4000ms exponential backoff on 429/5xx, dead-letter on final failure, post-send status flip. Bodies are template-literal in calling code (not Brevo-templated) — rendered string is passed in and stored in `crm.sms_log.body_rendered`. Shadow mode via `BREVO_SMS_SHADOW_MODE` env (default `true`) — log-only until flipped.
- **`admin-test-sms` Edge Function:** mirror of `admin-test-email`. Auth via `AUDIT_SHARED_SECRET` (vault). POST body: `{ submission_id, comm_type, phone? (override), body? (override) }`. Bypasses trigger gates so the helper itself can be verified without wiring. Returns `sms_log_id` + `brevo_message_id` + `shadow_mode` flag for verification.

**What's intentionally untouched:**
- Triggers (A, B, C) — Chunks 2 and 3.
- `SW_PROVIDER_REP_OR_NAME` Brevo attribute — Chunk 2 (added alongside the Trigger B wiring inside `fastrack-receive`).
- Short URL `/f/{token}` infra — Chunk 3 (Trigger A only).
- Phone-number SMS-capability pre-flight — open question in the design doc, addressed once we have real send data.
- Marketing SMS path (form-side `sms_opt_in`, `SW_CONSENT_SMS` attribute, channel-state mirror) — out of scope per S17 decision.

**Impact assessment** (per `.claude/rules/data-infrastructure.md` §8): logged in migration 0156 header. Internal table (no external contract ingested), no schema_version bump, no data migration, single new writer (`sendSms` via `functions_writer`). Owner sign-off only — no cross-brand impact.

**Verification before going live:**
- Apply migration, deploy EF.
- POST to `/functions/v1/admin-test-sms` with `x-audit-key: <secret>` and `{ submission_id: <any existing>, comm_type: "call_reminder_save_number" }`.
- Confirm `crm.sms_log` row lands with `status='sent'` and `brevo_message_id IS NULL` (shadow mode on).
- Flip `BREVO_SMS_SHADOW_MODE=false` via `supabase secrets set`, re-test against Charlotte's phone, confirm SMS arrives and `brevo_message_id` populates.

**Diagnosed + specced:** Wren 2026-05-18 (deferred S17), locked 2026-05-21 after Brevo sender LIVE. **Built:** Sasha. **Sign-off:** Owner 2026-05-21.

---

## 2026-05-21 — Sheet vocabulary split: "Calling" → per-attempt labels

**Incident.** Owner reported "anomalies in DB after updating EMS sheet statuses". Diagnosis: sheet dropdown collapsed three DB enum states (`attempt_1_no_answer` / `attempt_2_no_answer` / `attempt_3_no_answer`) into a single "Calling" label. `_shared/sheet-status.ts:80` returned `null` for "Calling" on the reverse map (ambiguous), and `sheet-edit-mirror`'s STATUS_MAP didn't include "Calling" at all — so every sheet→DB edit setting status to "Calling" was outright rejected as `unmapped status value`. Owner then added raw `attempt_N_no_answer` (with trailing tab) directly to the EMS dropdown, which were also unmapped. 24h impact (EMS): 39 sheet edits → 9 mirrored OK, 7 "Calling" rejected, 5 raw-enum rejected, 18 null-cell rejected. 2 leads (subs 213, 262) left with sheet="Calling" but DB="open".

**Fix.** Split "Calling" into three per-attempt sheet labels: `Attempt 1 - no answer`, `Attempt 2 - no answer`, `Attempt 3 - no answer`.

- `supabase/functions/_shared/sheet-status.ts`: forward (`statusToSheetLabel`) writes per-attempt label; reverse (`sheetLabelToStatus`) accepts both human form AND raw enum fallback (`attempt_N_no_answer`). Legacy "Calling" still returns `null` (skip) for any unrepublished sheet cells.
- `supabase/functions/sheet-edit-mirror/index.ts` STATUS_MAP: added three human-label keys + three raw-enum fallback keys.
- `app/lib/sheet-status-sync.ts` STATUS_TO_SHEET_LABEL (portal → sheet sync, duplicate map): mirrored the same split so portal-driven status changes push the right per-attempt label.

**Workflow decision.** Chaser cron keeps owning attempt-count auto-increment; sheet is a mirror, not the driver. Owner can override from sheet (which now flows back cleanly via the per-attempt labels). Ping-pong risk: low — auto-increment fires on real call windows, manual sheet edits are infrequent.

**Acceptance.**
- Republish-provider-sheet on EMS overwrites every "Calling" cell with the right per-attempt label.
- Owner updates EMS sheet's dropdown data validation: remove "Calling" + raw `attempt_N_no_answer\t` rows; add the three human labels.
- Tomorrow 06:00 UTC sheet-drift-reconcile-daily emits zero EMS drift rows (vs. would-have-been one per active EMS lead without the fix).
- Brevo chaser dead_letter "Contact already in list" spam (14 rows in 2.5h) is unrelated and flagged separately for next platform session.

**Impact assessment** (per `.claude/rules/data-infrastructure.md` §8). Readers: `republish-provider-sheet`, `sheet-drift-reconcile-daily`, `reconcile-sheet-to-db`, `pending-update-confirm`, `app/lib/sheet-status-sync.ts`. Writers: `sheet-edit-mirror`. All 5 Edge Functions redeployed. No DB schema change, no schema_version bump, no policy/role changes. Rollback: revert two files, redeploy, re-republish. Sign-off: owner.

**Authored + deployed:** Sasha 2026-05-21. **Sign-off:** Owner 2026-05-21.

---

## 2026-05-21 — leads.partials composite UNIQUE (session_id, form_name) — fix cross-form-context merge

**Incident.** Mable surfaced 0-ever rows for `fastrack-funded-v1` and `switchable-waitlist-enrichment` despite confirmed site-side wiring on `/funded/thank-you/` and `/waitlist/`. Diagnosis: `netlify-partial-capture` upserts on `session_id` alone (column-level UNIQUE from migration 0004). When the same browser session crosses form contexts — funded course page mints `session_id` under `form_name='switchable-funded'`, then `/funded/thank-you/` fires the tracker under `form_name='fastrack-funded-v1'` with the same `session_id` (sessionStorage persists) — the second tracker hits the existing row and merges its answers in, preserving the original `form_name`. Result: per-form-name analytics on `/admin/partials` reads false zero for the post-submit form contexts even though the data is landing in the JSONB blob on the parent row.

**Fix.** Migration 0155 drops the column-level UNIQUE on `leads.partials.session_id` and adds composite UNIQUE `(session_id, form_name)`. `netlify-partial-capture/index.ts`: `ON CONFLICT (session_id)` → `ON CONFLICT (session_id, form_name)`. Rate-limit check switched from "single-row upsert_count" to "SUM(upsert_count) across the session" so the 50-per-session abuse cap stays per-session, not per (session, form_name).

**Acceptance** (Mable's, adopted):
- New writes from `/funded/thank-you/` land under `fastrack-funded-v1`
- New writes from `/waitlist/` land under `switchable-waitlist-enrichment`
- No backfill of historical rows (age out via 90-day purge for incomplete sessions)
- `/admin/partials` filter by form_name returns real per-form activity within hours of deploy

**Untouched by design.**
- `_shared/ingest.ts:339` `is_complete` flip is `WHERE session_id = $1` (form-name-agnostic). Post-fix, a session can have multiple rows; the final-submit flip marks every form context touched in that session as complete, which is correct semantically (each form's flow ended successfully). Abandoned subsequent contexts (e.g. user submits funded, lands on `/funded/thank-you/`, fills some fastrack, leaves) keep `is_complete=false` on the fastrack row and age out via the 90-day purge.
- `vw_partials_to_submissions` join (migration 0005) is `s.session_id = p.session_id` — still works, may now return multiple `partials` rows per submission, which is correct for funnel-context analytics.

**Impact assessment** (per `.claude/rules/data-infrastructure.md` §8): logged in migration 0155 header. No cross-brand impact; owner sign-off only.

**Diagnosed:** Mable 2026-05-21. **Verified:** Sasha against source. **Migration + EF patch authored:** Sasha. **Sign-off:** Owner 2026-05-21.

---

## 2026-05-21 — Owner-CC leak fix: chaser stopped CCing provider rep

**Incident.** Charlotte spotted a learner chaser email (Stockton-on-Tees lead, EMS) had been CC'd to George Taylor, the EMS provider rep scoped to Stockton/Hartlepool. Her ask: "learner chaser emails dont need to have anyone else cc'd in".

**Root cause.** `sendTransactional` in `_shared/brevo.ts` unconditionally called `appendOwnerCc(undefined)`, which CCs every address in the `OWNER_CC_ALL_EMAILS` Edge Function env var. That env var was added in the email rearchitecture as a launch-monitoring lever but applied indiscriminately to every transactional send, including learner-facing chasers / U1 / stalled / U4 / fastrack ack and employer-facing S4B sends. Any address in the env var (intentionally or accidentally) was leaked into external-party inboxes.

**Fix.** `_shared/brevo.ts`: introduced `OWNER_CC_ELIGIBLE_TYPES` set, currently containing only `provider_presumed_warning` and `provider_presumed_flipped` (the two provider-facing transactional types). `sendTransactional` now appends the owner CC only for those types. Everything else sends with no CC. New-lead + callback emails are unaffected because they CC the owner explicitly via `buildCcList` in `route-lead.ts` / `admin-notify-callback`, not via this env var.

**Deployed.** 9 functions redeployed to land the bundle change: admin-brevo-chase, admin-brevo-chase-employer, email-stalled-cron, email-u4-cron, email-sunset-cron, fastrack-receive, netlify-employer-lead-router, netlify-lead-router, routing-confirm.

**Env var hygiene (separate, owner action).** `OWNER_CC_ALL_EMAILS` value should be inspected by Charlotte (`supabase secrets list --linked` from `platform/`) and any provider-rep addresses removed. After this code change the env var only affects `provider_presumed_*` sends, but it's still meant for owner monitoring only.

**Behaviour shift.** Charlotte no longer receives a CC on U1 / stalled / U4 / fastrack ack / chaser / S4B chaser sends. She does still receive new-lead and callback emails (explicit owner CC via `buildCcList`).

---

## 2026-05-20 (Session 55) — Experiment_id random backfill (24 rows)

Mable shipped the site-side fix (switchable/site commit `574b2c5`) for the funded-course DQ panel forms missing `experiment_id` / `experiment_variant` hidden inputs. New submissions land with metadata. Historical rows stay NULL until this backfill.

**Why random fill** (option 2 from Mable's push): exact attribution is impossible. `ads_switchable.page_views` has no `session_id` (aggregate by design, migration 0068). The variant-router sets a browser cookie that's never recorded against the submission. Live view splits were 1805/1780 + 1653/1695 — within 0.5% of 50/50, so random fill is statistically valid for aggregate DQ% comparison.

**Scope** (Mable's "out of scope" rule respected — pre-experiment-start rows left alone):
- `counselling-tees-hero-variant-2026-05`: 13 rows (1 qualified + 12 DQ) from 2026-05-04 BST onwards.
- `smm-tees-hero-variant-2026-05`: 11 rows (all DQ) from 2026-05-06 BST onwards.

**Audit**: data-ops 045 writes a `system:data-ops:045 / experiment_id_random_backfill` row to `audit.actions` with per-experiment totals and `attribution_is_exact=false`. Visible in `/admin/audit`. Mira's Monday audit will pick it up.

**Not row-attributable**: individual rows can't be traced to their actual variant. Aggregate DQ% comparison on `/admin/experiments` is valid. If a future view of `/admin/leads` filters by `experiment_variant`, expect ~24 historical rows whose assignment is synthetic.

**Deferred polish**: small banner on `/admin/experiments` showing "24 historical rows backfilled 50/50 on 2026-05-20" (read from audit.actions). Not built — trail lives in changelog + audit row for now.

---

## 2026-05-20 (Session 55) — /admin/actions reshaped for an auto-chase world

Charlotte: "esp now we auto chase, this page isn't helpful". Three of the six existing sections were duplicating cron work (Approaching 14-day auto-flip, Needs another chase, Cannot reach no chaser sent). Dropped them. Replaced with provider-pattern cards she actually needs to action.

**Kept**: Awaiting your call (pending AI), Unrouted, Presumed (awaiting confirmation).

**Dropped**: Approaching 14-day auto-flip, Needs another chase, Cannot reach no chaser sent.

**Added**:
- **U1 bounces** (lead-level): `crm.email_log` rows where `email_type LIKE 'u1_%' AND status LIKE 'bounced_%'`. Welcome email didn't land; learner won't get nurture. Manual chase or mark lost.
- **Provider patterns** (one parent card with three sub-tables, drift signals at provider level):
  - **Leads past SLA (7d)**: open enrolments with `sent_to_provider_at < now() - 7d`. Tighter than 14d auto-flip clock = early signal.
  - **Cannot-reach hotspots (7d)**: providers where >20% of recent routings hit cannot_reach (min 3 routings to avoid divide-by-tiny-N).
  - **Zero confirmations despite 5+ routings (30d)**: providers receiving leads but never marking signed/enrolled.
- All three provider-level cards exclude paused/archived/demo providers (CD, WYK, demos drop out automatically).

**Constants exposed at file top** (`SLA_OPEN_DAYS`, `RECENT_WINDOW_DAYS`, `CONFIRM_PATTERN_DAYS`, `MIN_ROUTINGS_FOR_CONFIRM_PATTERN`, `CANNOT_REACH_HOTSPOT_PCT`) for easy tuning without hunting the code.

**Deferred follow-up**: the "cannot reach but no chaser fired" signal is system-reliability (chaser cron failed), not a task — add it as a card/pill on `/admin/errors` instead of `/admin/actions`. Logged for next platform session.

---

## 2026-05-20 (Session 55) — Experiment page enrolment status buckets + experiment_id propagation gap

Charlotte spotted: `/admin/experiments` page variants weren't reporting DQ + enrolled correctly. Two findings, one fixed in platform, one pushed to switchable/site.

**Platform fix.** `experiments/page.tsx` had `BILLABLE_STATUSES = {enrolled, presumed_enrolled}` and `IN_FLIGHT_STATUSES = {open, cannot_reach}`. The canonical enum (migration 0151 `enrolments_status_check`) has 14 statuses. The page was silently dropping `attempt_1/2/3_no_answer`, `enrolment_meeting_booked`, `engaged`, `in_progress`, `signed`, `presumed_employer_signed`, `not_signed`. New buckets mirror `/admin/leads` page stage filter for cross-surface consistency. Lost bucket now uses a Set (`{lost, not_signed}`) instead of literal `=== "lost"`.

**Site-side gap (pushed to switchable/site).** Most DQ submissions (and some qualified) from the two Tees experiment pages are landing in `leads.submissions` without `experiment_id` / `experiment_variant` populated. Sample query of submissions since 1 May: counselling page → 9/69 qualified + 20/27 DQs missing experiment metadata; smm page → 11/31 qualified + 12/12 DQs missing. Likely culprit: DQ-path forms (cohort decline / L3 mismatch / etc.) submit a different Netlify form name than the main qualifier, and those forms lack the hidden experiment_id field. Pushed to `switchable/site/docs/current-handoff.md` as a top-priority audit task for Mable. Until fixed, the platform DQ rate column is under-reported regardless of bucketing.

---

## 2026-05-20 (Session 55) — Employer routing audit consistency

Charlotte spotted: Riverside routings weren't appearing in the admin audit view the way EMS routings were. Root cause: `_shared/route-lead.ts` writes `audit.actions.action='auto_route_lead'` via `writeAuditSystem` on every routing, but `netlify-employer-lead-router` skipped it. 30 historical Riverside routings had no audit row.

**Forward fix.** `netlify-employer-lead-router` now writes the audit row at the end of post-route fan-out (Promise.allSettled outcomes captured into `sheet_appended` / `provider_notified` / `employer_ack_sent` context fields). Same shape as the funded writer — admin audit view renders both consistently from here on.

**Backfill.** Data-ops 044 synthesises `auto_route_lead` audit rows for the 30 existing routing_log entries on `riverside-training`. created_at backdated to `routed_at` so the audit timeline reflects when the routing actually happened. Outcome booleans set to NULL (original functions didn't log them; we don't know retroactively). actor_email tagged with `(backfill data-ops/044)` for traceability. NOT EXISTS guard makes re-runs no-op.

**Audit shape consistency confirmed.** Every other EMS-only action type (`mark_enrolment_outcome`, `sheet_reconcile_*`, `auto_flip_to_presumed_enrolled`, `manual_revert_to_open`, `set_regional_contacts`) is EMS-only because no Riverside event has triggered it yet, not a code gap. Riverside has its own employer-specific actions (`fire_employer_chaser`, `set_b2b_trust_line`) that EMS doesn't.

---

## 2026-05-20 (Session 55) — Pause Courses Direct + WYK Digital

Both already had `pilot_status='paused'` but `active=true`. Routing in `_shared/route-lead.ts` gates on `active` + `archived_at`, not `pilot_status`, so they could still have received leads. Data-ops 043 flips `active=false` for both. Not archived (paused is temporary, archive is permanent). Stay visible on `/admin/providers/` with the "Inactive" badge — the list doesn't filter on `active`. Un-pause by setting `active=true`.

---

## 2026-05-20 (Session 55) — Archive demo providers + Charlotte as per-provider admin

Charlotte switching off demo accounts and standing up per-provider admin accounts on real providers. Decision: per-provider rather than impersonation, because impersonation needs auth-gate branching + RLS fanout + audit + view-as banner and pays off at 10+ providers, not 4.

**Demo providers archived.** Data-ops 042 archives `demo-b2c`, `demo-b2b`, `demo-provider-ltd` (sets `active=false`, `archived_at=now()`) and suspends their 5 provider_users rows. Hard delete blocked by FK ON DELETE RESTRICT on demo-provider-ltd's 13 routing_log + 13 enrolments + 13 submissions rows; archive across the board for consistency + audit preservation.

**Charlotte's portal accounts.** Self-invite via the existing `/admin/providers/[id]/` UI for the two real portal-enabled providers (EMS + Riverside). One passkey per provider in iCloud Keychain. Email aliases: `hello+ems@switchleads.co.uk`, `hello+riverside@switchleads.co.uk`. Display name `Charlotte (admin)`, role `provider_admin`.

**Courses Direct + WYK Digital left sheet-only** (paused, `portal_enabled=false`). Re-enable when they un-pause.

---

## 2026-05-20 (Session 55) — Per-user LA scoping of provider notifications

EMS hired three regional managers (George Taylor, Jake Balfour, Nick Rodgers) plus a catch-all account manager (Daniel Mearns). Today new-lead emails go only to Andy at provider-record level; callback-note emails fan out to every active `crm.provider_users` row indiscriminately. Charlotte's call: scope by LA so each manager only gets the leads they own.

**Schema (migration 0154).** `crm.provider_users.notification_las TEXT[]` — NULL or empty = catch-all (every notification, regardless of `submission.la`). Non-empty = include only when `submission.la = ANY(notification_las)`. Slugs match the LA values produced by the funded form (e.g. `'stockton-on-tees'`). Seed values inline: George → Stockton + Hartlepool, Jake → Middlesbrough + Darlington, Nick → Redcar. Andy + Daniel left NULL.

**Recipient pattern (now unified across both notification paths).**
- New-lead emails (`_shared/route-lead.ts sendProviderNotification`): TO = `provider.contact_email` (Andy). CC = owner (Charlotte from `getOwnerEmail()`) + `provider.cc_emails` + every active `crm.provider_users` row whose `notification_las` matches the lead's LA (NULL = always match). Deduped against TO.
- Callback-note emails (`admin-notify-callback`): TO = the matched `crm.provider_users` recipients (multi-recipient; team sees each other on the thread). CC = owner + `provider.cc_emails`. Deduped against TO.

**Owner CC on callbacks.** Charlotte was previously not CC'd on callback-note emails. Now she is, matching the new-lead behaviour.

**Greeting change.** `Hi ${provider.contact_name ?? "there"}` → `Hello,` in both `sendProviderNotification` templates (new-enquiry + re-application). Andy's name was being rendered to the whole CC list; "Hello," works for everyone.

**Shared helper.** `fetchAreaScopedProviderUsers(sql, providerId, la)` and `buildCcList(...)` exported from `_shared/route-lead.ts` for both notification paths to share. Single source of truth for the LA-scoping query — no per-function copies to drift apart.

**Andy's portal status.** He's still `invited` (passkey never enrolled). Callback emails skip him (status='active' filter). New-lead emails still reach him via `provider.contact_email`. Charlotte's decision 2026-05-20: leave as-is — he doesn't call leads anyway.

**Impact.** Touched: `platform/supabase/migrations/0154_provider_users_notification_las.sql`, `platform/supabase/functions/_shared/route-lead.ts`, `platform/supabase/functions/admin-notify-callback/index.ts`, `platform/docs/data-architecture.md` (new `crm.provider_users` section). Migration not yet applied — owner runs in Supabase SQL editor. No portal UI for self-edit; DB-only for now per Charlotte 2026-05-20.

---

## 2026-05-19 (Session 54) — Sheet pill bug fix (dedup-aware window)

Caught by Charlotte right after the pills shipped: the Sheet ↔ DB pill could falsely flip to "Aligned" on day 3 of standing drift.

**Root cause.** `sheet-drift-reconcile-daily` deduplicates against existing unresolved drift rows. If drift first appeared Tuesday, a dead_letter row was written; Wednesday's cron sees the same drift, skips writing (dedup), so the only signal is Tuesday's row. My pill used a 25h window matching the other reconcilers — so by Thursday the Tuesday row falls out of the window and the pill says Aligned while standing drift exists.

**Fix.** Per-source window policy in `reconcilerStatus` tally:
- `sheet_drift_detected`: count ALL unresolved (no time filter). Unresolved-ever = current standing drift, courtesy of the cron's own dedup.
- `reconcile_backfill`: keep 25h window (event-log per back-fill, not standing state).
- `brevo_attribute_drift`: keep 25h window (one summary row per drifty run, latest is current state).

**Touched files.** `platform/app/app/admin/errors/page.tsx` — `respectWindow` flag per source in the unresolved walk.

---

## 2026-05-19 (Session 54) — Status pills on every reconciler card

Closes the "some cards show drift state at-a-glance, others require clicking Check drift" inconsistency Charlotte raised. All five reconciler cards on `/admin/errors` now render a status pill on page load.

**The pattern.** Sheet ↔ DB, Netlify ↔ DB, DB ↔ Brevo each have a daily/hourly cron that writes a `leads.dead_letter` row when drift is found. The page now counts those rows per source in the last 25h and renders a small badge on the card title: green "Aligned" if zero, amber "N drifted (last 24h) · time ago" if non-zero. Meta ↔ DB and Internal DB sanity already had inline status — no change there.

**Brevo cron added.** `brevo-attribute-reconcile-daily` at 06:15 UTC via `data-ops/041`. Fires the function with `apply: false, log_drift: true`. New `log_drift` body param: when dry-run + drift > 0, writes one summary `leads.dead_letter` row with source='brevo_attribute_drift' (raw_payload = drift stats). Clean runs leave no row — the pill defaults to Aligned in their absence.

Schedule timing: 06:15 UTC sits between the 06:00 sheet-drift cron and the 06:30 drift-digest cron, so today's Brevo drift signal lands in dead_letter before the digest reads.

**`ReconcilerStatusPill` component.** Single rendering helper for all three cards. Inputs: drifted count + lastSeen timestamp + label (varies per card — Sheet uses "row", Netlify uses "back-fill", Brevo uses "run"). Green when zero, amber with formatAgo timestamp when non-zero.

**Card semantics.**
- **Sheet ↔ DB**: count of `sheet_drift_detected` dead_letter rows in last 25h
- **Netlify ↔ DB**: count of `reconcile_backfill` rows. Non-zero = webhook missed N submissions in last 24h (cron self-healed by back-filling).
- **DB ↔ Brevo**: count of `brevo_attribute_drift` rows. Non-zero = latest daily reconciler run found contacts with stale SW_* attribute values.

The on-demand Check drift / Re-sync buttons are unchanged on every card — pill is the cached at-a-glance, click is the fresh check.

**Touched files.**
- `platform/supabase/functions/brevo-attribute-reconcile/index.ts` — new `log_drift` body param + dead_letter write when drift > 0.
- `platform/supabase/data-ops/041_brevo_attribute_reconcile_cron_2026_05_19.sql` — schedules the new daily cron. Uses `public.get_shared_secret(...)` at fire time (same pattern as data-ops/040).
- `platform/app/app/admin/errors/page.tsx` — drift-count tally per source in the existing server fetch, new `ReconcilerStatusPill` component, pill wired into each card's title.

**Verification.** TypeScript clean, Deno clean (two pre-existing `route-lead.ts` errors untouched), eslint clean on the changed page (three pre-existing `Date.now()` purity warnings untouched). Edge Function deploy + cron apply pending owner action.

**Owner follow-ups.**
1. Deploy: `supabase functions deploy brevo-attribute-reconcile --no-verify-jwt` (re-deploy for the new `log_drift` body param).
2. Apply `data-ops/041` via Supabase SQL editor (schedules the 06:15 UTC cron, no secret substitution).

Once both are done, the Brevo pill will read "Aligned" until the next morning's cron run, then either stay Aligned or flip to "N runs (last 24h)" if drift detected.

---

## 2026-05-19 (Session 54) — Drift digest + orphan cleanup

Two follow-ups from the S53 plan, plus a perf fix on the Brevo reconciler from earlier in the session.

**Brevo reconciler perf fix.** Initial S54 build of `brevo-attribute-reconcile` ran ~50s on 200 contacts (sequential per-contact SQL with max:1 pool) — beyond Netlify's 26s Server Action cap. Charlotte hit the timeout on first use. Refactored into two passes: pass 1 (read-only) evaluates every contact in parallel inside each Brevo page; pass 2 (apply only) re-fires upserts sequentially with the 250ms throttle. SQL pool bumped to max:8. Now well inside the cap.

**Drift digest daily.** New Edge Function `drift-digest-daily`. Reads every `leads.dead_letter` row received in the last 25h that's still unreplayed, groups by source, sends Charlotte one summary email at 06:30 UTC. Quiet days send nothing. `data-ops/040_drift_digest_cron_2026_05_19.sql` schedules the cron and unschedules `dead-letter-alert-hourly` in one transaction. The hourly dead-letter alert and the per-cron sheet-drift email both stop firing — same signals, one inbox channel.

`sheet-drift-reconcile-daily` patched: dead_letter writes continue (digest reads them), but the inline `sendOwnerSummary` call is suppressed. Helper kept in source as reference if we ever want to re-enable per-source channels.

**024 orphan cleanup.** The legacy SW_REFERRAL_URL + SW_FASTRACK_URL backfill panel + Edge Function. Repo deletions:
- `app/app/admin/data-ops/run-024-panel.tsx`
- `BackfillSpotCheck` / `BackfillSummary` / `BackfillResult` types + `runBackfillAction` + `callBackfillFunction` helper from `app/app/admin/data-ops/actions.ts`
- `supabase/functions/backfill-referral-fastrack-urls/` (entire directory)
- `[functions.backfill-referral-fastrack-urls]` entry in `supabase/config.toml`

**025 orphan cleanup.** The client_nonce backfill panel was already deleted in S52; this session removes the rest:
- `supabase/functions/backfill-client-nonce/` (entire directory)
- `[functions.backfill-client-nonce]` entry in `supabase/config.toml`
- Migration **0153_drop_count_client_nonce_pending.sql** — drops the `public.count_client_nonce_pending` RPC that powered the panel's auto-hide.

**config.toml additions.** `brevo-attribute-reconcile` + `drift-digest-daily` added to `[functions.*]` for canonical declaration.

**Remote-state follow-ups (need owner action, NOT auto-run).**
1. **Run migration 0153** via Supabase SQL editor (drops the orphan RPC).
2. **Apply data-ops/040** via Supabase SQL editor (schedules digest cron, unschedules dead-letter-alert-hourly). No secret substitution — body calls `public.get_shared_secret('AUDIT_SHARED_SECRET')` at fire time, so vault rotations propagate automatically and no plaintext secret lives in `cron.job`.
3. **Delete remote Edge Functions** (optional but recommended): `supabase functions delete backfill-referral-fastrack-urls backfill-client-nonce`. The repo no longer carries the source so they can't be redeployed.
4. **Deploy new functions** (the ones in this session): `supabase functions deploy drift-digest-daily --no-verify-jwt` (brevo-attribute-reconcile already deployed earlier in the session).

**Verification.** TypeScript clean (`tsc --noEmit`). Deno clean on `drift-digest-daily`, `sheet-drift-reconcile-daily`, `brevo-attribute-reconcile` (the two pre-existing `route-lead.ts` errors at lines 1393 + 1547, present on `main`, are untouched). Eslint clean on the changed app files.

**Schema-versioning note.** Migration 0153 is a DROP of a SECURITY DEFINER function with no callers — additive change is being undone, no version bump anywhere. Data-ops 040 is a pg_cron schedule change, not a schema change.

---

## 2026-05-19 (Session 54) — DB ↔ Brevo full SW_* attribute reconciler

S53 left the DB ↔ Brevo card scoped to SW_REFERRAL_URL + SW_FASTRACK_URL (the 024 backfill panel). This session replaces it with a per-attribute reconciler that covers every SW_* attribute the canonical upsert helpers produce.

**Pure-builder refactor on `_shared/route-lead.ts`.** Two new exports:
- `buildLearnerBrevoAttributes(sql, provider, submission)` — extracted from `upsertLearnerInBrevo`. Returns the matched-path attribute dict without writing.
- `buildLearnerBrevoAttributesNoMatch(sql, submission, matchStatus)` — extracted from `upsertLearnerInBrevoNoMatch`. Returns the no_match/pending attribute dict without writing.

Both existing upsert functions now call the new builders internally. **No behaviour change** — same attributes pushed to Brevo by the live path. The extraction exists so the reconciler can project DB → desired-attrs using the same code path as the canonical upsert.

**New Edge Function: `brevo-attribute-reconcile`.** Forked from `backfill-referral-fastrack-urls` (the 024 function). Walks Brevo's contact list, looks up each contact's most-recent non-archived submission by email, determines path (matched / no_match / pending) via the same logic admin-brevo-resync uses, projects through the new builder, diffs per attribute. Returns:
- `per_attribute_drift: Record<string, number>` — count per attribute.
- `drift_list` — up to 50 drifting contacts with their drifted attr names.
- Standard `audience_size / processed / contacts_with_drift / contacts_aligned / skipped_no_submission / skipped_no_email` counts.

Apply mode re-fires the canonical `upsertLearnerInBrevo` / `upsertLearnerInBrevoNoMatch` for every drifted contact (not just the first 50 sample) with 250ms throttling.

**Schema-versioning note.** No DB schema change. New Edge Function. Pure refactor on shared module. No version bump needed.

**UI.** New `app/app/admin/errors/reconcile-brevo-panel.tsx` mirroring the sheet + netlify panel shape. DB ↔ Brevo card on `/admin/errors` now hosts the new panel — the legacy `Run024Panel` import + the "Coverage today" amber note are dropped.

**Server action.** `brevoAttributeReconcileAction({ apply })` in `reconcile-actions.ts`. Same `callEdgeFunction` plumbing.

**Touched files.**
- `platform/supabase/functions/_shared/route-lead.ts` — extracted `buildLearnerBrevoAttributes` + `buildLearnerBrevoAttributesNoMatch`; existing upsert helpers thinned to call them.
- `platform/supabase/functions/brevo-attribute-reconcile/index.ts` — new function.
- `platform/app/app/admin/errors/reconcile-actions.ts` — new `brevoAttributeReconcileAction` + types.
- `platform/app/app/admin/errors/reconcile-brevo-panel.tsx` — new client component.
- `platform/app/app/admin/errors/page.tsx` — DB ↔ Brevo card now renders the new panel; `Run024Panel` import removed.

**Verification.** TypeScript clean (`tsc --noEmit`), Deno clean on the new function (`deno check`), eslint clean on the three changed/new files. The two pre-existing `route-lead.ts` Deno errors (lines 1393 + 1547, present on `main`) are untouched. Three pre-existing `Date.now()` purity warnings in `page.tsx` remain. Edge Function deploy pending owner confirm.

**Legacy paths.** `backfill-referral-fastrack-urls` Edge Function + `data-ops/run-024-panel.tsx` are now unused but stay deployed. Cleanup goes onto the next session's "delete orphaned 025 surfaces" pass.

**Next from S53 plan (still queued).** Daily drift digest consolidated email cron; delete orphaned 024 + 025 surfaces (panels + RPC + Edge Functions).

---

## 2026-05-19 (Session 54) — Netlify ↔ DB reconciler card lands on /admin/errors

S53 left a "Not built yet" placeholder for the fourth reconciliations card. This session replaces it with a working dry-run + back-fill panel.

**Edge Function change.** `netlify-leads-reconcile` (the existing hourly back-fill cron) gains an `apply` body parameter. `apply: true` is the existing behaviour (insert missing rows, write dead-letter audit, process referrals, send owner alert email). `apply: false` does the same Netlify-API ↔ DB diff but skips every side effect — returns a `would_backfill` count + the drift list so the operator can see what's missing before any insert fires. Default stays `true` so the hourly cron (which posts `{}`) is unchanged.

**Schema-versioning note.** No DB schema change. Edge Function response shape is additive: existing consumers of the function (only the hourly cron, which ignores the response body) are unaffected. New fields: `ok: true`, `mode`, `would_backfill`. No version bump needed under the rule's additive-change carve-out.

**UI.** New `app/app/admin/errors/reconcile-netlify-panel.tsx` mirroring the `reconcile-sheet-panel.tsx` shape — Check drift button, drift summary banner, table of missing submissions (netlify_id / form / course / email / submitted-at), Back-fill button with confirm step. `NetlifyVsDbPlaceholderCard` in `page.tsx` replaced with `NetlifyVsDbCard` that hosts the panel + explanatory copy.

**Server action.** `netlifyReconcileAction({ apply })` in `app/app/admin/errors/reconcile-actions.ts`. Same `callEdgeFunction` plumbing as the sheet + GDPR actions (AUDIT_SHARED_SECRET fetched from vault per call).

**Scope decisions (S53 open questions).**
- *Per-form vs aggregate.* Aggregate. The Edge Function already excludes `contact` (intentionally never ingested) and `fastrack-funded-v1` (handled by a dedicated function); every other form name is in scope. Per-form filtering adds UI complexity for no clear use — the drift list shows `form_name` per row, which is enough drill-down.
- *Window.* 24h, matching the existing hourly cron's lookback. The panel uses the same constant (`LOOKBACK_HOURS`) so dry-run reflects exactly what the next cron run would see.
- *Auth.* Same `AUDIT_SHARED_SECRET` from vault as Sheet ↔ DB; no new secret.

**Touched files.**
- `platform/supabase/functions/netlify-leads-reconcile/index.ts` — body parsing for `apply`, gate side-effects, additive response fields.
- `platform/app/app/admin/errors/reconcile-actions.ts` — new `netlifyReconcileAction` + types.
- `platform/app/app/admin/errors/reconcile-netlify-panel.tsx` — new client component.
- `platform/app/app/admin/errors/page.tsx` — placeholder card replaced with the working card.

**Verification.** TypeScript clean (`tsc --noEmit`), Deno clean (`deno check`), eslint clean on the changed/new files (three pre-existing `Date.now()` purity warnings in `page.tsx` remain, untouched). Edge Function deploy pending owner confirm.

**Next from S53 plan (still queued).** Extend the DB ↔ Brevo reconciler to every `SW_*` attribute; daily drift digest consolidated email cron; delete orphaned 025 surfaces (`count_client_nonce_pending` RPC + `backfill-client-nonce` Edge Function).

---

## 2026-05-19 (Session 52) — BEFORE INSERT trigger stamps funded client_nonce

Closes the leak path the 025 backfill panel was mopping up.

**Background.** Migration 0087 added `client_nonce` so every funded learner could carry a per-lead fastrack URL. The form path (`_shared/ingest.ts`) reads `client_nonce` from the form payload, so any insert path that didn't supply one (legacy form snapshots, ad-hoc replays, future ingestion sources) silently landed funded rows with NULL nonces. The 025 backfill panel existed to mop them up; over time the trickle kept reappearing.

**Migration 0152:** new `leads.stamp_client_nonce_if_funded()` PL/pgSQL function + BEFORE INSERT trigger on `leads.submissions`. Stamps `gen_random_uuid()` when funding_category is gov/loan and incoming `client_nonce` is NULL. No-op when the caller already supplies a nonce — the form path stays in control of which UUID lands on a fresh submission.

**Effect:** every present and future insert path is automatically protected. The 025 backfill function + admin panel become genuinely vestigial — pending count stays at 0 forever now, panel auto-hides.

**Carry — drop the 025 panel.** Once we've gone a week with no new pending rows, remove `count_client_nonce_pending`, the `backfill-client-nonce` Edge Function call from the UI, and the panel component itself. Flagged to next platform session.

**Carry — same instinct elsewhere.** Audit any other panel under "Data ops — one-shot fixes" that exists to compensate for an upstream gap. Most likely candidates: nothing else currently surfaced, but worth a sweep when the data-ops reshape ships.

---

## 2026-05-19 (Session 52) — enrolments_status_check widened to employer taxonomy

Closes a constraint-vs-RPC drift that blocked the provider portal on Riverside leads.

**Background.** Freya Kelly (Riverside) reported on 2026-05-19 that clicking "Engaged" on the lead-forward stepper in the provider portal threw `new row for relation "enrolments" violates check constraint "enrolments_status_check"`. The same path works for learner-lead statuses because migration 0091 listed those values when it rebuilt the CHECK during the provider-portal MVP. Employer-lead statuses (`engaged / in_progress / signed / not_signed / presumed_employer_signed`) were never added to the CHECK — migration 0126 extended the admin RPC `crm.upsert_enrolment_outcome` to accept them but never widened the underlying table constraint. The provider portal's `markOutcomeAction` (`app/app/provider/leads/[id]/actions.ts`) writes via a direct `supabase.update()`, not through the admin RPC, so the table-level CHECK is the gate Freya's click hit.

**Migration 0151:**
- `DROP CONSTRAINT IF EXISTS enrolments_status_check` then re-`ADD` with the full learner + employer taxonomy (same set as the 0126 admin-RPC whitelist).
- Comment updated on the constraint with the dual-state-machine note disambiguated by `leads.submissions.lead_type`.

**Doc lockstep:** `platform/docs/data-architecture.md` `crm.enrolments.status` block rewritten with the full taxonomy + migration history (0028 → 0091 → 0151). The line "TypeScript types derive from the CHECK, never define their own list" stays — but for the period between 0126 and 0151 the TS types were ahead of the DB. 0151 brings the DB back in lockstep.

**Apply on Charlotte's side:** `supabase db push --linked`. No app deploy needed; pure DB change. After apply, Freya's "Engaged" click should succeed.

**Carry — cosmetic bug on /admin/leads U1 badge.** Same session Charlotte flagged that the "U1 sent" column shows `missing` (red badge) for Riverside leads even though Brevo confirms a send. Root cause: the badge heuristic in `app/app/admin/leads/page.tsx` lines 485-498 only checks `email_type IN ('u1_funded','u1_self')` — both learner-only — and has no employer-lead exclusion. Every routed `employer_apprenticeship` lead with `submitted_at >= 2026-05-05` falls through to the "Routed Phase-2 lead with no U1 send recorded" branch. Fix is app-side (either branch on `lead_type` to show `—` for employer, or accept an employer welcome `email_type` once Sasha + Wren agree the type name). Not shipped this session — flagged to next platform session.

**Carry — Freya UX question, leads disappearing from Open tab.** Same screenshot: Freya noted that after marking `attempt_1_no_answer`, the lead leaves the Open tab. Working as designed (Open filters `status='open'`; attempted-but-no-answer rows move into Calling). Not a bug. Design call for next session: either add an "All in-flight" superset tab or extend Open to include attempts. Flagged to next session.

---

## 2026-05-18 (Session 51) — S4B employer chaser path

Sibling to the learner chaser. Closes a wiring drift that silently misfired against Riverside earlier today.

**Background.** Riverside (S4B v1 pilot) had 4 real leads in the portal; 2 (`#450` Haris, `#468` Lee Anthony) transitioned to `attempt_1_no_answer` by Freya Kelly. The provider portal's `markOutcomeAction` auto-fire branch ran. Downstream:
- `crm.fire_provider_chaser` → `admin-brevo-chase` → branches on `funding_category`, which is NULL on `employer_apprenticeship` submissions → silent `transactional = "skipped"`. **No email sent.**
- A misleading `crm.lead_notes` row ("Learner chaser email auto-sent...") landed on both leads, visible to Riverside staff. We told Freya we'd chased the employers; we hadn't.

**Migration 0148:**
- Extended `crm.email_log.email_type` CHECK to allow `s4b_employer_chaser`.
- New `crm.fire_employer_chaser(BIGINT[])` SECURITY DEFINER. Filters to `lead_type='employer_apprenticeship'`. No legacy Brevo list-add (employer side is transactional-only). Calls new Edge Function `admin-brevo-chase-employer` via pg_net.

**New Edge Function `admin-brevo-chase-employer`:** reads submission + provider name from `crm.providers`, sends Brevo transactional via `sendTransactional` with `emailType='s4b_employer_chaser'`, `forceResend=true`, params: `FIRSTNAME / LASTNAME / COMPANY / STANDARD / PROVIDER_NAME / SUBMISSION_ID`. Dead-letters with source `edge_function_brevo_chase_employer` on failure. `verify_jwt=false`, same `x-audit-key / AUDIT_SHARED_SECRET` pattern as the learner sibling.

**`_shared/brevo.ts`:** `EmailLogType` union extended with `s4b_employer_chaser`.

**`app/app/provider/leads/[id]/actions.ts`:** auto-fire branch in `markOutcomeAction` now selects `chaserConfig` by `leadType`. Learner → `fire_provider_chaser` + `chaser_funded/chaser_self` rate-limit gate + learner system-note wording. Employer → `fire_employer_chaser` + `s4b_employer_chaser` rate-limit gate + "Chaser email auto-sent to employer..." system-note wording. 10-min rate-limit and `routedProviderId` gate unchanged.

**New env var:** `BREVO_TEMPLATE_S4B_EMPLOYER_CHASER` (template ID for the Brevo transactional template, employer-voiced). Wren-editable copy lives in Brevo.

**Two misfired system notes left in place** on submissions #450 and #468 per Charlotte's call ("status on the portal is fine"). Future transitions on employer leads write the corrected wording.

**Deploys this session:**
- `supabase db push --linked` (migration 0148)
- `supabase functions deploy admin-brevo-chase-employer --no-verify-jwt`
- App deploy via Netlify auto-rebuild on push.

**Manual fire for in-flight lead:**
- `#450 Haris` skipped — original U1 ack soft-bounced (typo'd domain `windowhaus.uk` has no MX). Chaser would bounce too.
- `#468 Lee Anthony` fired manually after wiring lived via `SELECT * FROM crm.fire_employer_chaser(ARRAY[468]::bigint[]);`.

**Carry for Wren:** Brevo template copy is currently a placeholder Charlotte dropped in. Polish in next email session.

**Carry to flag for Mira:** decision-record review of the chaser-to-employer commercial shape (timing, tone, opt-out) after Riverside has cycled 5+ employer leads through real contact cadence. Currently fires on attempt_1/2/3 + cannot_reach with the same 10-min rate-limit as learner side — may want a longer cadence or attempt_1-only cap once we have data.

---

## 2026-05-17 (Session 50) — Channel B sheet writeback + post-nonce Brevo refresh + /admin/errors UX cleanup

Three connected Edge Function + admin-app changes wrapped together. Closes the two largest accumulators of data drift in the platform.

**Change 1: Channel B (`pending-update-confirm`) now writes status back to provider sheets.**

- After every approve / override that updates `crm.enrolments.status`, the function now POSTs the new status to the provider's sheet via the appender's `update_by_submission_id` mode.
- Best-effort + dead-letter pattern mirroring `fastrack-receive`: failures land in `leads.dead_letter` with source `channel_b_sheet_writeback`, function still returns success to the operator.
- Skipped silently if `SHEETS_APPEND_TOKEN` env isn't set, or if the provider has no `sheet_webhook_url` (portal-only).
- **Why:** the manifest's known limitation since Channel B shipped — AI Note approval updated DB but not sheet — was the biggest single source of new sheet drift (5/9 sub 199 stayed `Cannot reach` on sheet vs `open` in DB for 6 days, sub 208 similar). Republish was the only cure.
- **Impact:** new dead-letter source `channel_b_sheet_writeback`. Should stay empty in normal operation. Any entry = the new writeback path failing, investigate.

**Change 2: `backfill-client-nonce` now calls `crm.sync_leads_to_brevo` after each apply run.**

- Stamping a `client_nonce` changes `SW_FASTRACK_URL` from empty to a real link, but `route-lead.ts` pushes the Brevo URL attributes only once at lead-insert. Without the new RPC call, those contacts' Brevo cards keep the empty fastrack URL and stay drifted until the next manual URL backfill sweep.
- RPC is async via `net.http_post`; doesn't block the writer.
- **Why:** of 166 opted-in leads since 1 April, 65 had `client_nonce` set AFTER insert via this backfill — that's where most of the 30 contacts the URL-backfill panel kept finding came from. Now closed at the source.
- **Going-forward rule:** any new Edge Function or admin path that modifies `client_nonce` / `referral_code` / `course_id` / `marketing_opt_in` on an existing `leads.submissions` row MUST follow the write with `SELECT crm.sync_leads_to_brevo(ARRAY[<id>]::bigint[])`. Locked into project memory `project_brevo_urls_dont_auto_refresh_on_post_insert.md`.
- **Not patched** (deliberate): sites that flip `marketing_opt_in=false` (sunset cron, brevo-event-webhook, brevo-consent-reconcile-daily). Those contacts are being unsubscribed anyway; stale URL is harmless.

**Change 3: `/admin/errors` UX cleanup.**

- "Lead not found" cosmetic bug on drift / writeback / fastrack / reconcile dead-letter rows: `postgres@3` returns bigint as JS string; the page's `typeof === "number"` check silently dropped every row whose `raw_payload.submission_id` came from a `SELECT s.id` source. Replaced with coerce-both helper. Saved as feedback memory `feedback_postgres3_bigint_returns_string.md`.
- "Legacy sheet Submission IDs" backfill panel removed — work complete across all providers.
- "024: Brevo URL backfill" panel renamed to "Brevo: refresh learner referral & fastrack URLs"; description rewritten in plain English; last-applied date surfaced as a separate line.
- New "Flagged for Claude" card above the unresolved errors list. Surfaces resolved dead-letter rows whose audit note contains "Flagged for next session" from the last 60 days. Makes the button actually do what it promises — next platform session sees the backlog at session-start.

**Migrations:** none. All three changes are Edge Function source + admin-app source.

**Deploys this session:**
- `supabase functions deploy pending-update-confirm --no-verify-jwt`
- `supabase functions deploy backfill-client-nonce --no-verify-jwt`
- Admin app: git push to `switch-platform`, Netlify auto-rebuild.

**One-shot data-ops applied this session:**
- Republished EMS / WYK Digital / Courses Direct sheets via `/admin/errors` to clear 12 outstanding sheet-drift rows.
- Applied Brevo URL backfill (30 contacts mutated, 0 errors) to clear current SW_REFERRAL_URL / SW_FASTRACK_URL drift.

**Signed off:** Owner (Session 50).

---

## 2026-05-17 (Session 49) — `netlify-partial-capture` ALLOWED_FORMS extended to 6 form names

Added four form names to the `ALLOWED_FORMS` Set in `supabase/functions/netlify-partial-capture/index.ts`: `s4b-employer-lead-v1`, `switchable-waitlist`, `switchable-waitlist-enrichment`, `fastrack-funded-v1`. Function redeployed (config.toml already has `verify_jwt = false` for this function).

**Why:** Mable wired `partial-tracker.js` `.track()` calls into six Switchable forms after the 2026-05-16 audit found `partial-tracker.js` was loaded but never invoked on `/business/`, `/business/construction/`, `/course-finder/`, `/find-funded-courses/`, `/waitlist/`, and `/funded/thank-you/`. The site-side fix is queued in `switchable/site/deploy/` and pending push. The Edge Function's allowlist only accepted two form names (`switchable-self-funded`, `switchable-funded`), so the four new ones would have been rejected with `disallowed_form_name` on arrival even with `.track()` firing correctly. Result before this change: still zero partials for those four form names 24h after Mable's fix.

**Impact:** additive change to a Set, no schema migration, no consumer impact. Once Mable's site-side push lands, partials should start appearing in `leads.partials` for the four newly-allowed form names. Watch `leads.partials` over the next 24h for the new `form_name` rows.

**Signed off:** Owner (Session 49).

---

## 2026-05-16 (Session 48) — SW_PROVIDER_CONTACT_BLOCK split into three plain-text attributes + U1 funded template collapse

Second Wren push of the day. Two changes wrapped:

**Change 1: split `SW_PROVIDER_CONTACT_BLOCK` into three plain-text attributes.** Brevo's text-type contact attributes always escape-render — `{{contact.X | raw}}` throws a syntax error and there's no template-side workaround. Wren's call: keep the variables plain text on the contact, put the `<p>` + `<strong>` wrapper in static template content. The template renders `<p>{{contact.SW_PROVIDER_CONTACT_BEFORE}} <strong>{{contact.SW_PROVIDER_PHONE}}</strong> {{contact.SW_PROVIDER_CONTACT_AFTER}}</p>`, with empty `<strong></strong>` rendering invisibly in the fallback case.

- **`renderProviderContactBlock` renamed to `renderProviderContactValues`** in `_shared/route-lead.ts`. Returns `{ before, phone, after }` plain strings instead of a single HTML string. No `escapeHtml` calls — Brevo handles escape on `{{contact.X}}` substitution.
- **Three new attributes written from both upsert helpers** (`upsertLearnerInBrevo` + `upsertLearnerInBrevoNoMatch`): `SW_PROVIDER_CONTACT_BEFORE`, `SW_PROVIDER_PHONE`, `SW_PROVIDER_CONTACT_AFTER`. Regional match (EMS): full split, e.g. `before="George from Enterprise Made Simple will give you a call..."`, `phone="07955 265 739"`, `after="in your contacts now and pick up when it rings."`. Fallback: `before` carries the unified sentence, `phone`/`after` empty.
- **Old `SW_PROVIDER_CONTACT_BLOCK` attribute no longer written.** Now orphaned on existing Brevo contacts; Charlotte deletes from Brevo dashboard once the new template is verified live.
- **Old per-send `SW_PROVIDER_CONTACT_BLOCK` param removed** from `sendU1Transactional` (was the bridge during the morning's redesign).

**Change 2: U1 funded template collapse — fastrack-state branching dropped.**

- **`sendU1Transactional` always sends `BREVO_TEMPLATE_U1_FUNDED`.** Wren's call: the regular U1 copy ("if you haven't already") gracefully covers fastracked learners, and the post-fastrack "thanks for sending the extra details" beat duplicated the site thank-you page's own ack.
- **`BREVO_TEMPLATE_U1_FUNDED_POST_FASTRACK` env var reference removed.** Vault key can stay (harmless when unread); the orphaned Brevo template is Charlotte's to delete from the Transactional → Templates list whenever.
- **`isPostFastrack` derivation deleted** from `sendU1Transactional`. Funded vs self split is the only template branch now.

**Sequence:**

1. Charlotte registers `SW_PROVIDER_CONTACT_BEFORE`, `SW_PROVIDER_PHONE`, `SW_PROVIDER_CONTACT_AFTER` in Brevo (all text type).
2. Charlotte redeploys `routing-confirm`, `netlify-lead-router`, `admin-test-email`, `admin-brevo-resync`, `backfill-sw-provider-contact-block`.
3. Charlotte runs `./scripts/run-039-backfill.sh "AUDIT_KEY"` to populate the three new attributes on existing contacts (same chunked-loop pattern as the previous attempt — now reliable, ~90 seconds).
4. Charlotte signals Wren — Wren publishes the new u1-funded template with the three-attribute composition.
5. Once verified live: Charlotte deletes the orphan `SW_PROVIDER_CONTACT_BLOCK` attribute + the orphan `u1-funded-post-fastrack` template from Brevo.

**No DB migration. No payload change.** Three attribute names registered in Brevo (one-time setup); existing contacts get the three values via the resync backfill.

Signed off: Charlotte (session 2026-05-16).

## 2026-05-16 (Session 48) — SW_PROVIDER_CONTACT_BLOCK: per-send param → Brevo contact attribute

Wren push during today's QA: Brevo template preview was rendering blank where Nick's paragraph should land, because `SW_PROVIDER_CONTACT_BLOCK` was the only SW_* in the U1 funded templates that wasn't a contact attribute. Preview only resolves contact attributes, not transactional params, so this one was invisible during QA and architecturally special-cased vs the other 18 SW_* attributes already on the contact. The Session 47 rationale ("per-send param avoids the attribute-wiring backfill rule") was real but small compared to the cost of preview-invisibility + special-casing — Wren's call to align it with the rest of the set.

- **`_shared/route-lead.ts` `renderProviderContactBlock` simplified.** `isPostFastrack` parameter dropped. Unified fallback wording works for both U1 funded variants: `<p>They'll be in touch within the next few days by email or phone to talk you through your start date and answer anything you want to ask.</p>`. The regular U1 template's next paragraph already covers eligibility ("...so EMS can confirm you qualify ahead of the call..."); post-fastrack doesn't need it at all. `provider` arg now typed `ProviderRow | null` to serve `upsertLearnerInBrevoNoMatch` (no provider on no_match / pending paths — fallback branch only).
- **Attribute write added to `upsertLearnerInBrevo` + `upsertLearnerInBrevoNoMatch`.** Every Switchable learner upsert now carries `SW_PROVIDER_CONTACT_BLOCK`. Matched-and-funded contacts get the named-rep paragraph (or the fallback if their LA has no regional rep). no_match / pending contacts get the fallback (consistency across lifecycle states — no blank reads if a future template ever references it).
- **Per-send param kept temporarily** in `sendU1Transactional`. Identical render to the contact attribute. Stays in place until both U1 funded templates (pre-fastrack + post-fastrack) are switched live in Brevo to `{{ contact.SW_PROVIDER_CONTACT_BLOCK }}`, then removed as dead code. Stops any U1 funded send from rendering blank in the gap window between this deploy and Wren's template push.
- **Migration 0145 header not edited.** Per `.claude/rules/data-infrastructure.md` migrations are immutable once applied. The param→attribute switch is a Brevo wiring change, not a DB schema change — recorded here in the changelog and in `platform/docs/data-architecture.md` (the `regional_contacts` block was rewritten to reflect the new wiring).
- **No DB migration. No payload change. No `crm.email_log` change.** The data and the render function are unchanged; only the transport (param → attribute) and the wording for the fallback branch shifted.
- **Sequence:** Charlotte (1) registers `SW_PROVIDER_CONTACT_BLOCK` as a text attribute in Brevo, (2) redeploys `routing-confirm`, `netlify-lead-router`, `admin-test-email`, `admin-brevo-resync` to land the attribute on every new upsert, (3) runs a one-time backfill across existing Switchable Brevo contacts via the existing `admin-brevo-resync` mechanism (iterate non-archived submission ids; re-upsert lands the new attribute), (4) signals Wren the attribute is populated and templates are clear to switch. Once Wren's templates are live referencing `{{ contact.X }}`, follow-up deploy removes the now-dead per-send param.
- Signed off: Charlotte (session 2026-05-16).

## 2026-05-16 (Session 48) — U1 funded contact block: fallback paragraph + fastrack signal

Yesterday's first real Tees Valley EMS funded U1 send surfaced two bugs in the new `SW_PROVIDER_CONTACT_BLOCK`. (1) Brevo rendered the `<p>` + `<strong>` HTML as literal text in the inbox (Susan saw `<p>George from...`). (2) The U1 funded paragraph above the block already says "they'll be in touch... by email or phone to talk you through eligibility..." which the contact block now duplicates. Wren is cutting that sentence from both U1 funded templates, so the block needs to cover the "what's next" job alone — including for non-EMS leads where it was previously an empty string.

- **`_shared/route-lead.ts` `renderProviderContactBlock` extended.** Now takes a third arg `isPostFastrack: boolean` and renders a generic fallback paragraph when no regional match. Pre-fastrack fallback names eligibility + start date; post-fastrack drops "eligibility" (fastrack already confirmed it). Regional-match branch unchanged in copy.
- **Callsite in `sendU1Transactional` passes `isPostFastrack`** (already derived from `submission.fastracked_at` for template-env selection — single source of truth).
- **No schema change. No payload change. No `crm.email_log` change.** Per-send transactional param only — no Brevo contact backfill required.
- **Bug #1 (HTML escape) is a template-side fix**, not platform. The platform produces well-formed HTML on purpose (`<strong>` around the phone number is the styling we want); splitting into discrete plain-text params would force Liquid `{% if %}` for the regional-vs-fallback branch, which is banned (`feedback_brevo_no_liquid_conditionals.md`). Recommendation pushed to Wren: move the `{{ params.SW_PROVIDER_CONTACT_BLOCK }}` placeholder into a Brevo HTML block (cleaner than `| safe` and survives non-technical edits). Same change in both U1 funded templates.
- Sequence: Charlotte redeploys `routing-confirm`, `netlify-lead-router`, `admin-test-email`, `admin-brevo-resync`. Wren then pushes the two template updates (cut duplicated sentence + raw-HTML placeholder).
- Signed off: Charlotte (session 2026-05-16).

## 2026-05-15 (Session 47) — U1 funded splits by fastrack state

Wren is splitting the U1 funded template into pre-fastrack vs post-fastrack variants. Pre-fastrack keeps the "Get a head start" push; post-fastrack drops it (the learner has already fastracked, the push would be redundant). Split via two templates rather than Liquid conditional per `feedback_brevo_no_liquid_conditionals.md`. Platform side reads a second env var and branches.

- **`_shared/route-lead.ts` `sendU1Transactional` branches on `submission.fastracked_at`.** New `BREVO_TEMPLATE_U1_FUNDED_POST_FASTRACK` env var used for funded leads with `fastracked_at IS NOT NULL`. Pre-fastrack funded leads + self-funded leads unchanged. Self has no fastrack flow so stays single-template.
- **Safe rollback path: `BREVO_TEMPLATE_U1_FUNDED_POST_FASTRACK` falls back to `BREVO_TEMPLATE_U1_FUNDED` when unset.** Until Charlotte creates the new template in Brevo and sets the Vault key, fastracked leads keep receiving the original `U1_FUNDED` template (current behaviour). Deploy is safe at any time relative to the Brevo-side work.
- **No DB migration. No payload schema change. No `crm.email_log` change.** `email_type` stays `u1_funded` for both variants (idempotency keys `(submission_id, email_type)` are unaffected; the per-submission idempotency check inside `sendTransactional` prevents double-sends regardless of which template was chosen).
- **Infrastructure manifest updated** with the new env var row and a note on the existing `BREVO_TEMPLATE_U1_FUNDED` row that it doubles as the fallback.
- Sequence: Charlotte creates the post-fastrack template in Brevo Transactional templates, sets `BREVO_TEMPLATE_U1_FUNDED_POST_FASTRACK` in Supabase Vault, then pings me to deploy `routing-confirm` + `netlify-lead-router`. Code is shipped; deploy held pending Charlotte's go.
- Signed off: Charlotte (session 2026-05-15).

## 2026-05-15 (Session 47) — EMS regional contacts wired into U1 funded ack

Charlotte's call: every EMS Tees Valley funded learner should know which named rep will be ringing them and what mobile number to expect. EMS routes by local authority, three reps cover the five LAs.

- **Migration 0145** Adds `crm.providers.regional_contacts JSONB` (nullable, additive). Per-provider rep-by-LA mapping. JSONB chosen over a dedicated table because v1 is one provider, five LAs, and the shape may evolve as we learn what fields downstream emails want.
- **Data-ops 038** Populates `enterprise-made-simple` with the flat-by-LA mapping (George Taylor → stockton-on-tees + hartlepool / 07955 265 739; Jake Balfour → middlesbrough + darlington / 07931 601 801; Nick Rodgers → redcar-and-cleveland / 07842 444 808).
- **`_shared/route-lead.ts`** gains `renderProviderContactBlock(provider, submission)` which resolves `provider.regional_contacts?.by_la?.[submission.la]` and pre-renders an HTML paragraph. Empty string when no mapping applies. Passed as the transactional param `SW_PROVIDER_CONTACT_BLOCK` on `sendU1Transactional`. `ProviderRow` type extended with `regional_contacts: RegionalContacts | null`; the routing SELECT, `admin-test-email`, and `admin-brevo-resync` SELECTs all include the new column to keep ProviderRow shape consistent.
- Pre-rendered HTML rather than discrete fields + Liquid `{% if %}` per the no-conditionals-in-Brevo rule (`feedback_brevo_no_liquid_conditionals.md`). Wren's U1_FUNDED template drops one `{{ params.SW_PROVIDER_CONTACT_BLOCK }}` placeholder; empty string renders as nothing for every non-EMS lead.
- Per-send transactional param, not a Brevo contact attribute. No Brevo contact backfill required (the attribute-wiring rule applies to contact attributes only).
- Impact: read by `sendU1Transactional` on funded ack send. No read from any other consumer at v1. Reversible via DOWN section in 0145 (drop column).
- Sequence: Charlotte applies 0145, runs 038, redeploys `routing-confirm`, `netlify-lead-router`, `admin-test-email`, `admin-brevo-resync`. Cross-project handoff to Wren (`switchable/email/`) to drop `{{ params.SW_PROVIDER_CONTACT_BLOCK }}` into the live U1_FUNDED template after the matched-with-provider paragraph.
- Signed off: Charlotte (session 2026-05-15).

## 2026-05-15 (Session 46, evening) — Portal launched: Riverside + EMS invited, Daniel first through

First real provider users invited. Daniel Mearns (EMS admin) signed in at 15:20, completed welcome + SLA tick at 15:26. First production walkthrough of the new welcome deck v3 + per-user SLA flow.

- **0143** Patches `provider_read_submissions` RLS policy on `leads.submissions` to add `AND is_dq IS NOT TRUE`. Test rows stop appearing in provider portal queries automatically. Mirrors the dashboard-view filter pattern from 0136.
- **0144** Adds `sla_accepted_at TIMESTAMPTZ` + `sla_accepted_version TEXT` to `crm.provider_users`. Per-user SLA acceptance replaces per-provider per Charlotte 2026-05-15 — managers don't always forward the SLA on to new staff, so every team member accepts individually with an audit row per acceptance. Per-provider columns on `crm.providers` stay as historical first-acceptance markers but are no longer read at the gate.
- **`requireProviderUser`** rewritten to read user-level SLA. `skipWelcomeGate` option also skips the SLA gate so the welcome deck's final slide can handle the tick inline.
- **Welcome deck v3 shipped.** SLA folded into the deck as the final slide ("I agree, take me in" → `markWelcomeAndSlaAccepted` writes both timestamps + audit row). Admin-only "Bringing your team in" slide inserted before the SLA terminator for users with `role='provider_admin'`. Home slide adds timer/Overdue badge mention. Automations slide drops auto-flip clock line. Billing slide replaced with Support slide. HeroVisual loses the dead stat block. AutomationsVisual trimmed to 2 rows per audience. New SupportVisual + AddUsersVisual + SlaSlide components.
- **Demo providers seeded.** Data-ops 035 created `demo-b2b` (apprenticeship, v2). Data-ops 036 created `demo-b2c` (gov-funded, v1). Both with `is_demo=true` and `portal_enabled=true`.
- **Riverside contact update.** Data-ops 033 set `contact_name='Freya Kelly'` + `contact_email='Freya.Kelly@riverside-training.co.uk'` (was the mangled `<\tjane@riverside-training.co.uk>` from a paste). U2 greeting matches the actual recipient.
- **U2 lead-notification sender split.** New `switchleads_leads` brand in `_shared/brevo.ts` reading `BREVO_SENDER_EMAIL_LEADS`. Applied to `_shared/route-lead.ts` B2C U2, `netlify-employer-lead-router` B2B U2, `email-presumed-warning-cron`, and `email-presumed-flipped-cron`. `resolveBrandSender` falls back to `BREVO_SENDER_EMAIL` when LEADS unset — deploy is safe before the env var is set, lead notifications keep coming from support@ until Charlotte flips to hello@switchleads.co.uk.
- **`x-allow-real: true` always sent from admin invite Server Action** to bypass the demo-only fence in `provider-invite-link`. Edge Function-side gate stays in place defensively.
- **U2 emails carry sheet fallback.** Both B2C funded and B2B employer U2 now render the sheet link below the portal CTA when both are present, so providers can still reach the lead if the portal misbehaves.
- **OWNER_CC_ALL_EMAILS helper** added to `_shared/brevo.ts`. When the env var is set, every `sendBrevoEmail` + `sendTransactional` call cc's the owner for launch monitoring. Unset by default.
- **Audit-trail bug fixed.** `markWelcomeAndSlaAccepted` was calling the audit RPC via the admin client (NULL `auth.uid()` → `audit.log_provider_action` rejected, silent fail). Switched to the authenticated supabase client for the RPC. Same fix on `/provider/sla-agreement/actions.ts`. Data-ops 037 backfilled Daniel's missed audit row.
- **Admin preview is_dq filter.** `/admin/preview/<id>/leads` and `/admin/preview/<id>/home` now apply the same is_dq filter as the production RLS. Two-step query for home (the earlier nested-relation supabase-js filter silently dropped every row).
- **Admin provider detail SLA badge** now derives from `crm.provider_users.sla_accepted_at` and shows `SLA: X/N accepted`. Was reading the deprecated per-provider column.
- **Provider /leads gains a Region column** on learner views, sourced from `leads.submissions.region`.
- **`B2B_STANDARD` attribute** added to `upsertEmployerInBrevo` so Wren's U1-employer template can reference `{{contact.B2B_STANDARD}}`.
- **Edge Functions redeployed (9):** `netlify-employer-lead-router`, `netlify-lead-router`, `routing-confirm`, `admin-test-email`, `admin-brevo-resync`, `provider-invite-link`, `email-presumed-warning-cron`, `email-presumed-flipped-cron`. All pick up the shared `_shared/brevo.ts` brand + cc + sender resolution changes.
- Signed off: Charlotte (session 2026-05-15).

## 2026-05-15 (Session 46) — B2B_PROVIDER_NAME + B2B_PROVIDER_TRUST_LINE on employer router

Wren rewrote U1-employer to reference `{{contact.B2B_PROVIDER_NAME}}` + `{{contact.B2B_PROVIDER_TRUST_LINE}}` instead of hardcoding Riverside trust prose, so the same template serves v2+ providers without re-templating. The 2026-05-14 employer upsert was pushing neither attribute, so live sends would render two blanks until the parallel work lands.

- **Migration 0142** Adds `crm.providers.b2b_trust_line TEXT` (nullable). New column rather than reusing `trust_line` because the audience register diverges (HRD/L&D vs adult learner). Per `feedback_no_patchwork.md`, forking at the schema layer beats re-templating at v2.
- **Data-ops 032** Backfills Riverside's `b2b_trust_line` with the canonical prose Wren had hardcoded ("30 years … NHS / BMW / MINI / Five Guys / Wiley"). One-row UPDATE + audit row. Charlotte runs after migration 0142 lands.
- **`netlify-employer-lead-router` upsertEmployerInBrevo extended** to SELECT `name` + `b2b_trust_line` from `crm.providers` keyed by `row.primary_routed_to`. For v1 that resolves to riverside-training; v2+ resolves dynamically from routing. Pushes `B2B_PROVIDER_NAME` + `B2B_PROVIDER_TRUST_LINE` alongside the other B2B_* attributes. Provider-lookup failure logs but doesn't throw — attributes ship as empty strings rather than blocking the upsert.
- Sequence: Charlotte applies 0142, runs 032, pings me to deploy the function, then pastes the new U1-employer template HTML into the live Brevo template. Current Brevo template stays serving until 5 (avoid blank placeholders in real employer inboxes).
- Cross-project: Mable updates `data/apprenticeship-providers/<slug>.yml` + `/new-apprenticeship-provider` skill to prompt for `b2b_trust_line` at onboarding once 0142 is live (her skill insert needs the column to exist).
- Signed off: Charlotte (session 2026-05-15).

## 2026-05-14 (Session 45, addendum) — Data-ops 031 closes Riverside test-enrolment gap

Solis flagged that data-ops 030 left two leftover open enrolment rows (540, 541) attached to subs 421 and 422 — both already flagged `is_dq=true, dq_reason='owner_test_submission'` from earlier sessions, but outside 030's narrow id range (423-427). Enrolment-id sequence jumps 541 → 547 after 030 confirmed the gap.

- **Data-ops 031** Deletes any `crm.enrolments` row whose `submission_id` carries `is_dq=true` and a `dq_reason` in the owner-test family (six values, same filter as 027). Idempotent re-runnable script — catches today's gap (540, 541) and any future leftover surfacing from the same class. Replaces the narrow-id-range pattern from 030 as the canonical recovery shape going forward. Submissions kept for audit.
- Signed off: Charlotte (session 2026-05-14).

## 2026-05-13 (Session 44, addendum) — Employer-router source_form wiring + Riverside test-lead cleanup

Triggered by Solis Session 3 handoff pushing the question of why every `/business/*` submission landed with `source_form=NULL`. Confirmed in DB: ids 421, 422, 425, 426, 427 (and 423, 424 earlier the same day) all carried NULL despite the Edge Function validating `form_name === 's4b-employer-lead-v1'` on the way in.

- **`netlify-employer-lead-router` redeployed** with `source_form` now written to `leads.submissions`. Added `source_form: string` to the `EmployerSubmissionRow` interface, set it to the hardcoded `'s4b-employer-lead-v1'` value in `normalise()` (only valid form for this router; the guard at top of the handler rejects anything else), and threaded it through the INSERT column list. No payload-schema bump — the source-of-truth form_name is on the inbound payload already; this just persists it.
- **Data-ops 030** Flips submissions 423, 424, 425, 426, 427 to `is_dq=true, dq_reason='owner_test_submission'` and deletes their downstream `crm.enrolments` rows (542-546). Audit row per submission via `audit.log_system_action`. Same pattern as data-ops 027. Reason: Charlotte 2026-05-13 — every routed-to-Riverside lead to date is a test (5 from this session plus 8 already-DQ from earlier sessions: 401, 408, 410-413, 421, 422). Real Riverside traffic begins after Wed paid-traffic flip confirms in Meta Events Manager (Solis Session 3 next step 1). Charlotte cleans the matching Riverside sheet rows manually after running (sheet → DB direction not auto-mirrored).
- Signed off: Charlotte (session 2026-05-13).

## 2026-05-12 (Session 42, addendum 3) — Performance pass + agreement UI consolidation

Triggered by Charlotte asking for a "speed and performance" sweep on the portal mindful of multi-user multi-provider scaling, plus a UX change folding the standalone `/provider/agreement` page into Account so the admin preview can see it too.

- **0138** Added 19 missing FK indexes across `crm.*`, `leads.*`, `audit.*`. Audit on 2026-05-12 surfaced them — `crm.sheet_edits_log` was already 57.6% sequential scans on 191 rows, `leads.submissions` had 4,873 sequential scans accumulated. All additive btree indexes (`<table>_<column>_idx`), `IF NOT EXISTS` for idempotency. Hot-path coverage: `crm.lead_notes.{provider_user_id, author_user_id}`, `crm.enrolments.{routing_log_id, callback_requested_by}`, `crm.sheet_edits_log.submission_id`, `crm.billing_events.{enrolment_id, submission_id, created_by}`, `crm.support_requests.{provider_user_id, resolved_by}`, `crm.provider_users.{invited_by, current_invite_issued_by}`, `crm.providers.sla_accepted_by_user_id`, `crm.routing_config.updated_by`, `crm.pending_updates.source_log_id`, `leads.submissions.parent_submission_id`, `leads.dead_letter.replay_submission_id`, `audit.access_requests.processed_by`, `audit.erasure_requests.processed_by`.
- **Agreement folded into Account.** The standalone `/provider/agreement` nav tab is gone. The PPA summary, SLA thresholds, both-sides obligations, and Notion reference link now render as a "Pilot agreement" card inside `/provider/account`, visible to all team roles. Same card appears inside `/admin/preview/[provider_id]/account` so Charlotte can see each provider's agreement when viewing-as. Components extracted to `app/app/provider/agreement-section.tsx` with an exported `AGREEMENT_COLUMNS` constant so the parent pages stay in sync on the column list.
- **`/provider/agreement` kept as a redirect** to `/provider/account` so bookmarks and any old links still resolve.
- **`provider-shell.tsx` Active type** narrowed: removed `"agreement"` from the nav state union; nav is now Home / Leads / Support / Account.
- Performance audit findings beyond Tier 1 (FK indexes) deferred: provider `/leads` page has an N+1 fetching enrolments after submissions (should be parallel), siblings query on lead detail loads up to 500 rows for prev/next nav (should be cursor-style), `RealtimeRefresh` listens to `lead_notes` with no filter (should be scoped to displayed lead IDs), two RLS policies on `crm.disputes` + `leads.fastrack_submissions` use unscoped scalar subqueries that need `(SELECT crm.provider_user_provider_id())` wrapping at scale. None urgent at pilot volume; revisit when any provider crosses 500+ active leads or when a second admin user starts hitting the preview surface concurrently.
- Signed off: Charlotte (session 2026-05-12).

## 2026-05-12 (Session 42, addendum 2) — Dashboard test-row reconciliation + sheet silent-failure fix

Triggered by Charlotte spotting "5 leads routed to Riverside" on the admin dashboard when every one was an owner test. Investigation widened: EMS still_open was inflated by 3 stale test enrolments, and the sheet-vs-DB diff for EMS surfaced submission 267 (Christy Clarence, real Hartlepool lead, 4 May) marked `delivery_status='sent'` in the DB but never actually appended to the EMS sheet.

- **0136** Added `is_dq IS NOT TRUE` filter to `crm.vw_provider_performance` (both `leads_30d` and `enrolments_30d` scalar subqueries, via JOIN through `leads.submissions`) and `crm.vw_provider_billing_state` (`routing` CTE + `counts` CTE). Goal: tests stop polluting dashboard counts even when not archived. Introduced a bug — `counts` used a top-level WHERE on the join through submissions, which dropped providers entirely when every enrolment was a test (Riverside went missing from the view instead of showing zeros).
- **0137** Fixed 0136 by pushing the `is_dq IS NOT TRUE` filter INTO each `count(*) FILTER (WHERE …)` clause and leaving the LEFT JOINs unfiltered. Providers with only-test enrolments now correctly emerge with all-zero counts.
- **Data-ops 027** Deleted 6 stale `status='open'` test enrolment rows from `crm.enrolments` (3 Riverside today + 3 EMS from late April / early May). Provider portals query enrolments directly, so removing the rows clears them from Jane and Andy's `/provider/leads` view. Submissions kept (`is_dq=true`, `dq_reason='owner_test*'`) for audit.
- **`_shared/route-lead.ts` sheet-append silent-failure fix.** The previous `catch { return { ok: true }; }` after `res.json()` treated any non-JSON Apps Script response (HTML auth page, plain text error, redirect) as success. Replaced with explicit `{ ok: false, error: 'apps script: unparseable response: …' }`. Root cause of submission 267 / Christy Clarence sitting in DB as routed-to-EMS but absent from Andy's sheet for 8 days. All 5 functions importing `_shared/route-lead.ts` redeployed (`netlify-lead-router`, `netlify-employer-lead-router`, `routing-confirm`, `admin-test-email`, `admin-brevo-resync`).
- **Christy Clarence (submission 267) manually added to EMS sheet** as a row with status='Open'. Enrolment row 426 already linked, no DB change needed.
- **Migration drift cleared.** 0134 + 0135 had been applied to production via SQL editor without being recorded in `supabase_migrations.schema_migrations`. Repaired with `supabase migration repair --status applied 0134 / 0135` before pushing 0136.
- Open follow-up: WYK and Courses Direct sheets have not yet been diffed against DB for the same silent-failure ghost pattern (EMS confirmed only Christy missing). Worth a session-start sheet-vs-DB reconcile across all funded providers.
- Signed off: Charlotte (session 2026-05-12).

## 2026-05-12 (Session 42, addendum) — S4B Riverside launch fixes

- **0134** Added `crm.providers.site_slug TEXT` (nullable) + partial unique index `providers_site_slug_unique WHERE site_slug IS NOT NULL`. Backfilled Riverside to `'riverside'` (DB provider_id stays `'riverside-training'`). Additive, no consumer today. Drives v2+ apprenticeship redirect derivation; v1 unaffected because the form action is statically `/business/thank-you/riverside/` (Mable, commit 2efba5c in switchable/site).
- **0135** Exposed `free_enrolments_cap` on `crm.vw_provider_billing_state` SELECT. Additive view column. Surfaces the per-provider cap that migration 0132 had moved into the view's CTE but not exposed. Admin UI updated in lockstep (`platform/app/app/admin/page.tsx` + `platform/app/app/admin/providers/page.tsx`) so the "X / Y free" display reads the per-provider cap instead of the hardcoded "/ 3". Riverside (PPA v2 apprenticeship, cap 1) now renders correctly as "1 / 1" instead of "1 / 3".
- **`netlify-employer-lead-router` redeployed** with three fixes after Charlotte's happy-path test:
  - Sheet append shape rewritten to mirror `_shared/route-lead.ts` (token + flat snake_case payload keys; previous shape `{mode, fields: {"Header Name": value}}` returned `unauthorized` silently because the v2 appender requires a token and reads `body[payload_key]`).
  - Per-leg `Promise.allSettled` outcomes now logged by leg name (`post-route leg <name> failed`) so silent leg failures stop disappearing. Lost ~90 min on the unauthorized return because the rejection wasn't surfaced.
  - `TEST_MODE` + `OWNER_TEST_EMAIL` env vars: when `TEST_MODE='true'`, U2 (provider notification) redirects to `OWNER_TEST_EMAIL` instead of the provider `contact_email`, cc_emails stripped, subject prefixed `[TEST]`. Added after Jane received three test U2s when the SQL-swap-then-test pattern was skipped.
- **`provider-sheet-appender-v2.gs`** FIELD_MAP extended with 19 employer / B2B field aliases (`submissiontime`, `role`/`roletitle`, `company`/`companyname`, `companysize`/`companysizeband`, `sector`, `levystatus`/`levy`, `urgency`, `candidateinmind`/`candidate`, `existingapprentices`, `headcountestimate`/`headcount`, `standardsinterested`/`standards`, `additionalnotes`, `ern`). Apps Script redeployed by Charlotte. v1 funded provider scripts unaffected (their sheets have no matching headers).
- **Admin lead detail page** branched on `lead_type`. Employer leads now render a Company + apprenticeship card (company_name, sector, company_size_band, levy_status, interest, urgency, candidate_in_mind, existing_apprentices, headcount_estimate, standards_interested, ern, additional_notes) in place of the Course + qualification card, and the Contact card shows Role instead of postcode/LA/region. Fastrack + referral cards stay gated to learner leads.
- **Riverside `free_enrolments_remaining` data fix** (UPDATE, not migration): flipped 3 → 1 in `crm.providers` to match PPA v2 apprenticeship pilot (1 free Employer Signed, not 3 like funded providers).
- **Test cleanup**: submissions 408 / 410 / 411 / 412 marked `is_dq=true, dq_reason='owner_test'` and their open enrolment rows deleted from `crm.enrolments`. None ever exited `open` status, so no billing impact.
- Data-architecture doc updated for the new `site_slug` column. Mable's `switchable/site/CLAUDE.md` § Apprenticeship-provider YAML and `provider-onboarding-playbook.md` already log the v2 options that consume that column.

## 2026-05-12 (Session 42) — Switchable for Business backend + per-provider SLA template + auto-flip rewrite + reconciliation pass

**Type:** 12 migrations (0122-0133), 1 new Edge Function, 1 cron schedule, 1 data-ops seed, several Edge Function patches, multiple portal/admin UI changes, 1 Brevo backfill semantics fix.

- **0122** Added `lead_type` discriminator (`learner` | `employer_apprenticeship`) to `leads.submissions` + 14 employer-only columns + `routing_outcome` + `terms_accepted_at` + composite index `(provider_id, routed_at)` for sibling-lead lookups.
- **0123** Added `agreement_version` (v1/v2 CHECK), `sla_provider_obligations` text[], `sla_switchleads_obligations` text[] to `crm.providers`. Drives the portal `/provider/agreement` page.
- **0125** Extended `crm.email_log` email_type CHECK to include `s4b_employer_u1` + `s4b_employer_ud`.
- **0126** Rewrote `upsert_enrolment_outcome` RPC with extended status + lost_reason whitelists covering both lead types.
- **0127** Added 5 per-provider SLA columns to `crm.providers` with PPA v1 defaults (24h first attempt / 6 attempts / 7-day window / 36h stale / 14-day flip). Riverside v2 set to 24h / 6 / 14-day window / 120h stale / 60-day flip. CD set to 17-day flip as grace.
- **0128** Added `auto_flip_enabled` (default true), `sla_accepted_at`, `sla_accepted_by_user_id` (FK), `sla_accepted_version` to `crm.providers`. Drives the first-sign-in SLA agreement gate.
- **0129** Rewrote `crm.run_enrolment_auto_flip` to use per-provider `sla_presumed_flip_days`, branch presumed-target by `lead_type`, gate on `auto_flip_enabled AND sla_accepted_at IS NOT NULL`. Dispute window stays hardcoded 7 days for now (followup ticket).
- **0130** Added `provider_presumed_flipped` email_type to `crm.email_log`.
- **0131** Scheduled `email-presumed-flipped-cron-daily` at 07:00 UTC.
- **0132** Rewrote `crm.vw_provider_billing_state` to use `crm.providers.free_enrolments_remaining` as per-provider cap (replaces hardcoded `3`) and added employer success states (`signed`, `presumed_employer_signed`) to `billable_or_pending_count`. Surfaced by Charlotte spotting Riverside displaying "3/3 free" on admin list when the v2 PPA cap is 1.
- **0133** Rewrote `crm.vw_provider_performance` (counts `signed` alongside `enrolled` in 30-day window) and `leads.vw_needs_status_update` (per-provider threshold + simpler "open or no enrolment" actioned-leads filter). Replaces hardcoded 14 days and learner-only filters that would have silently misreported for Riverside.
- **New Edge Function `netlify-employer-lead-router`.** Receives `s4b-employer-lead-v1` form webhook from Netlify. Inserts lead with `lead_type='employer_apprenticeship'`, fires `crm.ensure_open_enrolment`, writes `leads.routing_log` with canonical column names mirrored from `_shared/route-lead.ts`, sends U1 (sendTransactional) + U2 (inline HTML provider notice) emails, appends to Riverside sheet via Apps Script v2 appender. Three failed test submissions chased out invented column names — process learning saved as memory.
- **`netlify-lead-router` patched** to ignore `s4b-employer-lead-v1` form (defensive, in case site-wide webhook fires).
- **`sheet-edit-mirror` STATUS_MAP extended** with employer values (engaged, in_progress, signed, not_signed, presumed signed).
- **`email-presumed-warning-cron` made per-provider aware** (day-12 v1 / day-58 v2) + gated on `auto_flip_enabled AND sla_accepted_at`.
- **New Edge Function `email-presumed-flipped-cron`.** Picks up newly-flipped leads from the previous 24h, sends batched per-provider notification with 7-day dispute deadline.
- **data-ops/026** seeded Riverside provider row + PPA bullets for all four pilot providers (v1/v2 wording divergence).
- **Portal-to-sheet status sync** new helper `app/lib/sheet-status-sync.ts`. Server Actions fire `pushSheetStatus()` on major transitions (skips sub-states like attempt_1/2/3, in_progress, meeting_booked). Uses `SHEETS_APPEND_TOKEN`.
- **First-sign-in SLA acceptance page** `/provider/sla-agreement` (admin-only accept, checkbox-gated submit, sign-out button). `require-provider.ts` redirects when `sla_accepted_at IS NULL` or version drift. Server Actions split: `SLA_VERSION` in `version.ts` (Server Action files can only export async functions).
- **Provider agreement page in portal** `/provider/agreement` renders PPA bullets + SLA thresholds from `crm.providers` columns. Notion link hidden when `agreement_notion_page_id` is null.
- **Lead 128 (Jyotika Mark) orphan fixed** via `crm.ensure_open_enrolment(128, ...)` — routing_log row from 25 April with no enrolment row.
- **`backfill-referral-fastrack-urls` semantics fix.** Now uses first-submission per email for `referral_code` (stable share-with-friend links) and latest-submission for fastrack URL (current course intent). Two CTEs joined on email. Applied clean (~20 contacts changed: swaldby-class learner referrals stabilising + two historical drift corrections from previous "latest wins" applies).
- **Impact assessment** (per `.claude/rules/data-infrastructure.md §8`):
  - Change: 12 migrations + 1 new Edge Function + 1 cron schedule + view rewrites. Some DDL (new columns), some view replacements, no destructive operations.
  - Readers: every cron + UI consumer of `crm.providers` benefits from new SLA columns. Views consumed by admin and Iris's flags. Brevo backfill function consumed via `/admin/data-ops` panel.
  - Writers: `auto_flip_enabled` / `sla_accepted_at` / `sla_accepted_version` written via SLA acceptance flow (admin role only). Lead writes via `netlify-employer-lead-router`.
  - Schema versions: lead payload bumped for employer fields (additive — old consumers continue to work).
  - Rollback: each migration carries its own DOWN section. Views replaced with prior bodies if needed. Edge Function removable via `supabase functions delete`.
- **Sign-off:** owner-approved each migration in-session; auto-flip migration 0129 applied behind dual gate so it's safe even without immediate sign-off from any provider.

---

## 2026-05-11 (Session 40) — Daily sheet ↔ DB drift reconcile cron

**Type:** 1 new Edge Function + 1 migration (0115) + 1 Apps Script mode + 1 shared module extraction.

- **Why:** `republish-provider-sheet` shipped in Session 39 as the recovery path for sheet drift, but detection was operator-discretion ("run the republish tool when you suspect something"). Lead #375's two-day silent drift bit before the fix landed; the cron is the proactive counterpart that surfaces drift within ~24h instead of waiting for an operator to notice.
- **Edge Function `sheet-drift-reconcile-daily`** (`supabase/functions/sheet-drift-reconcile-daily/index.ts`). For every active provider with a `sheet_webhook_url`, POSTs the appender's new `read_all_status` mode, projects each routed-non-DQ DB lead through `_shared/sheet-status.ts` (`statusToSheetLabel` + `lostReasonHumanText` — the same projection `republish-provider-sheet` writes with, so the two tools agree on "what the sheet should say"), and compares against the sheet cells. Records drift kinds (`status`, `lost_reason`, `fastracked`, `missing_from_sheet`) and writes `leads.dead_letter` source `sheet_drift_detected` rows. Dedupes against existing unresolved drift rows by `(provider_id, submission_id, sorted-kinds)` so persisting-from-yesterday drift doesn't re-fire. Per-provider read failures (unknown mode, missing Submission ID column, fetch error) land as source `sheet_drift_provider_skipped` with 23h-window dedup. Emails owner a summary when any new drift detected. Auth: `x-audit-key`. Deploy with `--no-verify-jwt`.
- **Apps Script `read_all_status` mode** (`apps-scripts/provider-sheet-appender-v2.gs`). Read-only — no cells touched. Returns one JSON row per data row keyed by Submission ID, carrying values for the drift-relevant columns. Sheets without a Submission ID column return `ok:false`; the cron caller surfaces those as `sheet_drift_provider_skipped` so the gap is operator-visible.
- **Migration 0115** schedules `sheet-drift-reconcile-daily` cron at 06:00 UTC daily (07:00 BST) — sits before the 08:00 meta-ads and 09:00 stalled-email crons so the morning summary email lands clean of cross-noise. Mirrors the `email-stalled-cron` migration pattern (`net.http_post` via vault `AUDIT_SHARED_SECRET`). 120s timeout for headroom on cold-start sheet reads.
- **Shared module extraction:** moved `statusToSheetLabel` + `lostReasonHumanText` out of `republish-provider-sheet/index.ts` into `_shared/sheet-status.ts`. Two consumers today (republish + drift cron), one source of truth for the projection. `fastrack-receive` keeps its own specialised lost_reason humaniser for the two fastrack-specific reasons (different intent).
- **Dead_letter naming:** new sources are `sheet_drift_detected` (per-drift) and `sheet_drift_provider_skipped` (per-provider read failure). Both visible to `/admin/errors` via the existing `crm.dead_letter`-backed query.
- **Impact assessment** (per `.claude/rules/data-infrastructure.md §8`):
  - Change: 1 cron schedule + 1 Edge Function + 1 helper script mode. No schema change.
  - Readers: cron function reads `crm.providers`, `leads.submissions`, `crm.enrolments`, `leads.dead_letter` (dedup). Apps Script reads sheet rows (read-only).
  - Writers: cron function INSERTs `leads.dead_letter` via existing `functions_writer` role (RLS policy + GRANT both already in place from migrations 0001 + 0002). No new GRANTs.
  - Schema version: not affected. No payload changes.
  - Rollback: `cron.unschedule('sheet-drift-reconcile-daily')` + delete Edge Function deploy. Sheets keep working — `read_all_status` mode is additive and harmless if never called.
- **Pre-cutover requirement (owner action):** every active provider sheet must be redeployed with the 2026-05-11 `provider-sheet-appender-v2.gs` before the cron covers it. Sheets pending redeploy: EMS, WYK, Courses Direct (also any demo sheet if active). Until redeployed, the cron logs one `sheet_drift_provider_skipped` per day per sheet ("unknown mode: read_all_status") and skips comparison for that provider — visible at `/admin/errors`.
- **Sign-off:** in-session owner approval per Session 39 handoff sequencing this as Session 40's first task. Migration unapplied + functions undeployed at session close per the deploy-batching workflow; deploy ritual queued for the session-end batch.

---

## 2026-05-11 — Brevo backfill: SW_REFERRAL_URL + SW_FASTRACK_URL (Wren ask, completed)

**Type:** 1 data-ops local script + 1 Edge Function + 1 admin UI panel. Pre-broadcast data hygiene.

- **Why:** `_shared/route-lead.ts buildReferralUrl()` was rewired on 2026-05-04 (commit aadf5ad → 30e62e0) from per-funding-category referral paths to a single `/refer/?ref=`. No Brevo backfill ran when the wiring changed; 160 existing contacts on the marketing list held stale URLs. The earlier-2026-05-10 referral launch broadcast to EMS-matched contacts shipped with the broken old URLs (site redirect commit `e99fd6d` on switchable-site rescued clicks in the meantime).
- **Same pass also backfilled `SW_FASTRACK_URL`** (introduced 2026-05-09). Pre-cutover contacts had no value set; the U1 funded transactional template + future marketing depend on it.
- **Audience:** every Brevo contact whose latest `leads.submissions` row has `marketing_opt_in=true` (regardless of provider).
- **Path:** started as a local Deno script (`supabase/data-ops/024_backfill_referral_and_fastrack_urls_2026_05_10.ts`), pivoted to an Edge Function (`backfill-referral-fastrack-urls`) + admin button at `/admin/data-ops` after local execution hit two friction points: Brevo's API key UI doesn't reveal existing keys, and the project's direct DB host (`db.<ref>.supabase.co`) is IPv6-only and unreachable from local laptops. Edge Function reads both creds from Supabase env, sidesteps both.
- **Run log:**
  - Audience size: 174 (latest `leads.submissions` per email with `marketing_opt_in=true`)
  - Brevo contacts processed: 250
  - Mutated: 160 (stale → current)
  - Skipped (not in audience, e.g. internal/admin emails or non-opt-in contacts): 90
  - Skipped (already matching): 0 (dry-run after the apply: every audience contact in Brevo is now current)
  - Errors: 0
  - 14 of the 174 audience emails have no Brevo record yet — those will be created the next time `route-lead.ts` upserts on a submission. Not a backfill concern.
- **Sign-off:** owner-approved apply, executed via `/admin/data-ops`. Post-apply dry-run (174 audience / 0 would-mutate / 160 already-matching) confirms the wiring is clean. Page crashed cosmetically during apply (Server Action timed out on Netlify's ~26s function-call cap while the Edge Function kept writing to completion); subsequent commit `5fff3f5` cuts the inter-write delay 250→100ms and adds a client-side error boundary so future retries don't crash.
- **Process lock:** memory entry `feedback_brevo_attribute_wiring_requires_backfill.md` + `Core discipline` block in `platform/CLAUDE.md`. Any future change to a `_shared/route-lead.ts` function producing a Brevo attribute MUST queue a same-session backfill ticket before merge.

---

## 2026-05-09 (Session 38): Audit wrapper, RLS proof, and the missing-GRANT bug

**Type:** 3 migrations (0106, 0107, 0108) + 1 data-ops script (020) + 1 Server Action edit + 1 runbook doc. Clears 2 of Clara's 3 EMS-cutover gating conditions.

- **0106** `public.log_provider_action_v1` — public-schema thin wrapper over `audit.log_provider_action`. The audit schema is intentionally not exposed via the Data API, so supabase-js `.rpc()` from Server Actions couldn't reach the inner writer. SECURITY INVOKER, delegates straight through; auth identity flows via the per-request `request.jwt.claims` GUC. Versioned (`_v1`) so we can deprecate cleanly. Replaces the TODO in `markOutcomeAction` (Server Action now writes through the wrapper after every UPDATE; surfaces audit failure to the caller rather than swallowing).
- **0107** REVOKE EXECUTE FROM anon on the wrapper. Supabase's `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ... TO anon, authenticated, service_role` auto-grants every new public function to anon; explicit REVOKE FROM PUBLIC didn't undo it. Defence-in-depth — inner gate already rejects anon (`auth.uid()` NULL), but visible least-privilege wins.
- **0108** GRANT UPDATE ON `crm.enrolments` + INSERT ON `crm.disputes` to `authenticated`. **Bug surfaced during RLS proof:** migration 0096 shipped two write-side RLS policies that depended on table-level GRANTs that didn't exist. PostgreSQL evaluates GRANT before RLS, so a denied GRANT short-circuits the policy with `42501 permission denied`. Net effect: the portal Server Action `markOutcomeAction` had been silently unable to persist outcomes since shipping in Session 37, despite the handoff marking it owner-tested. Confirmed by inspecting `crm.enrolments.updated_at` on the demo provider — every row carried the seed timestamp, no Charlotte-driven UPDATEs had landed. 0108 fixes by granting what 0096's comment already promised. Row scope still enforced by 0096 policies (RLS proof confirmed cross-tenant writes still blocked post-grant).
- **data-ops/020** RLS proof script. 14 assertions covering helper return value, baseline own-data SELECT, cross-tenant SELECT on 6 tables, cross-tenant UPDATE/INSERT, audit `actor_provider_id` spoof rejection, `portal_enabled=false` lockout. All side effects in a `BEGIN; ... ROLLBACK;`. 14/14 PASS recorded in `platform/docs/rls-proof-2026-05-09.md`.
- **Server Action edit** `app/app/provider/leads/[id]/actions.ts` — captures before-state via SELECT, performs UPDATE, calls `public.log_provider_action_v1` with before/after, surfaces audit failure to caller. Idempotent on retry of identical state. Atomic UPDATE+audit refactor flagged as a follow-up consideration in handoff.

**Sign-off:** owner approved 0106 + 0107 (wrapper + ACL hygiene) and 0108 (the GRANT fix surfaced during proof). RLS proof clears Clara's gating condition #2 (`accounts-legal/docs/current-handoff.md` item 2). Condition #3 (originally framed as a multi-agent cloud diff review) needs substituting with an alternative review path — open question for next session.

---

## 2026-05-09 (later): Demo provider seeded + Brevo sync filters demo data

**Type:** 1 migration (0101) + 1 data-ops script (019). Provider portal MVP P2-P4 fixture in place.

- Migration 0101: `crm.sync_leads_to_brevo` filters out submissions whose routed-to provider has `is_demo=true`. Single source of truth for "demo data does not reach Brevo" — covers the three triggers from 0098, the daily reconcile cron from 0100, and any direct Server Action / data-ops call.
- data-ops/019: seeded `demo-provider-ltd` (Demo Provider Ltd, hello+demo@switchable.org.uk, `is_demo=true`, `portal_enabled=true`) + 12 fake leads (`@demo.example.com`) + 12 routing_log + 12 enrolments spanning every status in the new taxonomy: open ×3 (varying ages), attempt_1/2/3, enrolment_meeting_booked, enrolled ×2, lost (`not_interested`), cannot_reach, presumed_enrolled. Days-since-routed spread 2-17 days for realistic UI age variety.
- Verification: 12 enrolment INSERTs each fired the auto-sync trigger from 0098, the 0101 filter caught all of them, zero pg_net dispatches to admin-brevo-resync from demo IDs.
- Mid-apply fix: first apply attempt failed on `enrolments_lost_reason_chk` (used `changed_mind`, not in CHECK list). Switched to `not_interested` per the live constraint values, transaction committed clean.
- Why: portal P2-P4 build over the weekend dogfoods auth + invite + outcome marking against demo data instead of touching real provider data.

**Sign-off:** owner approved both 0101 (Brevo filter) and 019 (37-row production seed) explicitly.

---

## 2026-05-09: Provider portal foundation + DB ↔ Brevo single-source-of-truth architecture

**Type:** 10 migrations (0091-0100), 4 Edge Function code paths updated + redeployed twice, 3 data-ops scripts applied, 1 Brevo full-cohort resync (twice — for SW_COURSE_SCHEDULE backfill and for the 8 new attributes). Major architecture milestone.

**Status:** Live end-to-end. Triggers firing real-time on every relevant DB write. Daily reconcile cron scheduled (first run 2026-05-10 04:45 UTC). Brevo aligned across 174 routed-active contacts. All four pilot providers reconciled against their sheets.

**Why:** Three threads converged this session: (a) provider portal MVP scoping locked in at "smallest" framing with EMS-first cutover mid-next-week — the schema foundation needed to land before this weekend's portal build, (b) Wren + Mable both flagged Brevo attribute gaps that the existing discipline-based push wasn't covering reliably, prompting a shift to trigger-based architecture, (c) Charlotte's "every change to lead data must update Brevo so automations trigger correctly" principle made the case for layer 1 + 2 + 3 architecture (triggers + cascades + daily reconcile) explicit.

**Migration summary:**

- 0091 status taxonomy expansion (open / attempt_1/2/3 / enrolment_meeting_booked / enrolled / lost / cannot_reach / presumed_enrolled). Dropped legacy 'contacted' (zero rows).
- 0092 dropped legacy `enrolments_status_chk` constraint (0091's DROP IF EXISTS targeted the wrong name; lesson saved to memory `feedback_query_live_pg_proc_before_patching`).
- 0093 `crm.providers.is_demo` + `crm.providers.portal_enabled` boolean flags.
- 0094 `crm.provider_users` table (multi-user mapping + role + status CHECKs + RLS).
- 0095 `audit.log_provider_action` SECURITY DEFINER helper.
- 0096 `crm.provider_user_provider_id()` helper + 9 RLS policies for provider-context reads/writes across leads.submissions / leads.routing_log / leads.fastrack_submissions / crm.enrolments / crm.providers / crm.provider_users / crm.disputes. portal_enabled gate baked into the helper for per-provider cutover.
- 0097 reactivated auto-flip + day-12 warning crons — applied alongside 0098 by accident, immediately disarmed via cron.unschedule SQL. Lesson: check `supabase migration list --linked` before push.
- 0098 Postgres triggers on crm.enrolments + leads.submissions + crm.providers — auto-fires `crm.sync_leads_to_brevo` on every relevant change.
- 0099 waitlist enrichment columns (start_timing, interest_breadth, investment_willingness, current_qualification, source_form, enriched_at) + extended trigger function.
- 0100 daily 04:45 UTC Brevo attribute reconcile cron — Layer 3 belt-and-braces.

**Brevo attribute set extended by 9 attributes today:**

- `SW_COURSE_SCHEDULE` (Wren ask, shipped earlier today, 143 contacts backfilled)
- `SW_PHONE`, `SW_LOST_REASON`, `SW_FASTRACK_COMPLETED`, `SW_FASTRACK_URL`, `SW_START_TIMING`, `SW_INTEREST_BREADTH`, `SW_INVESTMENT_WILLINGNESS`, `SW_CURRENT_QUALIFICATION` (Mable + Wren ask, all routed-active backfilled, 8 spot-checks confirmed clean)

**Provider sheet ↔ DB reconciles:**

- WYK (data-ops 016): 9 status corrections + 1 INSERT (Naomi @petsapp dedup child)
- EMS (data-ops 017): 6 status corrections + 2 INSERTs (Glennis Adamson dedup children)
- Courses Direct: no DB-side corrections needed (DB and sheet matched at Open across the board); held back from auto-flip per Marty's two-product-provider angle (separate funded provider Charlotte wants to onboard)
- Riverside: no leads yet
- DQ taxonomy consolidation (data-ops 018): 5 rows level/qual → overqualified, 3 rows location → region_mismatch. Form-side cleanup pushed to Mable's handoff.

**Code architecture changes:**

- `_shared/route-lead.ts`: 9 new SW_* attributes at all 3 composition sites (matched / U1 transactional / no-match-pending); SubmissionRow interface extended; SELECT statements extended; enrolment-status query extended to also pull lost_reason; `buildFastrackUrl(client_nonce)` helper added; utility list-add decoupled (env var now optional, ready for ~6 Aug list deletion per Wren).
- `_shared/ingest.ts`: parent_ref-first parent lookup with email fallback; 6 new fields captured from switchable-waitlist-enrichment payloads; parent UPDATE step that mirrors enrichment fields onto the parent row when parent_ref + parent resolved.
- `admin-brevo-resync/index.ts`: SELECT extended for new columns.
- `brevo-consent-reconcile-daily/index.ts`: redeployed (Session 35's redeploy hadn't taken; verified clean via manual trigger returning 200 with one drift correction).
- 4 Edge Functions redeployed.

**Cross-project pushes:** Nell (CD warm conversation), Mira (provider activity-gate framework), Clara (PPA portal-access review), Mable (DQ taxonomy form-side fix), Wren (`brevo-attribute-architecture.md` reference doc + delivery confirmations).

**Memory:** new `project_marty_dual_provider_angle`; updated `project_auto_flip_and_day12_deferred` (held until prerequisites land) + `feedback_query_live_pg_proc_before_patching` (broadened to cover constraints + indexes).

**Sign-off:** owner approved each migration before apply; 4 spot-checks across providers + funding categories confirmed Brevo aligned end-to-end.

---

## 2026-05-08: Added SW_COURSE_SCHEDULE Brevo contact attribute

**Type:** Additive Brevo contact attribute. No DB migration. Single shared file change in `_shared/route-lead.ts`. Three Edge Functions redeploy (every function that imports `_shared/route-lead.ts`).

**Status:** Code change applied. Pending Brevo dashboard attribute creation by owner + Edge Function redeploy + admin-brevo-resync sweep across already-routed contacts.

**Why:** Wren (Switchable Email Lead) flagged ahead of N1/N2/N3 nurture activation. N2 needs to answer "will I have the time?" with the actual course schedule string ("one day per week, 9:30am to 4:30pm" / "Monday to Friday, 10am to 4pm"), not a defer-to-provider line. The string already shows on the live funded page, just needed a contact attribute pipe. Fast-lane ahead of the broader per-course merge fields ticket (duration, outcomes, job titles, employers, next-qual progression) which lands later as one batch.

**Changes:**

- `_shared/route-lead.ts`: extended `MatrixRoute` interface with `schedule?: string`. Extended `MatrixContext` interface + `EMPTY_MATRIX_CONTEXT` + `readRoute` mapper with `courseSchedule`. Extended `composeBrevoCourseContext` return type + both branches (self-funded → empty string, funded → `matrix.courseSchedule ?? ""`). Added `SW_COURSE_SCHEDULE: ctx.courseSchedule` to all three Brevo attribute composition sites: `upsertLearnerInBrevo` (matched leads), `sendU1Transactional` template params (U1 send), `upsertLearnerInBrevoNoMatch` (no_match + pending leads, kept consistent so the contact record doesn't shift shape across lifecycle transitions).
- `switchable/email/CLAUDE.md`: attribute list updated, count bumped from 17 to 18 incl. FIRSTNAME/LASTNAME, footnote on source + self-funded behaviour.

**Source:** matrix.json already carries the `schedule` field per route (emitted by `switchable/site/deploy/scripts/build-funded-pages.js` line 513 from each page YAML's top-level `schedule:` field). No build script change needed. Live data verified for `counselling-skills-tees-valley`, `smm-for-ecommerce-tees-valley`, `lift-digital-marketing-futures-lift-boroughs` ahead of code change.

**Self-funded behaviour:** `composeBrevoCourseContext` already short-circuits matrix.json lookup for self-funded leads (their `course_id` is a YAML id, not a page slug). `SW_COURSE_SCHEDULE` lands as empty string for self-funded contacts, same shape as `SW_COURSE_NAME`, `SW_REGION_NAME`, etc. N2 only fires on `SW_FUNDING_CATEGORY in (gov, loan)` per the Brevo automation entry filter, so empty-on-self is irrelevant for the use this attribute exists for.

**Schema versioning:** additive-only on the Brevo contact contract. No schema_version bump required per `.claude/rules/schema-versioning.md`.

**Owner steps required:**

1. Add `SW_COURSE_SCHEDULE` as a **Text** contact attribute in Brevo dashboard (Contacts → Settings → Contact attributes).
2. Once attribute exists in Brevo, redeploy: `netlify-lead-router`, `routing-confirm`, `admin-brevo-resync`, `fastrack-receive` (all import `_shared/route-lead.ts`). Each with `--no-verify-jwt` per existing deploy posture.
3. Run `admin-brevo-resync` against the existing routed-contacts cohort (POST with submission ids of contacts who should have schedule populated; the function re-runs the upsert, picks up the new attribute from the redeployed code path). Verify a sample contact in Brevo carries the new attribute populated.
4. Once verified, Wren / Charlotte can use `{{ contact.SW_COURSE_SCHEDULE }}` in N2 template. N1/N2/N3 marketing automations are still being built and have not fired yet, so no in-flight sends affected.

**Sign-off:** owner approval ahead of build (this session).

---

## 2026-05-07 (later, evening): Fastrack back-end deployed end-to-end (lead-to-enrol uplift Phase 2)

**Type:** New Edge Function + 2 migrations + 2 Edge Function patches + Apps Script update mode + manual sheet redeploys + Netlify webhook wiring. Schema additive only.

**Status:** Live and exercised end-to-end on all three paths. Tests 1 + 2 verified before Mable's fix; Test 3 (cohort decline) initially blocked on a frontend issue (Netlify Forms silently drops POSTs to URLs carrying query params, so the cohort=no rewritten action never registered as a form submission); Mable diagnosed + shipped a fix in switchable/site Session 58 evening — form now POSTs to the clean `/funded/thank-you/` URL and JS navigates to the DQ-encoded URL after success. Test 3 re-verified live (fastrack child id 4, owner-test, `cohort_confirmed=false` correctly recorded, no dead_letter). First real fastrack from a non-owner-test learner (Mr Whitehead, parent 316) landed mid-evening — DB writes all correct (parent + child + asymmetric consent + fastracked_at), but the sheet update failed with `sheet has no Submission ID column for update mode` because EMS sheet had never had a Submission ID header (route-lead.ts has been silently dropping that field on append for months — append mode tolerates missing headers, update mode doesn't). Owner added Submission ID column to EMS + WYK sheets and manually filled Mr Whitehead's row (Submission ID, Fastrack Application Filled, Fastrack Details). Side-effect dead_letter 158 bulk-resolved via dashboard. Future fastracks ride the automatic path end-to-end now that the column exists for new appends.

**Why:** Mable shipped the Fastrack form front-end this evening as switchable/site Session 57 (commit `2d56a29`). Funded thank-you page now has a Fastrack form that captures cohort confirmation, doc readiness, voice-of-learner intro for the EMS adviser, and an L3 reconfirmation cross-check (catches the L3 leakage Daniel Manning flagged from EMS for counselling-skills-tees-valley). Front-end was sitting hot waiting for platform plumbing. Owner pushed for tonight cutover so first real funded learner tomorrow morning lands in the new pipeline.

**Changes (in execution order):**

1. **Migration 0089** — extended `crm.enrolments.lost_reason` CHECK constraint with `l3_mismatch_self_reported` and `cohort_decline`. Pre-flight requirement called out in the platform Session 34 PUSH FROM block — fastrack-receive's DQ flip would have tripped the existing constraint without this. DROP + re-ADD pattern matching migration 0082; DOWN block carries an explicit precondition that the new values must be at zero rows before reverting.

2. **Migration 0087** — `leads.fastrack_submissions` table + two new columns on `leads.submissions`:
   - `client_nonce` UUID (nullable, partial index on NOT NULL) — set by the funded form's pre-submit JS, identifies the parent submission via the post-submit redirect's `?ref=<uuid>` URL param without exposing PII.
   - `fastracked_at` TIMESTAMPTZ (nullable, partial index on NOT NULL) — fast filter for "fastracked vs not" without joining the child table.
   - `leads.fastrack_submissions` — discrete typed columns per captured fastrack field, FK to parent submission, RLS + role grants matching the leads-schema convention from 0001.
   
   Migration was un-applied as of session start (Mable created the file between sessions); my Phase 5 sunset cron took 0088 to avoid collision. Applied via `supabase db push --linked --include-all`.

3. **`netlify-lead-router` patched** with two changes, redeployed:
   - `client_nonce` write-through in `_shared/ingest.ts` (single field added to the `CanonicalSubmission` interface, the normaliser base, the INSERT column list, and the values list, plus a new `parseClientNonce` helper mirroring `parseSessionId`'s UUID validation pattern).
   - `formName === "fastrack-funded-v1"` early-return filter (mirrors the existing `contact` filter pattern). Netlify's site-wide outgoing webhook fires `netlify-lead-router` for every form submission including fastrack; without this filter, fastrack form submissions would land as spurious rows in `leads.submissions`. The dedicated `fastrack-funded-v1` → `fastrack-receive` webhook handles the real fastrack processing.
   
   `netlify-leads-reconcile` redeployed in lockstep (same `_shared/ingest.ts` import) — both functions emit identical canonical rows for the same Netlify payload, per the architecture invariant in the file's header comment.

4. **`fastrack-receive` Edge Function** (NEW) — 8-step pipeline:
   1. Verify Netlify auth (URL-secrecy + TLS, no shared secret — same pattern as `netlify-lead-router`).
   2. Parse fastrack payload (schema 1.0).
   3. Look up parent submission via `client_nonce`. Missing parent → `leads.dead_letter` source=`fastrack_form`, return 200 (data not lost).
   4. Compute `l3_mismatch_flag` (`body.l3_reconfirmed === true`) and `cohort_decline_flag` (`body.cohort_confirmed === false`).
   5. Insert child row in `leads.fastrack_submissions`.
   6. Stamp `leads.submissions.fastracked_at` on parent (best-effort).
   7. Asymmetric marketing: only an explicit `body.marketing_opt_in === true` writes a fresh `crm.consent_history` row. False/blank does NOT downgrade prior consent (parent stays source of truth; withdrawal flows through Brevo unsubscribe links).
   8. DQ flip: l3 mismatch precedence, then cohort decline. `UPDATE crm.enrolments SET status='lost', lost_reason=…, status_updated_at=now()`. Best-effort failures land in `leads.dead_letter` source=`fastrack_side_effect` so they're visible without poisoning the success path.
   9. Sheet update via `provider-sheet-appender-v2` in `update_by_submission_id` mode (see #5). Best-effort, side-effect dead_letter on failure.
   10. Return 200 with `fastrack_submission_id`, `parent_submission_id`, computed flags, and `lost_reason` (or null).

5. **`provider-sheet-appender-v2.gs` extended with `update_by_submission_id` mode** (in-place file revision, additive — default mode stays `append` so existing `routing-confirm` + `auto-route` callers are unaffected). Update mode:
   - Finds the row whose `Submission ID` column equals `body.submission_id` (exact-match string compare to handle Sheets' numeric storage).
   - Errors with no write if zero or multiple rows match.
   - Updates only cells whose payload values are non-empty (won't overwrite Status with empty string just because the payload didn't include it).
   
   Owner manually pasted the new script + redeployed on the EMS + WYK provider sheets via `Manage deployments → New version` (kept existing webhook URLs stable). Courses Direct sheet skipped — they're self-funded only and fastrack only fires on funded leads. EMS + WYK sheets each gained two new column headers: `Fastrack Application Filled` (yes/no) and `Fastrack Details` (free text). Owner inserted these by replacing the unused `Enrolment date` and `Charge` columns rather than appending — header-driven appender handles position-agnostically.
   
   FIELD_MAP additions: `fastrackapplicationfilled` → `fastracked`, `fastrackdetails` → `fastrack_notes`, plus a `lostreason` → `lost_reason` entry for the DQ flip writes (and aliases `fastracked` + `fastracknotes` for header naming flexibility).

6. **Mid-test bugfix** — first deploy of `fastrack-receive` referenced a non-existent `lost_at` column on `crm.enrolments` in the DQ status flip. Test 1 (happy path) didn't trigger it. Test 2 (L3 mismatch) would have, except the bug was caught at DB query time before Test 2 fired (running a verification query failed on the same column). The existing pattern in `crm-webhook-receiver` and `sheet-edit-mirror` uses `status_updated_at` as the lost-timestamp; corrected fastrack-receive to match, redeployed before Test 2. No data corruption — Test 1 didn't write to `crm.enrolments` (owner-test rows have no enrolment row), and Test 2 hit the corrected version.

7. **Netlify webhook wiring** — owner added a per-form outgoing webhook on `fastrack-funded-v1` → `https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/fastrack-receive`. Existing site-wide "any form" → `netlify-lead-router` webhook stays; the filter in #3 makes it no-op cleanly for fastrack submissions.

8. **`form-allowlist.json`** — set `webhook_url` for `fastrack-funded-v1` (was `null`). Picked up by Mable's switchable/site Session 58 deploy.

**Test results (owner-test using `charliemarieharris@icloud.com`):**

- **Test 1, happy path** — parent 313, fastrack child id 1, `l3_mismatch_flag=false`, no DQ flip, `fastracked_at` stamped. Asymmetric marketing handler correctly skipped writing a fresh consent row (parent already had `marketing_opt_in=true`; fastrack form's JS hid the checkbox per `?m=1` URL param and posted `marketing_opt_in=false`, asymmetric handler preserved prior consent). No dead_letter rows. Sheet write skipped (owner-test parent has `primary_routed_to=null`).
- **Test 2, L3 mismatch DQ** — parent 314, fastrack child id 2, `l3_reconfirmed=true` → `l3_mismatch_flag=true`. lost_at column bug had been fixed before this fired; no dead_letter rows. Asymmetric marketing handler correctly wrote a fresh `crm.consent_history` row (parent had `marketing_opt_in=false`, fastrack form's checkbox was visible and ticked, came in as true). Enrolment UPDATE WHERE submission_id=314 affected 0 rows (owner-test has no enrolment) — UPDATE syntax verified clean against the live schema.
- **Test 3, cohort decline DQ** — parent 315 created. Fastrack form's submit handler fired client-side (URL rewrote to `?fastracked=1&cohort=no`, DQ confirmation card rendered correctly), but the form POST never reached Netlify Forms — dashboard for `fastrack-funded-v1` showed only Test 1 + Test 2. Diagnosed as a Netlify edge behaviour: when the form action carries query params, Netlify silently drops the POST without form-handler processing (returns 200 with the static page HTML, the wrapper's fetch sees 200 and navigates without Netlify ever creating a submission). Pushed to Mable's switchable/site Session 58 with diagnostic context. **Mable shipped a fix the same evening** — form now POSTs to the clean `/funded/thank-you/` URL (no query params), JS navigates to the DQ-encoded URL via `window.location.href` after the POST succeeds. Test 3 re-verified end-to-end on the fix: fastrack child id 4 landed for owner-test parent 317 with `cohort_confirmed=false`, no dead_letter, no enrolment update fired (owner-test has none).
- **First real fastrack** (after Tests 1 + 2, before the cohort-decline fix landed): Craig Whitehead, `mrwhitehead@hotmail.co.uk`, parent 316, fastrack child 3. Happy path (cohort=yes, l3=no, docs=no soft flag, voice="A career change"). All DB writes correct (parent + child + fastracked_at, asymmetric consent skipped because parent already had `marketing_opt_in=true` from funded form). **Sheet write failed** with `sheet has no Submission ID column for update mode` — EMS sheet had never had a Submission ID header (route-lead.ts has been silently dropping the field on append for months because no header matched; append mode tolerates this, update mode does not). Owner added Submission ID column to EMS + WYK sheets and manually filled Mr Whitehead's row (Submission ID = 316, Fastrack Application Filled = "yes", Fastrack Details = composed summary with the docs-gathering flag). Dead_letter 158 (`fastrack_side_effect`) bulk-resolved via the data-health dashboard. **All future fastracks now ride the automatic path end-to-end** — route-lead.ts will populate Submission ID on every new lead append, fastrack-receive's update mode finds the row by that key. Mr Whitehead is the one casualty of the missing-column oversight, recovered manually. Lesson saved to memory: pre-flight ALL columns the new code path references, not just the new ones being added.

**Open watch items (next 24h):**

- ~~First real fastrack submission from a non-owner-test learner~~ — landed and resolved tonight (Mr Whitehead, parent 316). Manual sheet fill applied; DB clean; future fastracks will ride the automatic path now that the Submission ID column exists.
- ~~Mable's cohort_decline fix landing~~ — shipped same evening, end-to-end verified.
- Form-allowlist audit (`netlify-forms-audit` daily run) — should pass on tomorrow's run after Mable's switchable/site Session 58 deploy landed `webhook_url` for `fastrack-funded-v1`.
- Sheet write reliability for the next several real fastracks — first one had to be manually fixed; subsequent ones should be automatic. Watch `leads.dead_letter` source=`fastrack_side_effect` for any new entries.

**Follow-up addition (same session):** Migration 0090 + admin dashboard fastrack surfacing.

- **Migration 0090** — `admin_read_fastrack_submissions` SELECT policy on `authenticated` role + table-level GRANT, mirroring the pattern in 0014 for the other admin-readable tables. Without this the admin dashboard's authenticated session couldn't see fastrack rows even though 0087 had created the table with RLS — only `functions_writer` and `readonly_analytics` had policies. Caught when querying `pg_policies` while wiring up the new fastrack card.
- **Admin lead detail page** (`platform/app/app/admin/leads/[id]/page.tsx`) — added a Fastrack submission card after the re-application banner and before the enrolment outcome form. Surfaces cohort confirmed, transport help, docs ready, L3 reconfirmed, marketing opt-in, terms accepted, voice-of-learner intro. Top-of-card badges fire on `l3_mismatch_flag`, `cohort_confirmed=false`, `docs_ready=false`, `transport_help_requested=true`. Header gains a violet "Fastracked" badge whenever `lead.fastracked_at` is set, alongside the Routed/DQ badge. Hidden entirely when the lead has no fastrack data. Falls back to a "fastracked_at stamped but no child row found" warning if the parent's timestamp is set but no child row exists (data inconsistency canary). TypeScript check clean. List-view fastracked indicator deferred (not asked for, future enhancement).

**Two issues surfaced overnight via Sasha's data-health dashboard, fixed in the same session (2026-05-08 morning):**

- **`netlify-leads-reconcile` was back-filling fastrack-funded-v1 submissions as spurious unknown-form DQ leads.** The site-wide Netlify webhook fires for every form including fastrack-funded-v1; netlify-lead-router correctly filters fastrack out of its insert path. Reconcile then sees those Netlify submissions, fails to find them in `leads.submissions`, and back-fills them. **Fix:** mirror the same `if (formName === "fastrack-funded-v1") continue;` filter in `netlify-leads-reconcile/index.ts` (immediately after the existing `contact` skip). Redeployed. 7 spurious rows generated by the unfiltered reconcile (ids 318/319/320/321/324/326/327, all `dq_reason='unknown_form:fastrack-funded-v1'`) will be archived in a one-shot data fix. The fastrack child rows for the corresponding parents are all correctly landed in `leads.fastrack_submissions` (ids 1-7) — none of the user-facing fastrack data was lost.
- **`brevo-consent-reconcile-daily` cron tripped a CHECK constraint** on `crm.consent_history` for 4 of 6 drifted contacts. Drift was 6/227 = 2.64%, exceeding the 2% threshold. The cron writes audit rows with `changed_by='system:cron:brevo-consent-reconcile-daily'` and `source='reconcile_brevo_to_db'`, neither of which is in the CHECK constraint allowed set from migration 0074 (`changed_by IN ('contact','system','admin','backfill')`, `source IN ('form','unsubscribe_link','spam_complaint','admin_dashboard','api','reconcile_cron','backfill')`). The transaction wrapping (UPDATE submissions + INSERT consent_history) rolled back atomically, so DB state stayed at the drifted value. **Fix:** changed the cron to `changed_by='system'` + `source='reconcile_cron'` (both in the existing CHECK), with the descriptive cron name + direction moved into the metadata JSON. Redeployed. Tomorrow's 04:00 UTC run will retry the 4 failed corrections; they should succeed cleanly. The 2 contacts in the other direction (`brevo_unblocked_db_no_consent`) are intentionally not auto-corrected per the cron's design.

**Signed off:** Owner (this session, 2026-05-07 evening).

---

## 2026-05-07: Email rearch cutover ritual completed

**Type:** Production state change. 4 Edge Function deploys, 6 migrations applied, env-var flip, 8 Brevo automations disabled, one-off backfill executed. No new schema beyond what migrations 0080-0085 introduce.

**Status:** Live end-to-end. Brevo channel state aligned with `marketing_opt_in` for 47 contacts mutated this run. Two-channel architecture (utility on Transactional API, marketing on Email campaigns channel) operating as designed — verified by Charlotte in Brevo dashboard: opted-out contacts show `emailBlacklisted=true` for marketing while transactional sends continue.

**Why:** Tuesday's cutover bundle (per Session 33 handoff) deployed 5 Edge Functions but didn't complete the rest of the ritual — `BREVO_SHADOW_MODE` was never flipped to false, migrations 0080-0085 weren't applied, the 3 cron functions weren't deployed, legacy automations stayed active, and the Phase 3c backfill never ran. Effective state was "shadow log-only mode with legacy automations doing the real work" — looked green on the dashboard because nothing was breaking, but nothing had cut over either. This session ran the missing pieces.

**Changes (in execution order):**
1. **`BREVO_SHADOW_MODE=false`** — set in Supabase Vault. Edge Functions read this on cold start; within seconds, all callers (`routing-confirm`, `netlify-lead-router`, `email-stalled-cron`, `email-u4-cron`, `admin-brevo-chase`) switched from log-only to real Transactional API sends.
2. **4 Edge Functions deployed** via `supabase functions deploy --no-verify-jwt`:
   - `brevo-consent-reconcile-daily` (NEW) — daily 04:00 UTC drift check between Brevo channel state and `marketing_opt_in`.
   - `email-failure-alert-daily` (NEW) — daily 04:30 UTC alert if ≥3 transactional sends failed in last 24h.
   - `email-presumed-warning-cron` (NEW) — daily 05:00 UTC, dormant until `BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING` is set + auto-flip is re-enabled (both indefinitely deferred per owner).
   - `sheet-edit-mirror` (REDEPLOY) — Tuesday's row_email cross-check now active end-to-end.
3. **Migrations 0080-0085 applied** via `supabase db push --linked`:
   - 0080: pause_enrolment_auto_flip — **patched to be idempotent (DO/IF EXISTS)** because the manual unschedule from Tuesday's incident response had already removed the job; first apply attempt threw XX000.
   - 0081: brevo_consent_reconcile_cron schedule.
   - 0082: lost_reason CHECK expansion (`cancelled`, `withdrew_after_enrolment`).
   - 0083: email_failure_alert_cron schedule.
   - 0084: email_log `provider_presumed_warning` email_type added.
   - 0085: email_presumed_warning_cron schedule.
4. **8 legacy Brevo automations disabled** in Brevo dashboard (status → Off, templates archived). 90-day rollback retention (until 2026-08-05). Dual-send window between step 1 and step 4 was ~10 minutes; any leads landing in that window may have received duplicate U1 emails (low risk at current volumes; not flagged a real-world incident yet).
5. **`data-ops/013_backfill_email_campaigns_channel.ts --apply`** — second apply attempt succeeded after script patched to use `field_changed='email_campaigns_subscription'` (lowercase, matches existing CHECK constraint). Final summary: processed 225, mutated 47, skipped 178, errors 0.

**Audit gap from the failed first apply:** the script blocks Brevo BEFORE writing the `crm.consent_history` audit row. ~30 contacts got `emailBlacklisted=true` in Brevo during the first apply attempt, but the consent_history INSERT failed (CHECK constraint violation on the `EMAIL_CAMPAIGNS_CHANNEL` value the script was using). Brevo state for those contacts is correct (matches their `marketing_opt_in=false`); audit trail row is missing. Repair task queued for next session — write a one-shot SQL INSERT to backfill the missing rows with `source='backfill'`, `metadata.reason='audit_repair_after_2026-05-07_partial_failure'`.

**Other incidents handled this session:**
- **Brevo API key exposure:** during the live-apply attempt, the owner pasted a Brevo API key into a `read -p` command (bash syntax that doesn't work in zsh) where the key ended up in shell history + chat log. Investigation showed the leaked key didn't match any active key in the Brevo dashboard — already deleted at some prior point. No rotation needed. Owner generated a new one-off "platform" key for the backfill itself; can be deleted post-session.
- **DB password reset:** the owner's local `SUPABASE_DB_URL` connection failed DNS resolution (direct connection host `db.<ref>.supabase.co` not reachable from owner's network, and credentials weren't to hand anyway). Owner reset the database password via Supabase dashboard, switched to the Session pooler URL (`aws-0-...pooler.supabase.com:5432`). Edge Functions auto-updated to the new password (Supabase manages `SUPABASE_DB_URL` injection); no action required there.

**Smoke test:** Brevo dashboard confirms two-channel state correct for sample of opted-out and opted-in contacts. `/admin/automations` page green throughout (was already deployed pre-cutover).

**Signed off:** Owner (this session, 2026-05-07).

---

## 2026-05-07: Phase 5 prerequisite — email-sunset-cron + re_engagement email type (migration 0088)

**Type:** New Edge Function, new daily cron, CHECK constraint extension on `crm.email_log.email_type`. No table or column added.

**Status:** Function + migration written, awaiting `supabase functions deploy email-sunset-cron --no-verify-jwt` and `supabase db push --linked`. Phase 1 (re-engagement send) is dormant until `BREVO_TEMPLATE_RE_ENGAGEMENT` is set in Supabase Vault — owner's task once she creates the Brevo template. Phase 2 (suppression) runs regardless.

**Why:** Spec deliverability section ("Sunset policy") flags this as a prerequisite for any marketing automation going live. Without engagement-based sunset, every contact who never opens a marketing email continues to receive sends indefinitely. At pilot volumes (low hundreds) the reputational cost is small; once N1-N3 + referrals + monthly newsletter are firing, dead-inbox accumulation tanks the inbox-placement rate for everyone else. The architecture handles it natively (Email campaigns channel state, marketing_opt_in flag, channel-level unsubscribe), so the cron just has to drive the state transitions.

**Algorithm:**
- **Phase 1 (re-engagement):** candidates are `marketing_opt_in=true` Switchable contacts where (a) the earliest `crm.email_log` send is ≥180 days ago — they've genuinely had time to engage, brand-new contacts are exempt — AND (b) no `opened` or `clicked` rows in `email_log` in the last 180 days, AND (c) no prior `re_engagement` row at all (one-shot per contact). Function picks the most recent submission per email as the recipient and fires `sendTransactional` with `email_type='re_engagement'`. `metadata.shadow_log_only` falls out naturally from `BREVO_SHADOW_MODE` (currently `false` post-cutover, so real sends go).
- **Phase 2 (suppress):** candidates are contacts whose earliest `re_engagement` send was ≥14 days ago AND who have no `opened`/`clicked` rows after that re-engagement triggered_at AND still carry `marketing_opt_in=true` in our DB (idempotent on previously-suppressed contacts). For each, the function (1) writes a `crm.consent_history` row (`source='sunset_suppression'`), (2) flips `marketing_opt_in=false` on every matching `leads.submissions` row via `functions_writer` (column-level grant from migration 0079), (3) calls `upsertBrevoContact` with `marketingOptIn=false` to push `SW_CONSENT_MARKETING=false` and channel=unsubscribed. Mirrors the Phase 3a `brevo-event-webhook` suppression pattern.

**Asymmetry:** only the marketing (Email campaigns) channel is suppressed. Transactional (utility) sends — U1, stalled, chaser, U4 — keep working because their basis is contract not consent. Same family of asymmetric rule as the Phase 3c backfill (only-block-never-unblock).

**Changes:**
- Migration 0088: ALTER `crm.email_log.email_type` CHECK to add `re_engagement`. ALTER `crm.consent_history.source` CHECK to add `sunset_suppression` (Phase 2 audit rows need this label distinct from `unsubscribe_link` / `spam_complaint` / `reconcile_cron`). Schedule pg_cron `email-sunset-cron-daily` at `0 3 * * *` (03:00 UTC, 1h before `brevo-consent-reconcile-daily` so suppression flips settle before reconcile reads).
- New Edge Function `supabase/functions/email-sunset-cron/index.ts`: 250ms throttle, 500-candidate cap per run per phase, `x-audit-key` auth via vault.
- `supabase/functions/_shared/brevo.ts`: extended `EmailLogType` union with `"re_engagement"`.
- `supabase/config.toml`: `[functions.email-sunset-cron]` `verify_jwt = false`.
- `platform/docs/infrastructure-manifest.md`: function + cron + env-var rows + manifest changelog entry.

**Impact assessment (per `.claude/rules/data-infrastructure.md` §8):**
1. Change: see Changes above.
2. Readers: function reads `leads.submissions`, `crm.email_log`. No new readers introduced beyond the function itself.
3. Writers: function writes `crm.email_log` (via `sendTransactional`), `crm.consent_history`, and `leads.submissions.marketing_opt_in` (Phase 2 only).
4. Schema version: not affected.
5. Data migration: none.
6. Role/policy: Phase 2 path uses `SET LOCAL ROLE functions_writer` (existing grant from migration 0079).
7. Rollback: `cron.unschedule` + DOWN reverts CHECK constraint (guarded — won't drop the value if `re_engagement` rows exist).
8. Sign-off: owner (this session, 2026-05-07).

**Smoke test plan (after deploy):**
- POST function URL with `x-audit-key` → expect 200 and `{ reengagement: { candidates: 0, sent: 0, ... }, suppression: { candidates: 0, ... } }` for first run (no qualifying contacts at pilot volumes).
- After Charlotte sets `BREVO_TEMPLATE_RE_ENGAGEMENT` and the cron has run a day, manual force-trigger (`SELECT cron.alter_job(jobid, schedule := '0 3 * * *')` to re-run) won't re-fire to anyone already sent (idempotent at email_log via the NOT EXISTS guard on `re_engagement`).
- First real qualifying contact won't appear until ~2026-11-04 (180 days after the earliest 2026-05-05 email_log row), so the cron is effectively a no-op for the next ~6 months. Expected.

**Signed off:** Owner (session 2026-05-07).

---

## 2026-05-07: Phase 4 closeout — drop crm.enrolments.last_chaser_at, derive from email_log (migration 0086)

**Type:** Schema change (drop column), new read-time view, function body rewrite, data backfill.

**Status:** Migration written, awaiting `supabase db push --linked`. Three dashboard files updated to consume the new view / derive from email_log directly. No production impact until the migration applies.

**Why:** End the dual-write between `crm.fire_provider_chaser` (which stamped `crm.enrolments.last_chaser_at` synchronously) and `admin-brevo-chase` via `sendTransactional` (which writes the canonical `crm.email_log` row asynchronously through pg_net). The two writers could disagree — a pg_net invocation failure left `last_chaser_at` stamped while no `email_log` row existed, so the dashboard would say "chased" when nothing went out. Spec line 159 deferred the choice to Phase 4 between (a) drop the column and derive at read time, or (b) replace it with a `GENERATED ALWAYS AS` expression. Postgres generated columns can only reference other columns in the same row (cross-table aggregates are not supported), so option (b) was unimplementable. Option (a) is the only real choice — and the cleaner end state, since email_log already has full per-send fidelity.

**Changes:**
- Migration 0086: backfill INSERT into `crm.email_log` for any `crm.enrolments.last_chaser_at IS NOT NULL` without a matching chaser row (NOT EXISTS guard against the dual-write window). Synthetic rows tagged with `metadata = {"backfill": true, "source": "0086_drop_last_chaser_at", "note": "..."}`, `template_id = '__backfill__'` since historical sends went through Brevo automations not the Transactional API. Type chosen by the submission's `funding_category` (defaults to `chaser_funded` for null/missing).
- Migration 0086: new view `crm.vw_enrolments_chaser_state` exposing `e.*` plus a derived `latest_chaser_at` from `MAX(triggered_at)` over `chaser_funded` / `chaser_self` rows in healthy delivery states (`sent`, `delivered`, `opened`, `clicked`). Inherits RLS from underlying tables. SELECT granted to `authenticated` and `readonly_analytics`.
- Migration 0086: `crm.fire_provider_chaser(BIGINT[])` rewritten to drop the `UPDATE crm.enrolments SET last_chaser_at = now()` step. Function still does eligibility filtering, audit log (`p_after = {chaser_fired_at: now()}`), and pg_net call into `admin-brevo-chase`. The Edge Function's existing `sendTransactional` call writes the canonical `email_log` row.
- Migration 0086: `ALTER TABLE crm.enrolments DROP COLUMN last_chaser_at`.
- `app/admin/layout.tsx`: two badge-count queries (`needsChasingCount`, `cannotReachNoChaserCount`) now query `crm.vw_enrolments_chaser_state` against `latest_chaser_at`.
- `app/admin/leads/page.tsx`: dropped `last_chaser_at` from the enrolments selection. New `lastChaserBySubId` Map derived from the existing `email_log` query (filter `email_type IN (chaser_funded, chaser_self)`, healthy status set, MAX `triggered_at` per submission). Render lookup updated.
- `app/admin/actions/page.tsx`: "Needs another chase" and "Cannot reach but no chaser" queues now read `crm.vw_enrolments_chaser_state.latest_chaser_at`. Type definition + render lookup renamed.
- `app/admin/leads/bulk-actions.ts`: doc comment on `fireProviderChaser` updated to reflect the single-source model.

**Impact assessment (per `.claude/rules/data-infrastructure.md` §8):**
1. Change: see Changes above.
2. Readers affected: `app/admin/layout.tsx`, `app/admin/leads/page.tsx`, `app/admin/actions/page.tsx`. All updated in this session.
3. Writers affected: `crm.fire_provider_chaser` only; rewritten in this migration. `admin-brevo-chase` already writes `email_log` via `sendTransactional` and needs no change.
4. Schema version: not affected (internal column, no external contract).
5. Data migration: backfill of historical chaser sends. Idempotent via NOT EXISTS guard.
6. Role/policy: SELECT grant on the new view to `authenticated` + `readonly_analytics`. No new role.
7. Rollback plan: DOWN re-adds the column, repopulates from `email_log` MAX, drops the view, restores the original `fire_provider_chaser` body. Lossy in one direction only — synthetic backfill rows are tagged with `metadata.backfill=true` and can be filtered out of "real send" analytics.
8. Sign-off: owner (this session, 2026-05-07).

**Smoke test plan (post-`supabase db push`):**
- `SELECT COUNT(*) FROM crm.email_log WHERE metadata->>'backfill' = 'true' AND metadata->>'source' = '0086_drop_last_chaser_at'` returns expected row count (matches `SELECT COUNT(*) FROM crm.enrolments WHERE last_chaser_at IS NOT NULL` from a pre-drop snapshot).
- `SELECT COUNT(*) FROM crm.vw_enrolments_chaser_state WHERE latest_chaser_at IS NOT NULL` matches the same number.
- `\d crm.enrolments` shows no `last_chaser_at` column.
- Dashboard `/admin/leads` "Last chaser" column renders the same dates as before for routed leads.
- Dashboard `/admin/actions` "Needs another chase" and "Cannot reach but no chaser" queues populate the same way.
- `/admin/layout` action badge count matches pre-cutover number for known-active rows.

**Signed off:** Owner (session 2026-05-07).

---

## 2026-05-05: Phase 3a — brevo-event-webhook now flips marketing_opt_in on unsub/spam events (migration 0079)

**Type:** Behaviour change in `brevo-event-webhook` Edge Function. New RLS UPDATE policy + column-level grant on `leads.submissions` for the `functions_writer` role. No table or column added.

**Status:** Migration 0079 applied. Function redeployed `--no-verify-jwt`. Phase 3 lifecycle gate is now closed end-to-end for the webhook reactor side; the proactive-push side (Phase 3b — `upsertBrevoContact` syncing channel state on every contact upsert) and backfill (3c) and reconciliation cron (3d) are queued for next session.

**Why:** Phase 1 of the rearchitecture left a known gap: when a Brevo unsubscribe / spam event arrives, the function logged it to `crm.consent_history` but did NOT flip the source-of-truth `marketing_opt_in` flag on `leads.submissions`. Without this, the moment Phase 5 marketing automations launch, an entry filter reading the attribute on the Brevo contact would be correct, but our admin dashboard view of "did this person consent?" would show stale data — and any future code that re-evaluates marketing eligibility from our DB would target unsubscribed learners.

**Changes:**
- Migration 0079: column-level `GRANT UPDATE (marketing_opt_in) ON leads.submissions TO functions_writer` + RLS policy `functions_writer_consent_updates` (USING true / WITH CHECK true). Mirrors the column-level grant pattern from migration 0072 for owner-test toggling.
- `brevo-event-webhook/index.ts`: on `unsubscribed` / `spam` / `complaint` events, after the `consent_history` insert, the function now (1) flips `marketing_opt_in=false` on every `leads.submissions` row matching the recipient email (idempotent — `WHERE marketing_opt_in = true`), and (2) pushes `SW_CONSENT_MARKETING=false` as an attribute update via `upsertBrevoContact` so the Brevo contact's attribute matches our DB. Both are best-effort — failures log and continue, since the `consent_history` row already captures what happened and Brevo's channel-level unsubscribe is already in place from when the user clicked the unsub link.

**What this does NOT do (queued for next session):**
- Push channel-subscription state on every routing-time contact upsert (Phase 3b). New contacts who said "no" at signup still get channel=subscribed at Brevo by default until 3b ships.
- One-off backfill of existing contacts (Phase 3c).
- Daily reconciliation cron between Brevo and Supabase (Phase 3d).

These are not blocking — Brevo's own channel-level unsubscribe handling is the actual deliverability gate, and there are zero marketing automations live yet to mistarget. The remaining Phase 3 pieces tighten the belt-and-braces layer; Phase 3a closes the most-visible compliance gap (the admin dashboard's view of consent state was about to start lying).

**Smoke test:** no live event to test against until either a Phase 5 marketing email gets unsubscribed OR a current utility email gets marked spam. The function's path is type-checked + deployed; first real unsub will exercise it. Pre-existing `sql.json` deno-check warnings (also present in route-lead.ts and unrelated) noted but not blocking — Edge Function deploys aren't strict-mode.

**Signed off:** Owner (session 2026-05-05).

---

## 2026-05-05: Phase 2 shadow mode flipped from real-send to log-only

**Type:** Behaviour change in `_shared/brevo.ts` `sendTransactional`. No schema change.

**Status:** Code shipped. Will take effect on next redeploy of the 5 callers (`routing-confirm`, `netlify-lead-router`, `email-stalled-cron`, `email-u4-cron`, `admin-brevo-chase`).

**Why:** Initial Phase 2a/2b implementation matched the spec's "still adds to utility list AND sends transactional" wording — every routed lead would receive the U1 (and eventually stalled/U4/chaser) twice during the parity window, once from the legacy automation and once from the new transactional path. Owner flagged the duplicate-email annoyance for real learners as not worth the parity-verification benefit, especially given the U1 funded path was already verified end-to-end via this morning's smoke test.

**Changes:**
- `sendTransactional` now short-circuits when `BREVO_SHADOW_MODE=true`: writes the `crm.email_log` queued row, immediately flips it to `status='sent'`, and returns without calling the Brevo API. `metadata.shadow_log_only=true` is set on insert so post-cutover analytics can filter these rows out cleanly. `brevo_message_id` stays NULL — that's the unambiguous signal that the row didn't actually leave Brevo.
- Lead detail page metadata pill now shows "log-only" instead of generic "shadow" for these rows, with a tooltip explaining the old automation handled the actual send.

**What this changes for the 48h window:**
- Real learners receive ONE U1 (from the legacy automation), not two.
- The new code path still runs end-to-end except for the Brevo HTTP call: query selects the right template, params compute, `email_log` row written, idempotency works.
- `email_log` parity check (today's SQL query / new dashboard column) still works — rows show `status=sent`.
- Verification gap: we don't re-verify Brevo's actual rendering / DKIM / deliverability for U1 self, stalled, chaser, U4 in this window. Mitigation: U1 funded already verified this morning; the others use identical code paths with different template IDs. Risk is small, contained to first real send post-cutover (Thursday).

**Cutover Thursday:** flip `BREVO_SHADOW_MODE=false` and redeploy the 5 functions. Same redeploy step disables the legacy automations in Brevo (Charlotte's task in dashboard, not code).

**Signed off:** Owner (session 2026-05-05).

---

## 2026-05-05: Email platform rearchitecture, Phase 6a — admin dashboard email_log visibility

**Type:** Two dashboard pages updated. No DB change. Read-only consumer of `crm.email_log`.

**Status:** Code shipped to `main`. Local production build green. Will deploy on next git push (Netlify auto-builds from `./app` on every push to main).

**Why:** The Phase 2 shadow window needs ongoing parity verification — "did this lead get U1?" — across the next 48-72h. Without dashboard visibility Charlotte would be running raw Supabase SQL twice a day. Phase 6 in the spec eventually grows into a full automations-status page; Phase 6a is the minimum viable surface that replaces the manual SQL workflow.

**Changes:**
- `app/admin/leads/[id]/page.tsx`: new "Email log" Card between Routing history and Error replays. Shows chronological table of every `crm.email_log` row for the lead (email_type, channel, status, sent_at, brevo_message_id, error_text). Status badges colour-coded by family (`sent`/`delivered`/`opened`/`clicked` = healthy green, `failed`/`bounced_*`/`complained` = red, others neutral). Shadow + forced metadata rendered as small outline pills.
- `app/admin/leads/page.tsx`: new "U1" column between "Lead status" and "Last chaser". Per-row badge shows the latest U1 status for that submission. Pre-Phase-2 leads (submitted before 2026-05-05 12:00 UTC) and DQ/unrouted leads correctly render as `—` rather than "missing" — that distinction is the at-a-glance parity check.
- Both pages stay within the existing supabase-server / RLS read pattern (admin policy on `crm.email_log` from migration 0073). No new Edge Function or migration.

**Smoke test:** `npm run build` clean. Routes `/admin/leads` and `/admin/leads/[id]` listed in build output. Detail page already validated against today's `crm.email_log` row (submission 288 u1_funded, sent, shadow=true) — column shape matches the page's typing.

**Signed off:** Owner (session 2026-05-05).

---

## 2026-05-05: Migration 0078 — split chaser email_type into funded + self (Phase 2b follow-up)

**Type:** Constraint change on `crm.email_log.email_type` CHECK. No data migration (no `chaser` rows existed yet — verified before applying).

**Status:** Applied to production via `supabase db push --linked`. `admin-brevo-chase` redeployed with funded/self branching. `BREVO_TEMPLATE_CHASER_FUNDED=6` + `BREVO_TEMPLATE_CHASER_SELF=12` set in Supabase Vault. Chaser dual-fire now end-to-end live.

**Why:** The Phase 2b spec assumed a single chaser template, but Charlotte's actual Brevo setup has two (funded id 6, self id 12), matching the funded/self pattern already used by U1, stalled, and U4. Splitting the email_type value keeps the per-funded-route distinction visible in `email_log` analytics and matches the rest of the schema.

**Changes:**
- Migration 0078: `ALTER TABLE crm.email_log DROP CONSTRAINT email_log_email_type_check` then `ADD CONSTRAINT` with `chaser_funded` + `chaser_self` replacing `chaser`. All other values preserved.
- `_shared/brevo.ts`: `EmailLogType` union updated to match.
- `admin-brevo-chase/index.ts`: replaced single `BREVO_TEMPLATE_CHASER` lookup with funded/self branch on `submission.funding_category`. Per-funded-route silent skip if the relevant env var is unset (was previously a global skip).
- `infrastructure-manifest.md`: replaced `BREVO_TEMPLATE_CHASER` row with the two new ones.

**Signed off:** Owner (session 2026-05-05).

---

## 2026-05-05: Email platform rearchitecture, Phase 2b — stalled cron + U4 cron + chaser dual-fire (migrations 0076 + 0077)

**Type:** Two new Edge Functions (`email-stalled-cron`, `email-u4-cron`), one Edge Function refactor (`admin-brevo-chase` dual-fires the chaser), two cron schedules, five new template-id env vars. No new tables.

**Status:** Code shipped to `main`. Migrations 0076 + 0077 applied. Both new functions deployed `--no-verify-jwt`. `admin-brevo-chase` redeployed. Three of the four template env vars set in Supabase Vault (stalled funded=17, stalled self=19, U4 funded=22, U4 self=24). Chaser template id deferred — Charlotte hasn't created a standalone chaser template yet (the existing one only lives inline in the SF2 automation). `admin-brevo-chase` continues to fire the legacy list-add and silently skips the transactional chaser path until `BREVO_TEMPLATE_CHASER` is set. `BREVO_SHADOW_MODE=true` already set by Phase 2a, applies globally to all `sendTransactional` callers.

**Why:** Phase 2b of the email platform rearchitecture (spec at `platform/docs/email-platform-rearchitecture-spec.md`, owner-signed 2026-05-05). Phase 2a stood up the `sendTransactional` helper and wired U1 into the routing flow. Phase 2b stands up the three remaining utility paths (stalled, chaser, U4) so the cutover from the old automation engine can flip all four utility paths in one go.

**Pre-Phase-2 lifecycle gate (important):** the new stalled and U4 cron queries gate on `EXISTS (u1_funded/u1_self row in crm.email_log)`. This means leads that came in BEFORE Phase 2a (any submission before 2026-05-05) never enter the new stalled or U4 paths — they continue to be served by the old Brevo automations only. After cutover (Charlotte pauses the old automations), pre-Phase-2 in-flight leads will lose access to utility emails. Acceptable risk: small cohort, 1-2 weeks of overlap. Alternative (backfilling email_log rows for historical leads) was rejected — would mean re-sending U1/stalled/U4 to historical learners.

**Changes:**
- New Edge Function `email-stalled-cron`: daily 09:00 UTC scan for day-4 open leads (Phase-2-gated). Per-row send via `sendTransactional`. Throttled 250ms. Returns `{candidates, sent, skipped, failed, missing_template_env, outcomes[]}` JSON. Auth via `x-audit-key`.
- New Edge Function `email-u4-cron`: daily 09:30 UTC scan for enrolled / presumed_enrolled leads (Phase-2-gated). Same shape as stalled-cron. Scheduled job over DB trigger by design — sync trigger calling Brevo would block writers if Brevo is slow.
- `admin-brevo-chase`: refactored to call `sendTransactional(BREVO_TEMPLATE_CHASER, ..., {forceResend: true})` per email after the legacy list-add. Per-row response now includes `transactional` field (`sent` | `skipped` | `failed`). Skips silently per-email if `submissionId` is missing or `BREVO_TEMPLATE_CHASER` is unset.
- Migration 0076: `cron.schedule('email-stalled-cron-daily', '0 9 * * *', ...)` POSTing to the function URL with the vault-stored audit key.
- Migration 0077: same for `email-u4-cron-daily` at `'30 9 * * *'`.
- `config.toml`: added `verify_jwt = false` blocks for both new functions.
- `infrastructure-manifest.md`: added 2 Edge Function rows, 2 cron job rows, 5 new env-var rows. Updated the "Currently `<id>`" annotations on the U1 env vars too.

**Owner tasks before Phase 2b is "live":**
1. **Stalled + U4 are live now in shadow mode.** The cron jobs will pick up any new (post-Phase-2a) leads that hit day-4 or get marked enrolled. During shadow, learners get one stalled / U4 from the old automation AND one from the new transactional path — same pattern as U1.
2. **Chaser is gated on a missing template.** Either:
   - (preferred) Find the inline template inside the existing SF2 automation in Brevo, save it as a standalone template, get its numeric id, set `BREVO_TEMPLATE_CHASER=<id>` via `supabase secrets set`. Then the chaser will dual-fire too.
   - (fallback) Leave it for now. Chaser keeps working on legacy list-add only. Set the env var before flipping `BREVO_SHADOW_MODE=false`, otherwise post-cutover chasers stop sending entirely.
3. **48h hold for parity** is now ~Thursday 2026-05-07. After parity-verifying U1 + stalled + chaser + U4 across that window (no missed sends, no double-sends to wrong addresses, templates render correctly), set `BREVO_SHADOW_MODE=false` and redeploy `routing-confirm`, `netlify-lead-router`, `email-stalled-cron`, `email-u4-cron`, `admin-brevo-chase`. Another 48h with single emails, then pause the old utility automations in Brevo (don't delete — Phase 4 retains for 90 days post-cutover per spec).

**Smoke test (post-deploy):** `email-stalled-cron` and `email-u4-cron` both expose POST endpoints. Trigger ad-hoc via the cron-equivalent CLI: `curl -X POST -H "x-audit-key: <secret>" https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/email-stalled-cron`. Expect `200 {candidates: 0|N, sent: ..., ...}`. With no day-4 Phase-2 leads yet, candidates will be 0 — that's the correct empty case. Re-test once a real Phase-2 lead crosses day-4 (~2026-05-09 for today's test lead, but it's archived, so realistically wait for a real lead).

**Signed off:** Owner (session 2026-05-05).

---

## 2026-05-05: Email platform rearchitecture, Phase 2a — `sendTransactional` helper + U1 hook wired into route-lead.ts

**Type:** New shared helper + new call site in the routing flow. No schema change. No new Edge Function. New env vars (3).

**Status:** Code shipped to `main` (not yet deployed). Deploys with the next `routing-confirm` + `netlify-lead-router` redeploy. Live U1 transactional sends are gated on Charlotte setting `BREVO_TEMPLATE_U1_FUNDED` and `BREVO_TEMPLATE_U1_SELF` in Supabase secrets — until then, `sendU1Transactional` silently no-ops (same posture as the missing-list-id path in `upsertLearnerInBrevo`).

**Why:** Phase 2a of the email platform rearchitecture (spec at `platform/docs/email-platform-rearchitecture-spec.md`, owner-signed 2026-05-05; Session 31 commissioned Phase 1). Phase 2a stands up the canonical transactional path so utility emails (U1, stalled, chaser, U4) stop riding the Brevo automation engine — see Phase 1 entry for the compliance + audit motivation. This step ships the infrastructure (`sendTransactional`) and the first consumer (U1 on routing success). Phase 2b adds stalled + chaser + U4. Shadow mode keeps the existing list-add automation firing in parallel for ≥48h after Charlotte sets the templates so we can verify parity before cutover.

**Changes:**
- `_shared/brevo.ts`:
  - New `sendTransactional({ sql, templateId, recipient, params, submissionId, emailType, brand?, tags?, replyTo?, forceResend? })`. Inserts a `crm.email_log` queued row up front, calls Brevo's templated transactional API, retries 429 / 5xx / network errors with 250ms / 1s / 4s backoff (4 attempts total), updates the row to `sent` with `brevo_message_id` on success or to `failed` + writes a `leads.dead_letter` row (`source='brevo_transactional'`) on final failure. Idempotent on `(submission_id, email_type)` against any non-failed prior row; the chaser bypasses this with `forceResend=true`.
  - New `BREVO_SHADOW_MODE` env flag (default `true`). When on, every `crm.email_log` row carries `metadata.shadow=true` so the parallel-run period is filterable from post-cutover analytics. Functional behaviour does not change in shadow mode — both the new transactional path and the existing list-add automation fire; recipients get two U1s during the parity window. Charlotte flips to `false` after ≥48h of parity-verified shadow.
  - Added `import type { Sql } from "npm:postgres@3"` at the top — runtime-zero, just brings the type in for `sendTransactional`'s `sql` arg. Brevo helper file is no longer DB-naive but stays runtime-pure (no postgres runtime import).
- `_shared/route-lead.ts`:
  - New private `sendU1Transactional(sql, provider, submission, trigger)` helper. Composes per-send template params from the same matrix + submission shape that `upsertLearnerInBrevo` uses (so contact attributes and per-send params stay aligned), routes to `BREVO_TEMPLATE_U1_FUNDED` (gov / loan) vs `BREVO_TEMPLATE_U1_SELF` (self), delegates idempotency / retry / dead_letter to `sendTransactional`. Hooks in immediately after `upsertLearnerInBrevo` so both auto-route and manual-confirm paths fire identically.
  - Skips silently for: `trigger='re_application'` (parent submission already received U1 — new submission_id would otherwise pass per-submission idempotency and double-send), submissions with no email, null `funding_category`, or unset template env var.
- `infrastructure-manifest.md`: added `BREVO_TEMPLATE_U1_FUNDED`, `BREVO_TEMPLATE_U1_SELF`, `BREVO_SHADOW_MODE` rows under Edge Function secrets. Updated `routing-confirm` row to mention the new U1 hook. Logged the change in the manifest's own change log table.

**Owner tasks before Phase 2a is "live":**
1. In Brevo, duplicate the existing automation U1 templates (one funded, one self-funded) into the **Transactional** template section. Use `{{ params.SW_COURSE_NAME }}`, `{{ params.SW_PROVIDER_NAME }}`, etc. for variables (per-send params, not contact attributes — both are present, params win during transactional sends).
2. Note the numeric template IDs.
3. Set the env vars in Supabase via CLI (NEVER via the dashboard — see Phase 1 lesson on digest-vs-value):
   ```
   supabase secrets set BREVO_TEMPLATE_U1_FUNDED=<numeric_id> --project-ref <ref>
   supabase secrets set BREVO_TEMPLATE_U1_SELF=<numeric_id> --project-ref <ref>
   supabase secrets set BREVO_SHADOW_MODE=true --project-ref <ref>
   ```
4. Redeploy `routing-confirm` and `netlify-lead-router` with `--no-verify-jwt` to pick up the new shared code.
5. Submit a non-owner-test form (owner-test domains auto-DQ and never reach routing). Verify two U1 emails arrive (one from the existing automation, one from the new transactional path), and a `crm.email_log` row exists with `status='sent'`, `metadata.shadow=true`, and a populated `brevo_message_id`.
6. Hold for ≥48h. Spot-check the email_log for missed sends, double-sends, or rendering issues. Once parity holds, set `BREVO_SHADOW_MODE=false` and redeploy. After another ≥48h, disable the old utility automation in Brevo (per Phase 4 — don't delete, just turn off).

**Signed off:** Owner (session 2026-05-05).

---

## 2026-05-05: Migrations 0073 + 0074 + 0075 — email platform rearchitecture, Phase 1 (DB foundations + webhook receiver)

**Type:** Three new tables, new Edge Function, new secret. No live behaviour change yet (writers come in Phase 2).

**Status:** Migrations applied to production via `supabase db push --linked`. `brevo-event-webhook` Edge Function deployed. Brevo dashboard webhook config and `BREVO_WEBHOOK_SECRET` paste are owner tasks (instructions below).

**Why:** Phase 1 of the email platform rearchitecture (spec at `platform/docs/email-platform-rearchitecture-spec.md`, owner-signed 2026-05-05 with 9 amendments same session). The current setup runs both utility (contract-basis) and marketing (consent-basis) emails through Brevo automations on the Email campaigns channel — when a contact unsubscribes from marketing, Brevo blocks them from utility emails too. Phase 1 lays the DB foundations (audit log, consent history, GDPR right-of-access log) and stands up the bounce/complaint receiver. Phases 2-4 cut utility over to the Transactional API; Phase 5 builds proper marketing automations.

**Changes:**
- Migration 0073: `crm.email_log` — one row per email send. Idempotency key for one-shot sends, audit log, target for `brevo-event-webhook` status updates. Indexes on `(submission_id, email_type)`, `(status, triggered_at DESC)`, and partial on `brevo_message_id`. RLS: admin + analytics read, functions_writer ALL.
- Migration 0074: `crm.consent_history` — append-only audit log of every consent state change. RLS: admin + analytics read, functions_writer INSERT only (no UPDATE/DELETE policy — append-only by design). Submission_id nullable to support future newsletter-only contacts.
- Migration 0075: `audit.access_requests` — GDPR Article 15 right-of-access log. Mirrors the existing `audit.erasure_requests` table from migration 0016 (which the original spec missed; spec amended same session to reuse it rather than create a duplicate `crm.erasure_log`). Adds `export_url` for the signed Storage URL of completed exports.
- Edge Function `brevo-event-webhook`: receives Brevo webhook events (delivered/opened/clicked/bounce/spam/unsubscribed). Updates `crm.email_log.status` by `brevo_message_id`. For unsubscribe/spam events also inserts a `crm.consent_history` row. Auth: shared-secret bearer in `Authorization` header, constant-time compared against `BREVO_WEBHOOK_SECRET`. Phase 3 will add the round-trip to flip `SW_CONSENT_MARKETING` in Brevo + Supabase; Phase 1 only logs.
- `supabase/config.toml`: `[functions.brevo-event-webhook] verify_jwt = false`.
- `data-architecture.md` updated with all three new tables.
- `infrastructure-manifest.md` updated with new function row, new secret row, and the owner-test allowlist refresh from earlier this session.

**Webhook auth pattern note:** Brevo's public docs do not document HMAC payload signing (verified 2026-05-05 against `developers.brevo.com` — only event schemas published). Brevo's dashboard supports custom HTTP headers on webhook calls, so we use a high-entropy bearer secret in the `Authorization` header. Spec amended in same session to reflect this.

**Owner tasks before Phase 1 is "live":** ✅ Complete (2026-05-05). End-to-end verified with a real Brevo event hitting the function with valid bearer, returning 200, and Brevo's webhook counter showing 1 successful delivery.

**Lessons learnt during commissioning (worth capturing for future webhook setups):**
- The Supabase secrets dashboard shows the **SHA-256 digest** of each secret, not the value. Copying the digest from the dashboard list and pasting it as the secret value is the most common bug — and ate ~30 minutes of this session. Always set the secret via CLI (`supabase secrets set NAME=$VALUE --project-ref X`) and copy the value directly from the terminal output you ran `openssl rand -hex 32` in. Never trust dashboard display values as secret values.
- Brevo's Token authentication method **auto-prepends `Bearer `** to the value field. Paste ONLY the hex into Brevo's Token value, never `Bearer <hex>` (would result in `Bearer Bearer <hex>` being sent).
- A long-lived diagnostic mode in the Edge Function (returning length + 4-char head/tail prefixes in the 401 response without leaking the full secret) was the tool that finally pinpointed the digest-vs-value mistake. Pattern is reusable for any future shared-secret webhook auth — keep it as a deployable diagnostic in `_shared/` if a similar bug ever bites again.

**Signed off:** Owner (session 2026-05-05).

---

## 2026-05-05: Migration 0072 — admin column-level UPDATE on leads.submissions for owner-test tagging

**Type:** Access policy. Column-level GRANT + RLS UPDATE policy.

**Status:** Applied to production via `supabase db push --linked`. Edge functions `netlify-lead-router` and `netlify-leads-reconcile` redeployed in same session with extended allowlist.

**Why:** Today's session needed two manual SQL UPDATE statements to back-tag leads #277 (`hello@charlie-harris.com`) and #284 (`kieranwrites@gmail.com`) as owner-test submissions after they slipped past the `_shared/ingest.ts` allowlist. The dashboard had no UI for this. Migration adds the minimum privilege surface for a `markOwnerTestSubmission` admin server action — pattern mirrors migration 0051.

**Changes:**
- `GRANT UPDATE (is_dq, dq_reason, archived_at) ON leads.submissions TO authenticated`
- `admin_update_owner_test_flags` RLS UPDATE policy on `leads.submissions` (gated on `admin.is_admin()`)
- `_shared/ingest.ts`: `OWNER_TEST_DOMAINS` extended with `charlie-harris.com`; `OWNER_TEST_EMAILS` extended with `kieranwrites@gmail.com`
- `app/admin/leads/[id]/actions.ts`: `markOwnerTestSubmission(submissionId, markAsTest)` server action (writes the canonical DQ shape; clears it back to NULLs on un-mark)
- `app/admin/leads/[id]/owner-test-toggle.tsx`: client toggle showing "Mark as test lead" or "Remove test flag" depending on `dq_reason`. Confirm prompt on mark; un-mark only available when `dq_reason='owner_test_submission'` so legitimate DQ rows (waitlist, no_match, etc.) are never touched.

**Signed off:** Owner (session 2026-05-05)

---

## 2026-05-05: Migrations 0070 + 0071 — is_test flag added then REVERTED

**Type:** Schema change applied then fully reverted in the same session.

**Status:** Both migrations applied to production. Net effect: schema and views are back at pre-0070 state.

**Why reverted:** The `is_test` column was a parallel mechanism that duplicated existing functionality. Owner-test submissions are already handled at ingest by `applyOwnerTestOverrides` in `_shared/ingest.ts` (sets `is_dq=true`, `dq_reason='owner_test_submission'`, `archived_at=now()` based on `OWNER_TEST_DOMAINS` / `OWNER_TEST_EMAILS` allowlists). For manual tagging of leads that bypassed the allowlist, the same DQ + archived state should be applied directly. A second flag is redundant and leaves leads in an ambiguous open-but-test state.

**Operational note from this session:** Leads #277 (`hello@charlie-harris.com`) and #284 (`kieranwrites@gmail.com`) were tagged retrospectively with `is_dq=true`, `dq_reason='owner_test_submission'`, `archived_at=now()`. Both had already been routed to enterprise-made-simple via the sheet webhook before the DQ — those rows are still sitting in EMS's Google Sheet and need follow-up (DB DQ does not propagate back to provider sheets).

**Gap surfaced:** there is no dashboard action to manually mark a lead as DQ + owner_test_submission. Today this requires direct SQL. A future session may add a `markOwnerTestSubmission` server action mirroring the existing DQ mechanism (no new column).

**Signed off:** Owner (session 2026-05-05)

---

## 2026-05-04: Migration 0069 — INSERT RLS policy for functions_writer on page_views

**Type:** Schema change. New RLS policy.

**Status:** Applied via SQL editor (same session as 0068).

**Why:** Migration 0068 enabled RLS and granted INSERT to functions_writer but omitted the INSERT RLS policy. PostgreSQL requires both the privilege grant AND a matching policy for non-superuser roles. Without it, every INSERT by the log-page-view Edge Function was silently rejected by RLS — the function returns 200 regardless, so the failure was invisible for several hours.

**Changes:**
- `CREATE POLICY "functions_writer_insert_page_views" ON ads_switchable.page_views FOR INSERT TO functions_writer WITH CHECK (true)`

**Signed off:** Owner (session 2026-05-04)

---

## 2026-05-04: Migration 0068 — ads_switchable.page_views + log-page-view Edge Function

**Type:** New table, new Edge Function, variant-router path expansion, experiments page updated.

**Status:** Fully live. Migration applied via SQL editor. Edge Function deployed. Page views landing in DB confirmed.

**Why:** No way to verify the 50/50 A/B split or compute view-to-lead conversion rate without page view counts. The variant-router already runs on every experiment page request — adding a fire-and-forget logging call costs the visitor zero latency.

**Changes:**
- `ads_switchable.page_views`: new table — `experiment_id`, `page_slug`, `variant`, `viewed_at`. No PII.
- RLS: `admin_read_page_views` (authenticated + is_admin), `readonly_analytics_read_page_views`.
- `functions_writer` granted INSERT + sequence usage.
- New Supabase Edge Function `log-page-view`: receives POST from variant-router, inserts one row. No auth — `Deno.env.get` does not reliably read Netlify env vars in the edge runtime, making a shared-secret check impractical. Low-risk: no-PII analytics table, worst case is view count inflation from spoofed requests.
- `config.toml`: `[functions.log-page-view] verify_jwt = false` added.
- `variant-router.ts`: path expanded from `/funded/*` to `/*` (covers self-funded, loan-funded, any future page type). Asset exclusion via last-segment dot check. `logPageView()` call added, awaited in parallel with `context.next()` via `Promise.all` (zero latency impact). `LOG_ENDPOINT` hardcoded constant (not env var) to eliminate misconfiguration.
- `platform/app/app/admin/experiments/page.tsx`: view counts queried from `ads_switchable.page_views`, merged into per-variant stats. New columns: Views, View→lead conversion. New "View split" tile showing A/B breakdown with health check (flags if outside 45/55).

**Signed off:** Owner (session 2026-05-04)

---

## 2026-05-04: Migration 0067 — referral voucher trigger restricted to confirmed enrolment only

**Type:** Schema change. Two Postgres functions replaced via CREATE OR REPLACE.

**Status:** Applied and verified via pg_proc.prosrc.

**Why:** Charlotte (via Clara) decided the referral voucher should fire only when a provider has confirmed the learner actually started. Presumed-enrolment rows are billing placeholders; paying out a voucher against a row that later gets disputed would mean paying for an enrolment that didn't happen.

**Changes:**
- `crm.upsert_enrolment_outcome`: `IF p_status IN ('enrolled', 'presumed_enrolled')` narrowed to `IF p_status = 'enrolled'`
- `crm.run_enrolment_auto_flip`: FOREACH referral flip loop removed entirely; `v_flipped_id BIGINT` declaration removed. Brevo sync loop unaffected.
- Migration history repaired via `supabase migration repair --status applied 0067` after manual SQL editor apply.

**Consumers affected:** leads.referrals voucher_status; admin /admin/referrals dashboard; referrer Brevo attributes.

**Signed off:** Owner (session 2026-05-04, via Clara instruction)

---

## 2026-05-03: Migration 0065 — Iris stage 5: ads_switchable.v_ad_to_enrolment view (closed-loop attribution)

**Type:** Schema change. New view extending v_ad_to_routed with enrolment counts + revenue + cost-per-enrolment.

**Status:** Migration written. Not yet applied.

**Why:** Closed-loop attribution. Powers the cost-per-enrolment tile on `/admin/ads` and feeds Iris's planned P3.1 closed-loop CPA flag. View ships now even though `crm.enrolments` is empty at pilot scale; returns zero enrolments per ad until real revenue data lands.

**Changes:**
- New view `ads_switchable.v_ad_to_enrolment`. Extends `v_ad_to_routed` (per-ad daily spend ↔ leads ↔ routed) with `leads_enrolled` (count of enrolled + presumed_enrolled), `revenue` (SUM of `crm.enrolments.billed_amount`), and `cost_per_enrolment` (spend ÷ enrolled).
- Schema-spec note: scope doc speculated `invoice_amount_pence` but production column is `crm.enrolments.billed_amount` (NUMERIC, in £). View uses the actual column.
- Only `enrolled` and `presumed_enrolled` statuses contribute to revenue; `lost / cannot_reach / open` excluded.
- Grants: SELECT to `authenticated` (dashboard) and `iris_writer` (future Iris P3.1).

**Owner sign-off:** stage 5 scope confirmed in this session.

---

## 2026-05-03: Iris stages 3 + 4a + 4b — dashboard surfaces for the iris_flags table

**Type:** New admin routes. No schema change. All three reuse the same `IrisFlagsSection` component for consistency.

**Status:** Built and committed. Visible after deploy.

**Why:** Stage 2 (iris-daily-flags Edge Function, deployed earlier today) writes flags to `ads_switchable.iris_flags` but had no surface to display them. Stages 3-4 close that loop:
- **Stage 3 — `/admin/iris-flags`**: full audit history (last 30 days), per-automation summary tiles (active/resolved/suppressed), full table with severity badges, server actions for mark-resolved + bulk resolve-all. Active flags also surface as a top-of-page card on `/admin` overview.
- **Stage 4a — `/admin/ads`**: per-ad performance dashboard. Period pills (24h/7d/30d/lifetime), brand tabs (Switchable | SwitchLeads dormant), funding-segment filter, 5 headline tiles, embedded Iris signals card, 11-column performance table sorted by qualified leads desc + CPL asc. Signal dots link to /iris-flags.
- **Stage 4b — `/admin/ads/[ad_id]`**: per-ad drill-down. Lead funnel tiles (delivered → DB total → qualified → routed → enrolled), cost tiles (True CPL, cost per enrolment, revenue, CTR), inline SVG bars chart for daily spend, per-provider breakdown table, this ad's Iris flag history, recent leads list with link-through to /leads/[id].

**Sidebar nav:** Added "Ads" + "Iris flags" under Tools (between Profit tracker and Agents).

**Stage 4b not built (deferred):** Per-ad CPL trend over time as a second axis on the chart (currently spend bars only). Acceptable at pilot scale; revisit if pattern-spotting requires it.

---

## 2026-05-03: `/admin/experiments` page live (Switchable A/B test analytics)

- **Type:** New admin route in `platform/app/`. No schema change. Reads `leads.submissions` via the existing supabase-ssr server client.
- **Change:** New `app/app/admin/experiments/page.tsx` plus an "Experiments" entry in `components/admin-shell.tsx` Tools nav (between Analytics and Social). Pulls every submission with `experiment_id IS NOT NULL` and `parent_submission_id IS NULL`, groups by experiment + variant in JS, renders a section per experiment with submission count, qualified count (DQ-excluded), DQ rate, date range, lift (B vs A) on qualified deltas, and a confidence flag (≥30 qualified per side before reading the lift).
- **Why:** Closes the loop on the Switchable A/B test infrastructure (sessions 1-5 today). Owner needs a UI to read variant performance without writing SQL. Sits alongside the existing `/admin/analytics` funnel page; doesn't bloat that page with experiment-specific concerns.
- **Status:** Deployed (commit 0e5459b on switch-platform/main). Empty state until a Switchable page YAML carries an `experiment:` block and starts collecting leads. First reader of the migration 0061 columns.
- **Related:** Migration 0061 (the columns this page reads), `switchable/site/docs/funded-funnel-architecture.md` (the producer side), commits 4437855 + e8953f3 on switchable-site (Meta dedup fix shipped in same session — separate concern, mentioned for cross-context).
- **Signed off:** Owner.

---

## 2026-05-03: Migration 0064 — RLS read policy on iris_flags for readonly_analytics

**Type:** Access policy. New SELECT policy on `ads_switchable.iris_flags` for `readonly_analytics`.

**Status:** Applied 2026-05-03 via SQL editor.

**Why:** Migration 0056 created `iris_flags` with RLS read policies for `authenticated` (dashboard) and `iris_writer` (Edge Function) only. `readonly_analytics` had table SELECT grant via the migration-0001 default-grant inheritance but no RLS read policy, so agents querying via Postgres MCP saw zero rows even though data was present. Per data-infrastructure rule §11 ("Agents can read all tables and views"), this policy closes the gap. Surfaced when the first iris-daily-flags run inserted a flag and the readonly MCP couldn't see it.

---

## 2026-05-03: Migration 0063 — grant SET + INHERIT options on iris_writer to postgres

**Type:** Role-membership grant fix. Originally written as 0061 in this session, renamed to 0063 mid-handoff after discovering Mable's parallel 0061 leads_experiment_columns file collision.

**Status:** Applied 2026-05-03 via SQL editor (one-line GRANT, no transaction wrap needed).

**Why:** Migration 0056 created the `iris_writer` role; the implicit grant of role-membership to the postgres superuser landed with only the admin_option (manage iris_writer's own grants) and not the set_option or inherit_option. Postgres 16+ split role-membership into three flags and the default-grant case lands without SET/INHERIT. The `iris-daily-flags` Edge Function (deployed same session) connects as postgres and tries `SET LOCAL ROLE iris_writer` to write through the scoped role per data-infrastructure rule §11; that call failed with "permission denied to set role iris_writer" until this fix. `functions_writer` already had both options on postgres (verified via pg_auth_members), so this brings iris_writer to parity.

**Process lesson:** When creating a new scoped role in a migration, explicitly `GRANT new_role TO postgres WITH SET TRUE INHERIT TRUE` in the same migration. Defaults are not enough.

---

## 2026-05-03: Migration 0061 — `leads.submissions` experiment_id + experiment_variant

- **Migration:** `0061_leads_experiment_columns.sql`
- **Change:** Two new nullable TEXT columns on `leads.submissions` (`experiment_id`, `experiment_variant`) plus a partial composite index `leads_submissions_experiment_idx` on (experiment_id, experiment_variant) WHERE experiment_id IS NOT NULL.
- **Why:** Foundation for site-controlled A/B testing on Switchable funded / self-funded / loan-funded landing pages. Each lead row records which experiment the visitor was part of and which variant they saw, so conversion rate and CPL can be computed per variant. Approach: per-page opt-in via a new `experiment:` block on the page YAML; Edge Function fronts `/funded/*` and rewrites the response to variant B for half the traffic; cookie persists; hidden form inputs carry the cookie value into the submission.
- **Impact:** Additive only. No existing column changed, no row touched. No reader queries these columns yet — first reader will be the planned `/admin/experiments/` page in `platform/app/`. No payload schema_version bump (additive optional fields per `.claude/rules/schema-versioning.md`).
- **Status:** Migration applied to production this session (verified via `information_schema.columns` lookup). `_shared/ingest.ts` updated in lockstep — `CanonicalSubmission` interface gains both fields, INSERT column + values lists carry them through, base payload mapping reads `firstString(data["experiment_id"])` / `firstString(data["experiment_variant"])` (empty string normalises to NULL automatically). Function deploy pending end-of-session batch.
- **Related:** `switchable/site/docs/funded-funnel-architecture.md` (additive payload note + full A/B system spec, updated this session), `switchable/site/deploy/scripts/build-funded-pages.js` (variant build pipeline), `switchable/site/deploy/template/funded-course.html` (two new hidden inputs), `switchable/site/deploy/netlify/edge-functions/variant-router.ts` (new — variant routing), `platform/docs/data-architecture.md` (schema doc updated this session).
- **Signed off:** Owner (this session).

---

## 2026-05-03: Iris stage 2 — `iris-daily-flags` Edge Function + cron

**Type:** New Edge Function + new pg_cron schedule. No schema changes (table + views from stages 1a-1c are the storage layer).

**Status:** Function code written, cron SQL written. Both pending end-of-session deploy + cron-schedule paste.

**Why:** Implements the four daily flag-only checks per `switchable/ads/docs/iris-automation-spec.md` (P1.2 fatigue, P2.1 daily health, P2.2 CPL anomaly, P2.3 pixel/CAPI drift). Replaces the prior approach where Iris wrote weekly markdown briefs to iCloud (which the owner did not review) with a server-side daily compute that lands flags into `ads_switchable.iris_flags` for surfacing on Action Centre (stage 3) and `/admin/ads` (stage 4).

**Implementation notes:**
- Auth via `x-audit-key` header sourced from Supabase Vault (`AUDIT_SHARED_SECRET`), same pattern as netlify-leads-reconcile.
- Reads from `ads_switchable.meta_daily`, `v_ad_to_routed`, `v_ad_baselines`, `leads.submissions`. Writes to `ads_switchable.iris_flags`.
- INSERT transaction wraps `SET LOCAL ROLE iris_writer` so writes go through the scoped role per data-infrastructure rule §11.
- 7-day suppression: if a candidate flag matches an existing `(ad_id, automation, brand)` notified=true row from the last 7 days, the new flag is inserted with `notified=false`. Audit row persists; dashboard surfaces only `notified=true`. Same-day re-runs are therefore idempotent.
- P2.1 graceful-degrades: every per-ad check requires `delivery_state` non-NULL (migration 0060 column). Until the meta-ads-ingest function patch + re-pull populates them, P2.1 finds zero candidates. P1.2, P2.2, P2.3 are unaffected.
- P2.3 applies the `parent_submission_id IS NULL` filter to DB paid-lead counts (consistent with the morning's `/admin/profit` audit fix per `feedback_paid_lead_count_filter.md`). Without it, P2.3 false-fires on waitlist enrichment days.
- Cron `iris-daily-flags` at `30 8 * * *` UTC, scheduled via `data-ops/012_iris_daily_flags_cron.sql`.

**Deploy steps (end of session):**
1. `supabase functions deploy iris-daily-flags --no-verify-jwt`
2. Smoke test: POST `?date=2026-05-02` against the function URL with the audit key, expect 200 with summary JSON.
3. Paste `data-ops/012_iris_daily_flags_cron.sql` into the SQL editor, run.
4. Verify cron row exists via `SELECT jobname, schedule, active FROM public.vw_cron_jobs WHERE jobname = 'iris-daily-flags'`.

**Companion docs:** ClickUp [869d4vu0h](https://app.clickup.com/t/869d4vu0h) tracks this work.

**Open follow-up:**
- Stage 1d backfill: meta-ads-ingest function patch to start populating `delivery_state`, `daily_budget`, `status`, `headline`, `primary_text` from Meta. Until this lands, P2.1 sits idle. Worth scheduling as the next platform session's lead item.

**Owner sign-off:** stage 2 scope confirmed in this session.

---

## 2026-05-03: Migration 0060 — Iris stage 1d: extend meta_daily with ad metadata columns

**Type:** Schema change. Five new nullable columns on `ads_switchable.meta_daily`. No backfill in this migration — existing rows go to NULL until the function-side update + re-pull lands.

**Status:** Migration written. Not yet applied.

**Why:** The stage 2 `iris-daily-flags` Edge Function P2.1 daily health check needs `delivery_state`, `daily_budget`, and `status` to flag ads stuck in LIMITED delivery or pacing wrong. The stage 4 `/admin/ads` performance table needs `headline` and `primary_text` for the per-ad drill-down preview.

**Changes:**
- Add `delivery_state TEXT` (Meta effective_status: ACTIVE / INACTIVE / LIMITED / ADSET_PAUSED / CAMPAIGN_PAUSED / etc).
- Add `daily_budget NUMERIC` (account currency minor units, sourced from adset → campaign hierarchy).
- Add `status TEXT` (Meta configured ad status — what was set, vs delivery_state which is what's happening).
- Add `headline TEXT` (creative headline; sourced from Meta creative endpoint, separate API hit per ad).
- Add `primary_text TEXT` (creative body text, same source as headline).
- All nullable, no CHECK constraints (Meta value sets evolve; we don't want a new value from Meta to break ingest).
- COMMENT ON COLUMN for each, documenting source + consumer.

**Follow-ups (separate from this migration):**
- Patch `meta-ads-ingest/index.ts` to request the new fields from Meta (`effective_status`, `status` at the insights level; separate creative endpoint hit per ad for headline/primary_text; adset/campaign join for daily_budget).
- Trigger a manual re-pull of the last ~30 days to backfill historical rows.
- Both bundled into the end-of-session deploy.

**Companion docs:** ClickUp [869d4ubwq](https://app.clickup.com/t/869d4ubwq) tracks this work.

**Owner sign-off:** stage 1d scope confirmed in this session.

---

## 2026-05-03: Migration 0059 — Iris stage 1e: funding_segment backfill + auto-derive trigger

**Type:** Schema change. New trigger function + trigger, plus a one-time UPDATE backfill of existing rows.

**Status:** Migration written. Not yet applied.

**Why:** `ads_switchable.meta_daily.funding_segment` is currently NULL on every row across 101 historical rows (verified via query). Owner needs this populated so `/admin/ads` can filter the performance table by funding segment when stage 4 ships. Single source of truth for the parsing rule lives in the trigger so the Edge Function doesn't need to know it.

**Changes:**
- New trigger function `ads_switchable.set_funding_segment_from_campaign()`. Maps `SW-FUND-*` → `funded`, `SW-PAID-*` → `self-funded`, `SW-LOAN-*` → `loan-funded` (reserved for future ALL campaigns), anything else → NULL. Unknown patterns degrade gracefully so a future naming-convention break doesn't block ingest.
- Trigger `trg_meta_daily_funding_segment` fires BEFORE INSERT OR UPDATE OF (campaign_name, funding_segment) — narrow scope, won't fire on unrelated UPDATEs.
- Backfill UPDATE re-derives every existing row.

**Companion docs:** ClickUp [869d4vtz2](https://app.clickup.com/t/869d4vtz2) tracks this work.

**Owner sign-off:** stage 1e scope confirmed in this session.

---

## 2026-05-03: Migration 0058 — Iris stage 1c: ads_switchable.v_ad_baselines view

**Type:** Schema change. New view, no table changes, no new role.

**Status:** Migration written. Not yet applied.

**Why:** Per-ad rolling baselines (launch CTR, 7-day CTR + CPL, 3-day CTR + frequency) consumed by the future `iris-daily-flags` Edge Function for fatigue (P1.2) and CPL anomaly (P2.2) detection. Computed at view layer so the same baselines are queryable ad-hoc from the dashboard or via Postgres MCP.

**Changes:**
- New view `ads_switchable.v_ad_baselines`. Three CTEs joined: `launch_window` (first 7 days post-launch CTR baseline + impressions), `rolling_7d` (CTR avg + CPL across yesterday and 6 days prior — excludes today which is partial), `rolling_3d` (CTR avg + frequency across last 3 days including today).
- Grants: SELECT to `authenticated` (dashboard) and `iris_writer` (stage 2 Edge Function).

**Companion docs:** ClickUp [869d4ubxv](https://app.clickup.com/t/869d4ubxv) tracks this work.

**Owner sign-off:** stage 1c scope confirmed in this session.

---

## 2026-05-03: Migration 0057 — Iris stage 1b: ads_switchable.v_ad_to_routed view

**Type:** Schema change. New view, no table changes, no new role.

**Status:** Migration written. Not yet applied.

**Why:** Per-ad daily join from Meta spend → DB-recorded leads → routed leads. Powers the "leads → qualified → routed" drill-down column on the future `/admin/ads` performance table (stage 4) and feeds stage 2's `iris-daily-flags` Edge Function for the P2.2 CPL anomaly check.

**Changes:**
- New view `ads_switchable.v_ad_to_routed`. LEFT JOIN from `ads_switchable.meta_daily` to `leads.submissions` on `utm_content = ad_id` and `submitted_at::date = date`. Filters `s.utm_medium = 'paid'` so organic submissions don't pollute per-ad counts.
- Aggregate columns: `leads_db_total`, `leads_qualified`, `leads_routed`, `cost_per_routed_lead`. All counts apply `parent_submission_id IS NULL` to exclude children that carry parent UTMs but don't represent novel paid conversions (consistent with this morning's `/admin/profit` and `/admin/errors` audit fix per `feedback_paid_lead_count_filter.md`).
- Grants: SELECT to `authenticated` (dashboard) and `iris_writer` (stage 2 Edge Function).

**Companion docs:** ClickUp [869d4ubxc](https://app.clickup.com/t/869d4ubxc) tracks this work.

**Owner sign-off:** stage 1b scope confirmed in this session.

---

## 2026-05-03: Migration 0056 — Iris stage 1a: ads_switchable.iris_flags table + iris_writer role

**Type:** Schema change. New table, two indexes, three RLS policies, one new role with scoped grants. No changes to existing tables.

**Status:** Migration written. Not yet applied. Requires owner to replace `<PASSWORD_IRIS_WRITER>` placeholder with `openssl rand -base64 32` output before pasting into the SQL editor, then log the password in LastPass + add a row to `secrets-rotation.md` after apply.

**Why:** Foundation table for the new ads dashboard architecture (Iris-as-source-of-truth, dashboard-as-review-surface). Replaces the prior approach where Iris wrote weekly markdown briefs to iCloud — owner doesn't read those day-to-day. The new pattern: Edge Function `iris-daily-flags` (stage 2, not yet built) writes flags to this table; Action Centre (stage 3) and `/admin/ads` Signals card (stage 4) read from it. Stage 1a is the foundation that unblocks everything else.

**Changes:**
- New table `ads_switchable.iris_flags` with the 17 columns from the consolidated scope (`switchable/ads/docs/ads-dashboard-scope.md` stage 1a). Schema_version v1.0.
- Soft CHECK constraints on `severity` (must be `amber` or `red`) and `automation` (must be one of `P1.2`, `P2.1`, `P2.2`, `P2.3`). Defends against direct SQL writes; the Edge Function will be the canonical writer and constrains values upstream.
- Index on `(brand, ad_id, automation, flagged_at)` for per-ad drill-down + per-automation history queries.
- Partial index on `(notified, read_by_owner_at) WHERE notified = true AND read_by_owner_at IS NULL` — small index serving the Action Centre's "open flags" query.
- RLS enabled. Three policies: `admin_read_iris_flags` (SELECT for `authenticated`), `admin_update_iris_flags` (UPDATE for `authenticated` — for owner clearing flags via dashboard), `iris_writer_insert_iris_flags` (INSERT for the new `iris_writer` role only).
- New `iris_writer` Postgres role per data-infrastructure rule §11. Grants: USAGE on `ads_switchable` + `leads` schemas, INSERT + sequence access on `iris_flags`, SELECT on `meta_daily` + `leads.submissions` + `leads.routing_log` (the source tables stage 2's flag-computation queries need). Stages 1b (`v_ad_to_routed`) and 1c (`v_ad_baselines`) will add their own SELECT grants for those views in their migrations — granting up-front would error.
- Dashboard reader (`authenticated`) gets SELECT + UPDATE on the table. USAGE on schema already granted in migration 0050.

**Companion docs:**
- `platform/docs/data-architecture.md` updated header.
- ClickUp [869d4vty3](https://app.clickup.com/t/869d4vty3) tracks this work; will be marked complete after apply.

**Open follow-up:**
- Stage 1b (`v_ad_to_routed` view) ticket [869d4ubxc](https://app.clickup.com/t/869d4ubxc).
- Stage 1c (`v_ad_baselines` view) ticket [869d4ubxv](https://app.clickup.com/t/869d4ubxv).
- Stage 1d (extend `meta_daily` columns) ticket [869d4ubwq](https://app.clickup.com/t/869d4ubwq).
- Stage 1e (`funding_segment` fix) ticket [869d4vtz2](https://app.clickup.com/t/869d4vtz2).
- After 1a-1e land, stage 2 (Edge Function) ticket [869d4vu0h](https://app.clickup.com/t/869d4vu0h).
- After apply: log `iris_writer` password in `secrets-rotation.md` (annual rotation cadence per default), and update `infrastructure-manifest.md` Postgres roles table.

**Owner sign-off:** stage 1a scope confirmed in this session.

---

## 2026-05-03: Migration 0055 — fix referral eligible-flip hook on the live 6-arg upsert

**Type:** Function body correction. Drops one dead overload, refreshes one live function. No new tables, no new columns.

**Status:** Applied 2026-05-03 via Supabase SQL editor. Verified: one row returned for `crm.upsert_enrolment_outcome` (the 6-arg signature), `hook_present = true`. Dead 3-arg overload no longer exists.

**Why:** Verification of migration 0054 the morning after Session 24 close found the hook only half-live. `crm.run_enrolment_auto_flip` was patched correctly (cron path fires the helper). `crm.upsert_enrolment_outcome` was NOT patched correctly: 0054 wrote against the 3-arg signature from migration 0022, but migration 0028 had since replaced that with a 6-arg signature. Postgres treated 0054's body as a separate overload, leaving the production 6-arg version (the one called from `app/admin/leads/[id]/actions.ts` and `bulk-actions.ts`) unhooked. Net effect: any enrolment marked through the admin UI before the 14-day cron promoted it would silently leave the matching referral stuck in `pending`.

**Changes:**
- DROP `crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT)` — the dead 3-arg overload introduced by 0054. Nothing in the codebase calls it.
- CREATE OR REPLACE `crm.upsert_enrolment_outcome(BIGINT, TEXT, TEXT, TEXT, BOOLEAN, TEXT)` — body byte-identical to migration 0028 plus the same `IF p_status IN ('enrolled', 'presumed_enrolled') THEN PERFORM leads.flip_referral_eligible(...);` block 0054 used, inserted between the audit log call and RETURN.
- COMMENT refreshed on the 6-arg version.
- REVOKE/GRANT statements re-stated to preserve `authenticated` execute access.

`crm.run_enrolment_auto_flip` is left untouched — 0054 patched it correctly.

**Verification:** after apply, run `SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname='upsert_enrolment_outcome' AND pg_get_function_identity_arguments(oid) LIKE '%BOOLEAN%';` and grep the result for `flip_referral_eligible`. Hook should appear once. The 3-arg signature should no longer exist (`pg_proc` query for `proname='upsert_enrolment_outcome'` returns one row, not two).

**Process lesson:** Session 24's two-pass review compared the 0054 doc claim against migration 0022's source. It did not query the live function signature. When patching a function known to have been refactored, query `pg_proc` for the current signature first. Saving as a feedback memory.

**Open follow-up:** Migration 0054 itself stays in the file system as a record of the original (broken) attempt — convention is never to edit past migrations. 0055 is the forward correction. Both files describe the same intent.

**Owner sign-off:** corrective migration confirmed 2026-05-03 in platform session.

---

## 2026-05-02: Migration 0054 — wire referral eligible-flip into enrolment-confirmation paths

**Type:** Function body refresh on two existing crm functions. No new tables, no new columns.

**Status:** Migration written, not yet applied. Apply after 0053 lands.

**Why:** Migration 0053 added `leads.flip_referral_eligible(submission_id)` but nothing in the enrolment-confirmation pipeline calls it. Without 0054, every confirmed enrolment leaves matching referrals stuck in `pending` forever — voucher never fires. 0054 wires both confirmation paths (owner-driven outcome + 14-day auto-flip cron) into the helper.

**Changes:**
- `crm.upsert_enrolment_outcome` body refreshed: when the new outcome is `enrolled` OR `presumed_enrolled`, fires `leads.flip_referral_eligible(p_submission_id)` after the audit log, before RETURN
- `crm.run_enrolment_auto_flip` body refreshed: alongside the existing `crm.sync_leads_to_brevo` bulk call, loops over `v_flipped_ids` and fires `leads.flip_referral_eligible` for each. Idempotent (no-op when no pending referral exists)

Both functions remain CREATE OR REPLACE — no signature change, no caller change. Body diff vs migration 0022 (upsert) and migration 0045 (auto-flip) is the new PERFORM calls only.

**Companion Edge Function patch (not in migration):**
- `netlify-lead-router/index.ts` extended to capture `?ref=` from form payload (hidden field), look up referrer by `referral_code`, run anti-fraud (self-referral by email/phone/address/postcode/LA, duplicate-email already in funnel), and INSERT a `leads.referrals` row in `pending` (or `fraud_rejected` with `fraud_reason`). Runs as `EdgeRuntime.waitUntil` background task per Session 3.3 architecture.

**Open follow-up:**
- `netlify-leads-reconcile` does NOT yet apply the same referral processing. Reconcile-path leads (rare, fast-path-miss only) lose their referral attribution. Either move the helper to `_shared/referral.ts` and wire reconcile, or document the gap and accept it. Decide before launch.
- `payout-referral-voucher` Edge Function (separate ticket [869d4vygz](https://app.clickup.com/t/869d4vygz)) reads `eligible` rows and fires Tremendous. Gated on owner Tremendous account + funded balance + API key in Supabase secrets.

**Owner sign-off:** referral programme scope confirmed 2026-05-02 in platform session.

---

## 2026-05-02: Migration 0053 — Switchable referral programme (data model + payout trigger)

**Type:** Schema change. Additive on `leads.submissions`, new table `leads.referrals`, three new functions, one trigger, two RLS policies.

**Status:** Migration written, not yet applied. Pending owner-triggered `/ultrareview` then production apply.

**Why:** Referral programme is the single biggest CPL lever available to Switchable inside SAC Employment constraints. Effective cost-per-referred-enrolment caps at the £50 voucher (vs ~£50-100 paid social per enrolment). Owner-approved 2026-05-02. Email and site sides are gated on this data model landing first.

**Changes:**
- `leads.submissions` extended: `referral_code` TEXT NOT NULL UNIQUE (8-char Crockford base32, auto-generated via BEFORE INSERT trigger, backfilled for all existing rows), `referrer_lead_id` BIGINT nullable FK self-ref
- New table `leads.referrals` with status machine (pending → eligible → paid, terminal fraud_rejected). One row per referred lead. Voucher amount stored per-row (default £50 / 5000 pence).
- Soft cap enforced as `needs_manual_review` flag, not block. 10 successful referrals per 90 days auto-flags for owner review.
- New functions: `leads.generate_referral_code()`, `leads.set_referral_code_default()` (trigger fn), `leads.flip_referral_eligible(submission_id)` (called from enrolment-confirmation path; idempotent)
- New RLS policies on `leads.referrals`: `admin_read_referrals`, `admin_update_referrals`. `readonly_analytics` granted SELECT.
- Schema version bumped: `leads.submissions` rows v1.2 → v1.3.

**Voucher delivery:** Tremendous (B2B payout API). Cleaner setup than Amazon Incentives direct, ~$0.50 per payout fee. Edge Function `payout-referral-voucher` (forthcoming) reads eligible-and-not-flagged rows and fires the API call.

**Anti-fraud (enforced in `netlify-lead-router` Edge Function, not the migration):**
- Self-referral block: same email/phone/address as referrer
- Duplicate-email block: friend's email already exists in `leads.submissions`
- Soft cap: 10 successful referrals per 90 days flags `needs_manual_review`

**Impact assessment:** `platform/docs/impact-assessment-2026-05-02-referrals.md`. Backfill is single UPDATE (volatile `random()` per row, then UNIQUE constraint added). Existing readers unaffected (additive columns). Edge Function changes ship separately.

**Cross-project:**
- Switchable email (ClickUp 869d4udfg): launch email + voucher fulfilment automation, blocked on this migration
- Switchable site (ClickUp 869d4udm6): `/refer` page + `?ref=` URL handling on funded + self-funded course finders, blocked on this migration
- Accounts/legal (Clara): privacy policy paragraph + new T&Cs page + friend-side notice on the qualifying form, separate ticket forthcoming

**Owner sign-off:** Charlotte 2026-05-02 (£50 voucher, switchable.org.uk URLs, soft cap as flag-not-block, Tremendous, automate from day one with backfill campaign).

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

- **Lucy Hizmo (id 25):** `primary_routed_to` = `enterprise-made-simple`, `routed_at` = `2026-04-20 08:31:14 UTC` (submitted_at + 5 min as proxy - owner confirmed manual-email routing but could not recall exact time). Inserted matching `routing_log` row (`delivery_method='manual_email'`, `delivery_status='sent'`). 14-day presumed-enrolment clock now starts from 2026-04-20 08:31 UTC → auto-flip window 2026-05-03.
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