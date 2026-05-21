# Platform Handoff, Session 56, 2026-05-21

## Current state

Sheet vocabulary split for per-attempt labels live, leads.partials cross-form merge bug fixed, reconcile-sheet-to-db whitelist+wrapper bugs fixed and three more audit-call sites hardened to use the public wrapper. Workspace audited for the same two bug classes, clean otherwise. Fastrack impact analysis delivered (8x active enrolment lift, 2.3x faster outcomes). SMS utility Chunk 1 + Chunk 2 prep done by a parallel agent session, fully shipped to prod but still uncommitted on this machine.

## What was done this session

- **Sheet vocab split.** "Calling" expanded into `Attempt 1 - no answer` / `Attempt 2 - no answer` / `Attempt 3 - no answer` in `_shared/sheet-status.ts` (forward + reverse maps), `sheet-edit-mirror` STATUS_MAP, and `app/lib/sheet-status-sync.ts`. Five EFs redeployed: sheet-edit-mirror, republish-provider-sheet, sheet-drift-reconcile-daily, reconcile-sheet-to-db, pending-update-confirm.
- **EMS sheet republished + dropdown updated.** Owner replaced data validation values; 31 "Calling" cells overwritten via Push DB to sheet on /admin/errors.
- **Reconcile panel patched.** Skipped (target_disallowed) IDs now render in the panel with sheet status, DB status, and a clickable admin link. EF response gained `drift_target_disallowed_submission_ids` + `drift_target_disallowed_details`. Action types + panel UI updated.
- **ALLOWED_TARGET_STATUSES extended.** attempt_1/2/3_no_answer added to reconcile-sheet-to-db's allow-list so per-attempt sheet labels flow sheet to DB through that tool too (not just sheet-edit-mirror).
- **BIGINT whitelist coercion bug fixed.** postgres@3 returns bigint as string; `whitelist.has(lead.submission_id)` was silently dropping every lead in apply mode (proposed=0, applied=0, errors=0). Fixed with `Number()` coerce at the .has() check.
- **Audit call switched to public wrapper.** reconcile-sheet-to-db's direct `audit.log_system_action` call inside the `SET LOCAL ROLE functions_writer` transaction was failing silently on permission denied. Switched to `public.log_system_action_v1` (migration 0147 wrapper, callable by functions_writer).
- **Hygiene pass on three more audit call sites.** route-lead.ts writeAuditSystem, netlify-employer-lead-router auto_route_lead, fastrack-receive mark_outcome_auto_dq all switched to the public wrapper. 10 EFs redeployed.
- **Workspace audit (BIGINT + audit-permission classes).** All clear elsewhere. Class 1 (BIGINT): four candidate sites checked, all safe (either coerced or both sides strings). Class 2 (audit-via-functions_writer): only reconcile was actively broken; the other three were outside the functions_writer trx so worked but were swapped for hygiene.
- **EMS unblock SQL.** 8 leads flipped from open to attempt_2_no_answer via Supabase SQL Editor (workaround before whitelist bug was diagnosed/fixed). Single bulk audit row written.
- **Mable's partials work shipped.** Applied migration 0155 (composite UNIQUE on session_id + form_name) via Supabase SQL Editor; deployed netlify-partial-capture EF with updated ON CONFLICT clause. fastrack-funded-v1 and switchable-waitlist-enrichment partials will land as their own rows from now on.
- **Fastrack impact analysis.** 13-day same-window comparison. Fastrackers: 0% DQ vs 23%, 56% reached an outcome vs 17%, 8x more active enrolment conversations, lost decisions 1.4d vs 2.5d, meeting bookings 4.2d vs 8.4d. Roughly half the lost outcomes were L3 mismatches (fastrack working as designed). Fastrack currently only fires on gov-funded; self-funded thank-you page never triggers it.
- **Commits.** `a9ffcc3` (sheet vocab + panel patch). `e0418ec` (partials migration + reconcile fixes + audit-wrapper hygiene). Both pushed.
- **SMS shadow mode flipped back to true.** Per Mable's S55 recommendation while SMS Chunks 2+3 are being built.

## Next steps

