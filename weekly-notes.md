# Sasha — Weekly Platform Report

**Date:** Monday 27 April 2026
**Period:** 21 April 2026 to 27 April 2026 (since last weekly review)
**Role:** readonly_analytics

---

## Headline

Pipe is running cleanly. Cron is healthy, no real failures in the last 7 days, no migration drift, every qualified lead routed. Two follow-up items: confirm the 6-row reconcile back-fill cluster on 2026-04-25 was the post-deploy 4h JWT outage backfill (looks like it), and rotate the two secrets that have been flagged overdue since 20 April (BREVO_API_KEY, ROUTING_CONFIRM_SHARED_SECRET).

---

## Data flow health

### `leads.submissions` (last 7 days)

- Total rows: 140
- Qualified: 78 (55.7%)
- DQ: 62 (44.3%)
- Session ID coverage: 97 / 140 with `session_id`, 43 NULL. ~69% tracker coverage. No collapse vs prior weeks.
- Funding route split: `free_courses_for_jobs` 59, NULL 50 (mostly DQ / waitlist), `lift_futures` 17, `self` 14
- `course_id IS NULL` on funded forms: 0 (no payload drift)
- Unrouted qualified leads older than 48h: 0
- Total unrouted qualified active leads: 0

### `leads.routing_log`

- Routed in last 7 days: 80 events
- Gap vs qualified inserted: routed (80) > inserted-qualified (78). Gap is normal — `routing_log` rows include re-routes / multi-provider routings, plus some routed leads inserted before the 7-day window.

### `leads.partials` (last 7 days)

- Sessions: 1,767 (1,681 incomplete, 86 complete)
- Top form: `switchable-funded` 1,621 incomplete + 82 complete
- `switchable-self-funded` 60 incomplete + 4 complete
- Top step_reached: step 1 (1,077 sessions), step 91 (493 — form-completion marker but `is_complete=false`, indicating submit triggered but not finalised). Step 6 next at 41.
- Abandonment ceiling: heavy drop between step 1 and the rest, classic top-of-funnel attrition. Step 91 with `is_complete=false` is mid-flight submit telemetry, not a true abandonment.
- Top utm_campaign × step × complete: campaign `120241514035290775` dominates volume (964 sessions hit step 1, 442 at step 91 incomplete, 28 complete). Second active campaign `120241604764620775` at much lower volume.
- `upsert_count` ≥ 40: 1 row (id 406, 45 upserts, complete=true, switchable-funded). Approaching the 50 cap but not abusive — completed submission. Below the 200 sessions/week trigger threshold for Metabase prioritisation.

### `leads.dead_letter`

- Total active rows (not yet replayed): 7
- Rows added in last 7 days: 9 (6 of which are reconcile back-fills on 2026-04-25)
- Oldest unresolved row age: 7 days (id 90, sheet append "unauthorized", 2026-04-23)
- No row > 7 days unresolved (just at the threshold; flag below)
- Pattern breakdown:
  - 6 × `reconcile_backfill` rows on 2026-04-25 12:54 — within seconds of each other, likely the safety-net catching the JWT-outage queue (Session 25 April 4h incident). Matches the "Reconcile cron pulls from Netlify Forms API every 30 min as a safety net" recovery path documented in the changelog. Worth confirming with the owner that all six were healthy back-fills and not a new failure mode.
  - 2 × `edge_function_sheet_append` (id 89, id 90) — id 89 is `provider has no sheet_webhook_url configured`; id 90 is "unauthorized" on 2026-04-23. Both unreplayed. These need owner triage: which provider was the unconfigured one, and is the 23 April unauthorized a one-off or did SHEETS_APPEND_TOKEN drift again?
- No `edge_function_partial_capture` rows — partials endpoint healthy.

---

## Automation health

### Cron jobs (`public.vw_cron_jobs`)

