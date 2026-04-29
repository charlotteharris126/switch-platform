# Platform: Current Handoff: 2026-04-29 (Session 17 closed): Brevo learner enrichment fix

**Session type:** Targeted bug-fix session triggered by a synthetic test against the Brevo learner upsert flow. Email project (Switchable) ran the test and surfaced 7 defects on the same submission (lead 205, SMM Tees Valley, EMS). Six were one root cause; one was independent.

**Session opened:** 2026-04-29 evening
**Session closed:** 2026-04-29 evening

---

## What we worked on (Session 17)

### 1. Brevo enrichment fix — `_shared/route-lead.ts`

Root cause for six of seven defects: `getCourseFromMatrix` indexed matrix.json route entries by `entry.courseId`, which doesn't exist in the published JSON. Routes use `slug`. Lookup has been silently failing for every routed lead since the helper shipped in Session 16. Every matrix-derived attribute fell through to the page-slug fallback (or was empty).

Renamed helper to `getMatrixContext`, indexed by `slug`, expanded return shape to cover course-only slug + course title + region name + intake (id + formatted date) + both interest tags. Intake resolution: prefer `submission.preferred_intake_id` matched in `route.intakes[]`, else first intake, else legacy `nextIntake`.

Brevo attribute composition rewritten:
- `SW_COURSE_NAME` → `matrix.courseTitle` (was page slug)
- `SW_COURSE_SLUG` → `matrix.courseId` (course-only slug; new field)
- `SW_COURSE_INTAKE_ID` → resolved intake id (was missing)
- `SW_COURSE_INTAKE_DATE` → resolved intake `dateFormatted` (renamed from `SW_COURSE_START_DATE`)
- `SW_REGION_NAME` → `matrix.regionName` (was `submission.la`)
- `SW_SECTOR` → `ffInterest` for funded leads, `cfInterest` otherwise (was missing)

Seventh defect (independent): marketing list-add raced against Brevo's backend on a separate `addBrevoContactToList` call, surfacing a misleading 400. Collapsed into a single `upsertBrevoContact({listIds: [utility, marketing]})` call. Atomic, no race.

### 2. Site change — `courseId` field in matrix.json

`switchable/site/deploy/scripts/build-funded-pages.js` now emits `courseId: page.course` on every route. Purely additive; simulator and live pages key by `slug` and are unaffected. Site rebuild + push lands ahead of the Edge Function deploy so live matrix.json has the field before the helper reads it.

---

## Deploy + verify

1. Site committed + pushed (Netlify auto-deploys, ~2 min).
2. Platform: `supabase functions deploy netlify-lead-router routing-confirm` — both share `_shared/route-lead.ts`. `verify_jwt = false` is already in `config.toml` for both.
3. Owner action: confirm `BREVO_LIST_ID_SWITCHABLE_MARKETING` is set in Supabase secrets. The env var was renamed from `BREVO_LIST_ID_SWITCHABLE_NURTURE` in Session 16; if the rename didn't pick up, marketing list-add no-ops silently.
4. Owner re-test: fresh non-owner email on SMM Tees Valley → verify 13 attributes correct + both list memberships in Brevo.

---

## Carry: prior session (Session 16) detail below

The full Session 16 close-out follows. Kept in this file because the Session 17 fix landed against Session 16 code without any further session running between the two. When the next platform session opens, replace this entire file with that session's handoff.

---

# Platform: Session 16 (closed earlier 2026-04-29): email launch infra + cohort capture + agents page + cross-project audit

**Session type:** Continuation of Session 15 (closed early hours today). Wide cross-project session covering platform, switchable/email, switchable/site, and switchleads/social. Owner direction shifted multiple times; no-patchwork rule invoked once and the recommendation was reversed accordingly.

**Session opened:** 2026-04-29 morning (07:06 BST start, post-Mira-review)
**Session closed:** 2026-04-29 evening

---

## What we worked on

### 1. /admin/agents page under Tools sidebar (deployed)

