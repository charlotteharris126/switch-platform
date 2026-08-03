# Platform Handoff, Session 87, 2026-08-03

## Current state

Platform SMS and fastrack surfaces were overhauled this session around the EMS York bootcamp and Riverside employer launches. Learner fastrack display + confirmation now handle all four reconfirm gates (L3 / earnings / support-role / business-status); SMS sends without a rep number for no-rep courses; the B2B employer SMS lifecycle (initial-on-routing + chaser) is live. EMS is fully cut over to the portal (sheet writes off, Google access revoked). Carried items from S82 (revenue backfill), S84 (clear-cache deploy), and S86 (14-EF sweep, Clara consent) remain open and untouched.

## What was done this session

- **Fastrack display fix (provider portal + admin).** The fastrack panel was hardcoded to L3, so EMS saw a phantom "L3 reconfirmed: No" on Immediate Impact (a business-status course) while the real answer was hidden. Now renders whichever reconfirm the course actually asked (L3 / earnings / support-role / business-status), keyed off the non-null column, and hides not-asked rows. Files: provider `lead-detail-view.tsx` + `page.tsx`, admin `leads/[id]/page.tsx`.
- **Fastrack qualify-ack gate fix (fastrack-receive).** The `u_fastrack_qualified` email + save-number SMS gate only covered L3 / earnings / support-role, so business-status learners got no confirmation. Added the business-status clause. Backfilled Alan (758) via data-op 052 (delete child row + replay stored raw_payload through the fixed EF): email sent; save-number SMS correctly skipped (York has no dedicated rep).
- **EMS sheet cutover.** Owner removed EMS's Google Drive access; nulled EMS `sheet_webhook_url` (data-op 053). EMS confirmed active on the portal (6 users, last login 2026-08-03). WYK + Courses Direct stay on sheets.
- **Removed the auto-route owner FYI email** (netlify-lead-router) — it false-alarmed "Sheet append failed, paste manually" on EMS portal-only leads. Action-needed emails (manual-confirm, fallback) untouched; real failures still hit dead_letter.
- **SMS no-rep fallback + number-less variants.** `resolveSmsContact` prefers the regional rep, else the provider general line (`contact_phone`), else a number-less body that drops the "save their number" clause. Dropped the rep-phone gate. Owner decision: applies to ALL sms-enabled providers, not EMS-only. Alan's York chaser sent.
- **Employer (B2B) SMS path.** Threaded `lead_type` through `SubmissionRow` + `SUBMISSION_FULL_COLUMNS`; employer leads bypass the gov/loan funding gate; employer chaser wording ("training enquiry", no course/"your place", no "apprenticeship" per Riverside's steer). Shelley (736) test chaser sent.
- **B2B initial SMS** (`fireEmployerInitialSms`) as a 4th leg in the employer post-route fan-out (fires on routing, alongside the U1 employer email).
- **Migration 0238** added `employer_intro` to the `sms_log_comm_type_check` CHECK. The B2B initial was silently failing (constraint reject swallowed by sendSms); first hit Paul (763). Backfilled Paul via a new optional `kind` param on `sms-chaser-attempt-1` (`chaser` | `employer_initial`): sent.
- **Deployed** to switch-platform main: fastrack-receive, netlify-lead-router, sms-chaser-attempt-1, sms-fastrack-prompt-cron, netlify-employer-lead-router, meta-instant-employer-lead-router. All changes committed; changelog updated per change.

## Next steps

1. **Verify the B2B initial SMS auto-fires on the NEXT real employer lead.** Paul's was a manual backfill via `kind`; the automatic fan-out path has not fired a fresh lead since the 0238 constraint fix. Watch the next genuine `/business/` or Instant Form employer enquiry land an `employer_intro` row in `crm.sms_log`.
2. **CARRIED FROM S84 (owner ~2 min): clear-cache deploy the platform app.** Removes the `DBG-SRV` banner on Riverside's portal + activates `focus_area` on the admin preview. Netlify to platform app to Deploys to "Clear cache and deploy site".
3. **CARRIED FROM S82 (owner decides):** revenue-backfill button on `/admin/data-ops` + revenue/profit on the tracker. ~£2,100 collected, `billed_amount` null on every enrolment, `crm.billing_events` empty. Then backfill 14 EMS + 1 WYK if yes.
4. **Optional polish:** trim "Ltd/Limited" from `company_name` in B2B SMS rendering (reads "Riverside Training Limited"). One-line in `resolveSmsContact` (`_shared/sms-utility.ts`).
5. **Optional:** switch off `sms_utility_enabled` / `sms_chaser_enabled` on the 3 demo providers (demo-b2b / demo-b2c / demo-provider-ltd) so they can't fire real SMS now the rep-phone gate is gone.
6. **composeFastrackNotes** (fastrack-receive) omits `business_status_reconfirmed` from the EMS sheet summary. Cosmetic (portal shows it); fold into the next fastrack-receive change.
7. **sendSms robustness:** it swallows sms_log insert failures (no throw, no dead_letter), and the employer fan-out audit field `employer_sms_sent` reads leg-completion not send-success. Surface insert failures + fix the audit field so a future bad comm_type isn't silent.
8. **CARRIED FROM S86: 14-EF `_shared` sweep** (grew this session with more `_shared` edits). Still-stale importers to redeploy: admin-brevo-resync, admin-notify-callback, admin-test-email, backfill-sw-provider-contact-block, brevo-attribute-reconcile, drift-digest-daily, iris-daily-flags, meta-ads-ingest, republish-provider-sheet, routing-confirm, sheet-drift-reconcile-daily, sheet-edit-mirror. (sms-chaser-attempt-1 + sms-fastrack-prompt-cron now deployed.)
9. **CARRIED:** Clara B2B consent-wording review (Hub open); Notion Tech Stack "Last updated" date bump; revoke leaked GitHub PAT (S81); verify B2C CAPI fix on next organic DQ lead (S81).

**Note: Work Hub capture was blocked this session** (`get_task_capture_key` permission denied over the MCP, same as S86), so steps 4-7 above were NOT filed as Hub tasks. They live here in Next steps only. Would-have-filed (all `platform`): demo-provider SMS flags off; composeFastrackNotes business_status gap; sendSms swallows insert failures + `employer_sms_sent` audit accuracy; Ltd/Limited trim in B2B SMS.

## Decisions and open questions

- **Number-less SMS applies to ALL sms-enabled providers** (owner decision), not EMS-only. Newly activates SMS for WYK + Riverside on gov/loan leads, and the demo providers if they ever get a real lead, hence the demo-flags follow-up (step 5).
- **`crm.sms_log.comm_type` has a CHECK constraint** (widened in 0238). Any new `SmsLogType` value needs a migration. Corrected an earlier wrong "comm_type is unconstrained" assumption from the B2B-initial build.
- **EMS sheet retired** (writes off + Google access revoked). The 26 sheet-stale drift rows in `/admin/errors` should now settle. WYK + Courses Direct stay on the sheet route; the shared reconcile-sheet-to-db cron stays for them.
- **Open (carried S82):** does a provider marking "Presumed Enrolled" ever become billable? Policy call needed before any presumed is billed. Revenue-backfill decision (step 3).

## Watch items

- **B2B initial SMS auto-fire** on the next real employer lead (unproven since the 0238 fix; Paul was a manual backfill).
- **CARRIED: `DBG-SRV` banner** on Riverside's portal until the clear-cache deploy lands.
- **CARRIED: Meta spend stale** in `ads_switchable.meta_daily` since 1 July.
- **26 sheet-stale drift rows** in `/admin/errors` — watch they clear now the EMS sheet is off.
- `platform/weekly-notes.md` has an uncommitted change not from this session (Sasha's Monday output); left as-is.

## Next session

- **Folder:** `platform/`
- **First task:** Verify the B2B initial SMS auto-fired on the latest real employer lead (`employer_intro` in `crm.sms_log`). Then the carried S84 clear-cache deploy and the S82 revenue-backfill owner decision.
- **Cross-project:** None required. Riverside is Nell's client (`switchleads/clients/`) but the employer SMS lifecycle is platform-internal; nothing pushed there.
