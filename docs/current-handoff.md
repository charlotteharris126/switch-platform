# Platform Handoff, Session 36, 2026-05-09

## Current state

Provider portal MVP foundation built end-to-end (10 migrations applied, 0091 through 0100). Status taxonomy expanded for the new outcome buttons, `crm.provider_users` table + RLS policies + audit helper in place, demo-flag and portal-cutover-flag columns added, auto-flip cron held disarmed pending prerequisites. DB ↔ Brevo single-source-of-truth architecture shipped: triggers fire near-real-time push on every relevant write to crm.enrolments / leads.submissions / crm.providers, plus a daily 04:45 UTC reconcile cron as belt-and-braces. Brevo attribute set extended by 9 attributes today (SW_COURSE_SCHEDULE, SW_PHONE, SW_LOST_REASON, SW_FASTRACK_COMPLETED, SW_FASTRACK_URL, SW_START_TIMING, SW_INTEREST_BREADTH, SW_INVESTMENT_WILLINGNESS, SW_CURRENT_QUALIFICATION) to support Wren's nurture v2 and Mable's fastrack cohort_decline + l3_mismatch UX. All four pilot providers reconciled against their sheets (WYK, EMS via data-ops 016 + 017; CD no DB-side corrections needed; Riverside no leads yet). Brevo aligned across 174 routed-active contacts with 8 spot-checks confirmed clean. Cron error from Session 35 (brevo-consent-reconcile-daily CHECK constraint) verified fixed via fresh deploy + manual trigger. Repo + origin: ahead by today's commits, clean tree.

## What was done this session

Migrations applied (in order):