New static directory of every agent: name, role, project folder, cadence, automations. Live cron status per automation via `public.admin_cron_status()` (migration 0039 — SECURITY DEFINER, gated by `admin.is_admin()`). Green dot = scheduled and active, rose dot = scheduled but disabled, red dot = expected but missing from cron.job. Static roster + live cron query, hybrid surface.

### 2. Migration 0037 — `social` schema reads for `readonly_analytics` (deployed)

Thea's MCP queries against `social.*` were failing with "permission denied for schema social". Migration grants USAGE on schema + SELECT on five tables (drafts, engagement_targets, engagement_queue, post_analytics, engagement_log) and six views, plus matching SELECT-only RLS policies for the role. Excluded sensitive tables (oauth_tokens, push_subscriptions).

### 3. Migration 0038 — provider trust content on `crm.providers` (deployed)

Added `trust_line TEXT`, `funding_types TEXT[]`, `regions TEXT[]`, `voice_notes TEXT` to `crm.providers`. Backfilled three signed providers verbatim from existing YAML files. WHERE-guarded backfill (`WHERE trust_line IS NULL`) to prevent re-run from overwriting owner edits. Tuesday's Path 4 (YAML-native) decision reversed — Edge Functions can't read switchable/site repo at runtime, so DB is canonical.

### 4. Migration 0039 — `public.admin_cron_status()` (deployed)

SECURITY DEFINER function returning jobname, schedule, active. Powers the agents page live status. Function lives in `public` so PostgREST exposes it via default Data API schemas; admin gating happens at function body via `admin.is_admin()`.

### 5. Migration 0040 — `crm.update_provider_trust()` RPC (deployed)

SECURITY DEFINER, gated by `admin.is_admin()`, validates `funding_types` against `gov`/`self`/`loan`, writes audit row via `audit.log_action('edit_provider_trust', ...)`. Powers the new `/admin/providers/[id]/trust` form.

### 6. /admin/providers/[id]/trust form (deployed)

Third tab on provider detail page. Form fields: trust line textarea, funding types multi-select pill buttons, regions comma-separated input, voice notes textarea. Pre-fills from existing values; doubles as initial-set + ongoing-edit surface. Replaces the SQL-paste recommendation from earlier (which Charlotte correctly flagged as patchwork).

### 7. _shared/brevo.ts extension (deployed)

Added BrevoBrand type, brand-aware sender selection in `sendBrevoEmail` (defaults to switchleads for backward compatibility), `upsertBrevoContact(email, attributes, listIds)`, `addBrevoContactToList(email, listId)`. Existing transactional callers (netlify-lead-router, netlify-leads-reconcile, routing-confirm) unchanged.

### 8. _shared/route-lead.ts extension + routing-confirm refactor (deployed)

Brevo learner upsert + matrix.json fetch helpers added to `_shared/route-lead.ts`. Both auto-route and manual-confirm paths now fire the Switchable utility/marketing automations identically. Originally placed in routing-confirm only — caught by Thea's memory note that hooks belong in the shared helper. Refactored routing-confirm from 878 lines to 210 by replacing the duplicate routing pipeline with a `routeLead("owner_confirm")` call. Picks up audit logging + re-application-note features the inline version lacked.

### 9. Course attribute resolution via matrix.json fetch

`COURSE_NAME` and `COURSE_START_DATE` Brevo attributes resolve via fetch from `https://switchable.org.uk/data/matrix.json` (5-min cache, 3-second timeout, slug fallback on any failure). SECTOR deferred entirely. Email project signed off this approach as the proper architecture (vs another DB migration).

### 10. Brevo SW_/SL_ namespacing + AGE_BAND defer + list consolidation (deployed)

Three coordinated email-side changes landed mid-session:
- All Switchable-specific Brevo attributes prefix with `SW_`. FIRSTNAME/LASTNAME stay unprefixed (Brevo defaults). Reserves `SL_` for future SwitchLeads attributes.
- `SW_AGE_BAND` deferred to v2 — form age question is being redesigned (under 19 / 19-23 / 24-34 / 35+). Better to not push deprecated values now.
- Switchable Nurture + Switchable Monthly lists consolidated into a single Switchable Marketing list. Cadence/branching is Brevo Automation logic, not list-membership.