1. **Commit SMS Chunk 1 + Chunk 2 work from the parallel session.** Migration 0156, `_shared/brevo.ts` `sendSms` helper, `_shared/sms-utility.ts`, `admin-test-sms` EF, `config.toml` admin-test-sms registration. All shipped to prod, uncommitted on this machine. Belongs to whichever session is finishing Chunk 2 (file was actively being edited during this session close).
2. **Diagnose Courses Direct's 0/12 outcome rate.** None of 12 routed CD leads have moved out of open/in-chase in the last 13 days. Not a fastrack issue (CD doesn't get fastracked leads in this window). Likely a service or sheet-wiring issue. Belongs in switchleads/clients with Nell rather than here.
3. **Extend fastrack to self-funded.** Same form logic, same L3/funding/intake reconfirm. Currently only the /funded/thank-you/ page fires fastrack; the self-funded thank-you page never does. Point the same flow at it. Belongs in switchable/site.
4. **Verify reconcile apply end-to-end on the next real drift case.** The whitelist + audit wrapper fix is deployed but only the SQL-bypass path was actually used today. First real apply through the panel will confirm.
5. **Auto-flip cron + day-12 warning email (carry from S51 / reopened S54 / S55 strategy push).** Migration 0097 still unapplied. EMS has 50 leads past 7-day SLA. Pre-conditions still owed: Brevo warning template, provider heads-up emails, Mira's activity-gate framework. S55 push: apply prospectively from 1 June 2026 cutoff; pre-1-June leads handled via one-time reconciliation by Nell (deadline 31 May for status updates).
6. **Remote Edge Function deletion (carry from S54).** `supabase functions delete backfill-referral-fastrack-urls --project-ref igvlngouxcirqhlsrhga`, then same for backfill-client-nonce.
7. **Per-provider CPL / CPE / P/L scoreboard (carry from S49).** Still queued.
8. **Infrastructure-manifest update (carry from S54).** Add brevo-attribute-reconcile-daily + drift-digest-daily cron rows; remove dead-letter-alert-hourly.
9. **Cannot-reach-no-chaser to /admin/errors (carry from S55).** System-reliability signal, belongs on /admin/errors as a reconciler card rather than /admin/actions.
10. **Brevo chaser "Contact already in list" dead_letter spam.** 14 errors today, all `invalid_parameter: Contact already in list and/or does not exist`. Fix: treat that error code as a no-op rather than a dead_letter row. Not blocking.

## Decisions and open questions

**Decisions:**

- **Per-attempt sheet labels use human form** (`Attempt 1 - no answer`, not raw enum). Why: matches the rest of the sheet's vocabulary (`Cannot reach`, `Meeting booked`, `Presumed enrolled`); raw enum was a quick-fix dropdown the owner typed mid-session and is now retired.
- **Chaser cron owns attempt-count auto-increment; sheet is a mirror, not the driver.** Why: ping-pong risk low (cron fires on real call windows, manual sheet edits infrequent); maintains existing automation; manual sheet edits override when needed.
- **Reconcile whitelist coercion uses `Number()` at the `.has()` check, not at Set construction.** Why: defensive against postgres@3 returning bigint as string for any ID column, not just submission_id. Pattern reusable elsewhere.
- **Hygiene pass extended to three audit-call sites even though only one was actively broken.** Why: same SET LOCAL ROLE + console.error catch pattern; fragile if role context shifts; cheap to fix, real risk reduction.
- **Two scoped commits, not one big bundle.** Why: respect attribution (sheet vocab is mine, partials is Mable's, both signed off this session); avoid bundling parallel-session SMS work that's still being actively edited.
- **SMS work left uncommitted on this machine.** Why: SMS Chunk 2 trigger wiring was actively in progress (fastrack-receive file changed mid-session, new `_shared/sms-utility.ts` file appeared); committing would risk an accidental merge collision.

**Open questions:**

- **Owner decides: extend fastrack form to self-funded leads?** Same form logic, same lift potential. Currently only fires on gov-funded thank-you page. Trivial to extend.
- **Owner decides: Courses Direct dig — switchleads/clients with Nell, or here in platform as a routing/wiring check first?** Read: switchleads/clients first; come back here only if a wiring issue surfaces.
- **Owner decides: SMS Chunk 1 + 2 commit ownership.** Stays with the SMS-session agent; flag here so it isn't forgotten.

## Watch items

- **Tomorrow's 06:00 UTC sheet-drift-reconcile-daily.** Should emit zero EMS drift rows now that the vocabulary is aligned. Pre-fix counterfactual was one drift row per active EMS lead.
- **Next real reconcile panel apply.** Verify whitelist + audit wrapper fix lands cleanly end-to-end (only the SQL-bypass path was exercised today).
- **SMS shadow mode currently `true`.** Confirm next admin-test-sms call lands in `crm.sms_log` with `brevo_message_id IS NULL` and `metadata.shadow=true`; no real SMS arrives.
- **SMS Chunk 2 commit + deploy from the parallel session.** Uncommitted files on this machine; not Sasha's responsibility but flag here so it isn't lost.
- **Carries from S55 still open:** first-fire verification of three reconciler crons (06:00, 06:15, 06:30 UTC), first real EMS lead's LA-scoped CC routing, live Riverside `auto_route_lead` audit row, /admin/experiments DQ rates render correctly post-backfill, EMS SLA-breach card on /admin/actions, U1 bounces, crm.email_log rows 504-506, first natural Riverside attempt transition by Freya without manual SQL, leads.dead_letter sources `channel_b_sheet_writeback` (S50) + `edge_function_brevo_chase_employer` (S52) staying empty.
- **Carries from S51 still open:** auto-flip cron + day-12 warning (migration 0097 unapplied), `u_fastrack_qualified` row in crm.email_log, invite-claim audit via public.log_system_action_v1, TEST_MODE=false re-verification before any B2B test submission.

## Next session

- **Folder:** `switchleads/clients`
- **First task:** Diagnose Courses Direct's stuck pipeline. 12 routed CD leads in the last 13 days, none moved out of open/in-chase. Verify Marty's sheet is receiving leads correctly, check Nell's outreach state, confirm the funded-provider angle is still live. Likely a service or wiring issue, not fastrack-related (CD doesn't get fastracked leads in this window).
- **Cross-project:** Pushed to `switchleads/clients/docs/current-handoff.md` (Courses Direct dig) and `switchable/site/docs/current-handoff.md` (extend fastrack to self-funded).