- **0091** status taxonomy expansion: open / attempt_1_no_answer / attempt_2_no_answer / attempt_3_no_answer / enrolment_meeting_booked / enrolled / lost / cannot_reach / presumed_enrolled. Dropped legacy 'contacted' value (zero rows).
- **0092** dropped legacy `enrolments_status_chk` constraint (0091's DROP IF EXISTS targeted the wrong name; constraint-name mismatch logged in updated memory `feedback_query_live_pg_proc_before_patching`).
- **0093** `crm.providers.is_demo` + `crm.providers.portal_enabled` boolean flags.
- **0094** `crm.provider_users` table (multi-user mapping, role + status CHECKs, FK to auth.users, RLS, admin/functions/analytics policies).
- **0095** `audit.log_provider_action` SECURITY DEFINER helper, gated on caller having an active provider_users row.
- **0096** `crm.provider_user_provider_id()` helper + 9 RLS policies across leads.submissions / leads.routing_log / leads.fastrack_submissions / crm.enrolments / crm.providers / crm.provider_users / crm.disputes. portal_enabled flag baked into the helper for per-provider cutover gating.
- **0097** auto-flip cron + day-12 warning cron rescheduled — applied alongside 0098 by accident, then disarmed via `cron.unschedule` SQL (db push pulled both pending migrations together; lesson noted, both crons now unscheduled pending prerequisites).
- **0098** Postgres triggers on crm.enrolments + leads.submissions + crm.providers — auto-fires `crm.sync_leads_to_brevo` on every relevant change. Removes the "did the developer remember to call sync?" risk entirely.
- **0099** waitlist enrichment columns (start_timing, interest_breadth, investment_willingness, current_qualification, source_form, enriched_at) + extended trigger function to cover the new fields + phone + fastracked_at.
- **0100** daily Brevo attribute reconcile cron at 04:45 UTC, chunked 50 ids per pg_net dispatch.

Code changes:

- `_shared/route-lead.ts`: 9 new SW_* attributes pushed at all 3 composition sites (matched / U1 transactional / no-match-pending) plus extended SubmissionRow interface, extended SELECT statements, extended enrolment-status query to also pull lost_reason. Added `buildFastrackUrl(client_nonce)` helper. Decoupled BREVO_LIST_ID_SWITCHABLE_UTILITY (now optional, mirrors marketing list pattern — Wren's ask, ready for ~6 Aug list deletion).
- `_shared/ingest.ts`: parent_ref-first parent lookup (UUID match against client_nonce) with email fallback, 6 new fields captured from switchable-waitlist-enrichment payloads, parent UPDATE step that mirrors enrichment fields onto the parent row when parent_ref + parent resolved.
- `admin-brevo-resync/index.ts`: SELECT extended for new columns.
- `brevo-consent-reconcile-daily/index.ts`: redeployed (Session 35's redeploy hadn't taken; verified by manual trigger returning 200 with one drift correction landing cleanly).
- 4 Edge Functions redeployed twice today as new attributes landed: netlify-lead-router, routing-confirm, admin-brevo-resync, plus brevo-consent-reconcile-daily.

Reconciles + data fixes:

- **data-ops/016** WYK sheet → DB: 9 status corrections + 1 INSERT (Naomi @petsapp dedup child). Zero in flip-cohort post-reconcile.
- **data-ops/017** EMS sheet → DB: 6 status corrections + 2 INSERTs (Glennis Adamson dedup children). Zero in flip-cohort post-reconcile.
- **data-ops/018** DQ reason consolidation: 5 rows level/qual → overqualified, 3 rows location → region_mismatch. Form-side cleanup pushed to Mable's handoff.
- Brevo full-cohort resync over 174 routed-active contacts (twice — once for SW_COURSE_SCHEDULE backfill, once for the 8 new attributes). Zero new dead_letter rows both times. Single-source-of-truth verified with 164=164 alignment between sheets and DB unique-routed-active emails, 239 Brevo contacts explained by dedup math (12 owner-test contacts intentionally absent from Brevo).

Cross-project pushes filed (durable record updates):

- Nell `switchleads/clients/docs/current-handoff.md`: CD warm conversation prep when new sales rep arrives, Marty's two-product-provider angle (CD + separate funded provider) as relationship-keeping rationale; phantom Jade Millward note retracted (she applied for both EMS + CD courses separately).
- Mira `strategy/docs/current-handoff.md`: provider activity-gate framework + two-product-provider rule needed for next Monday cycle.
- Clara `accounts-legal/docs/current-handoff.md`: PPA portal-access review needed before EMS cutover mid-next-week.
- Mable `switchable/site/docs/current-handoff.md`: funded form DQ taxonomy fix (level/qual/location → canonical) on 3 funded course pages + matrix.json schema doc + form-matrix simulator.
- Wren `switchable/email/docs/current-handoff.md`: SW_COURSE_SCHEDULE delivery, utility-list decoupling, sunset-cron gating correction, plus a new `brevo-attribute-architecture.md` reference doc explaining the three-layer DB ↔ Brevo architecture for designing future automations.

Memory updates:

- New `project_marty_dual_provider_angle` (CD relationship + funded-provider angle).
- Updated `project_auto_flip_and_day12_deferred` (now "held until prerequisites land", not "indefinitely deferred").
- Updated `feedback_query_live_pg_proc_before_patching` (broadened to cover constraints + indexes alongside functions).

## Next steps

1. **Provider portal P2 — auth + invite flow** (~2h focused). Build over the weekend per Charlotte's plan. `provider-magic-link` Edge Function, `/provider/login` + `/provider/auth/callback` routes, auth middleware, passkey enrolment, admin "Send portal invite" button on `/admin/providers/[id]`. Done when admin invite to demo provider sends magic link, lands authenticated, sets up passkey.
2. **Provider portal P3 — portal pages** (~3-4h). `/provider`, `/provider/leads` (filters + search + bulk select + day-count badges), `/provider/leads/[id]` (outcome buttons + notes + dispute + fraud-flag + audit history), `/provider/account`. Server Action for outcome marking — writes DB, fires `audit.log_provider_action`, fires CHASER template synchronously on attempt clicks.
3. **Provider portal P4 — admin polish + cutover prep** (~1-2h). Last-login column on /admin/providers, "providers without recent login" tile, provider-side audit panel on /admin/leads/[id], Brevo "new lead routed" template updated for portal deep link, Day-14 + Day-19 cron infrastructure wiring (templates dormant until written).
4. **Demo provider seed** — fixture script in `data-ops/` creating "Demo Provider Ltd" with `is_demo=true` + 10-12 fake leads spanning every status. Use during P2-P4 testing. Charlotte's demo email: `hello+demo@switchable.org.uk`.
5. **EMS cutover sequence** (mid-next-week, after P4). Clara has signed off auth model + PPA coverage + sub-processor disclosure (see item 10 below for conditions). Day 0 invite, days 0-14 parallel sheet + portal, day 14 emails switch to portal-only, day 21 sheet append disabled.
6. **SwitchLeads provider-facing template drafts** when auto-flip cron re-arms: BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING (day-12), day-14 confirmation, day-19 dispute reminder. Charlotte voice (charlotte-voice.md), no PII (count + portal link only). Owner approves before going live in Brevo.
7. **Re-arm auto-flip + day-12 warning crons** when prerequisites clear: Wren's day-12 template + Mira's activity-gate framework + provider heads-up emails sent (Nell). Clara's PPA review now cleared (see item 10). One SQL block re-schedules both.
8. **Verify Mable's frontend redirect for fastrack cohort_decline + l3_mismatch** lands cleanly. Mable shipped frontend at commit `bd7093c` 2026-05-09 evening. Both DQ paths flow into `/waitlist/` via consent click. Watch `leads.dead_letter` over the next 24-48h for any `edge_function_brevo_upsert` rows with payload shape `switchable-waitlist-enrichment` carrying `parent_ref` + `source_form='fastrack-cohort-decline'` or `'fastrack-l3-mismatch'`. Clean = working.
9. **Pre-fill enrichment form via backend lookup** (smart-to-have, future-flagged by Mable). When `/waitlist/` loads with `?parent=<client_nonce>`, currently the form re-asks for phone (sloppy to pass PII via URL). Cleaner: small new Edge Function (e.g. `enrichment-prefill`) reads parent submission by client_nonce, returns public-safe pre-fillable fields (phone, first_name, etc.). Lifts enrichment completion rate. No deadline; queue when there's appetite.

10. **Inbound from Clara, accounts-legal Session 11, 2026-05-09: provider portal sign-off granted with three conditions before real-provider cutover.**

    a. **Auth model approved for Article 32 UK GDPR.** Passkey-only with enrolment-only invite link is a sufficient TOM. Materially stronger than magic-link or password+MFA. Demo-only build today against `demo-provider-ltd` is cleared to proceed (no real PII at risk).

    b. **Three conditions gate any real-provider cutover** (i.e. before EMS portal_enabled flip):
       - **RLS proof must run green** on migrations 0091/0094/0096 with a fixture that includes ≥2 providers + a cross-provider read attempt, asserting provider A cannot SELECT provider B's rows in `leads.submissions`, `crm.enrolments`, `leads.routing_log`, `crm.disputes`. Confirm the `portal_enabled` gate baked into `crm.provider_user_provider_id()` (0096) returns zero rows for an unflagged provider.
       - **`/ultrareview` mandatory on the migrations + portal route code** before EMS cutover, per `.claude/rules/data-infrastructure.md` item 8. Routes and Server Actions consuming RLS context are new code and need the cloud review pass even though migrations are already shipped.
       - **Pen-test gate ([869d0hwxz](https://app.clickup.com/t/869d0hwxz)) holds firm before provider #5+ onboards.** Not gating EMS/CD/WYK/Riverside (three pilots we know personally + RLS as primary perimeter + 14-day parallel sheet operation). Must not slip when post-pilot providers come on.

    c. **PPA coverage cleared, no addendum gate.** PPA v2 clauses 7.1-7.6 + 10.4 are delivery-channel agnostic; clause 7.4 covers provider's-internal-access-control as TOM obligation; audit logging via `audit.log_provider_action` (0095) is our Article 30 obligation, not a contract issue. Optional one-paragraph clarification clause drafted and folds into existing PPA addendum stack [869d61kft](https://app.clickup.com/t/869d61kft) when it next goes out for the four signed providers — does not block cutover.

    d. **Sub-processor disclosure unchanged.** Supabase Auth + WebAuthn introduce no new third party. Generic processor wording on both privacy policies covers the data flow. No Notion edit, no HTML edit.

    Full record: `accounts-legal/changelog.md` 2026-05-09 (later session) entry.

11. **Inbound from Mable, 2026-05-09: re-run data-ops/018 for any rows written between SQL run and form-side fix.** Mable shipped form-side `dq_reason` canonical alignment in commit `435e092` (2026-05-09 evening) on the funded mini-quiz showResult and the find-your-course showHolding handler. Both now translate at the write boundary to canonical values (`age` → `age_below_min`, `location` → `region_mismatch`, `level` → `overqualified`, `start_date` → `cant_commit_dates`, `qual` → `overqualified`, `no-match` → `no_course_match`). The platform SQL data-ops/018 cleaned 8 historical rows earlier today; the comment in that script anticipated a second pass once Mable's fix landed to clean any rows written in the gap. Quick query: `SELECT id, dq_reason, created_at FROM leads.submissions WHERE dq_reason IN ('age', 'location', 'level', 'qual') AND created_at > '<data-ops/018 run time>'` — if non-zero, re-run the same UPDATE block. Likely zero or a handful (gap was hours, not days). 5-min job. After this second pass, future submissions won't write any deprecated values, and data-ops/018 can be retired.

## Decisions and open questions

### Decisions made this session

- **Provider portal MVP scope locked at "smallest" framing** (per Charlotte 2026-05-09): magic-link + passkey auth, status taxonomy expanded for attempt-by-attempt outcome marking, demo provider with `is_demo` flag, multi-user with provider_admin / provider_user roles, EMS-first strict-serial cutover. Build it now, defer marketplace / billing / invoicing UI to v2.
- **Auto-flip cron only flips status='open' rows** (engaged statuses left alone). Pugh + Turnbull "open" but <14 days from routing, so not in immediate flip cohort.
- **CD held back from auto-flip regardless of cron timing** (Marty's two-product-provider angle, £10/day ad spend stays running through new sales rep's first week, warm conversation not heavy).
- **Defaults locked for Wren attribute names**: SW_PHONE, SW_LOST_REASON, SW_FASTRACK_COMPLETED, SW_FASTRACK_URL, SW_START_TIMING, SW_INTEREST_BREADTH, SW_INVESTMENT_WILLINGNESS, SW_CURRENT_QUALIFICATION. Wren can rename via Brevo dashboard later (low cost).
- **SW_FASTRACK_URL pattern reuses Mable's existing `?ref=<client_nonce>` redirect param** so funded thank-you page logic handles nurture-email clicks without changes.
- **Daily Brevo attribute reconcile (Layer 3) shipped now** rather than deferring — closes the architecture cleanly for the weekend portal build.
- **Lucy Hizmo flipped lost → enrolled per sheet** (Status column authoritative over notes; "cancelled" note is informational and ambiguous, possibly stale alignment-bug residue from data-ops/015).
- **Migration 0097 applied accidentally** alongside 0098 because `db push` processes all queued migrations together. Mitigation: cron unscheduled via SQL right after. Lesson: check `supabase migration list --linked` before push to know what's pending.

### Open questions

- None blocking the weekend portal build.

## Watch items

- 🟡 First overnight runs of the new daily 04:45 UTC `brevo-attribute-reconcile-daily` cron. Should produce zero new dead_letter rows. Tomorrow 2026-05-10 is the first scheduled fire.
- 🟡 Mable's frontend redirect ship for fastrack cohort_decline + l3_mismatch (her Session 60). Receiver is deployed; if any payload arrives with parent_ref but the lookup fails, dead_letter `source=edge_function_brevo_upsert` will surface it.
- 🟢 Brevo consent reconcile cron (04:00 UTC) — fixed and verified clean today. Should remain clean.
- 🟢 Aaron Ryan (322), Lucy Hizmo (25), Sam Stevens (34), Rebecca Rollinson (310) — Brevo spot-checks across provider/funding combinations confirmed all 8 new SW_* attributes landed correctly.

## Next session

- **Folder:** platform/
- **First task:** Start Sessions P2 + P3 of the provider portal MVP build (~5-6h focused). Schema foundation already in place from migrations 0091-0096; demo provider seed + auth + portal pages still to ship. Alongside: monitor Mable's fastrack cohort_decline frontend ship for any payload anomalies via dead_letter.
- **Cross-project:** No new outgoing pushes from this session beyond the five filed today (Nell, Mira, Clara, Mable, Wren). Incoming items will surface from each agent in their own session pace.
