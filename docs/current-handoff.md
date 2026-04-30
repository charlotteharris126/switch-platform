# Platform: Current Handoff: 2026-04-30 — doc-mirror appends from switchable/site Session 47 (multi-cohort revert + sheet decluttering)

## Doc-mirror append (2026-04-30, from switchable/site Session 47)

Site reverted the multi-cohort start_date picker from multi-pick (Continue button) to single-pick auto-advance same session it shipped. CRO trade-off call: extra click was likely a small drop-off cost we couldn't measure without analytics. `acceptable_intake_ids` continues to mirror `preferred_intake_id` under single-pick — schema 1.2 stays intact, future multi-pick re-introduction is cheap. See site commit `8906d3a`.

Two platform-side commits resulted:
- **`ae9234b`** ([changelog](changelog.md), [provider-onboarding-playbook.md:40](provider-onboarding-playbook.md#L40)) — playbook now lists Preferred intake as optional for multi-cohort funded providers and explicitly flags Acceptable intakes as dormant. Owner deleted the Acceptable intakes column from the EMS provider sheet (header-driven appender = no script redeploy needed).
- **`8287b86`** ([infrastructure-manifest.md:127-128](infrastructure-manifest.md#L127-L128)) — refreshed Courses Direct + WYK Digital rows. DB confirmed both have sheet_id, webhook_url, auto_route_enabled=true, and first_lead_received_at on 2026-04-21 — manifest had been showing them as "pending sheet creation" since session 5.

FIELD_MAP entry for `acceptableintakes` retained in canonical `provider-sheet-appender-v2.gs` as a no-op for future revival. No DB or Edge Function changes from this session.

---

# Platform: Current Handoff: 2026-04-29 (Session 19 closed, late-evening doc-mirror append from switchable/site Session 45): Brevo enrichment fix end-to-end + admin-brevo-resync tool + no-match build spec

## Late-evening doc-mirror append (2026-04-29, from switchable/site Session 45)

The funding-category branching + 3-state `SW_MATCH_STATUS` + `SW_DQ_REASON` design (locked in this evening, full build spec at `platform/docs/no-match-brevo-build.md`, tracking ticket [869d3p127](https://app.clickup.com/t/869d3p127)) is now mirrored as an architectural record in **`platform/docs/data-architecture.md`** under a new section "Brevo learner upsert: funding-category branching and 3-state match" inserted after the provider trust content section.

The data-architecture entry covers: design principle (self-funded nurture is sector-led, not course-led), branching table (`gov`/`loan` = matrix.json lookup; `self` = skip, `SW_SECTOR` from `submission.interest`), 3-state behaviour, `SW_DQ_REASON` 15th attribute, four forms covered, and an impact assessment noting no DB changes are required (this is Edge Function behaviour governed by the existing `leads.submissions` contract).

No code changes from this append, just the design-doc update. Tomorrow's first-job build per ticket 869d3p127 is unaffected.

---

**Session type:** Bug-fix + tooling + scoping. Triggered by switchable/email's synthetic test 1 surfacing 7 defects in the Brevo learner upsert flow. Closed with the matched-lead path fully operational, a permanent operational tool for backfilling stale Brevo contacts, and a complete spec ready for tomorrow's first session.

**Session opened:** 2026-04-29 evening
**Session closed:** 2026-04-29 evening

---

## What we worked on

### 1. Brevo enrichment fix — matrix lookup + atomic list adds (commit eeff403)

Root cause for 6 of 7 defects: `getCourseFromMatrix` indexed matrix.json route entries by `entry.courseId`, but matrix.json keys routes by `slug`. Lookup silently failed for every routed lead since the helper landed in Session 16. Six attribute-mapping bugs (`SW_COURSE_NAME`, `SW_COURSE_SLUG`, `SW_COURSE_INTAKE_ID`, `SW_COURSE_INTAKE_DATE`, `SW_REGION_NAME`, `SW_SECTOR`) all fell through to page-slug fallbacks or empty.

Renamed helper to `getMatrixContext`, indexed by `slug`, expanded return shape (course-only slug, course title, region name, intake id + formatted date, both interest tags). Intake resolution: prefer `submission.preferred_intake_id` matched against `route.intakes[]`, fall back to first intake, then legacy `nextIntake`.

Brevo attribute composition rewritten. New attributes: `SW_COURSE_INTAKE_ID`, `SW_COURSE_INTAKE_DATE` (replaced `SW_COURSE_START_DATE`), `SW_SECTOR`. `SW_SECTOR` resolves to `ffInterest` for funded leads (`funding_category=gov`), `cfInterest` otherwise.

Seventh defect (independent root cause): marketing list-add raced against Brevo's backend on a separate `addBrevoContactToList` call, surfacing a misleading 400 "Contact already in list and/or does not exist". Collapsed into a single `upsertBrevoContact({listIds: [util, marketing]})` call. Atomic, no race.

Site change in sibling repo: `switchable/site/deploy/scripts/build-funded-pages.js` adds `courseId` (course-only YAML id) to every matrix.json route entry. Purely additive — simulator and live pages key by `slug` and are unaffected.

### 2. ISO date format follow-up (commit 4275bbf)

Synthetic test 2 (lead 207, post-deploy) confirmed 6 of 7 fixes landed clean. `SW_COURSE_INTAKE_DATE` was still empty. Brevo's Date attribute type silently nulls anything that isn't ISO 8601 YYYY-MM-DD, and the helper was pushing `intake.dateFormatted` ("2 June 2026"). `readRoute` now reads `intake.date` (ISO) and falls back to `route.nextIntake` instead of `nextIntakeFormatted`.

### 3. admin-brevo-resync Edge Function (commit a4e5c1c)

New POST endpoint at `/functions/v1/admin-brevo-resync` that re-fires `upsertLearnerInBrevo` for an arbitrary list of already-routed submission ids without touching routing state. Auth via `x-audit-key`. Skips DQ / archived / never-routed leads. Returns per-id status + skip reasons. `verify_jwt = false` in `config.toml`. Registered in `infrastructure-manifest.md`.

`upsertLearnerInBrevo` exported from `_shared/route-lead.ts` so the resync function reuses canonical attribute composition.

Permanent operational tool, not a one-off. Future use: provider trust line edits, sector taxonomy changes, future schema additions — any time existing contacts hold stale attributes.

### 4. Lead 206 (Hilda Gething) backfill — verified

Real production lead routed to EMS before today's enrichment fix. Contact held stale attributes from pre-fix helper output. Resync fired via Supabase SQL Editor + `pg_net` (audit secret stayed in DB, not in chat). Result: `{"id":206,"status":"ok"}`. Contact now holds the corrected 13-attribute set including ISO intake date.

### 5. Admin dashboard scoping — archive/unarchive lead action (commit 99a1ceb)

Added a "Post-MVP small enhancements" section to `platform/docs/admin-dashboard-scoping.md` with a single entry: archive/unarchive button on `/admin/leads/[id]`. Spec sketched (RPC pattern matching `crm.update_provider_trust`, audit type names `archive_lead` / `unarchive_lead` already in `app/lib/audit.ts`, confirm dialog on archive, "Archived YYYY-MM-DD" badge). Surfaced from this session's test cycle — owner forced into raw SQL with column-by-column risk every time. No ClickUp ticket per owner.

### 6. No-match Brevo build spec (commit f16dc16, c4f7e0f, then revised same evening)

Owner-locked scope went through a revision the same evening. Final shape:

- 3-state `SW_MATCH_STATUS` (matched / pending / no_match)
- Top-level branch on `funding_category` inside both Brevo upsert helpers
- Self-funded skips matrix.json entirely; `SW_SECTOR` pulls from `submission.interest`. `SW_COURSE_NAME` / `SW_COURSE_INTAKE_ID` / `SW_COURSE_INTAKE_DATE` / `SW_REGION_NAME` stay blank for self-funded
- New `SW_DQ_REASON` attribute pushed when `is_dq=true`, raw value from `submission.dq_reason`. Already configured in Brevo as 15th attribute
- N1-N7 nurture spine is funded-only (Brevo automation entry filter: `SW_MATCH_STATUS=matched AND SW_FUNDING_CATEGORY in (gov, loan)`)
- Self-funded routed leads get U-track utility only; sector-led self-funded nurture sequence is its own future workstream
- All four switchable forms covered (`switchable-funded`, `switchable-self-funded`, `switchable-waitlist`, `switchable-waitlist-enrichment`)
- Enrichment overwrite confirmed (same email, second submission overwrites with richer data, status stays `no_match`)

Earlier "option (b)" matrix-by-courseId secondary index DROPPED. Site session has no work. Edge Function only.

Full revised spec in `platform/docs/no-match-brevo-build.md`. ~2-hour single-session build. **First job tomorrow per owner.**

---

## Current state

Switchable email matched-lead path is fully operational and verified end-to-end. All 13 attributes correct, both lists wired atomically, ISO date format respected. Tonight's U1+SF2 Brevo automation launch on the email side runs on this; nothing more from platform tonight to support that. No-match build (3-state, ~2 hours) is queued as the first job tomorrow with a complete spec.

`admin-brevo-resync` exists as a permanent operational tool for any future stale-attribute scenario.

---

## Next steps

In priority order:

1. **No-match Brevo upsert (3-state build) in `netlify-lead-router`. FIRST JOB TOMORROW per owner 2026-04-29 evening.** Scope revised same evening — site work dropped. Final shape: 3-state `SW_MATCH_STATUS` (matched / pending / no_match), top-level branch on `funding_category` inside the upsert helpers (self-funded skips matrix entirely; `SW_SECTOR` from `submission.interest`), new `SW_DQ_REASON` attribute pushed when `is_dq=true`, N1-N7 nurture spine funded-only (Brevo entry filter `SW_MATCH_STATUS=matched AND SW_FUNDING_CATEGORY in (gov, loan)`). Full revised spec in [`platform/docs/no-match-brevo-build.md`](no-match-brevo-build.md). ~2-hour single-session build, **Edge Function only, no site work**.
2. **Build archive/unarchive lead action on `/admin/leads/[id]`.** Real defect: `archived_at` column exists, leads-list filter has "Archived" tab, `app/lib/audit.ts` already names `archive_lead` / `unarchive_lead` action types, but no Server Action and no UI button. Owner forced into raw SQL every time. No ClickUp ticket per owner.
3. **`leads.routing_log.confirmed_intake_id` + UI surface** (carried from Session 16). Owner override of learner's preferred cohort at confirm time.
4. **`crm.enrolments.intake_id` + reporting** (carried from Session 16). Per-cohort enrolment tracking. Slot in once cohort routing has been live 2-4 weeks.
5. **Three platform secrets overdue rotation** (`BREVO_API_KEY`, `SHEETS_APPEND_TOKEN`, `ROUTING_CONFIRM_SHARED_SECRET`). Ticket `869d0a9q7`. Carrying since 22 Apr.
6. **Quarterly backup restore test** (data-infrastructure rule). Not done this quarter.
7. **Continue platform queue:** Meta ad spend ingestion (#1, blocked on FB device-trust), bulk operations on /admin/leads (#2), anomaly detection / Sasha extension (#3).

Carry-forward unchanged from Session 18:
- 2 unresolved sheet-append rows from 23 April (id 89, 90) at the 7-day flag line — owner triage still pending.
- Mira's THE priority for the week is Rosa pipeline reset in `switchleads/outreach/` — not platform — and was not actioned today.

---

## Decisions / open questions

### Decisions made this session

- **3-state `SW_MATCH_STATUS`** locked: matched / pending / no_match. Multi-candidate leads enter Brevo at submission time as `pending`; owner confirm flips to `matched`.
- **Self-funded path: branch on `funding_category` at upsert helper top.** Self-funded skips matrix entirely; `SW_SECTOR` from `submission.interest`; course/region/intake stay blank. Earlier "option (b)" matrix-by-courseId secondary index OFF.
- **`SW_DQ_REASON` (15th attribute)** added — pushed when `is_dq=true`, raw value from `submission.dq_reason`. Already configured in Brevo.
- **N1-N7 nurture spine is funded-only.** Brevo automation entry filter: `SW_MATCH_STATUS=matched AND SW_FUNDING_CATEGORY in (gov, loan)`. Self-funded routed leads get U-track utility only; sector-led self-funded nurture is a future workstream.
- **Enrichment overwrite confirmed.** Same email already in Brevo from initial waitlist submission; enrichment upsert overwrites with richer data, `SW_MATCH_STATUS` stays `no_match`.
- **No per-state nurture differentiation in platform code** in v1. Brevo automation entry filters handle the routing. Conditional content blocks for v2.
- **`SW_AGE_BAND` deferred to v2.** Form age-question redesign needed first.
- **Brevo email metrics ingestion deferred.** Phase 2-3 trigger when Metabase dashboard count > 5 or owner asks for in-dashboard charts.

### Open questions

- **Carry from Session 18:** Does `OWNER_TEST_DOMAINS` (in `_shared/ingest.ts`) need to cover `ignoreem.com`? Synthetic test emails currently flow through normal routing and require manual archive. Decision affects whether to ship a tiny constant update + redeploy.

---

## Next session

- **Currently in:** `platform/` — Session 19 closed. Brevo enrichment fix shipped end-to-end; matched-lead path fully operational.
- **Next recommended:** `platform/` — first job tomorrow is the no-match Brevo build, owner-confirmed FIRST priority. Spec ready in `no-match-brevo-build.md`.

When tomorrow's session opens: read `platform/docs/no-match-brevo-build.md` first, then start with the site script update (matrix.json `coursesById` secondary index), push, then move to the Edge Function changes. ~2 hours total per the spec.

Mira's call from Monday's review still flags Rosa pipeline reset (`switchleads/outreach/`) as THE priority for the week — owner has chosen platform-first to clear the email launch dependency. Worth surfacing again at end of tomorrow.
