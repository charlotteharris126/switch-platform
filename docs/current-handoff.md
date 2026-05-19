# Platform Handoff, Session 52, 2026-05-18

## Current state

S4B employer chaser path live end-to-end. Migration 0148 added `s4b_employer_chaser` email type + `crm.fire_employer_chaser` RPC; 0149 moved the audit to `log_system_action_v1`; 0150 rebuilt `crm.vw_enrolments_chaser_state` to include the new type. New Edge Function `admin-brevo-chase-employer` deployed. `markOutcomeAction` now splits learner/employer chaser paths and the provider portal lead-detail indicator labels correctly per `lead_type`. Three real chasers fired tonight to subs #468 Lee Anthony, #486 Joe Laycock, #487 Harry Cromwell — all `sent`.

## What was done this session

- **Identified misfire on Riverside leads.** Subs #450 Haris + #468 Lee Anthony hit `attempt_1_no_answer` earlier today. `markOutcomeAction`'s auto-fire branch ran → `crm.fire_provider_chaser` → `admin-brevo-chase`, which silently skipped on `!funding_category` for `employer_apprenticeship` rows. Two misleading "Learner chaser email auto-sent" system notes landed in Riverside's lead_notes view. No email sent.
- **Migration 0148 `employer_chaser_path.sql`.** Added `s4b_employer_chaser` to `crm.email_log.email_type` CHECK. Created `crm.fire_employer_chaser(BIGINT[])` SECURITY DEFINER — filters to `lead_type='employer_apprenticeship'`, no legacy Brevo list-add (transactional only), async-fires `admin-brevo-chase-employer` via pg_net.
- **Migration 0149 `fire_employer_chaser_system_audit.sql`.** Swapped the audit call inside `fire_employer_chaser` from `audit.log_action(p_surface := 'admin')` to `public.log_system_action_v1`. Admin-surface gate requires `auth.uid()`, which the SQL editor doesn't have — was blocking manual backfill SELECT calls.
- **Migration 0150 `chaser_view_includes_employer.sql`.** DROP + CREATE of `crm.vw_enrolments_chaser_state` with `s4b_employer_chaser` added to the IN list. Used DROP rather than CREATE OR REPLACE because `e.*` in the original 0086 view had locked to the older enrolments shape (19 cols), and the current enrolments table has 22 cols — REPLACE refused because the new expansion would shift `latest_chaser_at`'s position. Rebuilt view now exposes all 22 enrolments cols + `latest_chaser_at`. No dependent views (pg_depend confirmed).
- **New Edge Function `admin-brevo-chase-employer`.** Reads submission + `crm.providers.company_name`, sends via `sendTransactional` with `emailType='s4b_employer_chaser'`, `forceResend=true`, params `FIRSTNAME / LASTNAME / COMPANY / STANDARD / PROVIDER_NAME / SUBMISSION_ID`. Dead-letters with source `edge_function_brevo_chase_employer` on failure. `verify_jwt=false`. First deploy referenced `p.name` (column doesn't exist) — hotfixed to `p.company_name` and redeployed.
- **`_shared/brevo.ts`.** `EmailLogType` union extended with `s4b_employer_chaser`.
- **`app/app/provider/leads/[id]/actions.ts`.** `markOutcomeAction` auto-fire block selects `chaserConfig` by `leadType`. Learner → `fire_provider_chaser` + `chaser_funded/chaser_self` rate-limit gate + learner system-note wording. Employer → `fire_employer_chaser` + `s4b_employer_chaser` rate-limit gate + "Chaser email auto-sent to employer..." wording. 10-min rate-limit + `routedProviderId` gate unchanged.
- **Provider portal lead-detail indicator.** Page query at `page.tsx:113` now includes `s4b_employer_chaser` alongside learner types. Label at `lead-detail-view.tsx:241` branches: employer leads render "Last chaser sent to employer: ..." instead of "...to learner:".
- **Brevo template + env var.** Charlotte created the template in Brevo (placeholder copy) and set `BREVO_TEMPLATE_S4B_EMPLOYER_CHASER` env var. Wren refines copy in the next email session.
- **CLI migration registry repair.** Before applying 0148, `supabase migration repair --status applied 0141 0142 0143 0144 0145 0146 0147 --linked` was run — those had been applied via dashboard SQL editor across earlier sessions but not via the CLI, so `db push` was about to retry them. Repair marked applied; subsequent pushes ran only the new files.
- **Manual chaser fires for the 3 in-flight leads.** `SELECT * FROM crm.fire_employer_chaser(ARRAY[468, 486, 487]::bigint[]);` returned three `ok` rows. `email_log` rows 504, 505, 506 all `sent` at 17:09 UTC.
- **#450 Haris skipped.** Original U1 ack soft-bounced 16 May 12:47 with `Unable to find MX of domain windowhaus.uk` — form submitted with typo'd domain (`windohaus.uk` is the real one). Chaser would bounce the same way. Phone path remains Riverside's only route to Haris.

## Next steps

1. **Watch Brevo webhook events** landing against `crm.email_log` rows 504-506 over the next ~24h — `delivered` / `opened` / `clicked` updates the `status` + `last_event` metadata. Confirms end-to-end deliverability of the new path.
2. **First natural Riverside attempt transition.** Next time Freya marks `attempt_1_no_answer` on a fresh lead without any manual SQL, expect a `s4b_employer_chaser` row in `email_log` + the correctly-worded system note ("Chaser email auto-sent to employer...") in `lead_notes` within seconds. Validates the auto-fire end-to-end on its own.
3. **Auto-flip + day-12 warning email** (carry from S51, still open). Migration 0097 written but never applied. EMS currently has 37 stale leads pending the day-12 warning template + cron before any flips fire.
4. **Watch `leads.dead_letter` source `channel_b_sheet_writeback`** — should stay empty (carry from S50).
5. **Watch `leads.dead_letter` source `edge_function_brevo_chase_employer`** — new dead-letter source from this session. Should stay empty under normal operation.
6. **Watch chaser auto-fire volume** for both learner + employer paths — current rate-limit allows up to 4 chasers per recipient per week worst case. Easy adjustment if complaints land.
7. **Brevo URL backfill panel** should stay at ≤2 mutations (carry from S51).
8. **Verify the rebuilt `/admin` overview** across all period buckets (carry from S49). 5-min eyeball.
9. **Per-provider CPL / CPE / P/L scoreboard** — design the campaign → provider mapping (carry from S49).
10. **Brevo orphan deletion** once Wren confirms `u1-funded` template is verified live (carry from S48-49).
11. **Carries from S47-51 still open.** Invited portal users walking through (Andy / Nick EMS, Jane Riverside); WYK + Courses Direct portal launch when ready; lead-assignment in-session lock (Phase 2); data-ops audit-log template tighten; WYK + CD sheet-vs-DB reconcile; `/provider/leads` N+1 + cursor siblings; RealtimeRefresh `lead_notes` subscription scope; RLS `(SELECT fn())` wrap on `crm.disputes` + `leads.fastrack_submissions`.
12. **Solis carries.** Schema naming `ads_business` vs `ads_switchable_business`; `crm.employer_signings` design before first Riverside Employer Signed event.
13. **Wren brief, utility SMS for funded learners (new, 2026-05-18 — updated 2026-05-19 to two-SMS flow).** Goal: lift phone pickup rates on EMS / WYK / CD funded leads. Full spec at `switchable/email/docs/sms-utility-design.md`. Channel: Brevo UK SMS v1 (WhatsApp via Brevo as possible v2 once we have data). Ask: (a) Brevo UK SMS sender registration, alphanumeric ID `Switchable`, ~3-7 day lead; (b) initial SMS credit purchase, Sasha to size (Wren estimate ~250 sends/week starter at current routing volumes — up from 150 because the two-SMS flow can fire both per qualifying lead); (c) new `sendSms` helper in `_shared/brevo.ts` mirroring `sendTransactional` — consider naming `sendOutboundMessage` to keep the WhatsApp swap clean; (d) log architecture call, either new `crm.sms_log` or extension of `crm.email_log` with a `channel` column + comm_type rename, Sasha's call. Idempotency on `(submission_id, comm_type)`. (e) short-URL infra `switchable.org.uk/f/{token}` for the fastrack-link variant, wrapping the existing fastrack URL output from `buildFastrackUrl` in `route-lead.ts`. **TWO triggers, TWO comm types:** Trigger A (`call_reminder_fastrack_link`) = pg_cron `sms-fastrack-prompt-cron` running every minute, fires for matched leads where `routing_completed_at < now() - interval '5 minutes'` AND `SW_FASTRACK_COMPLETED = false` AND no prior `call_reminder_fastrack_link` log row AND gate passes. 5-min lag is deliberate — fastrack form sits on the thank-you page, so the engaged subset will self-complete within that window. 1-hour stop condition. Trigger B (`call_reminder_save_number`) = fired from inside `fastrack-receive` Edge Function at the same point that triggers `u-fastrack-qualified` email (i.e. when `cohort_confirmed=true AND l3_reconfirmed=false`), gated on no prior `call_reminder_save_number` log row + phone present + funded/loan + matched provider. Trigger B covers BOTH the rare thank-you-page self-completer AND the larger late-fastrack cohort (those who fastrack via the SMS link, U1 email, or any other route, hours or days later). **Two body variants** (single-segment safe both): fastrack-link = `Hi {{contact.FIRSTNAME}}, confirm your {{contact.SW_COURSE_NAME}} place with {{contact.SW_PROVIDER_NAME}}. 2-min form: {{params.FASTRACK_SHORT_URL}}. Switchable` (~145 chars worst case). Save-number = `Hi {{contact.FIRSTNAME}}, {{contact.SW_PROVIDER_NAME}} will be in touch about your {{contact.SW_COURSE_NAME}} place soon. Save their number: {{contact.SW_PROVIDER_PHONE}}. Switchable` (~150 chars worst case). Use case 1 only for now; Use case 2 (missed-contact chase on `cannot_contact` flip) follows after v1 lands. Delivery-failure logging in the log table so silent SMS-disabled-number fails surface in `/admin/errors`. Migration to extend the relevant check constraint for both `call_reminder_fastrack_link` + `call_reminder_save_number` comm types. Not blocking the day-12 auto-flip work in #3 — sequence as Sasha sees fit.

## Decisions and open questions

**Decisions:**

- **Split paths over overloading admin-brevo-chase.** New parallel function (`crm.fire_employer_chaser` + `admin-brevo-chase-employer`) rather than branching the existing learner path on `lead_type`. Cleaner ownership: learner = funded/self list-add + transactional; employer = transactional only, no SF2 list, no funding-category branch.
- **`forceResend: true` for employer chaser sends.** Mirrors learner chaser semantics — each new "tried but didn't reach" status is a deliberate re-fire. The 10-min `markOutcomeAction` rate-limit handles rapid click-through; idempotency is not the right gate here.
- **Audit on `log_system_action_v1` (system surface).** Preserves auth context when present (`auth.email()`, `auth.uid()` captured into `p_actor` / `p_context`), but accepts NULL so SQL-editor / cron / pg_net invocations work. Avoids the admin-surface gate trip that blocked tonight's first backfill attempt.
- **DROP + CREATE on the chaser view rather than CREATE OR REPLACE.** `e.*` had locked to the 0086-era enrolments shape. Rebuild lets the view auto-include new columns. No dependent views — checked via pg_depend.
- **Two pre-existing "Learner chaser" misleading notes on #450 + #468 left in place** per Charlotte's earlier "status on the portal is fine" call. Future employer transitions write the corrected wording.
- **#450 Haris not chased by email.** Original U1 ack soft-bounced — typo'd domain at form submission. Re-fire would bounce identically. Phone path is Riverside's only route.

**Open questions:** None this session.

## Watch items

- **Brevo webhook events on rows 504-506** — `delivered` / `opened` / `clicked` over the next ~24h.
- **First natural attempt transition by Freya on a fresh employer lead** — validates the full path without manual SQL.
- **`leads.dead_letter` source `edge_function_brevo_chase_employer`** — new source, should stay empty.
- **`leads.dead_letter` source `channel_b_sheet_writeback`** — should stay empty (S50 carry).
- **Chaser auto-fire volume** for learner + employer paths — up to 4 emails per recipient per week worst case.
- **`BREVO_TEMPLATE_S4B_EMPLOYER_CHASER` template content** — currently placeholder copy from this session, Wren refines next email session. Content changes don't require redeploy.
- **Brevo URL backfill panel** — should stay at ≤2 mutations (S51 carry).
- **First `u_fastrack_qualified` row in `crm.email_log`** (S51 carry).
- **First invite-claim audit row via `public.log_system_action_v1`** (S51 carry, Andy / Nick / Jane).
- **`TEST_MODE = false`** in Supabase Vault — re-verify before any session that might trigger a real B2B submission (S51 carry).
- **CLI migration registry** now aligned through 0150 — drift fixed via repair at session start. No carries.

## Next session

- **Folder:** `platform`
- **First task:** Verify Brevo webhook events have landed on `crm.email_log` rows 504-506 (subs #468, #486, #487) confirming delivered / opened / clicked over the previous ~24h. Then watch for the first natural attempt transition by Freya on a fresh Riverside lead to confirm the auto-fire path works end-to-end without manual intervention. Then carry on with the day-12 auto-flip warning template + cron (Next-step #3 — carries from S51).
- **Cross-project:** Wren has been asked to refine the placeholder copy for the new `BREVO_TEMPLATE_S4B_EMPLOYER_CHASER` Brevo template — pushed to `switchable/email/docs/current-handoff.md`. Mira has a commercial-shape review item for the employer chaser cadence (timing, attempt-only-once vs every attempt, opt-out behaviour) once Riverside has cycled 5+ employer leads — pushed to `strategy/docs/current-handoff.md`.