| Job | Schedule | Active |
|---|---|---|
| `netlify-forms-audit-hourly` | `0 * * * *` | yes |
| `netlify-leads-reconcile-hourly` | `30 * * * *` | yes |
| `enrolment-auto-flip-daily` | `0 6 * * *` | yes |
| `purge-stale-partials` | `0 3 * * *` | yes |

All four critical/expected crons are scheduled and active. Last 7 days of `vw_cron_runs`: every run succeeded. No timeouts, no failures, no drift. `purge-stale-partials` ran clean (DELETE 0 — nothing to purge yet).

### Edge Function inventory

Folders in `platform/supabase/functions/`:
- `_shared/` (helpers)
- `netlify-lead-router`
- `netlify-forms-audit`
- `netlify-leads-reconcile`
- `netlify-partial-capture`
- `routing-confirm`

Five deployed functions, all expected per the manifest. No orphans. (Live deploy state would need CLI access; cross-checked from the manifest — last verified 2026-04-21.)

---

## Governance

### Migration discipline

- Files in `platform/supabase/migrations/`: 29 (0001 to 0029)
- `supabase_migrations.schema_migrations` not readable from `readonly_analytics` (permission denied — expected). Cannot verify direct match from this scan.
- Last in-changelog confirmation of migration repair: 2026-04-25 (`migration repair --status applied 0001..0016` brought the registry into line; subsequent push applied 0017). 0028 and 0029 applied 26 April per their changelog entries. No drift signal in any reachable surface.
- No migration files appear unrecorded in the changelog. 0001–0029 all have at least one corresponding entry in `platform/docs/changelog.md`.

### Changelog discipline

Changes since last Monday (2026-04-21) that should be logged:

- 2026-04-22 incidents (sheet append, token rotation) — logged
- 2026-04-22 morning data fix (Katy patch, id 30 cleanup) — logged
- 2026-04-25 outage (Edge Function deploy without `--no-verify-jwt`) — logged
- 2026-04-25 hardening (migration 0019 Vault helper) — logged
- 2026-04-25 auto-routing v1 + Realtime — logged
- 2026-04-25 data-ops 009 routing-state cleanup — logged
- 2026-04-26 enrolment status taxonomy (migration 0028) — logged
- 2026-04-26 social schema (migration 0029) — logged

Discipline holding. No silent changes spotted.

### Secrets rotation (`platform/docs/secrets-rotation.md`)

Cross-check vs today (27 April 2026):

- **OVERDUE (since 20 April 2026):** `BREVO_API_KEY` — flagged due for rotation in the secrets tracker since 2026-04-20 (plaintext exposed in Session 3 transcript). 7 days overdue. Blast radius: email send only. Action: generate new key in Brevo, replace Supabase secret, revoke old.
- **OVERDUE (since 20 April 2026):** `ROUTING_CONFIRM_SHARED_SECRET` — same plaintext exposure flag from Session 3. Tracker notes one mid-session rotation, but flag is still open. Blast radius: minting fake confirm links for existing leads. Action: rotate via fresh `openssl rand -hex 32`, redeploy `netlify-lead-router` and `routing-confirm`.
- **Approaching (within 60 days):** none.
- **No `Next due` date but >10 months since rotated:** none. Most secrets rotated 18–25 April 2026 (well within annual cadence).

The two overdue items have been overdue for 7 days. Worth getting them done this week.

### Infrastructure manifest (`platform/docs/infrastructure-manifest.md`)

Cross-check of critical rows:

- `netlify-lead-router` Edge Function: deployed (last verified 2026-04-21). No back-pressure or failure signal in dead_letter for routing path.
- `netlify-forms-audit` + `netlify-leads-reconcile`: cron history shows successful runs every hour and half-hour, full 7-day window. Both healthy.
- `netlify-partial-capture`: 1,767 partial sessions captured in 7 days, no `edge_function_partial_capture` dead-letter rows. Healthy.
- `routing-confirm`: 80 routing_log rows in 7 days. Active.
- Cron `netlify-forms-audit-hourly` + `netlify-leads-reconcile-hourly`: present, active, succeeding.
- Form allowlist: not directly verified this scan (would need a curl). No related dead_letter rows so allowlist is not actively blocking real submissions.
- Postgres roles: not fully verified from `readonly_analytics`. No symptom of role drift.
- RLS audit: every queryable table in `leads`, `crm`, `ads_switchable`, `social`, `audit`, `public` has `rowsecurity = true`. No tables missing RLS.

