# Platform Handoff, Session 61, 2026-06-01

## Current state
Newsletter signups now auto-add to Brevo (no more manual import) and DB↔Brevo attribute drift is fully cleared (0 drifted, status pill green). Dead-letter cleaned from 439 to a ~87 steady-state of real signals. All Edge Function changes deployed; admin app changes pushed and live on Netlify.

## What was done this session
- **Newsletter → Brevo automation (shipped, verified).** `netlify-lead-router` branch: `switchable-blog-subscribers` signups auto-add to Brevo newsletter list 10 (single opt-in, submit = consent); not-routed (no_match/waitlist) leads also added to list 10 when marketing-consented. Env var `BREVO_LIST_ID_SWITCHABLE_NEWSLETTER=10` set. 87 existing not-routed + consented contacts backfilled via `admin-brevo-resync` SQL.
- **Dead-letter cleanup.** Orphan Netlify form `switchable-newsletter` deleted (killed hourly netlify_audit noise). Data-op `048_clear_stale_dead_letter` applied (~165 dead rows + ~187 netlify_audit closed). 439 unresolved → ~87 (all real: sheet_drift, brevo_attribute_drift, partial_capture).
- **Brevo reconcile gate fix (deployed).** `brevo-attribute-reconcile` now gates on archived-only (was active+archived), matching `admin-brevo-resync`. Killed ~52 paused-provider (CD/WYK) false errors. Only 13 demo-archived errors remain (correct).
- **Brevo drift driven to 0.** Root causes fixed: (1) `normaliseForCompare` now trims both sides (Brevo trims on store; DB carries trailing-space names + leading-space phones) — cleared ~115 false positives; (2) SW_ENROL_STATUS Brevo Category enum extended with missing values (Charlotte, dashboard) — Brevo was silently dropping writes; (3) final SQL resync of the 48 remaining drifters (ok 48/48).
- **Brevo reconcile panel apply rewrite (partial).** Replaced the hung async-apply-then-poll with chunked apply-by-ids; fixed the bigint-as-string id filter. Still times out on matched-heavy drift (Netlify Server Action window). Marked KNOWN-LIMITED in the UI with a pointer to the SQL recipe.
- **Lead 526 (Luke Wallace)** written off (real self-funded, never routed, 8 days stale; archived + is_dq, dq_reason `written_off_stale_unrouted`).
- **Self-correction:** early in session misdiagnosed a readonly_analytics grant regression (own wrong column name); deleted the bogus migration before it shipped.

## Next steps
1. **Proper fix for the reconcile panel apply button (deferred, fresh session).** Make the EF self-chunk through all drift ids in a background task; panel just kicks-and-polls. Most robust, most code, another untested-live deploy. Until then the SQL resync recipe on /admin/data-ops is the working path.
2. **CMS Phase 2 carries (from S60).** Build script flip so `editorial.posts` is the live blog source (gates CMS visibility), `/admin/blog/media`, `/admin/blog/content-plan`, Netlify deploy hook on publish, draft-ready notification. Confirm DATABASE_URL on Netlify first.
3. **Build 3 — Demand-aggregation view** (Mira PUSH, Phase 1 weeks 3-6). View at `strategy/docs/demand-aggregation-playbook.md`.
4. **Build 2 — Provider OS V1 architecture scoping** (Mira PUSH, fresh Supabase project).
5. **Build 4 — Blog cadence agentification** (Mira PUSH, pg_cron Anthropic drafter). Note: `0179_editorial_drafter_cron.sql` already exists.
6. **Wren broadcast-gating PUSH** (carry S58/S60): `SW_FASTRACK_COMPLETED` per-course + `SW_PENDING_RESTART` + `SW_COURSE_OPEN`. Blocks EMS 117-lead broadcast.
7. **Auto-flip cron + day-12 warning** (carry S51-S60). Migration 0097 unapplied. EMS has 50+ leads past 7-day SLA.
8. **Optional:** delete the ~16 owner-test contacts (`hello+...@switchable`, `kieranwrites@`) from Brevo so they stop showing as SW_COURSE_OPEN drift on future checks.
9. **Older carries (S55-S60):** Construction `experiment_id` at INSERT, async_apply chunking pattern, filter inactive providers from brevo-attribute-reconcile, infrastructure-manifest update (add drift-digest-daily etc.), per-provider CPL/CPE scoreboard.

## Decisions and open questions
**Decisions made this session:**
- **Newsletter is single opt-in** for the signup form (submit = consent); not-routed leads gated on marketing consent (newsletter is a marketing comm). Owner decision.
- **Backfilled all 87 not-routed + consented** (not just the 25 waitlist) so existing population matches forward behaviour.
- **Panel apply button parked as known-limited**, SQL resync is the supported path. Owner chose this over more deploy cycles.
- **Lead 526 written off** rather than routed (self-funded, gone cold).
- **Reconcile gate is archived-only** (paused providers still reconcile) to match admin-brevo-resync.

**Open questions:**
- None blocking. The panel-apply proper fix is scoped but deferred; everything else has a working path.

## Watch items
- **Tomorrow's 06:30 drift digest** should be ~87 rows (down from 439) and shrinking. Confirm it's not back at 160+.
- **`edge_function_partial_capture`** — real connection-pool exhaustion errors on 30-31 May (4 rows). Not dead; watch if it climbs (free-tier connection ceiling signal).
- **Newsletter list 10** — new signups + new not-routed-consented leads should land automatically. Spot-check Brevo list count rises with new submissions.
- **`_shared/route-lead.ts` redeploy rule** — that file is bundled per-function at deploy; a change there is only live in functions actually redeployed. 17 functions import it; only the few touched this session run the new code.

## Next session
- **Folder:** `platform`
- **First task:** Owner decides priority between the reconcile panel-apply proper fix (#1) and CMS Phase 2 build-script flip (#2). CMS flip gates blog going live on-site; panel apply has a working SQL fallback, so CMS likely wins.
- **Cross-project:**
  - **Mable (switchable/site):** `form-allowlist.json` purpose text for `switchable-blog-subscribers` is now stale ("Charlotte manually imports") — wants a doc-only update (webhook_url stays null; it rides the site-wide webhook). Pushed to switchable/site handoff.
  - **Wren (switchable/email):** broadcast-gating PUSH still owed by platform (#6). EMS 117-lead broadcast remains blocked. No change this session.
