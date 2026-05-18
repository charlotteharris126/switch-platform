# Platform Handoff, Session 51, 2026-05-18

## Current state

Heavy day on the provider portal. Drift fully closed at the source (`route-lead.ts` canonicalises Brevo state per email, not per submission). Welcome+SLA gate bypass on `/account` + `/support` closed. Audit gap on invite acceptance fixed properly (migration 0147 + `public.log_system_action_v1` wrapper — the previous direct admin-client insert was silently RLS-blocked). EMS staff can filter by LA on `/provider/leads` via a multi-select; the pill row reshaped into two rows (workflow primary, state-lookup secondary) with Lost + Cannot reach surfaced separately. Chaser email auto-fires on attempt_/cannot_reach status changes with 10-min rate-limit and a "Last chaser sent" indicator on the lead detail. EMS onboarded George Taylor mid-session; Riverside onboarded Freya Kelly. Wren's SMM Tees Valley broadcast scheduled to fire tonight with an 18-contact audience.

## What was done this session

- **fastrack-receive `u_fastrack_qualified` params bug** (commit `bdd9a4d`). Brevo's transactional API rejects `params: {}` with HTTP 400 "params is blank". Patched to pass `FIRSTNAME / LASTNAME / SW_FUNDING_CATEGORY`. Affected Shazia Shibli #488 + Kayleigh Lancaster #489 overnight; Charlotte chose not to backfill manually.
- **Drift cron + republish skip re-submission children** (commit `865720a`). `parent_submission_id IS NOT NULL` filter added to `sheet-drift-reconcile-daily` and `republish-provider-sheet`. Children never get their own sheet row, so child IDs were showing as missing_from_sheet / status-drift every cron run. Killed 4 of 5 morning drift rows; only Jyotika Mark #127 remained (legitimate, Charlotte manually fixed her CD sheet row).
- **`route-lead.ts` Brevo canonicalisation** (commit `8881882`). New `loadEmailAggregateState()` helper queries across all submissions for an email. Latest opt-in drives URL inputs; earliest with referral_code drives referral identity; `bool_or` across all for fastrack flag. Both upsert helpers use it. Course/region/provider/enrol attrs deliberately STAY per-submission. Full re-sync chunks ran post-deploy; Brevo URL backfill panel dropped 8 → 1 mutation. Closes the duplicate-submission overwrite class at the source.
- **`/provider/leads` Area multi-select filter** (commit `56e7e65`). Pulls `leads.submissions.la` through the page → LeadRow → admin preview. Region column shows formatted LA when set (e.g. "Stockton-on-Tees"), falls back to region otherwise. New multi-select pill row in the Refine panel, only rendered when 2+ distinct LAs exist (optional per provider). EMS staff can filter to their assigned LAs and see only their queue. Jake's logged in; George + Nick will see it on first login.
- **Provider portal `/account` + `/support` gate bypass closed + invite-acceptance audit shipped** (commit `e4e98b4`). Both pages used bespoke session checks that skipped `requireProviderUser`'s welcome+SLA gates. Replaced. Plus `/provider-set-password` invite-claim flow now writes an `accept_invite` audit row when a user's status flips from `invited` to `active`.
- **Audit RPC wrapper fix** (commit `6f44fe8`, migration 0147 applied). The first invite-audit shipped earlier used `admin.schema("audit").from("actions").insert(...)` which RLS silently rejects — `audit.actions` has no INSERT grant for anyone, only SELECT for readonly_analytics. Migration 0147 adds `public.log_system_action_v1` (mirrors `public.log_provider_action_v1` from 0106): SECURITY INVOKER wrapper that delegates to `audit.log_system_action` (SECURITY DEFINER) so the actual INSERT runs with audit-owner privileges. provider-set-password now calls the RPC. Future invite acceptances audit cleanly. Bit Freya (silently swallowed) then George (Charlotte caught it) before the proper fix landed.
- **Auto-fire learner chaser + rate-limit + system note + visibility** (commits `3594efc`, `487e3bd`, `9461f5d`). `markOutcomeAction` fires `crm.fire_provider_chaser` on every transition to attempt_1/2/3_no_answer or cannot_reach. Rate-limited to 1 per submission per 10 min (gates on `crm.email_log.triggered_at` for any chaser_funded/chaser_self row in last 10 min). System note lands in `crm.lead_notes`. Lead detail page now shows "Last chaser sent to learner: <date>" in the At-current-status tile, reading from the same `crm.email_log` the admin /admin/leads "Last chaser" column uses. One source of truth across manual admin fire + auto-fire paths.
- **`/provider/leads` pill row reshape — Option A** (commit `6aaf3eb`). Two-row layout. Row 1 (workflow you act on, all exclude settled state by design): **New / Overdue / Needs callback / Fastrack**. Row 2 (state look-up, lighter tone): **Calling / Meeting booked / Enrolled / Lost / Cannot reach / All**. "Fresh" renamed to "New" (matches Charlotte's wording, also updated in the sidebar at-a-glance link). "Open" pill dropped (Fresh covered it under a confusing label). "Cold" pill replaced with explicit "Lost" + "Cannot reach" pills. cold/open Filter values stay valid for URL backward-compat. Action needed stays as its own prominent rose-toned row above.
- **Freya Kelly (Riverside) onboarded.** Welcome deck completed mid-morning; `sla_accepted_at` + `welcome_completed_at` stamped. SLA counter now 1/2 for Riverside (Jane Preston still pending invite claim).
- **George Taylor (EMS) onboarded.** Set password at 10:29 UTC, completed welcome at 10:33. SLA counter 3/5 for EMS (Daniel + Jake + George done; Andy + Nick still pending). George's invite-acceptance audit row is the one that triggered the migration-0147 fix.
- **Wren's SMM Tees Valley "last chance to apply" broadcast scheduled to fire PM 2026-05-18.** 18-contact audience using `SW_COURSE_SLUG = smm-for-ecommerce AND SW_ENROL_STATUS in (open, cannot_reach) AND SW_FASTRACK_COMPLETED = false AND SW_CONSENT_MARKETING = true AND SW_COURSE_INTAKE_DATE = 21 May value`.

## Next steps

1. **Wren's broadcast firing tonight.** Check Brevo send report for delivery count + soft bounces; check `crm.email_log` for any failures. Audience is 18, expected delivery ~17-18.
2. **First `u_fastrack_qualified` row in `crm.email_log`** once the next qualifying fastrack lands (validates params bug fix from `bdd9a4d`).
3. **First chaser auto-fire on a real attempt_1 click.** Validates `BREVO_TEMPLATE_CHASER_FUNDED` / `BREVO_TEMPLATE_CHASER_SELF` env vars + the full auto-fire path. Expect a row in `crm.email_log` + system note in `crm.lead_notes` within seconds of the provider click.
4. **First future invite-claim audit row** (Andy / Nick EMS, Jane Riverside). Should write automatically via `public.log_system_action_v1` once the user sets their password. Validates migration 0147 + the wrapper end-to-end.
5. **Auto-flip + day-12 warning email** (carry, surfaced 2026-05-18). All providers have `auto_flip_enabled=true` and per-provider SLA columns set. `run_enrolment_auto_flip_per_provider` function exists. Missing: the cron that calls it (migration 0097 written but never applied per memory) AND the Brevo "2-day heads-up" warning email template. EMS currently has 37 stale leads (9 open >14d + 28 cannot_reach >14d) — flipping them cold = ~£5,550 of presumed-enrolment invoices. Charlotte holding pending the warning email so providers have a countdown / disputable signal before billing.
6. **Watch `leads.dead_letter` source `channel_b_sheet_writeback`** — should stay empty (carry from S50).
7. **Watch chaser auto-fire volume** for learner complaints — current rate-limit is 1 per 10 min per submission; a provider working through "1st → 2nd → 3rd → cannot reach" across separate sessions over a week could trigger 4 chasers to the same learner. Easy adjustment to "first attempt only" or "1 per X hours" if complaints land.
8. **Brevo URL backfill panel** should stay at ≤2 mutations. If it grows past 5, the canonicalisation has a hole.
9. **Verify the rebuilt `/admin` overview** across all period buckets (carry from S49). 5-min eyeball.
10. **Per-provider CPL / CPE / P/L scoreboard** — design the campaign → provider mapping (carry from S49).
11. **CLI migration registry drift `0141-0145`** local but not on remote (carry from S47).
12. **Brevo orphan deletion** once Wren confirms `u1-funded` template is verified live (carry from S48-49).
13. **Carries from S47-50 still open.** Invited portal users walking through (Andy / Nick EMS, Jane Riverside); WYK + Courses Direct portal launch when ready; lead-assignment in-session lock (Phase 2); data-ops audit-log template tighten; WYK + CD sheet-vs-DB reconcile; `/provider/leads` N+1 + cursor siblings; RealtimeRefresh `lead_notes` subscription scope; RLS `(SELECT fn())` wrap on `crm.disputes` + `leads.fastrack_submissions`.
14. **Solis carries.** Schema naming `ads_business` vs `ads_switchable_business`; `crm.employer_signings` design before first Riverside Employer Signed event.

## Decisions and open questions

**Decisions:**

- **Pill row reshape: Option A.** Two rows, primary (workflow) + secondary (state). New/Overdue/Callback/Fastrack must be on the primary row and must exclude enrolled/lost/cannot_reach. Action needed kept as a separate prominent pill above (different question: "what's on your plate" vs Overdue's "what's already late"). Both kept; they answer different questions and EMS workflow uses both.
- **Chaser auto-fire on every "tried but didn't reach" status, rate-limited 1 per 10 min.** Charlotte's call: every attempt status (1/2/3 + cannot_reach) fires the chaser. Trade-off accepted (up to 4 chasers per learner per week in worst case). Rate-limit ensures click-through-the-list workflows don't spam the learner.
- **Brevo state canonicalised per email, not per submission.** Big architectural call. URL-shaped attributes aggregate across all an email's submissions; course/region/enrol attrs stay per-submission (immediate routing event). Mirror of the data-ops backfill function's logic so both paths converge.
- **Drift cron + republish skip re-submission children** (`parent_submission_id IS NOT NULL`). False positives forever otherwise.
- **Auto-flip held pending day-12 warning template + cron.** Don't fire 37 EMS flips cold (£5,550 of invoices) without a countdown / disputable warning first.
- **`/account` + `/support` use `requireProviderUser`** like every other `/provider/*` route. Bespoke session checks were a gate bypass.
- **Audit on invite acceptance via `public.log_system_action_v1` RPC** (migration 0147). Direct admin-client insert against `audit.actions` was silently RLS-blocked. The wrapper pattern is now the reusable shape for any future system-context audit event (cron-driven state transitions, webhook-triggered changes, etc.). Same as `public.log_provider_action_v1` from migration 0106.
- **"Action needed" + "Overdue" both kept on the pill row.** Different questions. Action needed = "what's on my plate today"; Overdue = "what should already have been done". Overdue is always a subset of Action needed.

**Open questions:** None this session.

## Watch items

- **Wren's SMM broadcast firing tonight** — delivery count + soft bounces in Brevo + `crm.email_log`.
- **`leads.dead_letter` source `channel_b_sheet_writeback`** — should stay empty.
- **First `u_fastrack_qualified` row in `crm.email_log`** — validates params fix.
- **First chaser auto-fire on real attempt_1 click** — validates env vars + full path. Expect a row in `crm.email_log` (`chaser_funded`/`chaser_self`) + system note in `crm.lead_notes` within seconds.
- **First invite-claim audit row via the new wrapper** (next time Andy / Nick / Jane / anyone activates).
- **Brevo URL backfill panel** — should stay at ≤2 mutations.
- **`/provider/leads` Area filter usage by EMS** — George active today; Andy + Nick still at `status='invited'`.
- **Jane Preston (Riverside) invite claim.** Audit row will land automatically.
- **Chaser auto-fire volume** — watch for learner complaints (up to 4 emails per week worst case).
- **Invited portal users walking through** (Andy / Nick EMS, Jane Riverside).
- **First real `cohort_decline` fastrack** (carry from S44).
- **First fire of `dead-letter-alert-hourly` cron** (carry from S44).
- **First real B2C ad-driven lead, full chain** (carry from S47).
- **`TEST_MODE = false`** in Supabase Vault — re-verify before any session that might trigger a real B2B submission.

## Next session

- **Folder:** `platform`
- **First task:** Verify Wren's broadcast fired cleanly overnight (Brevo send report + `crm.email_log`). Then check for the first chaser auto-fire row + the first `u_fastrack_qualified` row landing (both validate today's transactional path shipments). Then build the day-12 auto-flip warning template + cron (Next-step #5) so the 37 stale EMS leads can be flipped in good faith with a disputable signal first.
- **Cross-project:** Mable's `/refer/` page-view beacon ask still in `switchable/site/docs/current-handoff.md`. Wren's U1 referral CTA prominence ask still in `switchable/email/docs/current-handoff.md`. Both inherited carries.
