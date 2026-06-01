# Platform Weekly Notes — Monday 1 June 2026 (Sasha)

Window: 25 May – 1 June 2026. Read-only via `readonly_analytics`. Sasha flags; the owner implements.

---

## Headline

`sheet_drift_detected` dead-letter rows (71 unresolved, 31 older than 7 days, oldest 21 May) now breach the 14-day dead-letter rule and are the single largest unresolved signal. These are EMS hand-edited status cells, known and benign in cause, but the policy says any row >14 days is replayed or explicitly written off. They are neither. Decide a disposition (suppress EMS from drift detection, or bulk-write-off).

---

## Data flow health

**`leads.submissions` (last 7 days):**
- 22 rows: 14 non-DQ, 8 DQ.
- `funding_route` split: 7 `free_courses_for_jobs`, 15 null. The nulls are legitimate — 11 `s4b-employer-lead-v1` (B2B employer leads, no funding_route by design), 2 `switchable-waitlist`, 2 newsletter/other. Not payload drift.
- Funded-form rows with null `course_id`: **0**. No payload drift.
- Unrouted non-DQ leads older than 48h: **0**. Clean (lead 526 written off last session cleared the prior one).
- Tracker coverage: 9 of 22 carry `session_id`, 13 null. The 13 nulls map to `s4b-employer-lead-v1` (11) + others — the B2B form is not wired to the session tracker the way the funded form is. Not a regression, but worth confirming with Mable whether the employer form is meant to carry session_id (partial-tracker coverage gap, same class as the 16-May `.track()` wiring miss).

**`leads.routing_log`:** 18 distinct submissions routed this week vs 14 non-DQ submitted this week. Gap is positive (more routed than newly arrived) because routing fired on leads submitted before the 7-day window. No unrouted backlog. Healthy.

**`leads.partials` (last 7 days):**
- 537 rows across **517 distinct sessions**.
- Completion: 10 complete of 537 (top-of-funnel abandonment, expected).
- By form: `switchable-funded` 473 rows / top step 1 (9 complete), `s4b-employer-lead-v1` 41 / top step 3, `switchable-self-funded` 12, `fastrack-funded-v1` 5, waitlist 5.
- Max `upsert_count` = 31. **No session at or near the 40/50 abuse cap.** Clean.

**`leads.dead_letter`:** 102 unresolved total, 65 added this week, 37 older than 7 days, oldest 20 May. By source:

| source | unresolved | added 7d | >7d | note |
|---|---|---|---|---|
| `sheet_drift_detected` | 71 | 40 | 31 | EMS hand-edited cells. **Breaches 14-day rule.** See headline. |
| `brevo_attribute_reconcile_async_check_result` | 14 | 14 | 0 | Check-result artefacts from the daily reconcile, not real failures. Should be auto-closed/suppressed, not left as unresolved rows. |
| `brevo_attribute_drift` | 12 | 6 | 6 | Clears on /admin/errors Re-sync (or SQL recipe). 6 are stale (>7d). |
| `edge_function_partial_capture` | 4 | 4 | 0 | Connection-pool exhaustion. **See automation health — connection pressure.** |
| `brevo_transactional_sms` | 1 | 1 | 0 | Single send failure 31 May. |

Dead-letter is at 102, up from the ~87 steady-state at last session close. The growth is `sheet_drift_detected` (+40 this week) and the `_async_check_result` artefacts (+14). Neither is a pipe failure, but both are noise the table is not supposed to accumulate.

---

## Automation health

**Cron:** all 20 scheduled jobs `active=true`. All ran and succeeded in the last 24h except one isolated failure:
- `sms-fastrack-prompt-cron` (runs every minute): 1439 succeeded, **1 failed at 31 May 23:33 with `connection failed`**. Three `connection failed` failures across 31 May (11:51, 17:16, 23:33). Self-recovered each time. This matches the `edge_function_partial_capture` connection-pool dead-letters (same date, same cause). **Free-tier Postgres connection ceiling is showing under the every-minute SMS cron + partial-capture load.** Not breaking yet; watch. If it climbs, the every-minute SMS cron cadence is the obvious first lever (does it need 1440 runs/day at pilot volume?), or upgrade to Supabase Pro (the existing upgrade trigger keys on the 500MB / 50k-MAU limit, not connections, so this is a new pressure not covered by a trigger).
- `netlify-forms-audit-hourly` (24/24) and `netlify-leads-reconcile-hourly` (24/24) both green — webhook safety net intact.

**Edge Functions:** 48 function folders in git (`platform/supabase/functions/`). No orphan-vs-deployed cross-check possible — Sasha is MCP-only, no CLI deploy-list access. Flag: the **infrastructure manifest documents ~16 functions; production git has 48** (see governance).

