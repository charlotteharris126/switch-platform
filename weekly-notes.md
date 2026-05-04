# Sasha, Weekly Platform Notes 2026-05-04

Period: 28 April 2026 to 4 May 2026.

---

## Data flow health

**leads.submissions:** 92 rows added in the last 7 days — 49 qualified, 43 DQ. Zero unrouted leads over 48 hours. No rows with null `course_id` on `switchable-funded` forms (no payload drift). `session_id` coverage healthy — ratio has not collapsed.

**leads.routing_log:** 53 routing events against 49 qualified submissions. No gap. All qualified leads are accounted for.

**leads.partials:** 1,216 sessions last 7 days. See Growth Trigger below — this has crossed the 200/week threshold significantly.

**leads.dead_letter:** 71 total rows. 59 added this week. Zero unresolved rows. All bulk-resolved by 2026-05-02/03. The volume reflects the Meta API-blocked ingestion period (entries confirm `iris-daily-flags` dead-letter backfill from the Development Mode fix). Oldest row resolved. Business Verification gate (ClickUp 869d4xtng) is the live blocker for stage 1d; until that clears, `meta-ads-ingest` dead-letter entries will recur if the API gate re-fires.

---

## Automation health

All 7 cron jobs active and succeeding. No failures in the run window.

- `netlify-forms-audit-hourly`: scheduled, last run 10:00 today, status `"clean"`.
- `purge-stale-partials`: scheduled, last run 03:00 UTC today, clean.
- `iris-daily-flags`: first scheduled run confirmed this morning at 08:30 UTC — 200 response, zero candidates flagged, P2.3 correctly suppressed by the 7-day rule (same-day suppression active from 3 May flags).
- `meta-ads-ingest`: ran clean this morning. Meta Business Verification gate has not re-fired since 2026-05-03.

Edge Functions: inventory matches `platform/supabase/functions/`. No orphan deploys detected. No local functions undeployed.

---

## Governance

**Migration discipline:** migrations 0001-0066 on disk. The 0062 gap is intentional and documented. No new migrations applied or pending this week. DB and git in sync.

**Changelog discipline:** all Session 27 work logged in `platform/docs/changelog.md`. No unlogged changes detected.

**Secrets rotation — two OVERDUE, one untracked:**
- `BREVO_API_KEY`: rotation was due 2026-04-20. Now 14 days overdue. Owner action needed.
- `ROUTING_CONFIRM_SHARED_SECRET`: rotation was due 2026-04-20. Now 14 days overdue. Owner action needed.
- `META_ACCESS_TOKEN`: no expiry date logged in `secrets-rotation.md`. Cannot monitor. Owner should log the expiry date this session.

**Infrastructure manifest:** all critical rows verified. No silent drift detected.

---

## Growth triggers

**CROSSED (firing once): `leads.partials` at 1,216 sessions/week vs the 200/week threshold.**

The partials table is accumulating at 6x the trigger threshold. At this volume, SQL queries for funnel analysis become painful and Iris needs dashboards for ad optimisation. The already-deployed `vw_funnel_dropoff` view makes Metabase setup straightforward — the view is ready to drop into a dashboard.

Recommended next step: Metabase setup. This is the Sasha trigger at 200+ sessions/week. The view is live. Owner action: add Supabase as a data source in Metabase, build the funnel dropoff dashboard from `vw_funnel_dropoff`. Estimated time: 30-45 minutes. Unblocks Iris's conversion rate analysis and removes the reliance on ad-hoc SQL for funnel questions.

---

## Recommendations

Two secrets are 14 days overdue for rotation (BREVO_API_KEY, ROUTING_CONFIRM_SHARED_SECRET). These should be actioned this session before any provider-facing work starts. The partials growth trigger has crossed and Metabase setup is the clear next step — the view is already built, setup is a dashboard config task not a build task. Everything else is clean.