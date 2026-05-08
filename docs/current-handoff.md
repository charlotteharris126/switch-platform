# Platform Handoff, Session 34, 2026-05-07

## ✓ RESOLVED 2026-05-07 ~21:00: Fastrack cohort_decline POST drop (was: PUSH FROM platform Session 34 to switchable/site Session 58)

Sasha's PUSH at the top of switchable/site Session 58 ("Fastrack cohort_decline path drops the form POST before it reaches Netlify") is fixed and verified live. Both sides agree.

**Root cause (confirmed):** frontend bug. The fastrack submit handler rewrote `form.action` to a query-param URL (e.g. `/funded/thank-you/?fastracked=1&cohort=no`) before submitting, and Netlify Forms was silently dropping that URL shape on cohort=no specifically while accepting cohort=yes. Tests 1+2 worked because their query params didn't include `cohort=no`.

**Mable shipped (commit `864727c`):**
- Submit handler now POSTs to clean static `/funded/thank-you/` and navigates to the DQ-encoded URL via the `SwitchableFormSubmit` wrapper's new optional `redirectTo` second arg.
- Wrapper extended backward-compatibly. All 6 existing call sites unchanged.
- Mirrored on `/preview/fastrack-thank-you/` for the EMS demo URL.
- Owner verified end-to-end: charliemarieharris@icloud.com cohort=No test landed in `leads.fastrack_submissions` (id 3), EMS sheet wrote, DQ card rendered.

**Permanent rule for any Switchable Netlify form** (added to switchable/site session decisions): always POST to the form's static action URL and navigate to encoded outcome URLs separately. Never bake outcome state into `form.action` before submitting.

## ⚡ NEW PUSH FROM switchable/site Session 59, 2026-05-07: Receiver for `fastrack-cohort-decline-v1` enrichment form (PRIORITY: medium, scheduled with Mable's next session)

Owner's call this session: the cohort_decline DQ outcome card should become a proper waitlist enrichment form mirroring the `/waitlist/` pattern, not a passive confirmation. Mable will build the frontend next session and needs the platform receiver wired in lockstep.

**What Mable will build (frontend):**
- New Netlify form on the fastrack thank-you page when `cohort=no` fires: warm hero + enrichment form below.
- Suggested fields (owner final say next session): `phone` (optional tel), `start_timing` (chips: next month / 2-3 months / 6 months / just exploring), `dates_blocker_notes` (optional textarea), plus the standard hidden `parent_ref` token, `terms_accepted`, `marketing_opt_in`, `bot-field-cohort-decline`, `schema_version=1.0`, `form-name=fastrack-cohort-decline-v1`.
- "Save my details" submit + "Skip for now, thanks" escape link.

**What Sasha needs to build (platform):**
- New Edge Function `fastrack-cohort-decline-receive` (or extension to existing `fastrack-receive` keyed off `form-name`).
- Updates the existing `leads.fastrack_submissions` row located via `parent_ref` token. No new row inserted — this is enrichment of the cohort_decline submission already there.
- Schema-additive only on `leads.fastrack_submissions`: new columns `phone TEXT`, `start_timing TEXT` (CHECK constraint over the four chip values), `dates_blocker_notes TEXT`. No bump to fastrack payload `schema_version` (additive per `.claude/rules/schema-versioning.md`).
- New Postgres role / RLS check: not needed, same access shape as fastrack-receive.
- Migration file with `-- DOWN`, changelog entry, infrastructure-manifest entry per `data-infrastructure.md`.

**Sequencing:**
- Mable will NOT add the form name to deployed HTML until Sasha confirms the webhook URL, per the form-name rule in `switchable/site/CLAUDE.md`.
- Sasha to flag in next-session handoff once receiver is deployed and webhook URL is in `deploy/data/form-allowlist.json`-ready shape.