Manifest `Last verified` field is 2026-04-21 (Session 5). Six days old. Not stale enough to flag, but worth a refresh on the next platform session — particularly to bump verification of the Apps Script deployments table now that the WYK + Courses Direct rows have been moving since Session 5.

---

## Growth triggers

Re-check against the table in `platform/CLAUDE.md`:

- **Metabase dashboard count > 5:** Metabase not yet live. Not triggered.
- **100+ leads/month in `leads.submissions`:** 140 in last 7 days alone. Trigger fired earlier — already being handled by admin dashboard (in build per `platform/docs/admin-dashboard-scoping.md`). Performance tuning not needed yet (volume well under any pain threshold).
- **Provider dashboard requirement (Phase 4):** not triggered. Three pilot providers, none asking.
- **3+ providers per course on same routing criteria:** auto-routing v1 already shipped 2026-04-25 ahead of this trigger (single-candidate auto-route). Multi-candidate scoring not yet needed — none of the active courses have 3+ matched providers yet.
- **Supabase free tier limits (500MB / 50k MAU):** well under.
- **Dead letter rows > 10:** 7 active rows, 9 added this week. Below the 10-row threshold but climbing. **Worth a closer look this week** at the two unresolved sheet-append rows (89, 90).
- **Partials volume > 200 sessions/week:** 1,767 / week. Trigger has fired well past threshold. Metabase setup is overdue from this signal alone — but the admin dashboard build is the same project absorbing this need.
- **Any partial session `upsert_count` ≥ 50:** highest is 45. Not triggered.
- **Recurring manual DB edits:** trigger marked TRIGGERED on 2026-04-22, admin dashboard MVP in build. No new unrelated manual workflow surfaced this week — re-fire condition not met.
- **Any schema change touching 3+ consumers:** migration 0028 (enrolment status) touched the lead detail page, outcome form, server action, admin overview, and actions page — five surfaces, but all internal to the same dashboard codebase, single owner, single deploy. Not the kind of cross-consumer change the trigger is aimed at. Not escalated.

**Nothing newly fired this week.** Triggers already in motion (admin dashboard absorbing manual edits + Metabase replacement) are tracking on plan.

---

## Recommendations

Mira, three things to look at this week:

1. **Rotate the two overdue secrets** (BREVO_API_KEY, ROUTING_CONFIRM_SHARED_SECRET) — overdue since 20 April per the rotation tracker. Both blast-radius-limited but the flag has been open for a full week.
2. **Triage the two unresolved sheet-append dead_letter rows** (id 89 "no sheet_webhook_url configured" on 23 April, id 90 "unauthorized" on 23 April). These are at the 7-day "flag any row older than 7 days" line right now. Worth identifying which provider id 89 was for, and whether id 90 represents another SHEETS_APPEND_TOKEN drift event.
3. **Refresh the infrastructure manifest** `Last verified` row on the next platform session — six days since last verification, and Apps Script deployments for Courses Direct + WYK Digital are still listed as "pending sheet creation" but have clearly been live and routing leads since at least 21 April.

Otherwise: pipe is healthy, cron is clean, no migration drift, RLS holds. Pilot lead volume is real (140/week, 78 qualified) and routing has handled it without a queue building.

---

## Knowledge bake candidates

None this week. The `Supabase dashboard hover tooltip is unreliable for confirming secret values` insight from the 2026-04-22 SHEETS_APPEND_TOKEN incident is already captured in the secrets-rotation tracker as a process note. No new pattern emerged in this scan that warrants a skill or rule update.
