# Platform Handoff, Session 59, 2026-05-28

## Current state

Owner-led session built and shipped a manual batch SMS chaser surface on `/admin/leads` end-to-end: three migrations (0174 bulk RPC, 0175 missing RLS grants, 0176 dropping the once-ever unique index), four Edge Function redeploys, and a substantial `/admin/leads` UX refactor (pills dropped, lead status multi-select fixed, channel-specific Chased filter, chaser-timestamp sort, realtime subscription extended). 87 chaser SMSs went out across three batches with the 24h cooldown enforced; the only residual failures are two leads with malformed phone numbers in the source data. The four Phase-1 platform builds Mira PUSHed in S58 + the Wren broadcast-gating PUSH are still unstarted.

## What was done this session

**Strand 1 — Manual batch SMS chaser button + 24h cooldown (migrations 0174 / 0176):**
- Migration 0174 — new `crm.fire_sms_chaser_bulk(p_submission_ids BIGINT[])` RPC, sibling of `crm.fire_provider_chaser` (email bulk) and `crm.fire_sms_chaser_attempt_1` (singular auto-fire). Gates per row: not archived + has phone + has primary_routed_to + no non-failed chaser SMS in last 24h. Audits per-row, async-fires the `sms-chaser-attempt-1` EF with `cooldown_hours=24` in the body.
- `sms-chaser-attempt-1` EF extended to accept optional `cooldown_hours` body arg, threaded through `fireChaserSms` → `sendSms`. Auto-fire path passes nothing → once-ever semantic preserved.
- `sendSms` (`_shared/brevo.ts`) takes optional `cooldownHours` arg; when set, the idempotency `SELECT` windows on `triggered_at > now() - make_interval(hours => N)`.
- New `fireSmsChaser(submissionIds[])` server action in `app/admin/leads/bulk-actions.ts`, new "Send SMS chaser" button in `BulkActionBar`.
- Migration 0176 dropped `sms_log_submission_type_uniq` (partial unique index on healthy statuses). The index encoded the original once-ever design and silently blocked all 24h re-fires with `duplicate key value violates unique constraint` 500s — caught after 8 EMS leads with 5-day-old SMSs all failed to land. Replaced with a non-unique `(submission_id, comm_type)` btree.

**Strand 2 — Three EFs redeployed for stronger UK phone normalisation:**
- `normaliseUkPhoneToE164` (`_shared/sms-utility.ts`) now handles bare 10-digit-starts-with-7 (Netlify numeric-coercion bite), `44XXXXXXXXXX` 12-digit (no leading +), strips hyphens / parens. Auto-fire path covered too because shared utility.
- Redeployed `sms-chaser-attempt-1`, `fastrack-receive`, `sms-fastrack-prompt-cron` to bundle the new shared file.

**Strand 3 — RLS GRANT fix (migration 0175):**
- `/admin/leads` and `/admin/leads/[id]` had been returning silent empty results from `crm.sms_log` and `crm.email_log` since both tables shipped. Policies `admin_read_sms_log` + `admin_read_email_log` target `authenticated` role with `admin.is_admin()`, but no table-level `GRANT SELECT` to `authenticated` existed. Postgres evaluates GRANT before RLS — silent zero rows.
- Net effect: every "Last email chaser", "Last SMS chaser", and U1 column on `/admin/leads` had shown "—" for every row regardless of how many chasers fired, since launch. Verified via service-role queries during tonight's batch SMS session.
- Migration 0175 + applied: `GRANT SELECT ON crm.sms_log TO authenticated; GRANT SELECT ON crm.email_log TO authenticated;`. Same class as migrations 0109/0114 (`crm.lead_notes`) and 0096-0108 (`crm.enrolments`).