Live attribute count: 14 (FIRSTNAME, LASTNAME unprefixed + 12 SW_-prefixed). Three Brevo env vars set on Supabase (`BREVO_SENDER_EMAIL_SWITCHABLE`, `BREVO_LIST_ID_SWITCHABLE_UTILITY`, `BREVO_LIST_ID_SWITCHABLE_MARKETING`).

### 11. Migration 0041 — cohort intake capture (deployed)

`leads.submissions` gains `preferred_intake_id TEXT` and `acceptable_intake_ids TEXT[]`. Form schema bumped 1.0 → 1.2 by site session. ingest.ts extracts the new fields; route-lead.ts surfaces them on provider sheets via Apps Script v2 header mapping ("Preferred intake" / "Acceptable intakes"). Supports the two multi-cohort pages site is launching (Counselling Tees Valley 6 May + 2 Jun, SMM Tees Valley 21 May + 26 May).

Deferred: `leads.routing_log.confirmed_intake_id` and `crm.enrolments.intake_id`. Both flagged in data-architecture.md.

### 12. LinkedIn submission scope correction

Verified against current LinkedIn Community Management API docs. `r_member_social` is currently a CLOSED scope per LinkedIn FAQ #6. Charlotte's existing app carries only `openid`, `profile`, `email`, `w_member_social` (no analytics scope). Submission doc rewritten to request `r_member_postAnalytics` (the correct scope for member post analytics). Thea's CLAUDE.md and current-handoff updated to remove the false "already-granted r_member_social" premise. Analytics-sync cron stays paused.

### 13. Cross-project audit between platform / email / site

Three projects ran in parallel today; surfaced two crossed wires:
- Tuesday's Path 4 decision (YAML-native trust content) was reversed once Edge Function filesystem-access constraint surfaced.
- Earlier recommendation that `/new-course-page` skill should generate paste-able SQL was flagged as patchwork; rebuilt as proper admin form route.
Both crossed wires resolved within the same session.

---

## Current state

Email launch infrastructure is **end-to-end ready**. Every routed lead now upserts to Brevo with 14 attributes and adds to the Switchable Utility list (always) plus Marketing list (if opted in). Both auto-route and manual-confirm paths trigger identically. Three pilot providers' trust content is live in `crm.providers` and powers the upsert. Course context (title + start date) resolves from matrix.json with slug fallback. Three Brevo env vars are set; Brevo dashboard config is the remaining owner-side blocker.

Multi-cohort intake capture is live end-to-end (form 1.2 → ingest → DB → sheet), waiting on site to push their template + simulator changes and on owner to add two columns to multi-cohort provider sheets.

Cross-project communication is clean. No conflicts between platform/email/site. Thea's notes corrected. LinkedIn submission doc ready for Stage 2 once Session G `/social` module is presentable to LinkedIn reviewers.

---

## Next steps

In priority order for the next platform session:

