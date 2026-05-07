# Platform Handoff, Session 33, 2026-05-06

## ⚡ PUSH FROM switchable/site Session 57 (Mable), 2026-05-07: Fastrack form back-end ready to wire

Front-end of the Fastrack form (lead-to-enrol uplift Phase 2) is built and waiting to ship. Owner needs to do three things on the platform side before the form does anything beyond Netlify dashboard storage. Estimated 2-3 hours plus deploy.

**Already shipped on switchable/site (commit pending Charlotte's browser test + /ultrareview before push):**

- Migration `platform/supabase/migrations/0087_fastrack_submissions.sql` written. Adds `leads.submissions.client_nonce` (UUID, indexed) + `leads.submissions.fastracked_at` (TIMESTAMPTZ) + new table `leads.fastrack_submissions` with the full payload shape, RLS policies for `functions_writer` (ALL) and `readonly_analytics` (SELECT). Reversible via the `-- DOWN` block at the bottom.
- `switchable/site/docs/funded-funnel-architecture.md` updated. Lead payload doc gains an "optional `client_nonce` hidden field" note (additive, no schema bump). New Fastrack payload schema 1.0 section added with full field-by-field table and the Edge Function pipeline spec (steps 1-8).
- `deploy/data/form-allowlist.json` carries a new `fastrack-funded-v1` entry with `webhook_url: null` (deferred). Audit will pass — null webhook is allowed for forms not requiring a routing destination yet.
- `deploy/template/funded-course.html` adds a hidden `client_nonce` input + pre-submit JS that generates a UUIDv4 client-side, populates the field, and rewrites `form.action` to `/funded/thank-you/?ref=<uuid>&course=<slug>` so the post-redirect URL carries the lookup token.
- `deploy/deploy/funded/thank-you/index.html` gains the full Fastrack section (form + dynamic-render JS reading matrix.json / courses.json / providers.json + post-submit confirmation state via `?fastracked=1`).
- `deploy/scripts/build-funded-pages.js` extended: providers manifest now carries `trust_line` + `funding_types`; matrix.json routes carry `providerId`, `providerIds`, `qualification`, `level`, `fundingRoute`, `fundingCategory`, and the course `outcomes[]` array.

**What's needed from platform (you, with Sasha-monitored verification):**

### 1. Apply migration 0087

```bash
cd platform
supabase db push
```

Migration is additive: two nullable columns + one new table. No downstream consumer breaks. After apply, expose schema (already exposed since `leads` is part of the existing setup; new table inherits) and verify via `\d leads.fastrack_submissions` in psql.

### 2. Patch `netlify-lead-router` to persist `client_nonce`

The funded form now sends `client_nonce` as a hidden field on every funded submission. The router needs to read it and write to `leads.submissions.client_nonce` on insert. Single-line change in the normalisation block. Optional: dead-letter the row if `client_nonce` is missing AND form-name is `switchable-funded` post 2026-05-07 (defensive — pre-fix submissions still in the queue would hit this; OK to skip if it complicates the rollout).

### 3. Create `fastrack-receive` Edge Function

Full spec at `switchable/site/docs/funded-funnel-architecture.md` → Fastrack payload schema → Edge Function pipeline. Eight steps:

1. Verify Netlify auth header (use the same shared secret pattern as `netlify-lead-router`).
2. Lookup parent: `SELECT id, prior_level_3_or_higher, course_id, primary_routed_to, region_scheme, funding_route FROM leads.submissions WHERE client_nonce = $1`. Not found → write to `leads.dead_letter` with `error_context = 'fastrack: parent client_nonce not found'`, return 200.
3. Compute two flags:
   - `l3_mismatch_flag = body.l3_reconfirmed === true` (any "my record might show a Level 3" answer is a DQ — FCFJ requires no L3).
   - `cohort_decline_flag = body.cohort_confirmed === false` (learner can't commit to this cohort's start date — DQ for this round, funded cohorts run on fixed dates).
4. Insert into `leads.fastrack_submissions` with all fields + `parent_submission_id = parent.id` + `l3_mismatch_flag` + `raw_payload`.
5. `UPDATE leads.submissions SET fastracked_at = now() WHERE id = parent.id`.
6. **DQ handling (Charlotte's directive 2026-05-07):** if either flag is true, auto-mark lost so the adviser doesn't waste a call. L3 takes precedence when both fire (more permanent disqualification).
   - L3 mismatch:
     - DB: `UPDATE crm.enrolments SET status = 'lost', lost_reason = 'l3_mismatch_self_reported', lost_at = now() WHERE submission_id = parent.id`.
     - Sheet: pass `auto_lost` flag to the appender; writes `Status = "Lost"`, `Lost Reason = "L3 mismatch (self-reported on fastrack)"`.
   - Cohort decline:
     - DB: `UPDATE crm.enrolments SET status = 'lost', lost_reason = 'cohort_decline', lost_at = now() WHERE submission_id = parent.id`.
     - Sheet: writes `Status = "Lost"`, `Lost Reason = "Cohort decline (couldn't commit to start date)"`.
   - Lost_reason CHECK constraint extension: pre-flight `crm.enrolments.lost_reason` constraint. If `l3_mismatch_self_reported` and `cohort_decline` aren't already permitted values, ship a one-line migration adding them BEFORE deploying the Edge Function.
7. Compose sheet projection (see below).
8. Call the v2 Apps Script appender (header-driven `FIELD_MAP`) for `parent.primary_routed_to` provider's sheet. Pass `parent_submission_id` so the appender finds the existing row and UPDATES the projection columns in place (do NOT append a new row). New FIELD_MAP entries: `fastracked → "Fastracked"`, `fastrack_notes → "Fastrack Notes"`. When `auto_lost` is set, the same call also updates `Status` and `Lost Reason` columns. Sheet headers need adding by Charlotte before this fires (see step 4 of this push).
9. Return 200.

**Sheet projection format:**

```
fastracked = "yes"
fastrack_notes =
  "Start: <readable window>
   Docs ready: ID <y/n> | Address <y/n> | Quals <y/n> | NI <y/n>
   L3 reconfirmed: <yes/no>[ ⚠ MISMATCH]
   Notes: <voice_of_learner_intro or '—'>"
```

Readable window map: `within_2_weeks → "Within 2 weeks"`, `within_4_weeks → "Within 4 weeks"`, `within_8_weeks → "Within 8 weeks"`, `still_deciding → "Still deciding"`.

### 4. Add the two columns to each provider sheet (Charlotte, manual)

Per memory `feedback_appender_version_preflight` — pre-flight against `infrastructure-manifest.md` first. v2 appender is header-driven so this is just adding two columns at the right edge of EMS, WYK, Courses Direct sheets:
- `Fastracked` (yes/no flag)
- `Fastrack Notes` (free text summary)

### 5. Wire the Netlify webhook

In Netlify dashboard: Forms → `fastrack-funded-v1` → Form notifications → Add outgoing webhook → URL `https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/fastrack-receive`. Then update `deploy/data/form-allowlist.json` to set `webhook_url` to that URL (currently null) and run the platform audit (`POST` to `netlify-forms-audit`) to confirm no discrepancies.

### 6. Test end-to-end

Submit a funded test form → land on thank-you with the Fastrack section → submit fastrack → verify:
- New `leads.submissions` row has `client_nonce` populated and `fastracked_at` stamped
- New `leads.fastrack_submissions` row exists with `parent_submission_id` matching, all fields populated, `l3_mismatch_flag` set correctly
- Provider sheet's `Fastracked` + `Fastrack Notes` columns updated for that lead's row (not appended)

Three confirmation paths to verify:

- **Standard happy path:** cohort confirmed + record won't show L3 → standard "Application sent" card. DB row `status = 'open'`. Sheet `Fastracked = "yes"`, `Fastrack Notes` populated. No status flip.
- **L3 mismatch path:** "Now I think about it, it might" on PLR question → "Funded route isn't open to you" card with self-funded CTA. DB `status = 'lost'`, `lost_reason = 'l3_mismatch_self_reported'`. Sheet `Status = "Lost"`, `Lost Reason = "L3 mismatch (self-reported on fastrack)"`, `Fastrack Notes` carries `⚠ MISMATCH` marker.
- **Cohort decline path:** "I need different dates" on cohort question → "This cohort isn't right for you" card with two CTAs (other funded + self-funded). DB `status = 'lost'`, `lost_reason = 'cohort_decline'`. Sheet `Status = "Lost"`, `Lost Reason = "Cohort decline (couldn't commit to start date)"`.

Both DQ paths also confirm the auto-lost prevents a wasted EMS call.

### 7. Optional Brevo notification (defer until Andy asks)

Spec deliberately stops at sheet update. If EMS adviser needs a faster signal, a `sendTransactional` to Andy with the fastrack summary can land later. Owner's call.

**Sasha's monitoring (after step 6 verifies):**

- Add `leads.fastrack_submissions` row count + `l3_mismatch_flag` rate to her Monday audit.
- Add `fastrack-receive` failure rate (dead_letter rows with `error_context LIKE 'fastrack:%'`) to the daily failure check.

**Cross-reference:** `strategy/docs/lead-to-enrol-uplift.md` Phase 2, `switchable/site/docs/funded-funnel-architecture.md` (lead payload + Fastrack payload schema 1.0), migration `0087_fastrack_submissions.sql`, allowlist entry `fastrack-funded-v1`.

---

## Current state

Phase 3b + 3c + 3d email rearch code complete and held for tomorrow's Thursday cutover. Sheet alignment + auto-flip safety fixes shipped today after a same-day incident: 5 leads auto-flipped to presumed_enrolled this morning, 1 wrongly confirmed lost via sheet paste-error (Lana/Lucy mix-up). All 5 reverted, cron paused, sheet-edit-mirror cross-check (Edge Function + Apps Script on all 3 provider sheets) shipped to prevent recurrence. Four small platform items also coded tonight: lost_reason taxonomy expansion, Phase 6c failure alert cron, day-12 provider warning cron (dormant pending template), and the sheet cross-check above. Cutover bundle now: 8 functions + 6 migrations + 1 backfill script. DKIM green, parity green, ready for tomorrow morning.

## What was done this session

**Incident response — Lana/Lucy + auto-flip:**
- Diagnosed kieranwrites@gmail.com auto-resubmissions as iOS Safari POST-replay (same event_id 5+ times over 24h, only IP rotating per Private Relay). Mable shipped the AJAX-submit fix to switchable/site (commit 7bc0a4a, deployed live).
- Investigated dashboard "more enrolments than we have" anomaly. Found 5 leads auto-flipped at 06:00 UTC by enrolment-auto-flip cron: Sam (CD), Ruby/Laura/Raveena (WYK), Lana (EMS). Initial scoping missed Lana — she was caught after a separate Lucy issue surfaced.
- data-ops/014 reverted Sam, Ruby, Laura, Raveena to `open`.
- Lana/Lucy diagnosis: Lucy's sheet row was assigned Lana's lead_id (`SL-26-04-0021`) at original manual-onboarding time. Provider's "Cancelled" note on Lucy's row routed to Lana via the wrong lead_id. Owner clicked confirm, Lana flipped to lost.
- data-ops/015 reverted Lana → open, applied Lucy → lost (lost_reason temporarily `other` because `cancelled` not in the CHECK constraint), Brevo SW_ENROL_STATUS resync for both.
- Auto-flip cron paused: `cron.unschedule('enrolment-auto-flip-daily')` run manually + migration 0080 records the pause for next deploy.
- Sheet audit: cross-checked all 113 EMS-routed DB submissions against the sheet's lead_id column. Only 1 mismatch surfaced (Melanie Watson sheet row had `SL-26-04-0043` instead of `SL-26-04-0045`). Charlotte fixed the sheet manually.

**iOS POST-replay fix (cross-project):**
- Funded form action="/funded/thank-you/" (POST) left iOS Safari tabs in a "loaded by POST" state, replaying the original POST when iOS restored memory-evicted tabs.
- Fix shipped via Mable in switchable/site: new `js/form-submit-fetch.js` helper, swapped 5 `form.submit()` sites in `template/funded-course.html` to use `fetch` + `window.location.href` so the tab's history entry is a clean GET. Built locally, audit clean, pushed in commit 7bc0a4a.

**Email rearch — Phase 3b + 3c + 3d code shipped (held for cutover):**
- Phase 3b: `_shared/brevo.ts` adds `marketingOptIn?: boolean | null` to `UpsertContactArgs`; sets `emailBlacklisted` on the Brevo POST when defined. `_shared/route-lead.ts` (matched + no_match upsert helpers) and `brevo-event-webhook` all pass it through. Atomic single Brevo call, dead_letter on failure already wired by callers.
- Phase 3c: new `data-ops/013_backfill_email_campaigns_channel.ts` Deno script. Walks Brevo contacts, syncs emailBlacklisted to match SW_CONSENT_MARKETING. Asymmetric — only blocks; never unblocks (hard-bounce / complaint contacts stay safe). Halt on >0.5% errors per batch. Resumable via gitignored checkpoint. Dry-run validated tonight: 70 contacts to block, 0 errors.
- Phase 3d: new `brevo-consent-reconcile-daily` Edge Function (04:00 UTC). Walks Brevo contacts, detects drift both directions, auto-corrects only Brevo-blocked-DB-consenting case. Logs to `crm.consent_history`. Writes leads.dead_letter alert if drift > 2%. Migration 0081 schedules the cron.

**Phase 6b — admin/automations dashboard page (deployed live):**
- New `app/admin/automations/page.tsx` route with shadow-mode banner, drift-alert banner, utility transactional table (per email_type with last sent / 24h / 7d / failures / bounces), daily crons table, marketing automations placeholder cards.
- Sidebar link added in `components/admin-shell.tsx` Tools section.
- Deployed via git push, Netlify auto-build complete.

**Four small follow-up items (held for cutover):**
1. Sheet-edit-mirror cross-check: Apps Script reads row's email column and sends as `row_email`; Edge Function rejects updates where row_email ≠ submission.email + emails owner. Backward compatible (legacy sheets fall through). Apps Script updates applied to all 3 provider sheets tonight (EMS, Courses Direct, WYK Digital). Edge Function side held for Thursday deploy.
2. Day-12 warning: new `email-presumed-warning-cron` Edge Function (05:00 UTC). Finds 12-14-day open leads, batches by provider, sends ONE email per provider listing affected leads via Brevo template (params: PROVIDER_NAME, CONTACT_NAME, COUNT, LEADS_HTML, FLIP_DATE). Migrations 0084 (extend email_type CHECK) + 0085 (cron schedule). Dormant until Charlotte creates the Brevo template + sets `BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING` env var. Prerequisite for re-enabling auto-flip.
3. lost_reason taxonomy expansion: migration 0082 adds `cancelled` and `withdrew_after_enrolment` to the CHECK constraint, retroactively reclassifies Lucy from `other` → `cancelled`. Admin lead-detail dropdown updated (`enrolment-outcome-form.tsx`, `actions.ts`).
4. Phase 6c failure alert: new `email-failure-alert-daily` Edge Function (04:30 UTC). Counts failed transactional sends in last 24h; if ≥3, emails owner + writes dead_letter row. Migration 0083 schedules the cron.

**Cross-project push:**
- switchleads/clients/ (Nell): pushed educational-email task to her handoff. Three signed pilot providers need a Charlotte-voiced email explaining the 14-day auto-marking mechanic, framed proactively (not as "we made a mistake"), reusing voice file Pair 4 phrasing.

## Next steps

1. **Thursday morning cutover ritual** (~30 min):
   1. Final parity check: U1 column on `/admin/leads` still all-green.
   2. Set `BREVO_SHADOW_MODE=false` env var.
   3. Deploy 8 functions: `routing-confirm`, `netlify-lead-router`, `brevo-event-webhook`, `admin-brevo-resync`, `sheet-edit-mirror`, `brevo-consent-reconcile-daily`, `email-failure-alert-daily`, `email-presumed-warning-cron`.
   4. Apply migrations 0080-0085 via `supabase db push`.
   5. Disable the 8 old utility automations in Brevo (Settings → status → Off, archive templates into "Archived" folder, do NOT delete).
   6. Run `data-ops/013_backfill_email_campaigns_channel.ts --apply` (mutates ~70 contacts, ~2 min runtime).
   7. Tail `/admin/automations` through the morning. By Friday morning, first reconcile cron run should show no drift alert banner.
2. **Friday: clean-state verification** of /admin/automations after first 04:00 UTC reconcile run. If alert fires, dig into the dead_letter row.
3. **Brevo template creation (Charlotte's choice, when ready):** day-12 warning template with params PROVIDER_NAME, CONTACT_NAME, COUNT, LEADS_HTML, FLIP_DATE. Switchable brand (provider-facing). Once template ID set in `BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING` env var, the cron starts sending real emails.
4. **Auto-flip re-enable (Charlotte's call after day-12 warning lives a few clean days):** one SQL line — `SELECT cron.schedule('enrolment-auto-flip-daily', '0 6 * * *', $$SELECT crm.run_enrolment_auto_flip();$$);`
5. **HubSpot integration unpause:** when Ranjit replies with the form URL. Migration 0049 + route-lead.ts edits + receiver Edge Function ready.
6. **Apprenticeship pricing schema split (Riverside dual-route):** trigger is Kevin signing the activation page (sent 5 May, awaiting per Nell session 16). Adds lead_route + event_type to enrolments, per-route pricing on providers, 60-day presumed clock variant.
7. **Failure-alert email Brevo template creation (optional):** Phase 6c uses `sendBrevoEmail` with raw HTML for now. If Charlotte wants a branded template instead, swap in a template send. Low priority.
8. **Lead-to-enrol uplift Phase 2 — Brevo SMS integration + fastrack form back-end.** Two builds:
   - **Brevo SMS** on the transactional rail. Add `sendTransactionalSms` helper in `_shared/brevo.ts` mirroring `sendTransactional`. Idempotency on `(submission_id, sms_type)` via either a new `crm.sms_log` table or extending `crm.email_log` (decide via design doc first). Switchable-branded sender. 4-touch sequence (T+0 / T+24h / T+5d / T+10d) fires from cron + state triggers similar to the email utility track. Sequenced after Thursday cutover stabilises.
   - **Fastrack form back-end.** New Supabase table for fastrack-form responses (joined to `leads.submissions` via submission_id), `primed` flag exposed back to routing logic, qualification-name comparison logic that flags any mismatch between original q3 answer and the fastrack re-ask, surfaces the flag to EMS pre-call.
   - Schema design + data-architecture doc update first, migration files, RLS, then Edge Function plumbing. Full scope: `strategy/docs/lead-to-enrol-uplift.md`.
9. **Lead-to-enrol uplift Phase 3 — postcard trigger.** Edge Function fires print-job webhook at routing confirmation. A/B group assignment, 50/50 sample for the first 100 routed leads. Sequenced after Phase 2 lands.
10. **Lead-to-enrol uplift Phase 3 contingent — enrolment-slot calendar webhook.** Only fires if Andy buys in at the catch-up. Cal.com (or similar) webhook into Supabase against the lead row, exposed to fastrack-form completers as the booking surface. Owner narrowed: no longer booking a qualifying call, instead booking the actual enrolment meeting Andy already runs internally — higher commitment signal, EMS skips the cold-dial chase entirely.

## Decisions and open questions

### Decisions made

- **Auto-flip cron paused.** Why: 5 leads auto-flipped at 06:00 UTC today without provider warning. Day-12 warning system is the prerequisite to re-enable. Until then, no auto-flips fire.
- **Day-12 warning is the proper fix, not removing auto-flip entirely.** Why: contractual 14-day → presumed_enrolled mechanic is a real billing trigger and a good behaviour-shaper for providers; just needs grace-period email so they're not surprised.
- **Marketing automation entry trigger = attribute-change (`SW_CONSENT_MARKETING = true`), NOT list-add.** Why: fewer moving parts. The attribute is already enforced at four layers (form submit, every routing, daily reconcile cron, one-off backfill). List-add would add a fifth thing to keep in sync. Lists become legacy-only after Thursday cutover.
- **Asymmetric backfill rule (only block, never unblock).** Why: a Brevo contact with emailBlacklisted=true might be there for non-consent reasons (hard bounce, spam complaint). Re-enabling them via attribute-only signal could cross GDPR/deliverability lines. Re-opt-in is the form's job, not the backfill's.
- **Cutover Thursday morning, not tonight.** Why: parity is green and DKIM verified, but cutover wants alert eyes for first hour of monitoring; Wed-night-tired makes failure cost higher. Tomorrow morning fresh = same outcome with cleaner safety margin.
- **Lucy's lost_reason reclassified `other` → `cancelled` retroactively** as part of migration 0082. Why: cleaner taxonomy from this point forward; the `notes` field still preserves the full cancellation context.
- **Apps Script cross-check rolled out tonight, before Edge Function deploys Thursday.** Why: backward compatible — Edge Function tolerates missing `row_email`. Apps Script side ready means the cross-check activates immediately when Edge Function deploys, no per-sheet rollout lag.

### Open questions

- **Day-12 warning email copy + design.** Charlotte writes when ready. Provider-voiced (SwitchLeads brand), ops-tone, no apology framing. Single email per provider per day listing affected leads.
- **Auto-flip resume timing.** Days vs weeks of clean day-12 warning before re-enabling? No fixed answer — Charlotte's call once warning's been live and not throwing alerts.
- **Owner-test sheet for QA.** Worth having a dummy provider sheet for testing sheet-edit-mirror changes without touching live providers? Not blocking, but would have caught the row_email cross-check before deploy if we had one.

## Watch items

- **🔴 Thursday cutover** — full sequence in Next steps #1.
- **🔴 First reconcile cron run** Friday morning — should show clean state if 3c backfill ran cleanly.
- **🟡 Day-12 warning cron will run daily but exit early** with `reason: BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING env not set` until Charlotte creates the template. That's the expected dormant state.
- **🟡 Failure alert cron** runs Friday morning for the first time. If it finds drift in the immediate post-cutover period (e.g. failed sends during the deploy), expect a dead_letter row + email to Charlotte. Investigate.
- **24h watch on kieranwrites@gmail.com** — expect zero new submissions (he closed his Safari tab + the iOS fix is live for new users).
- **Auto-flip cron stays paused** until Charlotte decides on the day-12 warning + re-enable strategy.
- **Sheet-edit-mirror cross-check is now active end-to-end across all 3 provider sheets** once the Edge Function deploys Thursday. Should silently catch any future paste-error duplicates by emailing Charlotte the anomaly.
- **Email_log enum constraint** — migration 0084 adds `provider_presumed_warning`. If this migration fails on apply, the day-12 cron will fail when it tries to insert. Check after `supabase db push`.

## Next session

- **Folder:** platform/
- **First task:** run the Thursday cutover ritual (Next steps #1). Pre-flight on `/admin/leads` U1 column + DKIM still verified, then deploy 8 functions, apply migrations 0080-0085, disable old utility automations in Brevo, run data-ops/013 --apply, monitor.
- **Cross-project:** Pushed today to switchleads/clients/ (Nell handoff session 16) — provider auto-marking educational email queued for next Nell session. Pushed today to switchable/site/ (via Mable session 55) — iOS POST-replay fix bundled and deployed in commit 7bc0a4a. No new outbound pushes from this session beyond those already in flight.

  **Incoming pushes (added this session):** Lead-to-enrol uplift Phase 2-3 work pushed by Mira from `strategy/`. Phase 2: Brevo SMS integration on transactional rail + fastrack form back-end (Supabase table, primed flag, qualification comparison logic). Phase 3: postcard trigger + enrolment-slot calendar webhook (contingent on owner + Andy at the catch-up). Sequenced after Thursday cutover stabilises. Full scope: `strategy/docs/lead-to-enrol-uplift.md`.
