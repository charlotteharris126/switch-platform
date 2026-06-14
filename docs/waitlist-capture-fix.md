# Waitlist capture fix, scoping note for Sasha

Date raised: 2026-06-13. Raised by Charlotte via switchleads/email session.

## Update 2026-06-14 (Sasha) — existing 36 are recoverable; backfill built

Data check changed the picture. **44 of 45 waitlist rows carry a `parent_submission_id`** (the earlier form the person came through). For all **36 opted-in** ones the parent row holds: **name 36/36, location (postcode) 36/36, qualification 18/36, course_id only 3/36.** So the "blind, unrecoverable" assumption below is wrong for name + location — they sit on the linked parent. Only course interest genuinely isn't in the data.

Decisions (owner, 2026-06-14):
- **Backfill the existing 36 from their parent** (name/location/qualification). Built: migration `0208_backfill_waitlist_identity_fn.sql` (`crm.backfill_waitlist_identity_from_parent()`, idempotent) + one-click panel `/admin/data-ops/backfill-waitlist-identity`. Pending owner go to apply + run.
- **Leave course interest blank for the existing 36** — no re-engagement email. Going-forward form fix captures course for new signups.

Going-forward router fix — DONE 2026-06-14 (Sasha). `_shared/ingest.ts` now carries the resolved parent's `first_name / last_name / postcode / region / la / current_qualification` down onto a NEW waitlist/enrichment child (NULL-fill only), so the row — and the Brevo contact its upsert drives — is no longer born blank. Deployed to `netlify-lead-router` + `netlify-leads-reconcile`. Region/LA still come through only as far as the parent has them (parents carry postcode but usually NULL region/LA); postcode is enough to derive downstream, and a postcode→LA derivation is out of scope here (no such derivation exists on the main form path to mirror).

Still TODO (switchable-site / Mable, NOT built): the `/waitlist/` form carrying the originating `course_id` so course interest is captured for NEW signups (parent inheritance can't supply it — parents usually lack a course_id too). The existing 36 stay course-blank by owner decision. The sections below remain the spec for the form side.

---

## The problem

The `/waitlist/` page (form `switchable-waitlist-enrichment`, `source_form = switchable-waitlist`, tagged `dq_reason = waitlist_enrichment`) captures people who land on the waitlist, but throws away everything we need to act on them later.

Current state in the data: 45 waitlist leads, 36 marketing opted-in. Every single one has:

- `first_name` = null, `last_name` = null (no name)
- `la` = null, `postcode` = null, `region` = null (no location)
- `course_id` = null, `courses_selected` = empty (no course interest)
- qualification only present inside `raw_payload.data.current_qualification`, not in the `current_qualification` column

Net effect: waitlist leads are un-targetable. We cannot tell who they are, which region they are in, or what they wanted, so we cannot match them to a course, personalise an email to them (the FIRSTNAME merge renders blank), or include them in a geo/course-specific send.

This was understood to be working when the waitlist flow was set up. It is not. Part of this fix is establishing whether the capture was built and later broke, or was never wired, before deciding the fix.

## What this is NOT

This is not about filtering people out at the waitlist stage. Overqualified leads (prior L3+) still enrol fine on anything that is not gated on no-prior-L3: team leadership / management, self-funded, loan-funded, apprenticeships. The fix does not drop anyone. It is purely a capture gap. The goal is to store enough to match each waitlist lead to the courses they are actually eligible for.

## Required capture

The waitlist form must collect, and the router must persist into existing columns (no schema change needed, these columns already exist on `leads.submissions`):

1. **Name** into `first_name` / `last_name`. Without it every marketing email to a waitlist contact renders "Hi ," and there is no way to personalise.
2. **Location** into `postcode` and/or `region` / `la`. Postcode is enough to derive LA and region downstream.
3. **Course interest** into `course_id` (or `courses_selected`). Preferred: carry through the `course_id` of the page the user bounced off when they were offered the waitlist, so we know what they originally wanted. If the waitlist page is reached generically (not from a course page), ask a course-interest question instead.
4. **Qualification** into the `current_qualification` column, not just `raw_payload`. The value is already collected on the form; it just is not being mapped to the column.

## Touch points to assess (infra change, assess before building)

- `/waitlist/` page form fields (switchable site) and the hidden fields / page context that would carry the originating `course_id`.
- `netlify-lead-router` Edge Function: parse the new fields, derive LA/region from postcode (mirror however the main funded form does it), populate `current_qualification`, `course_id`, `postcode`/`region`/`la`.
- Brevo sync: confirm the new region + course + qualification attributes flow to the contact's SW_* attributes so waitlist leads become segmentable in Brevo, not just in the DB. Existing waitlist contacts will need a one-off backfill once capture is live (they have no location/course, so backfill can only set what we now collect going forward; the 36 existing ones stay blind unless re-captured via a re-engagement email).
- Admin display: waitlist leads should show location + course + qualification in the leads view.

## Open question for Charlotte / Mira

The 36 existing opted-in waitlist leads have no location or course on record, so they cannot be retro-fixed from data alone. Option: a single generic re-engagement email ("we are adding new courses, where are you and what are you after?") that re-captures location + interest and converts them into targetable leads. Decision pending, not part of the capture fix itself.

## Acceptance

A new waitlist submission lands with `postcode`/`region`/`la`, `course_id` (or course interest), and `current_qualification` all populated as columns, and those values reach Brevo as contact attributes. Verified end-to-end with a real test submission through the live form, not just a string check.