**Why this matters:** cohort_decline learners currently dead-end on a "doesn't fit" card. Owner's data: provider has the cohort_decline answer in the EMS sheet but no way to know WHEN the learner could start or WHAT got in the way. Enrichment captures both, lets EMS slot them into the next cohort intelligently.

## ✓ RESOLVED 2026-05-07 ~19:30: Fastrack back-end build complete (was: PUSH FROM switchable/site Session 57)

The original push asked Sasha to ship the platform side of the Fastrack form. Now done end-to-end. Both sides agree.

**Sasha shipped (this session, see "What was done this session" below):** migration `0087` applied, `netlify-lead-router` patched for `client_nonce`, `fastrack-receive` Edge Function deployed, EMS sheet columns added, `lost_reason` CHECK constraint pre-flighted.

**Mable closed the loop (switchable-site main):**
- Commit `53648a7`: `deploy/data/form-allowlist.json` flipped `fastrack-funded-v1` webhook URL from `null` to `https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/fastrack-receive` (Sasha's source-of-truth update, deployed via site rebuild).
- Daily `netlify-forms-audit` should clear on its next run now that allowlist + Netlify dashboard agree.
- Earlier site commits the same evening: `2d56a29` (Fastrack front-end), `6d4919b` (email migration to switchable.org.uk + WYK/CD provider skeletons), `634da79` (iOS POST-replay fix extended to find-your-course + contact).

**Outstanding for owner:** end-to-end smoke test next session. Submit a funded form, fill the Fastrack form, verify `leads.fastrack_submissions` row + `fastracked_at` stamp + EMS sheet column writes + correct UI per outcome path (qualify, L3 mismatch DQ, cohort decline DQ). If clean, retire the Netlify Forms dashboard queue (replay any pre-deploy submissions).

## Current state

Email rearch cutover completed today after the Tuesday ritual was discovered un-shipped at session start (BREVO_SHADOW_MODE was still default-true, 6 migrations un-applied, 3 cron functions un-deployed, 8 legacy Brevo automations still active). Phase 4 closeout (drop last_chaser_at + add view + sunset cron) also shipped same session after sub-agent code review caught two BLOCKERs. Two-channel architecture verified live in Brevo by owner. Mable's Fastrack back-end push (front-end already built, awaiting platform plumbing) is the highest-priority next-session task. Marketing automations cleared to launch once owner sets BREVO_TEMPLATE_RE_ENGAGEMENT.

## What was done this session

Cutover ritual, the missing pieces from Tuesday:

- BREVO_SHADOW_MODE flipped to false in Supabase Vault. Utility transactional sends are now real, not log-only.
- 4 Edge Functions deployed: brevo-consent-reconcile-daily (NEW), email-failure-alert-daily (NEW), email-presumed-warning-cron (NEW, dormant), sheet-edit-mirror (REDEPLOY with row_email cross-check).
- Migrations 0080 to 0085 applied via supabase db push --linked.
- Migration 0080 patched to be idempotent (DO / IF EXISTS guard). Manual unschedule from Tuesday's incident had already removed the cron job, so the unguarded unschedule threw XX000 on first apply attempt.
- 8 legacy Brevo utility automations disabled in Brevo dashboard, templates archived. Off-but-present until 2026-08-05.
- data-ops/013_backfill_email_campaigns_channel.ts ran live with 47 mutations, 178 skipped, 0 errors final. First apply attempt failed with CHECK constraint violation; script patched to use field_changed='email_campaigns_subscription' (lowercase, matches CHECK).

Phase 4 closeout, deployed after cutover:

- Migration 0086 dropped crm.enrolments.last_chaser_at column, added crm.vw_enrolments_chaser_state view (security_invoker=true), rewrote crm.fire_provider_chaser to remove the dual-write, backfilled historical chaser sends from enrolments to email_log.
- Migration 0086 reordered after first apply attempt failed. Original section order had view creation before column drop; view's e.* expanded to include the doomed column, so DROP COLUMN refused. Reordered to backfill, function rewrite, drop column, then view.
- Migration 0088 scheduled email-sunset-cron-daily (03:00 UTC), extended crm.email_log.email_type CHECK with re_engagement, extended crm.consent_history.source CHECK with sunset_suppression.
- New Edge Function email-sunset-cron deployed. Two-phase: 180-day no-engagement, re-engage, 14-day grace, then suppress. Asymmetric, marketing channel only. Phase 1 dormant until BREVO_TEMPLATE_RE_ENGAGEMENT is set.
- Dashboard files updated to derive last_chaser_at from email_log: app/admin/layout.tsx (badge counts via view), app/admin/leads/page.tsx (table column from email_log map), app/admin/actions/page.tsx (action queues via view), app/admin/leads/bulk-actions.ts (comment refresh).
- _shared/brevo.ts EmailLogType union extended with re_engagement.
- Pushed via git, Netlify auto-rebuild triggered.

Audit-row repair:

- 41 crm.consent_history rows inserted via SQL editor. Catches the ~30 partial-failure contacts from the failed first backfill apply, plus some always-opted-out contacts and owner-test domains. metadata.reason='audit_repair_after_2026-05-07_partial_failure' tags them for future analytics filtering.

Sub-agent code review:

- Two reviewers ran on the Phase 4 migrations, Edge Function, and dashboard changes before deploy.
- Fixes applied for: Phase 2 partial-failure transaction reordering (audit + flip atomic), Phase 1 marketing_opt_in latest-row check (GDPR Art. 21 exposure), MIN to MAX on re_engagement triggered_at, healthy-status floor on first-send check, backfill CASE explicit funding_category fallback, updated_at touch retained in fire_provider_chaser rewrite, view security_invoker=true, 0088 DOWN block syntax wrapped in DO.

Doc updates:

- platform/docs/changelog.md: cutover entry at top, plus Phase 4 and sunset cron entries.
- platform/docs/infrastructure-manifest.md: Last verified date, Retired infrastructure section (8 Brevo automations, last_chaser_at column note), three new manifest changelog rows.
- switchable/email/CLAUDE.md: Build state paragraph rewritten to reflect today's actual cutover, not Tuesday's planned one.
- accounts-legal/docs/current-handoff.md: pushed GDPR request-handling SOP task to Clara (next steps item 17, no deadline).
- switchable/email/docs/current-handoff.md: pushed BREVO_TEMPLATE_RE_ENGAGEMENT template build task (next steps item 9, no deadline).

Memory:

- New project memory: project_auto_flip_and_day12_deferred. Auto-flip cron and day-12 warning system both deferred indefinitely per owner's call 2026-05-07.
- New feedback memory: feedback_verify_deploy_state. At session start, run read-only diagnostics (supabase functions list, supabase migration list --linked) before stacking new work on top of user's claimed state. Burnt the morning of this session on this exact mistake.

Incidents handled:

- Brevo API key exposure during read -p paste mishap (bash flag in zsh shell). Investigation showed the leaked string was not in active Brevo keys list, already deleted at a prior point. No rotation needed. New "platform" key created for one-off backfill, deleted post-session.
- DB password reset triggered by DNS resolution failure on Direct connection URL. Owner switched to Session pooler. Edge Functions auto-updated via Supabase's managed SUPABASE_DB_URL injection.
- Migration 0086 first apply attempt failed (view-vs-column-drop ordering bug). Whole migration rolled back cleanly inside transaction. Reordered, re-applied successfully.
- data-ops/013 first apply attempt failed (CHECK constraint violation). ~30 contacts got Brevo-blocked before consent_history INSERT failed, leaving an audit gap. Repaired via SQL editor (41 rows).

## Next steps

1. **Verify Netlify build completed cleanly post-push** and dashboard renders properly. URLs to check: /admin/leads (Last chaser column), /admin/actions (queues populate), /admin/automations (still green).

2. **Mable's Fastrack back-end deploy (HIGH PRIORITY).** Mable's switchable/site Session 57 (today, 2026-05-07) pushed the front-end of the Fastrack form (lead-to-enrol uplift Phase 2). Front-end is built and waiting on platform plumbing. Six sub-tasks, ~2-3 hours plus deploy. Full spec at `switchable/site/docs/funded-funnel-architecture.md` → Fastrack payload schema 1.0 + Edge Function pipeline:

   1. **Apply migration 0087_fastrack_submissions.sql.** Already in repo as un-applied (renumbered around in this session — file is the original Mable one, my Phase 5 sunset cron took 0088). Adds `leads.submissions.client_nonce` (UUID, indexed) + `leads.submissions.fastracked_at` (TIMESTAMPTZ) + new table `leads.fastrack_submissions` with payload columns + RLS for functions_writer (ALL) and readonly_analytics (SELECT). Additive, no consumer breaks.
   2. **Patch netlify-lead-router** to read `client_nonce` from the funded form payload and write it to `leads.submissions.client_nonce` on insert. Single-line addition in the normalisation block.
   3. **Build new Edge Function `fastrack-receive`.** Eight-step pipeline (full spec in funded-funnel-architecture.md): verify Netlify auth, lookup parent by client_nonce, compute l3_mismatch_flag + cohort_decline_flag, insert fastrack_submissions row, stamp parent.fastracked_at, DQ handling (auto-mark lost on either flag with the appropriate lost_reason — pre-flight that crm.enrolments.lost_reason CHECK includes `l3_mismatch_self_reported` and `cohort_decline`; ship a one-line migration if not), compose sheet projection, call v2 Apps Script appender to UPDATE existing row (not append), return 200.
   4. **Add two columns to each provider sheet** (owner manual): `Fastrack Application Filled` (yes/no) and `Fastrack Details` (full free text — composed summary of all fastrack answers including the voice-of-learner intro). EMS, WYK, Courses Direct. v2 appender is header-driven so no script change needed once sheet headers exist.

      Plus, on a DQ outcome (l3_mismatch or cohort_decline), the appender ALSO writes to existing `Status` and `Lost Reason` columns (already on the sheets) so the lead's row reflects the DQ in addition to recording fastrack details. So a DQ writes 4 columns; a happy-path fastrack writes 2.
   5. **Wire Netlify webhook:** Forms → fastrack-funded-v1 → outgoing webhook → fastrack-receive function URL. Then update deploy/data/form-allowlist.json to set webhook_url (currently null) and run netlify-forms-audit to confirm clean.
   6. **End-to-end test:** submit funded test form → Fastrack form on thank-you page → verify happy path (no flips, sheet updated), L3 mismatch path (auto-lost with l3_mismatch_self_reported), cohort decline path (auto-lost with cohort_decline).

   **Spec freeze 2026-05-07 evening — latest details from final Mable iteration:**

   - **Form payload schema (1.0)** captured on `leads.fastrack_submissions`: `cohort_confirmed` (bool), `transport_help_requested` (bool, optional), `preferred_intake_id` (text, set in multi-intake mode where learner picks a specific date — single-intake just gets the only intake's id), `docs_ready` (bool — soft flag, NOT a DQ trigger), `l3_reconfirmed` (bool — `l3_mismatch_flag = (l3_reconfirmed === true)`), `voice_of_learner_intro` (text, optional, capped 1000 chars), `terms_accepted` (bool), `marketing_opt_in` (bool — asymmetric handling: only `true` writes a fresh `crm.consent_history` row, `false`/blank does NOT downgrade existing parent consent).

   - **Outcome paths consolidated to two**: qualify (any happy path) and DQ (any L3 mismatch OR cohort decline). The thank-you page reads `?l3=yes` or `?cohort=no` for analytics, but the user sees the same DQ confirmation either way. Auto-lost reasons: `l3_mismatch_self_reported` or `cohort_decline`. `docs_ready=false` is a soft flag, never auto-lost.

   - **Sheet projection on a happy-path fastrack** writes 2 columns: `Fastrack Application Filled = "yes"`, `Fastrack Details = <composed summary>`. Composed summary includes `Cohort confirmed: yes/no | Cohort: <date>/<id> | Transport help: yes/no | Docs ready: yes/no | L3 reconfirmed: yes/no | Notes: <voice of learner or '—'>`.

   - **Sheet projection on a DQ fastrack** writes 4 columns: `Fastrack Application Filled = "yes"`, `Fastrack Details = <composed summary with ⚠ marker>`, `Status = "Lost"`, `Lost Reason = "L3 mismatch (self-reported on fastrack)"` or `"Cohort decline (couldn't commit to start date)"`.

   - **Marketing consent URL hint:** the funded form's submit JS appends `&m=1|0` to the post-submit redirect URL based on whether the parent ticked marketing. The thank-you page uses this only to render the right consent UI (info line for opted-in vs fresh checkbox for not). The Edge Function should NOT use the URL `m` param; it should rely on the form's own `marketing_opt_in` body field with asymmetric handling.

   - **Front-end ships standalone**: form HTML, dynamic copy, JS routing, and outcome cards are all live without the Edge Function. Until the webhook lands, fastrack submissions sit in Netlify's Forms dashboard for owner replay. No data is lost.

3. First scheduled reconcile cron run 2026-05-08 04:00 UTC. Should report zero drift since today's 3c backfill aligned everything.

4. First scheduled failure-alert cron run 2026-05-08 04:30 UTC. Should not fire.

5. Optional: trigger email-sunset-cron manually from Supabase dashboard with x-audit-key header. Expected response: all-zero candidates plus `missing_template_env: true` (template env not set yet, that's fine).

6. Owner-side: build BREVO_TEMPLATE_RE_ENGAGEMENT template in Brevo, set its id in Supabase Vault. Spec lives in switchable/email/docs/current-handoff.md item 9. No deadline (no qualifying contacts for ~6 months).

7. Owner-side: marketing automations turn-on (N1, N2, N3, referral cold-lead, referral lost-lead). Cleared to launch in Brevo whenever templates and engagement-based entry filters are ready.

8. Lead-to-enrol uplift Phase 2 (Brevo SMS half): SMS helper in _shared/brevo.ts mirroring sendTransactional. Idempotency design via crm.sms_log table or extending crm.email_log (decide via design doc first). 4-touch sequence T+0 / T+24h / T+5d / T+10d. Sequenced after Mable's Fastrack back-end (item 2) lands.

9. Lead-to-enrol uplift Phase 3: postcard trigger + enrolment-slot calendar webhook (contingent on Andy buy-in at the next catch-up). Sequenced after Phase 2.

10. HubSpot integration unpause: when Ranjit replies with the form URL. Migration 0049 + route-lead.ts edits + receiver Edge Function ready.

11. Apprenticeship pricing schema split (Riverside dual-route): trigger is Kevin signing the activation page sent 5 May.

12. Sasha monitoring add-ons (post-Mable-Fastrack-deploy): leads.fastrack_submissions row count + l3_mismatch_flag rate to her Monday audit; fastrack-receive failure rate (dead_letter rows with error_context LIKE 'fastrack:%') to the daily failure check.

## Decisions and open questions

### Decisions made

- Cutover ritual ran in this session, not Tuesday as the previous handoff suggested. Why: Tuesday's deploy only covered 5 Edge Function redeploys; the rest of the ritual was un-shipped, discovered when supabase db push surfaced 6 unapplied migrations at session start.
- Phase 4 + sunset cron shipped this session too, not deferred 24-48h as initially planned. Why: owner pushed for full mop-up to clear the deck for marketing automation launch; sub-agent code review had caught real BLOCKERs and they were fixed; backfill confirmed end state on dashboard. Ship-now risk acceptable.
- Audit row repair was inclusive (caught ~10 always-opted-out and ~5 owner-test contacts beyond the strict ~30 from partial failure). Why: precise targeting required cross-Brevo-DB join; pragmatic single-DB query catches the gap with harmless extra rows. metadata.reason flag distinguishes for analytics filters.
- 0087 collision (mine vs Mable's fastrack) resolved by renaming mine to 0088. Why: Mable's fastrack file was created independently between sessions; safer to renumber the un-applied one (the new sunset cron) than disrupt Mable's pending workstream.
- DB password reset was safe in this setup. Why: Edge Functions get SUPABASE_DB_URL auto-injected by Supabase platform and auto-update on password reset. No external direct-connection consumers (Metabase not set up; Postgres MCP uses readonly_analytics role with separate creds). No .env files in repo.
- Brevo API key from terminal-paste leak: not rotated. Why: investigation showed the leaked string was not in active Brevo keys list (already deleted at a prior point), so the leak is moot. New "platform" key created only for the one-off local backfill, deleted post-session.

### Open questions

- Marketing automations launch date: owner's call. Cleared on platform side.
- BREVO_TEMPLATE_RE_ENGAGEMENT template content and voice: owner's call. Brief in switchable/email/docs/current-handoff.md item 9.
- Mable's Fastrack lost_reason values (l3_mismatch_self_reported, cohort_decline): pre-flight CHECK constraint before deploying fastrack-receive. Ship a one-liner migration if values aren't already permitted.
- Optional Brevo notification step in fastrack pipeline: deferred until Andy asks for it. Spec deliberately stops at sheet update.

## Watch items

- 🔴 Netlify build status. Needs verification it completed cleanly post-deploy (~3 min after git push). If broken, dashboard errors on /admin/leads and /admin/actions queries.
- 🔴 First reconcile cron run 2026-05-08 04:00 UTC. Should report zero drift if 3c backfill ran cleanly. If alert fires, check dead_letter for source='reconcile_drift'.
- 🟡 First failure-alert cron run 2026-05-08 04:30 UTC. Should not fire. If it does, check dead_letter for source='email_failure_alert'.
- 🟡 First sunset cron run 2026-05-08 03:00 UTC. Should report all zeros (no qualifying candidates yet).
- 🟡 41 audit repair rows in consent_history. Filter via metadata.reason='audit_repair_after_2026-05-07_partial_failure' if analytics needs to exclude.
- 🟡 email-presumed-warning-cron deployed but dormant. Runs daily 05:00 UTC, exits early because BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING env var not set. Auto-flip also paused indefinitely per owner's call.
- 🟡 sheet-edit-mirror cross-check active end-to-end. Should silently catch any paste-error duplicates by emailing owner the anomaly.
- 🟢 Two-channel architecture verified live in Brevo by owner: opted-out contacts blocked from marketing, transactional continues.

## Next session

- **Folder:** platform/
- **First task:** verify last 24h of cron runs were clean. Check /admin/automations or vw_cron_runs for the five daily crons (sunset 03:00, reconcile 04:00, failure-alert 04:30, stalled 09:00, U4 09:30). Confirm no dead_letter rows added overnight. Then start Mable's Fastrack back-end deploy (Next steps item 2). Estimated 2-3 hours plus deploy.
- **Cross-project:** Pushed today to accounts-legal/docs/current-handoff.md (item 17, GDPR request-handling SOPs for Clara, no deadline) and switchable/email/docs/current-handoff.md (item 9, BREVO_TEMPLATE_RE_ENGAGEMENT template brief, no deadline). Incoming pushes still queued: Mable's Fastrack back-end (full detail in switchable/site/docs/funded-funnel-architecture.md), Lead-to-enrol uplift Phase 2-3 SMS + postcard from strategy/.
