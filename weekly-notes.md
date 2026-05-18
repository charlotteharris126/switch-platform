# Platform Weekly Notes — Monday 2026-05-18

Sasha's Monday platform health report for Mira. Replaces the previous week.

## Data flow health

### `leads.submissions`
- 110 rows added in last 7 days (parents + children). 56 non-DQ, 54 DQ. 12 children (re-submissions).
- Top funding routes: 44 `free_courses_for_jobs` (learner), 35 with no funding_route, 21 employer apprenticeship leads, 10 self-funded.
- 0 `switchable-funded` submissions with NULL `course_id` on a non-child row — payload contract intact.
- 0 unrouted non-DQ parent submissions older than 48h — owner is clearing the queue.
- session_id coverage: 65 with / 45 without (59% coverage). Acceptable in mixed funded + employer + self-funded traffic, but worth a recheck once B2B partial-tracker is wired in (Mable's outstanding `/business/` tracker fix per memory note).
- Routing log: 73 distinct submissions routed in the 7-day window vs 54 non-DQ parents created in the same window. Healthy (older parents being routed in window pushes routed > created).

### `leads.partials`
- 917 distinct sessions in last 7 days (913 partial rows, 850 incomplete / 63 complete).
- By form: `switchable-funded` 894 sessions (60 complete / 834 abandoned), `s4b-employer-lead-v1` 10 (0/10), `switchable-self-funded` 8 (3/5), `switchable-waitlist` 1.
- Top abandonment step on funded form: step 1 (595 sessions) — opener fall-off, expected on cold paid traffic. Step 91 (184 sessions, the consent/terms surface).
- Max upsert_count = 39 (under the 40 warning threshold, 50 cap untouched).
- **Growth trigger crossed: weekly partial sessions >> 200.** See Growth triggers section.

### `leads.dead_letter`
- 186 total rows, 102 added this week, 7 unreplayed.
- Source breakdown last 7d: `sheet_drift_detected` 78 (5 unreplayed), `netlify_audit` 14 (0), `edge_function_employer_lead_router` 3 (0), `brevo_transactional` 2 (2 unreplayed), `reconcile_backfill` 2 (0), `edge_function_brevo_chase` 1, `edge_function_brevo_upsert` 1, `fastrack_side_effect` 1.
- Oldest unreplayed: 2026-05-17 22:27 — well under the 7-day flag threshold.
- The 5 unreplayed `sheet_drift_detected` rows (ids 266-270) are all from this morning's 06:00 UTC drift cron — 4 are EMS re-submission children (233, 373, 415, 475) which today's `865720a` deploy now filters out, and 1 is the genuine Jyotika #127 CD-sheet drift that Charlotte manually back-filled. Tomorrow's 06:00 cron should produce zero EMS rows.
- The 2 unreplayed `brevo_transactional` rows (ids 264, 265) are the pre-fix `u_fastrack_qualified` HTTP 400 failures (Shazia #488 + Kayleigh #489). `bdd9a4d` ships the fix; first success row in `crm.email_log` is pending.
- No unfamiliar `source` patterns. `edge_function_partial_capture` source absent.

### `leads.routing_log`
- 73 routings in 7d vs 54 non-DQ parents created in 7d — gap is positive (routing draws from a wider window than submission creation). No unrouted-lead backlog.

### `leads.fastrack_submissions`
- 32 fastrack rows in 7d. 5 with `l3_mismatch_flag=true`, 1 with `cohort_confirmed=false` (cohort decline). The L3 mismatch DQ path is firing as designed.

## Automation health

### Cron jobs
All 16 production crons present and active in `public.vw_cron_jobs`. Zero failed runs in the last 7 days across the lot.

- `netlify-forms-audit-hourly` — 168/168 ok over 7d, last run 2026-05-18 11:00 UTC. Healthy.
- `netlify-leads-reconcile-hourly` — 168/168 ok, last run 11:30 UTC.
- `purge-stale-partials` — 7/7 ok, ran 03:00 UTC today.
- `meta-ads-ingest-daily` — 7/7 ok, ran 08:00 today.
- `iris-daily-flags` — 7/7 ok, ran 08:30 today.
- `email-stalled-cron-daily` — 7/7 ok, ran 09:00 today.
- `email-u4-cron-daily` — 7/7 ok, ran 09:30 today.
- `email-sunset-cron-daily` — 7/7 ok, ran 03:00 today.
- `sheet-drift-reconcile-daily` — 7/7 ok, ran 06:00 today (produced 5 new drift rows, 4 of which the morning's deploy now resolves at source).
- `dead-letter-alert-hourly` — 124/124 ok across 7d. Live since 2026-05-13 (migration 0140).
- `brevo-attribute-reconcile-daily`, `brevo-consent-reconcile-daily`, `email-failure-alert-daily`, `email-presumed-flipped-cron-daily`, `leads_retention_anonymise_daily`, `social-publish-15min` — all green.

**Auto-flip cron status:** `run_enrolment_auto_flip_per_provider` function exists (migration 0129) and per-provider `auto_flip_enabled=true` is set across all 7 active providers — but **no cron schedules it**. Migration 0097 (which would schedule it) is still written-but-not-applied per the existing carry. Current stale-lead pool that would auto-flip on first run: EMS 37 (9 open >14d + 28 cannot_reach >14d), CD 21 (19 open + 2 cannot_reach). **58 leads total = ~£8,700 of presumed-enrolment invoices if fired cold.** Charlotte's call to hold pending the day-12 warning template + cron stands.

### Edge Function inventory
40 function folders in `platform/supabase/functions/` (counting `_shared` as one). Manifest's `Last verified: 2026-05-07` is now 11 days stale and does not include several production functions that have shipped since:
- `dead-letter-alert-cron`, `email-presumed-warning-cron`, `email-presumed-flipped-cron`, `gdpr-erase-learner`, `netlify-employer-lead-router`, `provider-invite-link`, `provider-support-notify`, `log-page-view`, plus three new `backfill-*` operational scripts and `reconcile-sheet-to-db`.
- The "Pending first deploy" status on `sheet-drift-reconcile-daily`, `email-stalled-cron`, `email-u4-cron`, `email-sunset-cron`, `iris-daily-flags` in the manifest is stale — all are live and producing successful cron runs (see above).
- **Recommendation:** owner refresh `platform/docs/infrastructure-manifest.md` to reflect current deployed state (catch-up entry for everything from 2026-05-08 onwards). I can draft the diff if Mira green-lights.

## Governance

### Migration discipline
**Drift: migrations 0146 + 0147 are applied to production but NOT logged in `platform/docs/changelog.md`.**
- `0146_email_log_u_fastrack_qualified.sql` (2026-05-17) — extends `crm.email_log.email_type` CHECK with `u_fastrack_qualified`. Verified live in `pg_constraint`.
- `0147_log_system_action_v1_public_wrapper.sql` (2026-05-18) — creates `public.log_system_action_v1()` RPC wrapper. Verified live in `pg_proc`.
- Per `.claude/rules/data-infrastructure.md` §9, every schema change requires a changelog entry. Both are mine to write (I authored both migration headers); owner action: confirm and I'll backfill the changelog rows next platform session. No production risk, governance hygiene only.
- Migrations 0141-0145 all logged correctly.

CLI migration registry drift `0141-0145` "local but not on remote" carry from S47 is now contradicted by what I see live in production (the CHECK constraint includes the latest values, the `log_system_action_v1` function exists). Either the registry has caught up since S47 or the carry was always a CLI-state oddity not an actual schema gap. Worth Charlotte re-checking `supabase migration list --linked` at the start of the next session to close the carry.

### Changelog discipline
- 18+ entries since last Monday (2026-05-11). Sessions 40, 42, 43, 44, 45, 46, 47, 48, 49, 50 all have changelog rows. Discipline good aside from the two unlogged migrations above.

### Secrets rotation
Reading `platform/docs/secrets-rotation.md` against today (2026-05-18):

**OVERDUE (still):**
- `BREVO_API_KEY` — flagged "Due for rotation (plaintext in Session 3 transcript)" 2026-04-20. **28 days overdue.** Rotate via Brevo dashboard → new key → swap Supabase secret → revoke old.
- `ROUTING_CONFIRM_SHARED_SECRET` — flagged "Due for rotation (plaintext in Session 3 transcript)" 2026-04-20. **28 days overdue.** Rotate via `openssl rand -hex 32` + Supabase secret swap. Invalidates any in-flight confirm-link emails (low impact at current volume).

**No other secrets within the 60-day approaching window.** All other rotations due 2027.

### Infrastructure manifest
Stale — see Edge Function inventory section above. `Last verified` was 2026-05-07; needs a refresh pass. Critical rows still verifiable: hourly audit cron, hourly reconcile cron, lead-router, fastrack-receive all green via live data + cron run logs.

## Growth triggers

**Two triggers crossed this week (firing loudly once, not weekly noise):**

1. **`leads.submissions` exceeds 100/month.** 462 submissions in last 30 days, 254 non-DQ, 246 unique parents. Threshold from `platform/agent.md` and `.claude/rules/data-infrastructure.md` is 100/month. **Recommended action:** start Supabase query performance review (per spec: "performance-tune Supabase queries, consider read replicas"). Pilot volume has scaled.
2. **`leads.partials` sessions/week crosses 200.** 917 distinct sessions this week, 4.5x the threshold. Threshold from `platform/agent.md`: "200 sessions/week OR Iris starts asking funnel questions weekly". **Recommended action:** prioritise Metabase setup — SQL queries against `leads.partials` are getting unwieldy and Iris's ads-optimisation flow needs funnel dashboards.

Both triggers reflect that the pilot is no longer at the "quiet system" volume the agent was designed for. Capacity note implication: Mira may want to weigh in on whether Metabase setup precedes or follows the in-dashboard analytics build per the existing scoping doc (`platform/docs/admin-dashboard-scoping.md`).

**Not crossed:**
- Dead letter ≥10 unresolved — current 7 unresolved.
- Phase 4 provider dashboard — the admin and provider portals are live, but the Phase 4 trigger as written is "provider dashboard requirement from a provider" / "5+ providers ready for self-serve" / "first credits-model provider being onboarded". Still 4 active pilot providers, no credits-model live yet.
- Supabase free tier limits — not assessed via SQL; check Supabase dashboard.
- 3+ providers per course on the same routing criteria — not yet, EMS / CD / WYK still in disjoint regions/funding routes.
- Recurring manual DB edits — none observed; Charlotte uses `/admin/data-ops` panel and Channel B sheet→DB for in-pipeline edits.
- Schema change touching 3+ consumers — none this week.
- `crm.email_log` failure rate, partial cap (50) — both safely under thresholds.

## Recommendations

Three things for Mira's attention this week, in order of priority:

1. **Decide auto-flip-cron prerequisites are good enough to ship**, or accept that the 58 stale EMS+CD leads keep accruing each week until the day-12 warning email lands. Today's handoff puts that build on the next-task list; Mira's call on whether to gate billing capability behind it or de-risk further. Either way, Charlotte should not be running the cron manually against 58 leads.
2. **Two growth triggers crossed.** Per `platform/agent.md` these "fire loudly once" — I'm firing them here. Read replicas / query tuning for `leads.submissions` is not urgent yet (no observed slow queries), but Metabase setup is concrete and should land in the next 2-3 sessions per the partial-volume signal. Coordinate with Iris (she'll want funnel-step views first).
3. **Two governance bits Sasha needs owner sign-off on:** (a) Charlotte to confirm I can backfill changelog entries for migrations 0146 + 0147 next session; (b) BREVO_API_KEY + ROUTING_CONFIRM_SHARED_SECRET have been overdue for rotation since 2026-04-20 — 28 days. Both are easy 5-minute rotations. Sasha doesn't rotate; owner action.

Otherwise the layer is healthy. Cron suite is fully green over 7 days, no schema or RLS drift, dead letter at 7 unresolved (all explainable and resolving on tomorrow's cron), no payload contract breaches.

Capacity note: not at the 2hr/week threshold yet — this Monday pass was ~30 min. No co-agent or implementation authority needed.
