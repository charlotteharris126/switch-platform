# Platform Handoff, Session 55, 2026-05-20

## ⚡ PUSH FROM Mira 2026-05-21: Reconciliation + auto-flip cron + Field Guide infrastructure preview

Operational + Q3 infrastructure asks from strategy session 14. Pickup by next platform session.

**1. Provider reconciliation + auto-flip cron rollout.** Apply migration 0097 prospectively from **1 June 2026 cutoff**. Funded short courses: 14-day clock. Apprenticeship Learner Leads + Employer Leads: 60-day clock per PPA v2. Pre-1-June leads handled via one-time reconciliation message (Nell owns provider comms, deadline 31 May for status updates). Pre-conditions still owed: Mira's activity-gate framework (carried 12+ days).

**2. Monday status nudge cadence.** Brevo automation: Monday morning nudge to each provider listing their open leads from prior week. Friday rejected (weekend signoff kills inbox attention). Escalation to Nell at 14 days silent.

**3. Field Guide infrastructure preview (build June-July).** Landing page at `switchable.org.uk/field-guide`, email signup gates PDF download, Brevo drip sequence over 4 weeks, Skills Translator £5 Stripe checkout integration. Full spec: `strategy/docs/field-guide-outline.md` + `strategy/docs/skills-translator-spec.md`.

**4. Switchable Members tier infrastructure preview (build Aug-Sept).** Stripe subscription + member portal + member-only content gate + sponsored recruiter listings management. Full spec: `strategy/docs/membership-discount-outreach.md`.

**5. Affiliate revenue tracking (deferred but flagging).** Simple admin panel view of per-partner monthly payouts vs UTM source. Lazy version OK: monthly manual check on each platform's payout report.

Reference: `strategy/docs/q3-revenue-plan.md` for the full 8-line revenue stack and sequencing.

---


## Current state

Big session — six discrete shipments. EMS provider notification routing now scopes by LA per user. Demo providers archived; Courses Direct + WYK Digital paused (active=false, still visible). Charlotte set up as `provider_admin` on EMS + Riverside via her own portal accounts. Employer routing now writes `audit.actions` rows in shape parity with the funded flow; 30 historical Riverside routings backfilled. Experiments page enrolment status buckets fixed to use the full migration-0151 enum, and 24 historical NULL `experiment_id` rows backfilled via 50/50 random so the page is now readable. `/admin/actions` rebuilt for an auto-chase world — three cron-handled sections out, four useful sections in.

## What was done this session

