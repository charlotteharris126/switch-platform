# Platform — Weekly Notes

**Scan date:** Monday 2026-04-20 (Sasha, Platform Steward)
**Scope:** 7-day rolling window ending 2026-04-20 07:00 UTC.
**Role used:** `readonly_analytics` via Postgres MCP.

---

## Headline

Pipe is healthy. Seven real leads this week, all routed to EMS, none stuck, dead letter still empty, hourly audit running green every hour. Two governance gaps worth flagging before they bite: `readonly_analytics` cannot see `supabase_migrations.schema_migrations` (so migration drift is unverifiable from this scan), and `AUDIT_SHARED_SECRET` is already listed as due for rotation.

---

## Data flow health

### `leads.submissions` — last 7 days

- 17 rows total. 7 real, 10 DQ. Real/DQ split looks right: 7 of the 10 DQ are Charlotte owner-test submissions (auto-flagged by the 2026-04-19 router change), 1 Charlotte legacy row (id 6, pre-auto-flag), 1 `dq_reason='location'` (id 22, 2026-04-20). No unexpected DQ patterns.
- Funding route on real rows: all 7 `free_courses_for_jobs`. No self-funded or loan-funded leads landed yet (expected — Courses Direct self-funded campaign only went live 2026-04-19 evening).
- `course_id` null on `switchable-funded` real rows: 0. No payload drift.
- Unrouted leads older than 48h: 0. Every real lead is accounted for in `leads.routing_log`.
- `session_id` coverage: 9 of 17 rows carry a `session_id` (53%), 8 do not. The 8 without include id 11 (the Katy manual back-fill, correctly nulled), the 5 DQ owner-tests that pre-date partial tracking, and a handful of early-week rows. For real leads only, 6 of 7 carry `session_id` — healthy tracker coverage. Watch this ratio next week now that partials are wired.

### Daily shape (real leads)

- Day of 2026-04-19: 6 real leads (Susan, Lesley, Katy, Shaun, Rachel, Jo).
- Day of 2026-04-20 (partial): 1 real lead (Lana).
- First meaningful daily volume has arrived, triggered by the EMS counselling campaign. Cumulative real pilot lead total is 7.

### `leads.partials` — last 7 days

- 87 distinct sessions, 87 rows (1:1 — no session has been upserted over the cap).
- 79 on `switchable-funded`, 8 on `switchable-self-funded`. Self-funded partial volume is tiny because the Courses Direct campaign only launched Saturday night.
- 7 completed (all on `switchable-funded`), 80 incomplete. Completion rate ~8% which matches the 7 real leads landed.
- Max `upsert_count` is 17 — well below the 40 flag threshold and the 50 hard cap. No abuse signals.
- Abandonment ceiling: `step_reached = 91` (which in `switchable-funded` is the "form displayed, no step entered" sentinel) accounts for 38 of 87 sessions. `step_reached = 1` accounts for 33. So the majority of partials never get past the first interactive step. This is the funnel's biggest drop-off and the most useful thing Iris can act on when she starts querying this table.
- UTM mix: campaign `120241514035290775` (Iris will recognise this ID from the EMS counselling ads) dominates the partial traffic — 69 of 87 sessions carry it. Campaign `120241604764620775` shows 5 sessions. The rest are null-UTM (likely direct or broken referrer).

### `leads.dead_letter`

- Total rows: 0. Zero rows added this week. No oldest-unresolved to flag.
- No unfamiliar `source` or `error_context` patterns — the table is clean because it is empty.

### `leads.routing_log`

- 7 routings logged this week. 7 real leads received this week. Gap = 0. Every real lead has been forwarded to EMS. All 7 went to `enterprise-made-simple`. Courses Direct has not yet received a routing — no matching self-funded lead has landed.

---

## Automation health

### Cron jobs

Both scheduled jobs are present and active:

- `netlify-forms-audit-hourly`, `0 * * * *`, active=true. Succeeded on every hour checked from 2026-04-19 18:00 UTC through 2026-04-20 06:00 UTC. 13 consecutive successful runs. Return message `1 row` (writes a heartbeat row on clean runs). No failures in the window.
- `purge-stale-partials`, `0 3 * * *`, active=true. Last run 2026-04-20 03:00 UTC, succeeded, `DELETE 0` (nothing stale enough yet to purge). This is the first successful run logged — manifest row had `Last verified: —`, now verified.

No cron failures anywhere in the last 24 runs across both jobs.

### Edge Function inventory

Three functions in `platform/supabase/functions/`: `netlify-forms-audit`, `netlify-lead-router`, `netlify-partial-capture`. All three are referenced by the infrastructure manifest and all three are producing expected downstream effects (hourly audit succeeds, real leads are inserted into `submissions`, 87 partial sessions are flowing in). No orphan deploy or missing deploy observed from the data side. A direct `supabase functions list` check requires CLI login and is out of scope for Sasha's read-only role — flagging to owner for session-start check.

---

## Governance

### Migration discipline

**Gap flagged:** `readonly_analytics` does not have SELECT on `supabase_migrations.schema_migrations` — the query errored with `relation does not exist`. I cannot verify from this scan whether all 8 migration files in `platform/supabase/migrations/` have been applied, or whether there are applied rows not in git.

Local files on disk: `0001_init_pilot_schemas.sql`, `0002_rename_n8n_legacy_names.sql`, `0003_grant_functions_writer_to_postgres.sql`, `0004_add_leads_partials.sql`, `0005_add_submissions_session_id.sql`, `0006_grant_analytics_cron_read.sql`, `0007_cron_visibility_view.sql`, `0008_cron_view_redact_command.sql`.

