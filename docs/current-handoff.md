# Platform: Current Handoff: 2026-04-29 (Session 18 closed): EMS sheet v1→v2 migration + cohort intake FIELD_MAP fix

**Session type:** Targeted bug-fix session triggered by a real test lead (`email@ignoreem.com`) landing on the EMS sheet with the two new cohort intake columns blank. Surfaced two pre-flight gaps from Session 16's Migration 0041 multi-cohort capture work.

**Session opened:** 2026-04-29 (afternoon, post-Session-17)
**Session closed:** 2026-04-29 (afternoon)

**Original ask:** owner said "put me in switchable site". Actual work was entirely platform — switchable/site untouched.

---

## What we worked on

### 1. Root cause of empty cohort columns on EMS sheet

Session 16 shipped Migration 0041 + form schema 1.2 + `_shared/route-lead.ts` payload changes for `preferred_intake_id` and `acceptable_intake_ids`. Changelog instruction said "add Preferred intake / Acceptable intakes columns to provider sheets — no redeploy needed."

Wrong on two counts:

1. **FIELD_MAP gap.** `provider-sheet-appender-v2.gs` had no entries for `preferred_intake_id` or `acceptable_intake_ids`. Even on v2 sheets, the cells stayed blank because the lookup table didn't know which payload key to fetch.
2. **EMS still on v1.** Per `infrastructure-manifest.md` line 125 (pre-this-session), EMS ran `provider-sheet-appender.gs` (v1, hardcoded `appendRow` array), not v2. v1 has no FIELD_MAP at all — it appends to fixed positions 1-17 and ignores any header beyond that. Adding cohort columns to row 1 of an EMS-on-v1 sheet did nothing.

### 2. FIELD_MAP fix in canonical script

Two entries added to `platform/apps-scripts/provider-sheet-appender-v2.gs`:
- `'preferredintake':   'preferred_intake_id'`
- `'acceptableintakes': 'acceptable_intake_ids'`

Header lookup is case- and punctuation-insensitive so "Preferred intake" / "Acceptable intakes" match.

### 3. EMS sheet migration v1 → v2

Owner walked through the migration in-session:
- Confirmed EMS row 1 headers (19 columns) all map cleanly to v2 FIELD_MAP entries (14 auto-fill, 3 manual blanks for Enrolment date / Charge / Notes, 2 new cohort columns)
- Owner replaced v1 script with v2 contents in EMS Apps Script editor, preserving the deployed TOKEN value
- Used Deploy → Manage deployments → pencil → New version (NOT New deployment, per playbook step 3.8 / 2026-04-22 WYK incident)
- Web app URL preserved unchanged (verified against `crm.providers.sheet_webhook_url`)
- WYK Digital and Courses Direct sheets received the FIELD_MAP update + redeploy in lockstep (already on v2; harmless until they have multi-cohort columns, but keeps canonical script in sync)

### 4. End-to-end verification

A real organic learner submission landed on EMS sheet with all 14 auto-columns populated AND both new cohort intake cells correctly filled. No synthetic test needed.

### 5. Documentation updates

- `platform/docs/changelog.md` 2026-04-29 Migration 0041 entry: "Correction (2026-04-29 later)" appended with full root-cause + lesson
- `platform/docs/infrastructure-manifest.md`: line 125 EMS row flipped v1 → v2, summary text rewritten ("All three pilot sheets now run v2"), manifest changelog row added for 2026-04-29 migration
- `platform/docs/provider-onboarding-playbook.md`: v1 reference reworded from "kept until all sheets are migrated to v2" → "historical reference, no live deployments since 2026-04-29 EMS migration"

### 6. Test row archived

Two test rows archived in `leads.submissions` via Supabase SQL editor (no admin dashboard archive button exists yet — see Open question 1):
- `email@ignoreem.com` — original test row that surfaced the bug
- `email2@ignoreem.com` — second test row from owner

Pattern (mirrors data-ops/009 from 2026-04-25): `is_dq=true`, `dq_reason='owner_test_submission'`, `primary_routed_to=NULL`, `routed_at=NULL`, `provider_ids='{}'`, `archived_at=now()`. `leads.routing_log` rows preserved as audit history. Both deleted from EMS sheet manually afterwards.

### 7. Memory saved

`feedback_appender_version_preflight.md` — pre-flight rule: before instructing owner to add new columns to provider sheets, check `infrastructure-manifest.md` Apps Script deployments table for the version each sheet runs. v1 hardcoded → patch or migrate; v2 → ship FIELD_MAP entry in same change + redeploy every v2 sheet.

---

## Current state

