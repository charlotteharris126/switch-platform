# Platform Handoff, Session 51, 2026-05-18

## Current state

A morning of platform fixes following the Session 50 work. Chaser auto-fire is live on the provider portal (rate-limited to 1 per 10 min, system-noted, visible via "Last chaser sent" indicator). The duplicate-submission Brevo overwrite class of bugs is closed at the source — `route-lead.ts` now canonicalises per email instead of per submission. EMS staff can filter their leads by LA (Stockton, Hartlepool etc.) via a multi-select on `/provider/leads`. Two real bugs found and closed: `/provider/account` + `/provider/support` were bypassing the welcome+SLA gate; the invite-claim flow wasn't writing an audit row. Wren's "last chance to apply" SMM Tees Valley broadcast is scheduled to fire this PM with a clean 18-contact audience.

## What was done this session

- **fastrack-receive `u_fastrack_qualified` params bug** (commit `bdd9a4d`). Yesterday's wiring passed `params: {}` which Brevo's transactional API rejects with HTTP 400 "params is blank". Patched to pass `FIRSTNAME / LASTNAME / SW_FUNDING_CATEGORY` (same shape as `email-u4-cron` / `email-stalled-cron`). Affected Shazia Shibli #488 + Kayleigh Lancaster #489 overnight; both missed their qualify-ack. Charlotte chose not to backfill manually.
- **Drift cron + republish skip re-submission children** (commit `865720a`). `parent_submission_id IS NOT NULL` filter added to `sheet-drift-reconcile-daily` and `republish-provider-sheet`. Re-submission children never get their own sheet row (route-lead.ts only writes the parent), so child IDs would show as `missing_from_sheet` or status-drift every cron run, forever. Killed 4 of 5 morning drift rows (Kirsty Crowther #233, Manasseh #373, Zane Lewis #415, Amanda Robinson #475). Only Jyotika Mark #127 remained — legitimate drift (parent missing from CD sheet); Charlotte manually added her row.
- **`route-lead.ts` Brevo canonicalisation** (commit `8881882`). New `loadEmailAggregateState()` helper queries across all submissions for an email: latest opt-in submission drives `SW_FASTRACK_URL` / `client_nonce` / `course_id` / `marketing_opt_in`; earliest submission with `referral_code` drives `SW_REFERRAL_URL` / `SW_REFERRAL_CODE`; `bool_or` across all for `SW_FASTRACK_COMPLETED`. Both upsert helpers (`upsertLearnerInBrevo` + `upsertLearnerInBrevoNoMatch`) now use it. Course/region/provider/enrol attrs deliberately STAY per-submission. Full re-sync chunks ran after deploy; Brevo URL backfill panel dropped 8 → 1 mutation. Closes the duplicate-submission overwrite class of bugs at the source.
- **`/provider/leads` Area multi-select filter** (commit `56e7e65`). Pulls `leads.submissions.la` through page → LeadRow → admin preview. Region column now shows formatted LA (e.g. "Stockton-on-Tees") when set, falls back to region otherwise. New multi-select pill row in the Refine panel, only rendered when 2+ distinct LAs exist on the provider's loaded rows (optional per provider — CD self-funded has no LA values, sees nothing). EMS staff can filter to their assigned LAs (George: Stockton + Hartlepool; Jake: Middlesbrough + Darlington; Nick: Redcar) and see only their queue.
- **Provider portal gate bypass closed + invite-acceptance audited** (commit `e4e98b4`). Two bugs:
  - `/provider/account` and `/provider/support` had bespoke session checks that skipped `requireProviderUser`'s welcome+SLA gates. Users mid-onboarding could navigate there and see content. Bit Freya Kelly (Riverside) this morning — she'd logged in but not completed the welcome deck; the SLA counter showed 0/2 even though she was "active". Both pages now use `requireProviderUser`.
  - `/provider-set-password` invite-claim flow flipped `status` to `active` without writing an audit row. Now writes `surface='system', action='accept_invite'` to `audit.actions` on every claim. Charlotte manually backfilled Freya's missing audit row.
- **Auto-fire learner chaser on attempt_/cannot_reach** (commits `3594efc`, `487e3bd`). `markOutcomeAction` in the provider portal now fires `crm.fire_provider_chaser` when a provider transitions a lead to attempt_1/2/3_no_answer or cannot_reach. Rate-limited to 1 chaser per submission per 10 minutes (gates on `crm.email_log.triggered_at` for any `chaser_funded`/`chaser_self` row in the last 10 min). System note lands in `crm.lead_notes` so provider portal users see the chaser fire in the lead's note log. Same `crm.email_log` the admin `/admin/leads` "Last chaser" column reads — one source of truth across manual + auto fire paths.
- **"Last chaser sent" indicator on provider lead detail** (commit `9461f5d`). Reads from `crm.email_log` (same source as admin "Last chaser" column). Shows in the "At current status" tile below the outcome note, only when at least one chaser has fired. Closes the "providers see what admin sees" gap.
- **Freya Kelly Riverside onboarded.** Welcome deck completed mid-morning (`welcome_completed_at` + `sla_accepted_at` both stamped). SLA counter now 1/2 for Riverside (Jane Preston still pending — invite issued 15 May, not yet claimed).
- **Wren's SMM Tees Valley "last chance to apply" broadcast scheduled to fire PM 2026-05-18.** 18-contact audience using filter `SW_COURSE_SLUG = smm-for-ecommerce AND SW_ENROL_STATUS in (open, cannot_reach) AND SW_FASTRACK_COMPLETED = false AND SW_CONSENT_MARKETING = true AND SW_COURSE_INTAKE_DATE = 21 May value`. Audience reconciled cleanly post-canonicalisation backfill. Course slug semantic gap clarified (DB `course_id` = regional slug, Brevo `SW_COURSE_SLUG` = bare matrix `courseId`).

## Next steps

1. **Wren's broadcast firing tonight.** Check Brevo send report for delivery count + any soft bounces; check `crm.email_log` for any failures. Audience is 18, expected delivery ~17-18.
2. **First `u_fastrack_qualified` row in `crm.email_log` once the next qualifying fastrack lands.** Validates the params bug fix from commit `bdd9a4d`. Should land with `status='sent'` and a `brevo_message_id`.
3. **Watch `leads.dead_letter` source `channel_b_sheet_writeback`** — should stay empty (carry from S50).
4. **Auto-flip + day-12 warning email** (carry, surfaced again 2026-05-18). All providers have `auto_flip_enabled=true` and per-provider SLA columns set. `run_enrolment_auto_flip_per_provider` function exists. Missing: the cron that calls it (migration 0097 written but never applied per memory), and the Brevo "2-day heads-up" warning email template. EMS currently has 37 stale leads (9 open >14d + 28 cannot_reach >14d) that would auto-flip on first run = ~£5,550 of presumed-enrolment invoices. Charlotte deliberately holding this pending the warning email so providers have a countdown / chance to dispute before billing fires. Order: build the day-12 warning template + cron, then schedule the flip cron itself.
5. **Watch chaser auto-fire volume** for learner complaints — current rate-limit is 1 per 10 min per submission; a provider working through their list "1st no answer → 2nd no answer → 3rd no answer → cannot reach" across separate sessions over a week could trigger 4 chasers to the same learner. Easy adjustment to "first attempt only" or "1 per X hours" if complaints land.
6. **Verify `BREVO_TEMPLATE_CHASER_FUNDED` / `BREVO_TEMPLATE_CHASER_SELF` env vars are set** on Supabase Edge Function secrets. If they're not, the auto-fire will silently skip ( sendTransactional returns `skipped_missing_template`). First real attempt_1 click on a funded EMS lead is the validation — should land a row in `crm.email_log` and a system note in `crm.lead_notes`.
7. **Audit row for Jane Preston (Riverside) once she claims her invite.** Currently `status='invited'`, no audit row. The new code on `/provider-set-password` will audit automatically when she clicks the invite link. No manual backfill needed.
8. **Duplicate-submission Brevo overwrite class** is now closed at the source (`route-lead.ts` canonicalises per email). Watch the Brevo URL backfill panel over the next week — should stay at ≤2 mutations (only genuinely new contacts that landed between the most recent sync and the dry-run). If it grows past 5, dig.
9. **Verify the rebuilt `/admin` overview** across all period buckets (carry from S49). 5-min eyeball task.
10. **Per-provider CPL / CPE / P/L scoreboard** — design the campaign → provider mapping (carry from S49).
11. **CLI migration registry drift `0141-0145`** local but not on remote (carry from S47).
12. **Brevo orphan deletion** once Wren confirms `u1-funded` template is verified live on a real EMS or WYK lead (carry from S48-49).
13. **Carries from S47-50 still open.** Invited portal users (Andy / Jake / George / Nick EMS, Jane Riverside) walking through; WYK + Courses Direct portal launch when ready; lead-assignment in-session lock (Phase 2); data-ops audit-log template tighten; WYK + CD sheet-vs-DB reconcile; `/provider/leads` N+1 + cursor siblings; RealtimeRefresh `lead_notes` subscription scope; RLS `(SELECT fn())` wrap on `crm.disputes` + `leads.fastrack_submissions`.
14. **Solis carries.** Schema naming `ads_business` vs `ads_switchable_business`; `crm.employer_signings` design before first Riverside Employer Signed event.

## Decisions and open questions

**Decisions:**

- **Chaser auto-fire on every "tried but didn't reach" status, rate-limited 1 per 10 min.** Charlotte's call 2026-05-18: every attempt status (1/2/3 + cannot_reach) fires the chaser. Trade-off accepted (up to 4 chasers per learner per week in worst case). Rate-limit ensures click-through-the-list workflows don't spam the learner. Admin manual-fire path stays available.
- **Brevo state canonicalised per email, not per submission.** Big architectural call. `route-lead.ts` now aggregates across all submissions for an email when setting URL-shaped attributes (`SW_REFERRAL_URL`, `SW_FASTRACK_URL`, `SW_FASTRACK_COMPLETED`, `SW_REFERRAL_CODE`). Course/region/enrol attrs stay per-submission (they reflect the immediate routing event). Mirror of the data-ops backfill function's logic so both paths converge on the same "right answer" per email.
- **Drift cron + republish skip re-submission children** (`parent_submission_id IS NOT NULL`). Children never have their own sheet row; including them in drift detection = false positives forever.
- **Auto-flip held pending day-12 warning template + cron.** Charlotte's call: don't fire 37 EMS flips cold (£5,550 of invoices) without the provider having a countdown / disputable warning first.
- **`/account` + `/support` use `requireProviderUser`** like every other `/provider/*` route. Bespoke session checks were a gate bypass.
- **Audit on invite acceptance via direct `audit.actions` insert with admin client.** No public RPC wrapper for `audit.log_system_action` exists; direct insert with `surface='system'` is the surgical fix. Future similar lifecycle events can mirror this shape.

**Open questions:** None this session.

## Watch items

- **Wren's SMM broadcast firing tonight** — check delivery count + soft bounces in Brevo + `crm.email_log`.
- **`leads.dead_letter` source `channel_b_sheet_writeback`** — should stay empty.
- **First `u_fastrack_qualified` row in `crm.email_log`** — validates params fix.
- **First chaser auto-fire on real attempt_1 click** — validates env vars set + path works end-to-end. Expect a row in `crm.email_log` (`chaser_funded`/`chaser_self`) + system note in `crm.lead_notes` within seconds of the provider click.
- **Brevo URL backfill panel** — should stay at ≤2 mutations.
- **`/provider/leads` Area filter usage by EMS** — Jake's accepted, George + Nick still at `status='invited'`; once both invited users land, they should each filter to their LAs.
- **Jane Preston (Riverside) invite claim.** Audit row will land automatically when she claims.
- **First Friday-late or Saturday-routed lead post-S48 deploy** (carry from S50).
- **Invited portal users walking through** (Andy / Jake / George / Nick EMS, Jane Riverside).
- **First real `cohort_decline` fastrack** (carry from S44).
- **First fire of `dead-letter-alert-hourly` cron** (carry from S44).
- **First real B2C ad-driven lead, full chain** (carry from S47).
- **Audit row on every new SLA acceptance** (carry from S46-47).
- **`SLA: X/N accepted` badge on `/admin/providers/<id>`** (carry from S46-47).
- **`TEST_MODE = false`** in Supabase Vault — re-verify before any session that might trigger a real B2B submission.

## Next session

- **Folder:** `platform`
- **First task:** Verify Wren's broadcast fired cleanly overnight (Brevo send report + `crm.email_log`). Then check `crm.email_log` for any `u_fastrack_qualified` + `chaser_funded`/`chaser_self` rows that landed (validates the two transactional paths shipped today). Then build the day-12 auto-flip warning template + cron (Next-step #4) so the EMS 37-stale-lead pile can be flipped in good faith. Per-provider CPL/CPE/P/L scoreboard work (Next-step #10) is also tee'd up if priorities shift.
- **Cross-project:** Mable's `/refer/` page-view beacon ask still in `switchable/site/docs/current-handoff.md`. Wren's U1 referral CTA prominence ask still in `switchable/email/docs/current-handoff.md`. Both inherited carries; not touched today.
