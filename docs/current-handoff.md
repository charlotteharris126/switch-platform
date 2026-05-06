# Platform Handoff, Session 33, 2026-05-06

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