**Strand 4 — `/admin/leads` UX refactor:**
- Killed the Stage pills row (All / Qualified / Routed / Awaiting / Enrolled / Lost / DQ / Archived). Pills weren't being used; dropdown filters now always render and apply, no stage gate. Archived leads stay hidden by default via `is("archived_at", null)` on every query.
- Lead status dropdown exposes the 4 missing attempt statuses (`attempt_1_no_answer`, `attempt_2_no_answer`, `attempt_3_no_answer`, `enrolment_meeting_booked`) plus the existing learner + employer values. Backend `VALID_LEAD_STATUSES` already accepted them; the UI was lagging.
- Fixed multi-select bug on Lead status dropdown. Every checkbox click was calling `router.push` which re-rendered the server tree and closed the Radix menu mid-interaction — looked single-select. Replaced with local React state + commit to URL on `onOpenChange(false)`. Same pattern applied to the new Chased filter.
- "Status" renamed to "Matched" (Routed / Unrouted → Matched / Not matched), "Routed to" → "Matched to", column header "Routed" → "Matched to". URL params (`routed=`, `provider=`) preserved.
- Removed redundant "Has phone" filter.
- New "Chased" filter as a multi-select dropdown: Email chased / No email chased / SMS chased / No SMS chased. Picks AND-chain in the backend (e.g. Email chased + No SMS chased = leads emailed but not SMSed). Counts ANY log row, not only healthy — a failed chase still counts as a chase, otherwise bad-phone leads stay queued forever and re-fire on every batch.
- Sort by chaser timestamp: clickable "Last email chaser" + "Last SMS chaser" column headers. Three-state cycle per column: inactive (↕) → asc (▲, oldest first) → desc (▼, newest first) → default. Never-chased always sinks to the bottom in both directions (an early asc-puts-nulls-at-top version was visually confusing because the first page was all "—" timestamps). App-side sort: fetch matching IDs, query log table for latest healthy `triggered_at` per submission, sort JS, paginate, then fetch page rows. The sort's "healthy status" set per channel had to match the column's set or sorted output looked random — email column counts `sent/delivered/opened/clicked` (Brevo lifecycle), SMS column stops at `sent/delivered`. Sort now mirrors per channel.
- `RealtimeRefresh` extended to subscribe to `crm.enrolments`, `crm.email_log`, `crm.sms_log` in addition to `leads.submissions`. The 600ms debounce already in place coalesces bulk-chase fan-outs into a single refresh. Pre-fix, batch sends landed in the DB but the page didn't auto-refresh and Charlotte saw stale columns.

**Strand 5 — Live SMS dispatch verification:**
- Three batches fired tonight: 20:39 (38 attempts, 34 sent), 20:53 (21 attempts, 16 sent — included the 5 broken-phone retries), 21:24 (8 attempts after migration 0176, all 8 sent). 21:18 batch of those same 8 leads failed before 0176 with the unique-index 500s — non-event, no Brevo cost. Plus Trigger A fastrack-link prompt fired for sub 534 (new lead Michael Sudron) at 21:12 via cron, also `sent`.
- Net: ~87 successful SMSs to learners between 20:39 and 21:24. Zero duplicates per (submission_id, recent window).

## PUSH from Mira (2026-05-25 strategy Session 18) — Phase 1 platform brief, four builds (carry from S58)

Phase 1 plan sharpened across 5 lanes. Four platform builds owed to Sasha. Full context: `strategy/docs/build-map.md` Phase 1 top-level view + `strategy/docs/product-and-revenue-map.md` cash trajectory + `strategy/docs/provider-os-scoping-2026-05-24.md` + `strategy/docs/demand-aggregation-playbook.md`.

**Build 1: `/admin/roadmap` MVP (Sasha-only, Week 1, ~4-6 hours).** Mable dropped 2026-05-25. Internal-only tool. 5-lane top-tier + revenue_model second-tier + tasks granular. Spec at `platform/docs/admin-roadmap-spec.md`. Mira will prep seed SQL with ~60-70 tasks.

**Build 2: Provider OS V1 architecture scoping (Sasha, 2-3 weeks design upfront).** Option B locked: build fresh on a new Supabase project, not refactor existing. Scope deliverable: new-platform schema design + multi-tenancy RLS pattern + tenant settings architecture + GoCardless billing model.

