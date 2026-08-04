# Platform Handoff, Session 87, 2026-08-04

## Current state

Large multi-part session, all shipped: learner fastrack display + confirmation now cover all four reconfirm gates; the SMS system was reworked (no-rep fallback + number-less variants; B2B employer initial-on-routing + chaser, auto-fire verified; provider-agnostic cross-channel employer dedup); a null-webhook regression from the sheet cutover was found and fixed; sheets are retired operationally (0 providers write to a sheet); and **pretty links are built end to end and LIVE** — fastrack SMS + emails now send `switchable.org.uk/go/<code>`. The one remaining piece is the dormant sheet CODE teardown.

## What was done this session

- **Fastrack fix (portal + admin + gate).** Renders the reconfirm each course actually asked (L3 / earnings / support-role / business-status), not a hardcoded L3; qualify-ack email + save-number SMS gate extended to business_status. Alan (758) backfilled via data-op 052.
- **EMS sheet cutover (053) + fixed the regression it caused.** Null `sheet_webhook_url` was treated as a sheet-append FAILURE in `route-lead.ts` → dead-lettered, emailed the owner "sheet append failed", and skipped the provider notification. Fixed: null webhook = clean skip. New EF `provider-renotify` backfilled the 3 EMS leads (762/764/766) that missed theirs.
- **Removed the auto-route owner FYI email** (false-alarmed "sheet append failed" on EMS).
- **SMS no-rep fallback + number-less variants** (all sms-enabled providers). Alan's York chaser sent.
- **B2B employer SMS:** chaser (Shelley #736) + initial-on-routing. Migration 0238 (`sms_log.comm_type` += `employer_intro`) fixed the initial silently failing; Paul (763) backfilled via a new `kind` param on sms-chaser-attempt-1. Auto-fire VERIFIED (Andy #767/#768).
- **Cross-channel employer dedup (provider-agnostic)** in employer-lead-core (email/phone match to a recent lead for the same `primary_routed_to`). Migration 0239 (`enrolments.lost_reason` += `duplicate`). Andy #767 marked dupe of #768; enrolment 786 closed.
- **Sheet retirement completed** operationally. WYK + Courses Direct webhooks nulled (data-op 054; both dormant). Sheet-activity tab removed from admin nav. 0 providers on sheets; drift cron already off.
- **Pretty links END TO END + LIVE.** Migration 0240 (`leads.short_links`), `_shared/short-link.ts` (mint + resolve, 6-char clean code), `go-resolve` EF; site `/go/<code>` route (switchable-site repo: `netlify/functions/go.js` + netlify.toml rewrite); emit-flip = new `buildFastrackUrlShort` wired into all 3 `SW_FASTRACK_URL` producers + the SMS `fireFastrackLinkSms`, with a long-URL fallback if mint fails. Redeployed the 7 emitters. Verified live: 758 → `/go/3m6hc9` → correct thank-you page.
- Memory index consolidated (12 files → 5).

## Next steps

1. **FINISH SHEET CODE REMOVAL (platform — the main remaining job, do with a clear head).** Owner: pull Google access from the WYK + Courses Direct sheets. Platform: it's an interconnected refactor (surfaced S87) — sheet code runs through the live lead router (`route-lead.ts`), `employer-lead-core.ts`, `crm-webhook-receiver`, the pending-update flow, `dead-letter-alert-cron`, `_shared/sheet-status.ts`, 5 standalone EFs (backfill-sheet-submission-ids, reconcile-sheet-to-db, republish-provider-sheet, sheet-drift-reconcile-daily, sheet-edit-mirror), and ~4 admin screens. 100% dormant now (0 providers, cron off) so ZERO urgency. Order: admin UI → standalone EFs + config → untangle live-path refs (deno-check + deploy each) → migration to drop `crm.providers.sheet_webhook_url` + `sheet_id` LAST. Full app typecheck + per-EF deno-check throughout.
2. **Brevo SW_FASTRACK_URL backfill (NOT urgent).** Pretty links are live; existing Brevo contacts keep their OLD long URL until re-upserted (long URLs still work). brevo-attribute-reconcile now treats the short URL as canonical and converges contacts over its daily runs — a one-shot re-upsert can force it if wanted.
3. **CARRIED S82 (owner decides):** revenue-backfill button + revenue/profit on the tracker (~£2,100 collected, `billed_amount` null on every enrolment, `crm.billing_events` empty).
4. **Multi-provider employer routing (only if launching Instant Forms for other providers).** `employer-lead-core` hardcodes Riverside as `primary_routed_to`; the dedup is already provider-agnostic but routing isn't. A design was drafted (payload `provider` field, validated, Riverside default, DQ on unknown) but NOT built.
5. **Optional polish:** Ltd/Limited trim in B2B SMS ("Riverside Training Limited"); switch off `sms_utility_enabled`/`sms_chaser_enabled` on the 3 demo providers.
6. **CARRIED:** Clara B2B consent review; Notion Tech Stack date bump; revoke leaked GitHub PAT (S81); verify B2C CAPI on next organic DQ lead (S81).
7. **CARRIED (grew): 14-EF `_shared` sweep** — many EFs bundle changed `_shared` modules and run old code (no live risk); redeploy to keep deployed = committed.

Note: Work Hub capture blocked all session (`get_task_capture_key` permission denied over the MCP). Steps live here only; the big one is finish-sheet-removal.

## Decisions and open questions

- **`sms_log.comm_type` (0238) and `crm.enrolments.lost_reason` (0239) both have CHECK constraints** — any new value needs a migration. (sendSms swallows an insert failure silently — noted robustness follow-up.)
- **Number-less SMS applies to ALL sms-enabled providers** (owner decision).
- **Auto-dedup keeps the FIRST arrival.** Andy was manually kept as the richer SECOND — automation can't predict richness; re-mark by hand for exceptions.
- **Sheets retired** (0 providers); future providers onboard to the portal.
- **Pretty-link token = `switchable.org.uk/go/<6-char code>`** (owner-locked): not a name (GDPR), not the course slug (too long), not word-pairs. `SW_FASTRACK_URL` now emits it; old contacts on the long URL until re-upserted (both work).
- **Open (carried S82):** presumed-billing policy; revenue backfill.

## Watch items

- **B2B initial SMS auto-fire** — verified once (Andy); keep an eye it keeps firing on real employer leads.
- **CARRIED: Meta spend stale** in `ads_switchable.meta_daily` since 1 July.
- `platform/weekly-notes.md` has an uncommitted change not from this session (Sasha's Monday output); left as-is.

## Next session

- **Folder:** `platform/`
- **First task:** the sheet code teardown (owner pulls WYK/CD Google access in parallel) — ordered + fully scoped in Next step 1.
- **Cross-project:** Pretty links touched `switchable/site` (Mable) — the live `/go/<code>` route (`netlify/functions/go.js`). Pushed to Mable's site handoff. No further site action needed; the platform emit already sends the short link.