- **Migration 0154 — `notification_las TEXT[]` on `crm.provider_users`.** NULL/empty = catch-all, non-empty = scoped. Seed: George Taylor → Stockton + Hartlepool; Jake Balfour → Middlesbrough + Darlington; Nick Rodgers → Redcar. Andy + Daniel left NULL (catch-all).
- **`_shared/route-lead.ts` updates.** `sendProviderNotification` now takes `sql`, fetches area-scoped CCs via new exported helper `fetchAreaScopedProviderUsers`, threads through `buildCcList` (also exported, dedup against TO). Greeting changed from `Hi ${provider.contact_name ?? "there"}` → `Hello,` in both new-enquiry and re-application templates.
- **`admin-notify-callback` rewritten** to single-email pattern (matched provider_users in TO, owner + provider.cc_emails as CC, area-filtered by lead's `la`). Charlotte CC'd on callback emails (was missing).
- **`admin-test-email` signature updated** to pass `sql` to `sendProviderNotification`.
- **Data-ops 042 — archive demo providers.** `demo-b2c`, `demo-b2b`, `demo-provider-ltd` set `active=false`, `archived_at=now()`. Their 5 provider_users rows suspended. Hard delete blocked by FK ON DELETE RESTRICT on demo-provider-ltd (13 routing_log + 13 enrolments + 13 submissions).
- **Admin providers page demo-strip filter.** Demo badge strip now filters `is_demo=true AND archived_at IS NULL`.
- **Data-ops 043 — pause Courses Direct + WYK Digital.** Flipped `active=false` (pilot_status was already 'paused' but doesn't gate routing).
- **Charlotte's per-provider portal accounts.** Self-invited as `provider_admin` on EMS (`support+ems@switchleads.co.uk`) and Riverside (`support+riverside@switchleads.co.uk`). Decision: per-provider accounts over impersonation at this scale.
- **`crm.provider_users` documented** in `platform/docs/data-architecture.md` (had no entry).
- **Riverside routing audit gap fixed.** `netlify-employer-lead-router` now writes `audit.actions` rows for routings (action=`auto_route_lead`, with sheet/email outcome flags). Shape parity with funded router via `writeAuditSystem`. Data-ops 044 backfills 30 historical Riverside routings with `created_at` backdated to `routed_at`.
- **Experiments page bucket fix.** `BILLABLE_STATUSES`, `IN_FLIGHT_STATUSES`, `LOST_STATUSES` now cover all 14 enum values from migration 0151. Was silently dropping `attempt_1/2/3_no_answer`, `enrolment_meeting_booked`, `engaged`, `in_progress`, `signed`, `presumed_employer_signed`, `not_signed`.
- **Experiment_id propagation gap surfaced + pushed to Mable.** 32/39 DQs + 20/100 qualified from the two Tees experiment pages landed without metadata. Mable fixed site-side (commit `574b2c5`), then asked for historical backfill.
- **Data-ops 045 — experiment_id random backfill.** 13 counselling rows + 11 smm rows back-filled with 50/50 random `experiment_variant`. Audit row written via `audit.log_system_action` with per-experiment totals and `attribution_is_exact=false`. Aggregate DQ comparison now reads cleanly on `/admin/experiments`; individual rows are not row-attributable.
- **`/admin/actions` reshaped.** Dropped three cron-handled sections (Approaching 14-day auto-flip, Needs another chase, Cannot reach no chaser sent). Added: U1 welcome email bounces (lead-level), Provider patterns parent card with three sub-tables (SLA breaches, cannot-reach hotspots, zero-confirmation providers). Tuning constants exposed at top of file (`SLA_OPEN_DAYS=7`, `RECENT_WINDOW_DAYS=7`, `CONFIRM_PATTERN_DAYS=30`, `MIN_ROUTINGS_FOR_CONFIRM_PATTERN=5`, `CANNOT_REACH_HOTSPOT_PCT=20`).

## Next steps

1. **First-fire verification 06:00-06:30 UTC tomorrow (2026-05-21).** Carries from S54: watch the three reconciler crons land (06:00 sheet-drift → 06:15 brevo-attribute → 06:30 drift-digest). Digest email should arrive (or nothing on quiet days).
2. **Watch first real EMS lead.** Live test of LA-scoped CC routing. Confirm CC list matches the LA rules (Middlesbrough → Jake; Stockton → George; Redcar → Nick). Greeting reads `Hello,`.
3. **Auto-flip cron + day-12 warning email (carry from S51, reopened S54).** Migration 0097 still unapplied. EMS has 50 leads past 7-day SLA (visible on the new /admin/actions card) — auto-flip would mop those up at day 14. Pre-conditions: Brevo warning template, provider heads-up emails, Mira's activity-gate framework, optional `auto_flip_enabled` per-provider flag.
4. **Counselling-tees experiment decision.** After backfill: A=27 qualified (18% DQ), B=34 qualified (28% DQ). B wins on volume, A wins on quality. Charlotte's call once she's weighed CPL vs CPE.
5. **Remote Edge Function deletion (carry from S54).** `supabase functions delete backfill-referral-fastrack-urls --project-ref igvlngouxcirqhlsrhga`, then same for `backfill-client-nonce`.
6. **Per-provider CPL / CPE / P/L scoreboard (carry from S49).** Still queued.
7. **Brevo orphan deletion** once Wren confirms `u1-funded` template verified live (carry from S48-49).
8. **Infrastructure-manifest update (carry from S54).** Add `brevo-attribute-reconcile-daily` + `drift-digest-daily` cron rows; remove `dead-letter-alert-hourly`.
9. **Cannot-reach-no-chaser → /admin/errors.** This signal is system-reliability (chaser cron failed), not a task. Move it from /admin/actions (where it was dropped) to /admin/errors as a new pill / reconciler card.
10. **Defer: portal UI for self-edit of `notification_las`.** DB-only edits via SQL for now. Build when a second provider asks for area routing.

## Decisions and open questions

**Decisions:**

- **Per-user LA scoping via `notification_las` on `crm.provider_users`, not a separate table.** Why: everyone Charlotte mentioned is already a `provider_users` row. Single column, optional, NULL = pre-existing catch-all behaviour.
- **`fetchAreaScopedProviderUsers` exported from `_shared/route-lead.ts`.** Used by both `sendProviderNotification` and `admin-notify-callback`. Single source of truth for the area-filter query.
- **Callback notification model: matched provider_users in TO (multi-recipient), owner + cc_emails in CC.** Team visibility + matches the new-lead pattern.
- **Archive (not delete) demo providers.** demo-provider-ltd's 13 routing_log + 13 enrolments rows would cascade-destroy audit chain on hard delete.
- **Per-provider admin accounts over impersonation.** Impersonation needs auth-gate branching + RLS fanout + audit start/stop + view-as banner; pays off at 10+ providers, not 4.
- **Pause CD + WYK via `active=false`.** `pilot_status='paused'` is metadata only; routing gates on `active`. Not archiving because paused is temporary.
- **Andy stays `invited` status (no nudge to enrol).** Charlotte 2026-05-20: he doesn't call leads. New-lead emails still reach him via `provider.contact_email`. Callback emails skip him.
- **Riverside audit backfill: random not exact.** `ads_switchable.page_views` has no `session_id`; variant cookie was never recorded against submission. View splits were within 0.5% of 50/50 so random is statistically valid for aggregate. Tagged `attribution_is_exact=false` in audit context.
- **/admin/actions: drop everything the cron handles.** Auto-chase + auto-flip mean those sections are duplicating cron work. Replaced with provider-pattern cards (SLA breach, cannot-reach hotspot, zero-confirm) that surface the kind of signal where the cron can't act for you.

**Open questions:**

- **Charlotte's portal alias landed as `support+ems@switchleads.co.uk`, not `hello+ems@switchleads.co.uk`** as originally proposed. Same inbox effect. Pick one prefix and stick to it as she onboards onto more providers.
- **Should Andy be CC'd on callback notes** (even though `invited`)? Today filtered out by `status='active'`. If yes, widen to `status IN ('active','invited')`.
- **Owner decides: counselling-tees experiment.** B wins volume (+26% qualified), A wins quality (lower DQ rate). Depends on CPL vs CPE focus. Bring decision to next session.

## Watch items

- **Tomorrow 06:00-06:30 UTC** — first natural fire of the three reconciler crons (S54 carry). Inbox should see one digest email or nothing.
- **First real EMS lead** — live test of LA-scoped CC routing. Until that lands, the wiring is unverified in production.
- **`audit.actions` for next Riverside routing** — should land as a live (non-backfilled) `auto_route_lead` row from the deployed employer router fix.
- **`/admin/experiments` DQ rates post-backfill** — counselling-tees now reads A=18% / B=28% DQ. Verify the page renders these numbers when Charlotte loads it.
- **`/admin/actions` SLA breach card** — EMS shows 50 leads past 7d SLA. That's the dominant signal on the new actions page until auto-flip ships.
- **U1 bounces** — 2 entries today. Manual chase or mark lost.
- **Carries from S52 still open** — crm.email_log rows 504-506 (employer chaser webhook events), first natural Riverside attempt transition by Freya without manual SQL, leads.dead_letter sources `channel_b_sheet_writeback` (S50) + `edge_function_brevo_chase_employer` (S52) should stay empty.
- **Carries from S51 still open** — auto-flip cron + day-12 warning (migration 0097 unapplied), `u_fastrack_qualified` row in `crm.email_log`, invite-claim audit via `public.log_system_action_v1`, `TEST_MODE = false` re-verification before any B2B test submission.

## Next session

- **Folder:** `platform`
- **First task:** Confirm overnight 06:00-06:30 UTC cron loop fired cleanly, then verify the next real EMS lead's email CC list and the live (non-backfilled) Riverside routing audit row. If clean, proceed with the auto-flip cron + day-12 warning email reopened scope (migration 0097, biggest unblocker on Charlotte's billing path) or the deferred cannot-reach-no-chaser → /admin/errors move.
- **Cross-project:** None. Mable's push (experiment_id site-side fix) closed in-session, no new push owed.