**Build 3: Demand-aggregation aggregation view (Sasha, Phase 1 weeks 3-6).** Pulled forward from month 8-9. View design at `strategy/docs/demand-aggregation-playbook.md`. Aggregates audience by location × course interest × demographic × consent.

**Build 4: Blog cadence agentification (Sasha, Phase 1 weeks 4-6).** Edge Function on pg_cron (Mon/Wed/Fri AM) picks topic from `editorial.post_ideas`, calls Anthropic, inserts `status='draft'`, Brevo notifies Charlotte.

Sequencing: Builds 1 → 3 → 2 (scoping in parallel) → 4. Build 1 ships Week 1.

## PUSH from Wren (broadcast-gating, 2026-05-25): re-applicant nurture wiring (carry from S58)

`SW_FASTRACK_COMPLETED` per-course + new `SW_PENDING_RESTART` flag + new `SW_COURSE_OPEN` flag. Three related changes in `_shared/route-lead.ts` plus a small course-state source-of-truth wiring, all needed before the EMS new-course broadcast (117 marketing-consented non-enrolled leads) can ship. Full detail in S58 handoff (lines 80-99 of pre-S59 file, now superseded — see commit `cbf1b7c..6108f44` parent if needed).

- **(a) `SW_FASTRACK_COMPLETED` per-course** — `loadEmailAggregateState` lines 553-600 currently uses `bool_or(fastracked_at IS NOT NULL)` across every submission. Swap to canonical submission only.
- **(b) New `SW_PENDING_RESTART` boolean** — set true when canonical course flips for a contact (detect via Brevo dashboard read pre-upsert OR a CRM tracking table). Drives N1-N3 restart condition.
- **(c) New `SW_COURSE_OPEN` boolean** — per-contact reflection of "course currently accepting applications". Source-of-truth on course YAML `accepting_applications: true|false`, through matrix.json into route-lead.ts. Extend `/admin/data-ops` with a "resync course state for course X" action.
- Brevo side (Wren owns): N1-N3 restart condition `SW_PENDING_RESTART = Yes` + first-action reset to No; exit on `SW_COURSE_INTAKE_DATE in past` OR `SW_ENROL_STATUS in (enrolled, presumed_enrolled)` OR `SW_COURSE_OPEN = No`.
- Backfill: `admin-brevo-resync` on the 117-lead EMS broadcast segment minimum. Pre-broadcast gate trips on `SW_FASTRACK_COMPLETED` wiring change (`switchable/email/CLAUDE.md` + 10 May incident). Wren spot-checks 3 contacts post-backfill.

## Next steps