EMS sheet integration is now on v2 across all three pilot providers, end-to-end verified with a real lead. Cohort intake fields surface correctly on multi-cohort EMS sheets. Three changelog and manifest correction entries make the original Session 16 instruction permanent record.

Two test rows fully archived. Owner-test allowlist (`OWNER_TEST_DOMAINS` in `_shared/ingest.ts`) does NOT cover `ignoreem.com`-style synthetic emails — they flow through normal routing and require manual archive. Consider extending the allowlist or adding `ignoreem.com` if owner uses it routinely.

---

## Next steps

In priority order:

1. **Build archive/unarchive lead action on `/admin/leads/[id]`.** Real defect: `archived_at` column exists, leads-list filter has "Archived" tab, `app/lib/audit.ts` already names `archive_lead` / `unarchive_lead` action types, but no Server Action and no UI button. Owner forced into raw SQL with column-by-column risk every time. Owner has flagged this to platform; no ClickUp ticket created (per owner instruction).
2. **No-match Brevo upsert in `netlify-lead-router`** (carried from Session 17). Learner with no candidate provider gets zero email. Should fire `SW_MATCH_STATUS=no_match` upsert. Required before email launch goes live.
3. **`leads.routing_log.confirmed_intake_id` + UI surface** (carried from Session 16). Owner override of learner's preferred cohort at confirm time.
4. **`crm.enrolments.intake_id` + reporting** (carried from Session 16). Per-cohort enrolment tracking. Slot in once cohort routing has been live 2-4 weeks.
5. **Three platform secrets overdue rotation** (`BREVO_API_KEY`, `SHEETS_APPEND_TOKEN`, `ROUTING_CONFIRM_SHARED_SECRET`). Ticket `869d0a9q7`. Carrying since 22 Apr.
6. **Quarterly backup restore test** (data-infrastructure rule). Not done this quarter.
7. **Continue platform queue:** Meta ad spend ingestion (#1, blocked on FB device-trust), bulk operations on /admin/leads (#2), anomaly detection / Sasha extension (#3).

Carry-forward unchanged from Session 17:
- 2 unresolved sheet-append rows from 23 April (id 89, 90) at the 7-day flag line — owner triage still pending.
- Mira's THE priority for the week is Rosa pipeline reset in `switchleads/outreach/` — not platform — and was not actioned today.

---

## Decisions / open questions

### Decisions made this session

- **EMS migrated v1 → v2.** No more v1 deployments live in production. v1 file in repo is now historical reference only.
- **FIELD_MAP changes ship as a New version on every v2 sheet, in lockstep with git.** Even sheets that don't immediately use the new field get the redeploy, to keep the canonical script identical across deployments.
- **No ClickUp ticket for the dashboard archive button gap.** Per owner: already flagged to platform via other channel.

### Open questions

- **Does `OWNER_TEST_DOMAINS` need to cover `ignoreem.com`?** Or is owner happy to manually archive each synthetic test row? Decision affects whether to ship a tiny `_shared/ingest.ts` constant update + redeploy.
- **Carry-forward open question from Session 17:** No-match Brevo path scope — upsert with empty PROVIDER_NAME / `SW_MATCH_STATUS=no_match` or skip upsert until match found?

---

## Next session

- **Currently in:** `platform/` — EMS migration closed; one new gap surfaced (admin dashboard archive button).
- **Next recommended:** **`switchleads/outreach/`** — Mira's THE priority for the week (Rosa pipeline reset). Front-of-funnel for new providers has gone dry while back-end delivery is at peak. To-contact queue at 0, six connection-sent stale, five chase DMs overdue. Hasn't been touched today (carried from Session 17).
- **If platform is the focus instead:** highest-leverage next platform items remain (a) the no-match Brevo path (Session 17 carry, ~30 min, blocks email launch), or (b) the archive/unarchive lead button (this session's surfaced gap, ~1h).
- **Switchable/site work was the original ask but wasn't started.** If owner wants to restart there next session, ask what the actual switchable/site task is — original ask was generic ("put me in switchable site") with no specific work named before the EMS bug took the session.

---

## Carry: prior session (Session 17) summary

Session 17 (2026-04-29 evening) was a Brevo learner enrichment fix triggered by a synthetic test from Email project. `getCourseFromMatrix` indexed matrix.json by `entry.courseId` which doesn't exist in the published JSON; fixed by indexing on `slug` and renaming to `getMatrixContext`. Six attribute defects collapsed; seventh (marketing list-add race) collapsed into single `upsertBrevoContact({listIds: [utility, marketing]})` call. Site shipped `courseId` field in matrix.json build. Both share `_shared/route-lead.ts`. Full detail in [changelog.md](changelog.md) under 2026-04-29 entries.
