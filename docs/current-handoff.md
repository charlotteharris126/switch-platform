# Platform: Current Handoff: 2026-04-28 (Session 15 closed): full-day pass on data discipline + business-health overview + analytics + roadmap refresh

**Session type:** Continuation of Session 14, picked up Tuesday morning. Owner direction: single source of truth + tidy DB before further build, then business-health overview, then analytics, then roadmap refresh.

**Session opened:** 2026-04-28 morning (continuation of Session 14)
**Session closed:** 2026-04-28 evening

---

## What we worked on

### 1. DB tidy (data-ops 011, applied)

Owner approved cleanup of three anomaly classes the morning audit surfaced:

- 2 archived test routing-log rows (sid 29 charliemarieharris, sid 30 test7@testing.com): pre-22-Apr legacy from before `applyOwnerTestOverrides` shipped. Deleted.
- 1 orphaned routing-log row (sid 184 Anita's DQ correction). Deleted (precedent set; DQ-corrected leads exit routing_log entirely).
- 9 unresolved dead_letter rows: 3 historical sheet-append failures (1 archived test, 2 owner-handled-manually), plus 6 reconcile_backfill audit logs. All marked resolved with explanatory notes.

Post-state: `leads.routing_log` 94 rows (was 97), `leads.dead_letter` 0 unresolved (was 9). Reconciliation closes cleanly: 94 sends = 89 unique people + 5 same-email duplicates (3 linked re-applications + 2 Jade Millward rapid-fire).

Anomaly 3 from the morning audit (Luana #159 "archived submission with open enrolment") was a false alarm: my UNION query mislabeled `e.status_updated_at` as `archived_at`. Luana is a normal routed-to-EMS lead. No action needed.

### 2. Overview rebuilt as business-health (commit `5b0c5b3` then `d6a8fc7`)

Per owner direction "dashboard overview needs to be business health, reconciliation needs to exist in errors". Four sections:

1. **Pace** (period-aware): Leads in / Sent to providers / Enrolments confirmed / Meta ad spend. Each shows delta vs prior period.
2. **Conversion** (lifetime): Confirmed conversion (7.9%) and Potential conversion incl. presumed (11.2%). Period-aware conversion is misleading because of enrolment lag, so this stays lifetime.
3. **Money** (lifetime): Revenue confirmed (no dispute risk) / Revenue potential (incl. presumed) / Cost per lead / First billable date countdown. Italic footnote makes the free-3-per-provider deal explicit.
4. **Provider scoreboard**: per-provider table with Routed / Enrolled / Conversion / Free left / Billable / Revenue.
5. **Needs your attention**: Unrouted / Presumed / Disputed / Errors.

Period selector pills at top: Last 2 days / Last 7 days (default) / Last 30 days / Lifetime. Drives Pace + Meta ad spend.

### 3. Lifecycle pills on `/admin/leads` (commit `5b0c5b3`)

Replaced the lifecycle period selector that used to live on the overview. Pills: All / Qualified / Routed / Awaiting outcome / Enrolled / Lost / DQ / Archived. Each is a self-contained filter that translates into the underlying submissions/enrolments query. Awaiting/Enrolled/Lost pre-fetch terminal-status submission IDs from `crm.enrolments` and pipe through `.in("id", ...)`.

### 4. Errors page reframed as Data health (commit `5b0c5b3`)

Renamed page, restructured into two clear sections:

- **DB reconciliation** (always visible, top): plain-English headline, "Match" / "Drift, investigate" badge, explanatory paragraph naming the breakdown in plain words. Today reads: "94 sends = 89 unique people + 5 known duplicates."
- **Errors** (below): when 0 unresolved (current state), shows "No errors. Every webhook, sheet append, and ingestion ran cleanly." When >0, the existing per-source plain-English breakdown.

### 5. Manual ad-spend paste form at `/admin/ads` (commit `e8303a7`)

Interim before Meta API ingestion. Owner blocked on Meta developer portal device-trust check (account-flagged, mobile + laptop both bounced). Form takes date + spend + leads (impressions/clicks optional), upserts into `ads_switchable.meta_daily` with `ad_account_id='manual_paste'`. Manual rows distinguishable from API rows once API lands. Page shows 30-day blended tiles, paste form, audit table. Sidebar gains "Ad spend" under Tools.

### 6. `/admin/analytics` page (commits `e50ee7b`, `c082ad1`, `66504cc`)

Big build. Single scrollable page with 7 sections + a Notable strip at top:

- **Notable strip**: deterministic flags worth acting on. Rules: DQ leakage (any reason >=25% of DQs with sample >=5), demand without supply (course with >=3 leads, 0 providers), top source with qualified %, lifetime conversion green/red.
- **Section 1**: Lead source quality (UTM source x medium x campaign with leads / qualified / routed / enrolled / conv %).
- **Section 2**: Demographics (age band, employment, course interest, qualification goal, prior L3+) deduped by email.
- **Section 3**: Funnel drop-off (per-step bars from `leads.partials` with completed/abandoned split, plain-English step labels).
- **Section 4**: Course demand vs supply (course_id with leads, routed %, enrolled, provider count; flags "Demand without supply" rows).
- **Section 5**: DQ pattern analysis (deduped by email).
- **Section 6**: Geographic distribution (LA for funded, postcode outward code for self-funded).
- **Section 7**: Time patterns (DOW + hour of day).

Period pills drive everything. Single big SELECT against submissions, single SELECT against partials, all bucketing in TypeScript. No Recharts/Tremor dependency.

Dedup rule applied (commit `c082ad1`): demographics, DQ patterns, geographic count distinct people; sources, funnel, time keep event-grain. Page header subtitle calls out the rule explicitly.

### 7. Roadmap refresh (commit `c62ddcf`)

`platform/docs/platform-vision-2026.md` was 3 days stale. Refreshed:

- Added "Shipped since 2026-04-25" table (14 entries covering Sessions 10-14).
- Added "Core principles (locked 2026-04-28)" section with 11 rules. Treat as constraints when scoping any new feature.
- Rebuilt the build queue: items 1-3 marked shipped; Meta ad spend ingestion promoted to **#1** (unlocks half the dashboard's value); weekly report email added as new #7; Session G.5 dropped to #21.

This is now the canonical roadmap document. Next session should refresh it again from the bottom of the build queue.

### 8. Marty disregard email sent

Owner sent the disregard email today. ClickUp ticket 869d2vpcj closed.

### 9. Post 2 verified published

Autonomous publish ran at 2026-04-28 09:00 BST, 4-second lag, status `published`, URN `urn:li:share:7454801595067686912`. Session G publish path proven for the second time.

---

## Current state

The platform now reads cleanly end to end:

- Overview is pure business-health. Pace tiles + Money tiles + provider scoreboard + attention surfaces. Period selector. Confirmed vs potential everywhere.
- `/admin/leads` has lifecycle pills. `/admin/providers` shows per-provider scoreboard with revenue.
- `/admin/analytics` answers seven distinct business questions with a Notable callout strip on top.
- `/admin/ads` lets the owner paste daily Meta totals manually until API ingestion unblocks.
- `/admin/errors` (Data health) keeps reconciliation as a permanent always-visible card. 0 unresolved errors today.
- Database tidy. 94 routing-log rows reconcile cleanly with 89 unique people. No orphan rows. No unresolved dead_letter.

11 commits today on the platform repo (b13b6cb through c62ddcf actually 12 if I count yesterday's late ones).

---

## Next steps

In priority order:

1. **Meta ad spend ingestion** (build queue #1). Owner's FB developer portal account-trust is flagging "use this device for a while" on both laptop and phone. Could clear in 24-72h. The moment it does: System User created (`switchable-readonly` ID 61589037205840), needs `ads_read` on the two ad account IDs assigned + a Meta app linked. Then I build `meta-spend-sync` Edge Function + cron + Vault entry + settings UI. ~half day to 1 day. Manual paste form at `/admin/ads` is the interim.
2. **Bulk operations** (#2). Multi-select on `/admin/leads`. Archive / mark / route in batches.
3. **Anomaly detection / Sasha extension** (#3). Daily pattern-watch on top of Sasha's Monday checks. Now that the analytics page exists the rules to watch are concrete and writeable.
4. **Weekly report email** (new, #7 in queue). Edge Function emails the owner Monday at 06:00 UK with analytics highlights + Notable callouts + week-over-week deltas.
5. **Mira's top priority for the week is in `switchleads/outreach/` (Rosa pipeline reset)**, not platform. We have not touched it today. Worth flagging next session opening: stay platform or pivot to Rosa.

Open carry-forwards from earlier sessions:
- 3 platform secrets overdue rotation (BREVO_API_KEY, SHEETS_APPEND_TOKEN, ROUTING_CONFIRM_SHARED_SECRET). Ticket 869d0a9q7.
- Quarterly backup restore test (data-infra rule). Not done this quarter.
- `/ultrareview` unavailable in owner's CLI build. Ticket 869d2cp0m.

---

## Decisions / open questions

- **Decision (this session):** the 11 core principles in `platform/docs/platform-vision-2026.md`. Most consequential: "one email = one person", "reconciliation lives on Data health, not overview", "tidy DB before features", "manual fallback before automation".
- **Decision (this session):** the routing log is append-only audit history with a documented exception for archived test rows + fully-corrected misroutes via dedicated `data-ops/` scripts. Precedent: data-ops 011.
- **Decision (this session):** period-aware conversion is misleading. Conversion + revenue + provider state stay lifetime. Pace + ad spend respect the period selector.
- **Decision (this session):** the platform-vision doc is the canonical roadmap going forward. Refresh from the bottom of the build queue when items ship.
- **Open:** owner's FB developer portal account-trust block. No action required, just wait.
- **Open:** whether to ship the weekly report email before or after Meta ingestion. Currently sequenced as #7 (after attribution wiring) but could pull forward to #2 (independent of Meta data).

---

## Next session

- **Currently in:** `platform/`.
- **Next recommended:** if FB has unblocked, jump on Meta ad spend ingestion (build queue #1) since it's the single highest-leverage outstanding task. If FB still blocked, bulk operations (#2) or weekly report email (#7) are next-best platform items. If owner wants to switch folders, Rosa pipeline reset in `switchleads/outreach/` is Mira's top weekly priority and hasn't been touched.
- **First task tomorrow:** ask the owner whether Meta dev portal has unblocked. If yes, walk through System User + app assignment + token generation. If no, pick the next platform item from the queue.