---

## Governance

**Migration discipline:** files run to `0179_editorial_drafter_cron.sql`. Cannot diff against `supabase_migrations.schema_migrations` — `readonly_analytics` is denied on that schema (`permission denied for schema supabase_migrations`). Flag: Sasha has no way to verify applied-vs-git migration state. Consider a `public.vw_schema_migrations` SECURITY DEFINER view (same pattern as `vw_cron_jobs`) so the Monday scan can actually run this check.

**Changelog discipline — GAP.** Four migrations shipped with no changelog entry:
- `0175_grant_authenticated_chaser_log_select.sql`
- `0176_drop_sms_log_unique_index.sql` — a destructive index drop (the windowed-dedup fix); should be logged per data-infrastructure §2/§9.
- `0177_admin_roadmap_lane_extension.sql`
- `0178_editorial_tier_and_batches.sql`

0175 and 0176 are siblings of 0174 (the 26 May bulk-SMS-chaser work, which IS logged) — they belong to the same session and were dropped from the entry. 0177/0178 are roadmap + editorial work. Owner: backfill four changelog rows.

**Infrastructure manifest — STALE.** `Last verified: 2026-05-07`, ~3.5 weeks old. It documents ~16 Edge Functions and ~10 crons. Production now has 48 function folders and 20 crons. Undocumented-in-manifest crons include: `drift-digest-daily`, `brevo-consent-reconcile-daily`, `editorial_auto_publish_every_15min`, `editorial_blog_drafter_mwf`, `editorial-auto-publish-scheduled-posts`, `email-presumed-flipped-cron-daily`, `leads_retention_anonymise_daily`, `social-publish-15min`, `sms-fastrack-prompt-cron`. The manifest is the critical-row verification list — if it doesn't list what's live, session-start verification can't catch a disabled critical job. Already a carry item (S60 handoff #9). Now overdue enough to flag loudly.

**Secrets rotation:** read `secrets-rotation.md`. Against today (1 June 2026):
- No annual rotations due within the 60-day window (all dated April 2026, next due April 2027).
- **Still flagged OVERDUE in the file itself:** `BREVO_API_KEY` and `ROUTING_CONFIRM_SHARED_SECRET` — both marked "Due for rotation (plaintext in Session 3 transcript)" since 20 April. Six weeks open. Low blast radius (email send / confirm-link minting at pilot volume) but the file flags them every Monday and they remain undone. Owner: rotate both, or downgrade the flag with a documented risk-accept.
- `META_ACCESS_TOKEN`: long-lived system-user token, "set Apr 2026", 60-day renewal cadence. If set early-mid April it may be inside its 60-day expiry window now (~early June). meta-ads-ingest ran green this morning, so still valid, but confirm the exact issue date — a silent 401 mid-week would stop ads ingest.

---

## Growth triggers

- **`leads.partials` > 200 sessions/week: CROSSED.** 517 distinct partial sessions this week vs the 200/week threshold for prioritising Metabase. SQL-by-hand on funnel questions gets painful at this volume and Iris needs dashboards for ad optimisation. Firing loudly once. Recommend Mira slot Metabase setup (or the in-dashboard analytics module) onto the build queue. (Note: 200/week was likely first crossed earlier given paid-social volume — flagging now as the first explicit surface.)
- New free-tier **connection** pressure (above) is not covered by any existing growth trigger — the Supabase-upgrade trigger keys on storage/MAU. Candidate new trigger: "recurring `connection failed` cron errors → review per-minute cron cadence / upgrade tier."
- `leads.dead_letter` > 10: technically crossed at 102, but the cause is benign accumulation (sheet drift + check artefacts), not an upstream pipe failure. Disposition is the headline item, not an architecture change.
- All other platform + data-infrastructure triggers: not crossed. Leads <100/month, no provider-dashboard demand, no 3+-providers-per-course routing.

---

## Recommendations

Mira, three things this week. First, decide the `sheet_drift_detected` disposition — 71 rows breaching the 14-day rule, growing 40/week; either suppress EMS hand-edit drift from the detector or bulk-write-off, because right now the dead-letter table is acting as a graveyard, which the rule forbids. Second, the infrastructure manifest is 3.5 weeks and ~30 functions/crons behind production — it's the session-start safety check and can no longer do its job; needs an owner pass to re-sync, plus four backfilled changelog rows (0175-0178). Third, the partials-sessions growth trigger is crossed (517/week) — Metabase or the in-dashboard analytics module should move up the queue. Underneath all that the live pipe is healthy: webhooks green, zero unrouted backlog, zero funded-form payload drift, no partial-abuse, all crons firing. The flags are governance and accumulation, not lead loss.

Capacity note: none. This week's scan was normal load.