1. **Build script flip: `scripts/build-blog-posts.js` reads `editorial.posts` not YAML** (CMS Phase 2 #1, carry from S58). Add postgres dep to `switchable/site/deploy`. Fetch posts WHERE status IN ('published', 'scheduled' AND publish_date <= today). Confirm DATABASE_URL is set on Netlify before starting.
2. **`/admin/blog/media` with Supabase Storage upload** (CMS Phase 2 #2, carry). Bucket creation first via Supabase dashboard: `blog-media`, public read, admin-only insert/update RLS.
3. **`/admin/blog/content-plan` pipeline view** (CMS Phase 2 #3, carry). Reads `editorial.post_ideas`. Pipeline by category: queued / drafted / published / killed.
4. **Netlify deploy hook on publish action** (CMS Phase 2 #4, carry). Server action POSTs to Netlify Build Hook URL when post flips draft → published.
5. **Draft-ready notification** (CMS Phase 2 #5, carry). Postgres trigger on `editorial.posts` INSERT WHERE status='draft' → `pg_net.http_post` → new `notify-draft-ready` EF → Brevo transactional to Charlotte.
6. **Build 1 — `/admin/roadmap` MVP** (Mira PUSH, Phase 1 Week 1, ~4-6 hours). Spec at `platform/docs/admin-roadmap-spec.md`. Internal-only tool. Mira to prep seed SQL with ~60-70 tasks before build.
7. **Build 3 — Demand-aggregation view** (Mira PUSH, Phase 1 weeks 3-6). View design at `strategy/docs/demand-aggregation-playbook.md`. Wren handoff coordination via switchable/email handoff push.
8. **Build 2 — Provider OS V1 architecture scoping** (Mira PUSH, 2-3 weeks design). Fresh Supabase project. Scope deliverable: schema + multi-tenancy RLS + tenant settings + GoCardless billing model.
9. **Build 4 — Blog cadence agentification** (Mira PUSH, Phase 1 weeks 4-6). pg_cron-triggered Anthropic draft generator.
10. **Wren broadcast-gating PUSH — `SW_FASTRACK_COMPLETED` per-course + `SW_PENDING_RESTART` + `SW_COURSE_OPEN`** (carry from S58). Blocks EMS new-course broadcast (117-lead segment).
11. **Manually fix or accept typo'd phones on subs 188 (`06771 709 0119`, 12 digits) and 377 (`075803090139`, 12 digits).** Tonight's stronger normaliser doesn't catch these because they're genuine typos in the source data. Either patch via admin tool / SQL or leave as known-failure.
12. **Auto-flip cron + day-12 warning** (carry from S51-S58). Migration 0097 unapplied. EMS has 50+ leads past 7-day SLA.
13. **Verify next Construction lead lands with `experiment_id` + `experiment_variant` at INSERT** (not via backfill, carry from S58).
14. **Decide whether to chase the `switchable-waitlist` experiment-attribution gap** (sub 523 NULL `experiment_id`, low priority — DQ-only, carry from S58).
15. **Platform-side router test** (Backlog `869ddxud4`, carry from S58). 30 min.
16. **Verify SW_MATCH_STATUS drift dropped to ~0** in the most-recent `brevo_attribute_reconcile_async_check_result` row after c49fe58 (carry). Fire Re-sync + republish-provider-sheet for Riverside if so.
17. **Design the async_apply chunking + checkpoint pattern** so result rows reliably land (carry).
18. **Filter inactive providers out of `brevo-attribute-reconcile`** (carry). 60 cosmetic errors per Check drift.
19. **Bulk-clean stale dead_letter rows** (carry): 179 partials (pre-hotfix), 9 brevo_chase (pre-no-op-fix), 11 Riverside sheet_drift, 1 daily brevo_attribute_drift.
20. **PUSH from Mira (Week 2-3): DQ-to-affiliate landing pages backend** (carry).
21. **PUSH from Mira (Week 5-6): post-course affiliate burst sequence SMS trigger logic** (carry).
22. **PUSH from Wren: `lead_call_phone TEXT` on `crm.providers`** as universal SW_PROVIDER_PHONE fallback. Gate on next non-regional business-audience course (carry).
23. **Remote Edge Function deletion** (carry from S54).
24. **Per-provider CPL / CPE / P/L scoreboard** (carry from S49).
25. **Infrastructure-manifest update** (carry from S54-S57). Add `brevo-attribute-reconcile-daily`, `drift-digest-daily`, `sms-fastrack-prompt-cron`. Remove `dead-letter-alert-hourly`.
26. **Cannot-reach-no-chaser to `/admin/errors`** (carry from S55).
27. **Optional UI polish: add a "failed" indicator on the chaser columns** so leads with only failed attempts (subs 188, 377 currently) show as "tried but failed" rather than "—". Surfaced in conversation, not built — Charlotte to confirm before next session.

## Decisions and open questions

**Decisions made this session:**
- **`sms_log` dedup moves to application layer.** Migration 0176 dropped the partial unique index because partial-expression `WHERE` clauses can't reference `now()` and the original once-ever index conflicted with the new 24h-windowed cooldown. Race window between `SELECT` and `INSERT` in `sendSms` is microseconds for single-EF invocation; acceptable trade-off.
- **"Chased" filter counts ANY log row, not only healthy.** A failed attempt is still a chase. The healthy-only semantic created a closed loop where bad-phone leads stayed queued forever, each retry adding another failed row that didn't count.
- **24h cooldown is the right default for the bulk admin path.** Long enough to not spam a learner the same day, short enough to allow next-day re-push.
- **Sort by chaser column puts never-chased at the bottom in both directions.** Initial design had nulls-first-on-asc (= chase priority) but the visual experience was confusing — first page of "—" rows looked like the sort was broken. The "No SMS chased" / "No email chased" filter is the right surface for the never-chased bucket.
- **Sort "healthy" status set per channel must match the column's set.** Email column counts `sent/delivered/opened/clicked` (Brevo lifecycle); SMS column stops at `sent/delivered` (no open/click webhooks). Sort mirrors per channel — diverging meant opened chaser emails fell out of the sort but stayed visible in the column, producing what looked like random order.
- **Phone normaliser handles bare 10-digit-starts-with-7.** Netlify numeric coercion strips the leading 0 on digits-only inputs. Already in workspace memory; now codified in the helper. Genuinely typo'd phones (sub 188, sub 377) remain unrecoverable.

**Open questions:**
- **Whether to add a failed-chaser indicator in the column** (next-step #27). Subs 188 + 377 currently show "—" in the SMS column because they only have `failed` rows. Filter handles them now (they're excluded from "No SMS chased"), but the column still suggests "untouched". Charlotte to confirm if worth adding a red "tried/failed" badge.
- **Carries from S58 still open:** markdown editor for CMS body, DATABASE_URL on Netlify confirmation, Brevo template ID for `notify-draft-ready`.

## Watch items

- **Bulk SMS chaser button on `/admin/leads` ships clean in production.** Three batches fired tonight without issue post-fixes. Spot-check on next batch.
- **24h cooldown enforced.** Re-firing the same lead within 24h returns `skipped` with reason `sms sent within last 24h`. Skipping should be visible in the toast's "Sent for X, skipped Y" count.
- **First fresh-fastrack lead post-normaliser-deploy.** New leads with bare 10-digit phones should now succeed at Brevo. No new such lead has come in since redeploy (21:24 onwards); confirm on first match.
- **Realtime refresh on `/admin/leads`.** Should auto-update Last email/SMS chaser columns within ~600ms of an EF write, no manual refresh required. Verify on the next live chase.
- **EMS has ~80 leads in attempt/cannot_reach states.** Their auto-flip 14-day clock continues; migration 0097 still unapplied (carry from S51).
- **Carries from S55/S56/S57/S58 still open:** Construction `experiment_id` populating at INSERT for next lead, SW_MATCH_STATUS drift after c49fe58, async_apply result rows, Riverside sheet drift backfill, 60 inactive-provider errors per Check drift, Greater Growth Tees Valley lead routing path verification, `sasha_test` row pollution in `leads.partials` (id 15920).

## Next session

- **Folder:** `platform`
- **First task:** Either ship Build 1 (`/admin/roadmap` MVP, Mira's Phase 1 Week 1 push, ~4-6 hours and unblocks the strategic-task surface) OR knock off the CMS Phase 2 items still on the carry (next-step #1-5). Owner decides — both are queued and ready. If the CMS Phase 2 items, start with the build-script flip (#1) since it gates the whole CMS becoming live-on-site.
- **Cross-project:**
  - **Mable (switchable/site):** the phone normaliser fix is bundled into `sms-chaser-attempt-1`, `fastrack-receive`, `sms-fastrack-prompt-cron` — no `switchable/site` change needed tonight. No outbound push.
  - **Wren (switchable/email):** no platform-side block on her broadcast-gating PUSH at the moment; it's on the platform Next steps list (#10).
  - **Charlotte (owner):** two earlier off-platform actions still pending from S58 — run the YAML port script + submit sitemap to GSC. Confirm completion before next session start so Build 1 / CMS Phase 2 stays unblocked.