Indirect evidence they are applied: `public.vw_cron_jobs` exists and returns redacted output (0007 + 0008), `leads.partials` table exists and carries data (0004), `leads.submissions.session_id` column exists (0005), and `cron.job` is queryable via the view (0006). So migrations 0004-0008 are live.

**Recommendation:** owner to ship a small migration granting `readonly_analytics` SELECT on `supabase_migrations.schema_migrations` (or on a `public.vw_migrations` SECURITY DEFINER view if the table contents are considered sensitive). Without it, Sasha cannot do the migration-drift check her CLAUDE.md specifies.

### Changelog discipline

`platform/docs/changelog.md` top entry is dated 2026-04-19 (Session 2.5) and covers migrations 0006-0008, the incident back-fill, the infrastructure manifest, the secrets-rotation tracker, and the owner-test auto-flag. Every schema and governance change since last Monday is logged. No drift observed. (Caveat: "since last Monday" is the whole lifetime of the platform — this is the first Monday scan.)

### Secrets rotation

Read `platform/docs/secrets-rotation.md`. Cross-checked `Next due` against 2026-04-20.

- `AUDIT_SHARED_SECRET`, last rotated 2026-04-19, `Next due` marked "Due for rotation (exposed in Session 2.5 transcript)". Belt-and-braces rotation is recommended in the tracker itself but has not yet happened. **Flagged as approaching — owner action at next convenient moment.** The exposed value was the pre-rotation one, briefly visible before migration 0008 redacted the view; the new value has not been exposed. Risk is low (secret only authorises calling the audit function), but the tracker notes it and the acknowledgement is that rotating again closes the loop.
- All other secrets: `Next due` 2027-04-18 or 2027-04-19 — 364 days out. No rotation due within the 60-day warning window.
- No row exceeds 10 months since `Last rotated` without a `Next due` date. Tracker is clean.

### Infrastructure manifest — critical row verification

| Critical row | Verify outcome |
|---|---|
| `netlify-lead-router` | Producing expected `leads.submissions` rows with owner-test auto-flag working (ids 8, 9, 12, 13, 15, 16, 17, 18 all auto-flagged). Live. |
| `netlify-forms-audit` | Hourly cron has run `netlify-forms-audit` 13 consecutive times with `status: succeeded`. Live. |
| `netlify-forms-audit-hourly` cron | Present via `public.vw_cron_jobs`, `active=true`, `schedule='0 * * * *'`. Live. |
| Netlify outgoing webhook | Indirect verification: 7 real leads landed this week via the normal pipe with `raw_source` null (i.e. not back-filled). Webhook is firing. Direct verification requires Netlify dashboard — owner action at session-start. |
| Postgres roles `readonly_analytics`, `functions_writer`, `ads_ingest` | Scan ran successfully as `readonly_analytics`. `functions_writer` and `ads_ingest` not checked directly — recommend adding a `SELECT rolname FROM pg_roles WHERE rolname IN (...)` as a standing manifest verification. |
| RLS on every `leads`, `crm`, `ads_switchable`, `ads_switchleads` table | Zero tables in those schemas with `rowsecurity = false`. All on. |
| Form allowlist | Out of scope for SQL check — requires curl to `switchable.org.uk/data/form-allowlist.json`. Flagged to owner for session-start. |
| Supabase daily backup | Out of scope for SQL check — Supabase dashboard only. Flagged to owner for session-start. |

No critical row fails verification from the data I can see. Two rows (Netlify webhook direct check, allowlist curl, backup dashboard, Edge Function list) need owner action to complete the manifest verification loop — they are not failures, just outside Sasha's read-only reach.

---

## Growth triggers

Cross-checked against `platform/CLAUDE.md` and `.claude/rules/data-infrastructure.md`.

- Metabase dashboard count > 15 — **not triggered** (Metabase not yet live; Session 2.6 is setup).
- 100+ leads/month — **not triggered** (7 real leads this week, <10/month extrapolated).
- Phase 4 provider dashboard requested — **not triggered**.
- Supabase free tier limits approached — **not triggered** (well under 500MB and 50k MAU).
- Dead letter rows > 10 — **not triggered** (table is empty).
- `leads.partials` crosses 200 sessions/week — **not triggered** (87 sessions this week, approaching but not over). Worth watching: if the Courses Direct self-funded campaign scales and the SMM campaign launches, 200/week is plausible within 2-3 weeks. Metabase setup (Session 2.6) is the right response.
- Any partial session with `upsert_count` ≥ 50 — **not triggered** (max seen is 17).
- Recurring manual DB edits by owner — **not triggered**, but noting: one manual back-fill happened during Session 2.5 (Katy, id 11). Single event, documented, not a pattern yet.
- Schema change impact touches 3+ consumers — **not triggered** this week.

No growth triggers have been crossed. The partials-volume trigger is the closest and is expected to fire within a few weeks — no action now.

---

## Recommendations

All clean on the live pipe: 7 real leads routed, zero in dead letter, hourly audit running, no unrouted leads, no payload drift, partials tracker flowing. Two small governance items worth Mira's attention this week: (1) grant `readonly_analytics` visibility into `supabase_migrations.schema_migrations` so the migration-drift check actually runs from Sasha's scan (owner ships a small migration), and (2) schedule the belt-and-braces `AUDIT_SHARED_SECRET` re-rotation mentioned in the secrets tracker — low risk but the tracker itself asks for it. Everything else is within the window you would expect for the first full Monday after the Session 2.5 incident hardening.
