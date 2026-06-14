# Platform Handoff, Session 73, 2026-06-14

## Current state
The full Wren-handoff Sasha set is shipped: fastrack-flag per-course fix, alumni-list graduation, employer email wording, plus the entire waitlist capture fix (existing 36 backfilled, going-forward router inheritance, and Mable's form course_id capture). All deployed and verified. Carry-forward platform work from S72 (provider-sheet republish background mode, one-way-sheet auto-republish decision, secret rotation) is untouched and still open.

## What was done this session
- **Fastrack flag bug fixed + deployed.** `_shared/route-lead.ts` `loadEmailAggregateState`: `SW_FASTRACK_COMPLETED` changed from the single-canonical-submission flag to a per-canonical-course `bool_or(fastracked_at)`. Fixes the same-course re-application wipe (Kirsty #233 was the lone live victim). Deployed to the 6 writers: `netlify-lead-router`, `routing-confirm`, `fastrack-receive`, `brevo-attribute-reconcile`, `admin-brevo-resync`, `netlify-employer-lead-router`. Charlotte resynced Kirsty via the DB↔Brevo panel.
- **Waitlist capture fix — fully closed.** (a) Migration `0208` adds `crm.backfill_waitlist_identity_from_parent()` (idempotent) + one-click panel `/admin/data-ops/backfill-waitlist-identity`; Charlotte ran it, the 36 opted-in waitlist contacts now carry name/postcode from their parent and are live in Brevo. (b) Going-forward: `_shared/ingest.ts` now carries the resolved parent's name/postcode/region/la/current_qualification onto a new waitlist/enrichment child (NULL-fill only); deployed to `netlify-lead-router` + `netlify-leads-reconcile`. (c) Mable shipped the `/waitlist/` form carrying `course_id` (verified live, test row 634 — auto-archived, zero downstream traces). Course interest for the existing 36 deliberately left blank (owner decision).
- **Alumni list graduation (item 4) built + deployed.** `email-u4-cron` gained a daily idempotent sweep: every enrolled/presumed_enrolled contact is added to the Switchable alumni list (new secret `BREVO_LIST_ID_SWITCHABLE_ALUMNI=9`) via `addBrevoContactToList`. Add-only, no removal (Brevo handles the newsletter move itself). Sweep covers the 7 already-U4'd + 20 pending + all future. Deployed `--no-verify-jwt`.
- **Employer email wording (item 2) closed.** "apprenticeship" → "training" already in source; Charlotte pasted the updated HTML into Brevo templates 61 (`s4b_employer_u1` welcome) and 66 (`s4b_employer_chaser`). Template IDs pulled from `crm.email_log`.
- **Admin UI (deployed via Netlify).** Leads list: sky "Fastracked ✓" badge for fastrack-passed leads. Work board: one-click tick to complete / re-open a card. Experiments page: humanised slug titles + period tag, a "Testing:" line resolving each test's course/employer page from real data, and a "Show ended" toggle that hides ended experiments by default.
- **Item 1.** Build an Online Shop campaign sent by Charlotte after the backfill + segment resync.

## Next steps
1. **Make `republish-provider-sheet` background-mode** (carry S72): "started, check back in ~1 min" response, mirror the `brevo-attribute-reconcile` async pattern, so a big sheet (Riverside ~40 rows) stops timing out with no result box.
2. **Decide one-way-sheet auto-republish on DB status change** (carry S72, Mira's call): root cause of recurring Riverside drift — Freya logs attempts in the portal/DB but nothing pushes DB→sheet until a manual republish.
3. **Tighten sheet-drift copy** (carry S72): "self-healing" overclaims for stuck cases; say "clears once reconciled".
4. **Consolidate the reconcile panel** (carry S72): four push buttons → cleaner two-direction design.
5. **Carry from S71/S72:** durable lead-webhook fix decision (direct-POST vs the 2-min backup, Mira's call) + `client_nonce` dedup scope; billing reconciliation (`/admin/billing`); ClickUp cutover (wire Rosa/Nell to `task-upsert`); rotate `BREVO_API_KEY` + `ROUTING_CONFIRM_SHARED_SECRET` + the 3 leaked `~/.zsh_history` creds.
6. **Alumni sweep efficiency (low priority):** the `email-u4-cron` sweep re-adds every enrolled contact to list 9 each run — fine at pilot scale; switch to a tracked flag (DB column or email_log marker) if enrolled volume grows large.

## Decisions and open questions
- **Decision: `SW_FASTRACK_COMPLETED` is a per-canonical-course `bool_or`, not a single-row read.** WHY: the single-row fix (Wren 2026-05-25) broke the opposite way — a same-course re-application child (fastracked_at NULL) became canonical and wiped a real completion. The bool_or scoped to the canonical course is correct in both directions.
- **Decision: alumni graduation is add-only, no removal from any list.** WHY: Brevo already moves nurtured prospects to the newsletter list after the nurture sequence, so the only missing step was adding enrolled learners to the alumni list (9).
- **Decision: waitlist test row 634 left archived, not hard-deleted.** WHY: it auto-archived via `dummy_test_email` and left zero downstream artefacts; archive is the established test-lead pattern (migration 0205) and avoids FK/orphan risk.
- **Open (carry, Mira): one-way provider sheets auto-republish on status change?** (Next step 2.)

## Watch items
- **Tomorrow's 09:30 UTC `email-u4-cron` run:** first real alumni sweep. Expect ~27 contacts added to Brevo list 9. Confirm via the function response `alumni_added` / `alumni_failed`, or glance at list 9's count in Brevo. No DB-side signal exists for it.
- **`email-u4-cron` deploy:** the new `addBrevoContactToList` import + `BREVO_LIST_ID_SWITCHABLE_ALUMNI` secret — verify the next run doesn't error on the alumni block (logs).
- **Carry S72:** 06:00 sheet-drift cron + 06:30 digest read honestly (EMS/Riverside no false "Aligned"); 14 `brevo_attribute_drift` rows clear once Charlotte runs DB↔Brevo "Check drift" → "Re-sync"; 3 `reconcile_backfill` rows persist until "Mark all resolved"; Brevo SMS stays down until credits topped up.

## Next session
- **Folder:** platform (Sasha)
- **First task:** Make `republish-provider-sheet` background-mode (Next step 1), then take the one-way-sheet auto-republish decision (Next step 2) to Mira.
- **Cross-project:** None outstanding. The waitlist coordination with switchable/site (Mable) completed this session — Mable shipped the `/waitlist/` form course_id capture, verified live (row 634), and the platform doc `waitlist-capture-fix.md` is marked closed. No pending push to Mable.
