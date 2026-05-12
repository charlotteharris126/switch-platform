# Platform Handoff, Session 43, 2026-05-12

## ⚡ PUSH FROM switchable/ads Session 32, 2026-05-12: NULL `session_id` flag resolved forward

The 40% NULL `session_id` finding from your platform monitor has been root-caused and fixed. Cause: `partial-tracker.js` not wired on `/business/*` (S4B v1, 100% miss since yesterday's launch, 14 leads) and `/funded/thank-you/` (fastrack-funded-v1, 100% miss, 3 leads). `/funded/<course>/` was mostly fine with a small DOMContentLoaded race tail.

Fix shipped under Iris context this session (3 files in switchable/site/, build clean, audit 0 critical, all three deployed pages verified). Mable holds three follow-ups: audit guard for tracker coverage, `form-submit-fetch.js` INCLUDE drift cleanup, residual race-tail belt-and-braces. All flagged in her handoff.

On your next platform-session start check, NULL share on `leads.submissions.session_id` should trend toward zero on new rows. 35 historical NULL rows stay NULL; not recoverable. Verification SQL for new S4B rows after your Edge Function ships:
```sql
SELECT id, page_url, session_id FROM leads.submissions
WHERE source_form = 's4b-employer-lead-v1' ORDER BY id DESC LIMIT 5;
```

---

## Current state

Switchable for Business v1 backend tested end-to-end and ready for Wed paid traffic (2026-05-13). Six test submissions fired through the real stack: sheet append works, DB ingestion correct (`lead_type='employer_apprenticeship'`, all 14 employer columns populated), admin lead detail page renders employer-aware fields, Riverside billing tile shows `0 / 1` (per-provider cap, not hardcoded 3). Edge Function deployed with TEST_MODE primitive + per-leg failure logging. Only outstanding gap is `BREVO_TEMPLATE_U1_EMPLOYER` (Wren delivering); without it employers still get no acknowledgement email but every other leg fires cleanly. Three test U2s leaked to Jane mid-session before TEST_MODE landed — Charlotte sent ignore-and-delete note.

## What was done this session

- **`netlify-employer-lead-router` Edge Function rewritten in three passes** after Charlotte's first happy-path test exposed:
  - Sheet append payload shape was `{mode:"append", fields:{"Submission ID":...}}` (sheet header names, no token); Apps Script v2 appender returned `{ok:false, error:'unauthorized'}` silently. Rewritten to mirror `_shared/route-lead.ts` verbatim: `{token, mode:"append", submission_id, ...}` (flat snake_case payload keys, token in body).
  - Post-route fan-out `Promise.allSettled` now logs each leg's rejection by name (`post-route leg sheet-append failed:`). Previously swallowed individual leg failures, which is why the unauthorized error was invisible in Supabase logs for the first ~hour of diagnosis.
  - `TEST_MODE` + `OWNER_TEST_EMAIL` env-var pair added. When `TEST_MODE='true'`, U2 (provider notification) redirects to `OWNER_TEST_EMAIL`, cc_emails stripped, subject prefixed `[TEST]`, log line emitted. If TEST_MODE=true but OWNER_TEST_EMAIL not set, U2 skips entirely (never falls back to provider email). Replaces the SQL-swap-then-test pattern that failed safely-three-times today.
- **Migration 0134** added `crm.providers.site_slug TEXT` (nullable) + partial unique index `WHERE site_slug IS NOT NULL`. Riverside backfilled to `'riverside'`. No consumer reads it today; surfaces the DB-id ('riverside-training') vs site-slug ('riverside') divergence so v2+ apprenticeship redirect work has typed mapping rather than a code switch.
- **Migration 0135** exposed `free_enrolments_cap` on `crm.vw_provider_billing_state` SELECT. First attempt failed with `42P16: cannot change name of view column` because `CREATE OR REPLACE VIEW` rejects column reorders; column moved to end of SELECT, succeeded. Admin UI updated in lockstep (`admin/page.tsx` + `admin/providers/page.tsx`): selects new column, displays `used / cap` (was `remaining / 3`). Riverside (PPA v2 cap=1) now renders correctly as `0 / 1` instead of `1 / 3`.
- **Admin lead detail page (`/admin/leads/[id]`)** branched on `lead_type`. Employer leads render Company + apprenticeship card (company_name, sector, company_size_band, levy_status, interest, urgency, candidate_in_mind, existing_apprentices, headcount_estimate, standards_interested, ern, additional_notes) in place of Course + qualification card. Contact card shows Role instead of postcode/LA/region. Fastrack + referral per-lead-links cards stay learner-only.
- **Apps Script v2 appender** (`platform/apps-scripts/provider-sheet-appender-v2.gs`) FIELD_MAP extended with 19 employer / B2B aliases (submissiontime, role/roletitle, company/companyname, companysize/companysizeband, sector, levystatus/levy, urgency, candidateinmind/candidate, existingapprentices, headcountestimate/headcount, standardsinterested/standards, additionalnotes, ern). Charlotte redeployed as new version. Funded provider scripts unaffected (their sheets have no matching headers).
- **Riverside data fix.** `UPDATE crm.providers SET free_enrolments_remaining = 1 WHERE provider_id = 'riverside-training'` (was column default of 3, semantically wrong for PPA v2 apprenticeship pilot which is 1 free Employer Signed).
- **Test cleanup.** Submissions 401, 408, 410, 411, 412, 413 marked `is_dq=true, dq_reason='owner_test'`. Their open enrolment rows in `crm.enrolments` deleted. None ever exited `open` so no billing impact.
- **Cross-project closures from Mable's same-day work:**
  - Phone leading-zero strip fixed site-side (commit 85cc319): form submit handler prepends space to digits-only phone values so Netlify keeps them as strings; existing `trimOrNull` strips the space. No Edge Function change.
  - INCLUDE-block tripwire fixed site-side (commit 38d763f): `form-submit-fetch.js` + `uk-phone.js` moved out of the gtm-head INCLUDE block so `npm run build:partials` doesn't strip them.
- **Iris's session_id tracker fix landed.** `/business/*` and `/funded/thank-you/` were missing `partial-tracker.js` wire-up (100% NULL session_id on 14 + 3 leads respectively). Iris pushed the fix; new submissions carry session_id from now on.

## Next steps

1. **Wed 2026-05-13 paid traffic launch** — eyeball Edge Function logs for the first real Riverside submission. Verify all four legs (DB insert + sheet append + U1 + U2) fire cleanly. If anything fails the per-leg logger will say which.
2. **Wren: 3 Brevo templates.** `BREVO_TEMPLATE_U1_EMPLOYER` (employer ack — degrades Wed UX until set, but doesn't break the flow), `BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING` (day-before warning), `BREVO_TEMPLATE_PROVIDER_PRESUMED_FLIPPED` (post-flip dispute window). Latter two only matter once Riverside has open enrolments past day-58.
3. **Carry forward from Session 42:** owner invites for Andy (EMS), Jane (Riverside, post-first-lead), Marty (CD); republish EMS + WYK sheets from DB before sending invites; mark 25 `sheet_drift_detected` dead-letter rows resolved on `/admin/errors`.
4. **Add session_id coverage to Monday weekly health report.** Track `count(*) FILTER (WHERE session_id IS NULL) / count(*)` on `leads.submissions` weekly. If above ~10%, flag (Mable's tracker gap doesn't reopen silently).
5. **Followup ticket (low priority):** per-provider `sla_dispute_deadline_days` column to replace hardcoded 7-day window in `crm.run_enrolment_auto_flip`. Promote when first PPA negotiation lands a different number.
6. **v2 multi-apprenticeship-provider redirect strategy** — when second apprenticeship provider signs, decide between Netlify form-success-URL branching / client-side action rewrite / `crm.providers.site_slug` mapping. Migration 0134 is groundwork for option C.

7. **From Solis Session 2 (2026-05-12): two parked B2B-ads items.**
   - **Schema naming decision: `ads_business` vs `ads_switchable_business`** for the B2B ads data schema. Solis's `agent.md` references `ads_business.*` (linkedin_daily, meta_daily); `data-architecture.md` lists `ads_switchable` (B2C) and `ads_switchleads` (placeholder for SwitchLeads provider acquisition, separate stream). `ads_business` is ambiguous. Recommend `ads_switchable_business` for consistency with `ads_switchable` (Iris's B2C) and disambiguation from `ads_switchleads` (Rosa's provider-side). **Decide before building the B2B Meta ad data ingest** — could be needed as soon as this week if you extend the daily ingest to cover B2B Meta data. Update `data-architecture.md` first, ship migration after.
   - **`crm.employer_signings` table design** (or `crm.enrolments` extension with `enrolment_type` discriminator) for closed-loop B2B attribution. Captures the £400 ex VAT billing event when Riverside confirms an employer has signed an apprenticeship hosting agreement. Becomes urgent when first Riverside Employer Signed event fires. Riverside leads with a call so cycle could be days, not weeks post-launch. Owner approves table shape before migration.

## Decisions and open questions

**Decisions made:**

- **TEST_MODE env-var primitive over SQL-swap-then-test.** Reason: SQL-swap pattern requires editing `contact_email` before the test, reverting after; today three test U2s leaked to Jane because the swap was skipped. TEST_MODE is in code, not data, can't be silently mid-state, and emits a log line so it's visible. New rule: never SQL-swap provider emails for testing again — flip the env var.
- **Lead detail page single template, branch on `lead_type`.** Reason: most fields (contact, attribution, routing, audit, email log, dead letter, partials, raw) are shared; only the middle "what they're asking for" card differs by lead type. Splitting into two templates would force every shared field to be maintained twice.
- **UI displays free credits as `used / cap`, not `remaining / cap`.** Reason: Charlotte's mental model is "X used out of Y allowed", not "X remaining of Y total". The latter was the previous display and was being misread. Same view, friendlier render.
- **`free_enrolments_cap` appended at end of `vw_provider_billing_state` SELECT.** Reason: Postgres `CREATE OR REPLACE VIEW` rejects column position changes. Trailing addition is the safe path; existing consumers select by name so column order doesn't matter to them.
- **No backfill of historic NULL session_id rows.** Reason: tracker not in DOM at submit time means there's nothing to recover. 14 + 3 historic NULLs stay null; new submissions carry session_id from Iris's fix forward.

**Open questions:**

- None new this session. Open question from Session 42 (per-provider `sla_dispute_deadline_days`) still parked.

## Watch items

- **Wed first real Riverside submission.** Logs are the source of truth. If sheet append fails or U2 doesn't fire, per-leg logger will say which.
- **TEST_MODE confirmed `false`** in Supabase Vault before Wed traffic. Charlotte flipped it back at session close. Worth confirming again Wed morning before paid traffic flips on.
- **`BREVO_TEMPLATE_U1_EMPLOYER` env var unset** — function warns-and-skips. Employer acks miss until Wren delivers and owner pastes ID in Vault.
- **Three test U2s leaked to Jane today** (lead IDs 410, 411, 412). Charlotte sent ignore-and-delete note. Watch for any reply / confusion from Jane Wed morning.
- **Carry-forward from Session 42** still live: auto-flip cron first scheduled fire (06:00 UTC daily, gated on SLA acceptance + auto_flip_enabled), Net `_http_response` null-status pair from Sessions 40-41.

## Next session

- **Folder:** `platform`
- **First task:** Eyeball Wed launch end-to-end on first real Riverside submission — Edge Function logs (all four legs), sheet row, DB row, U1 lands, U2 lands at Jane (not owner). Investigate `/admin/errors` for anything queued.
- **Cross-project:** No new cross-project pushes from this session. Wren still owes 3 Brevo templates (carried from Session 42). Mable's S4B work fully closed.