1. **No-match Brevo upsert in `netlify-lead-router`.** Currently a learner who submits and has no candidate provider gets zero email — no utility, no marketing. Should fire `SW_MATCH_STATUS=no_match` upsert with course interest, region, funding category attributes. Small piece of work (~30 min). Email project flagged this as required before email launch goes live.
2. **`leads.routing_log.confirmed_intake_id` + UI surface.** Owner override of learner's preferred cohort at confirm time. Migration + small UI on `/admin/providers/[id]/catch-up` to slot the learner into a specific cohort. Site project flagged as deferred from migration 0041.
3. **`crm.enrolments.intake_id` + reporting.** Per-cohort enrolment tracking so we can see "of the 8 leads who picked the May 6 counselling cohort, how many enrolled?" Slot in once cohort routing has been live for 2-4 weeks.
4. **Three platform secrets overdue rotation** (BREVO_API_KEY, SHEETS_APPEND_TOKEN, ROUTING_CONFIRM_SHARED_SECRET). Ticket `869d0a9q7`. Carrying since 22 Apr.
5. **Quarterly backup restore test** (data-infrastructure rule). Not done this quarter.
6. **Continue platform queue:** Meta ad spend ingestion (#1, blocked on FB device-trust), bulk operations on /admin/leads (#2), anomaly detection / Sasha extension (#3).

Carry-forward issues unchanged from Session 15 close:
- 2 unresolved sheet-append rows from 23 April (id 89, 90) at the 7-day flag line — need owner triage.
- Mira's THE priority for the week is Rosa pipeline reset in `switchleads/outreach/` — not platform — and was not actioned today.

---

## Decisions / open questions

### Decisions made this session

- **Provider trust content lives in `crm.providers`, not in YAML.** Reverses the Tuesday Path 4 decision. YAML files retained as version-controlled mirrors / audit history; not read at runtime by any system. Migration 0038 + WHERE-guarded backfill.
- **`/new-course-page` skill writes via the new admin form, not via raw SQL.** Replaces the patchwork SQL-paste recommendation. Form lives at `/admin/providers/[id]/trust`.
- **Brevo SW_/SL_ namespace convention.** Switchable attributes prefix `SW_`, future SwitchLeads attributes prefix `SL_`, Brevo built-ins (FIRSTNAME, LASTNAME, EMAIL) stay unprefixed. One email = one Brevo contact across both brands; namespacing prevents collisions.
- **Switchable Nurture + Monthly collapsed into single Marketing list.** Cadence/branching belongs to Brevo Automations, not list membership.
- **`SW_AGE_BAND` and `SECTOR` deferred to v2.** Age form-question being redesigned; SECTOR only used by post-launch nurture deep-dives.
- **Routing-confirm and netlify-lead-router converge through `_shared/route-lead.ts`.** All routing-time hooks (Brevo, future analytics, future audit additions) belong in the shared helper, not the caller. Refactored routing-confirm to call `routeLead("owner_confirm")` instead of duplicating the pipeline.
- **Auto-routing v1 is the default flow.** All three pilot providers have `auto_route_enabled=true`. Manual-confirm fires only on multi-candidate, auto-route-disabled providers, or fallback paths. Memory `feedback_owner_routes_leads.md` updated to reflect this.

### Open questions

- **No-match Brevo path scope.** Should `netlify-lead-router` upsert with empty PROVIDER_NAME / PROVIDER_TRUST_LINE and `SW_MATCH_STATUS=no_match`, or skip the upsert entirely until a match is found later? Email project's preference unclear.
- **Stage 2 LinkedIn submission timing.** Submission doc is ready. Needs Charlotte to submit via developer.linkedin.com once Session G `/social` module is fully presentable to LinkedIn reviewers. Approval timeline 2-8 weeks once submitted.
- **Email side-flow drafts** (12 emails: chase, post-call feedback, decline recirc, course lifecycle, testimonial ask, etc.) NOT yet drafted. Email project's job; non-blocking for utility + marketing v1 launch.

---

## Next session

- **Currently in:** `platform/` — email launch infra + cohort capture deployed; awaiting owner Brevo dashboard config + site push.
- **Next recommended:** **`switchleads/outreach/`** — Mira's THE priority for the week (Rosa pipeline reset). Front-of-funnel for new providers has gone dry while back-end delivery is at peak. To-contact queue at 0, six connection-sent stale, five chase DMs overdue. Hasn't been touched today.
- **If platform is the focus instead:** the no-match Brevo path is the highest-leverage next platform item. Email project flagged as required before launch goes live; ~30 min of work.
- **First task tomorrow:** ask the owner whether email Brevo dashboard config has progressed (sender verified, attributes created, lists created with IDs noted, suppression rule, branding). If yes, do a synthetic submission test end-to-end. If no, switch to switchleads/outreach for Rosa pipeline reset.
