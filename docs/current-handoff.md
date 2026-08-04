# Platform Handoff, Session 87, 2026-08-04

## Current state

Large SMS + fastrack + sheet session. Learner fastrack display + confirmation now handle all four reconfirm gates (L3 / earnings / support-role / business-status); SMS sends without a rep number for no-rep courses; the B2B employer SMS lifecycle (initial-on-routing + chaser) is live and auto-fire is verified; cross-channel employer dedup is live and provider-agnostic. Sheets are retired operationally — 0 providers write to a sheet. A null-webhook regression (from the EMS cutover) was found and fixed mid-session.

## What was done this session

- **Fastrack display fix (provider portal + admin).** Was hardcoded to L3 (EMS saw a phantom "L3 reconfirmed: No" on Immediate Impact). Now renders whichever reconfirm the course asked; hides not-asked rows. Also fixed the qualify-ack gate in fastrack-receive to cover business_status. Alan (758) backfilled via data-op 052.
- **EMS sheet cutover (data-op 053)** + **fixed the regression it caused.** A null `sheet_webhook_url` was treated as a sheet-append FAILURE in `_shared/route-lead.ts`, so EMS learner leads dead-lettered, emailed the owner "sheet append failed", and returned early BEFORE the provider notification. Fix: null webhook = clean skip; sheet backup link gated on the webhook. Redeployed netlify-lead-router + routing-confirm.
- **New EF `provider-renotify`** (x-audit-key auth): re-sends the standard provider notification for a routed lead. Backfilled the 3 EMS leads (762/764/766) that missed theirs during the regression window.
- **Removed the auto-route owner FYI email** (was false-alarming "sheet append failed" on EMS).
- **SMS no-rep fallback + number-less variants** (all sms-enabled providers, owner decision). Alan's York chaser sent.
- **B2B employer SMS.** Employer chaser (Shelley #736 test sent) + B2B initial-on-routing. Migration 0238 (`sms_log.comm_type` CHECK += `employer_intro`) fixed the initial silently failing; Paul (763) backfilled via a new `kind` param on sms-chaser-attempt-1. **Auto-fire VERIFIED**: Andy (#767/#768) both got `employer_intro` automatically.
- **Cross-channel employer dedup (provider-agnostic)** in `_shared/employer-lead-core.ts`. Matches a routed employer lead by email (or phone normalised to last-10-digits) to a recent (14-day) non-dupe lead for the SAME `primary_routed_to`; flags dupe + skips routing/fan-out. Migration 0239 (`enrolments.lost_reason` += `duplicate`). Andy #767 marked dupe of #768 (kept richer), enrolment 786 closed.
- **Sheet retirement completed.** WYK + Courses Direct webhooks nulled (data-op 054; both dormant/inactive). Sheet-activity tab removed from admin nav. 0 providers on sheets; drift cron already disabled.
- Deployed many EFs; changelog updated per change. Memory index consolidated (12 files → 5).

## Next steps

1. **FINISH SHEET CODE REMOVAL (platform — do first, with a clear head).** Owner: remove Google access from the existing WYK + Courses Direct sheets so no provider can accidentally use them. Platform: this is BIGGER than it looked (surfaced S87) — the sheet code is threaded through the live lead router (`route-lead.ts`, 12 refs), `employer-lead-core.ts` (14 refs), `crm-webhook-receiver`, the pending-update flow (`pending-update-confirm` / `pending-update-token`), `dead-letter-alert-cron`, the shared `_shared/sheet-status.ts`, 5 standalone EFs (backfill-sheet-submission-ids, reconcile-sheet-to-db, republish-provider-sheet, sheet-drift-reconcile-daily, sheet-edit-mirror), and ~4 admin screens (sheet-activity/, errors sheet panel + reconcile-actions, actions/page.tsx). It's 100% DORMANT + harmless now (0 providers on sheets, cron off) so ZERO urgency — but it's a proper interconnected refactor that must not be rushed (route-lead is the live lead path; broke once already S87). Order: remove admin UI → remove standalone EFs + config entries → untangle the live-path refs (route-lead/employer-lead-core/crm-webhook-receiver) with deno-check + deploy → migration to drop `crm.providers.sheet_webhook_url` + `sheet_id` LAST (after all code refs gone). Full app typecheck + per-EF deno-check throughout.
2. **PRETTY LINKS — DONE + LIVE (S87).** Fastrack SMS + emails now send `switchable.org.uk/go/<code>` (mint via short_links, resolves through the `go` netlify function → go-resolve EF → 302 to the real thank-you). Long-URL fallback if mint ever fails. Verified end to end with a real emit-minted code (758 → `/go/3m6hc9` → correct thank-you). Referral + portal links were already clean, left alone.
   - **Only follow-up (not urgent): Brevo SW_FASTRACK_URL backfill.** Existing contacts keep their OLD long URL until re-upserted; long URLs still work, and brevo-attribute-reconcile now treats the short URL as canonical and converges them over its daily runs. A one-shot re-upsert can force it if wanted.
   - **Decided design (owner, this session):** short-link `switchable.org.uk/go/<code>` where `<code>` is a ~6-char unguessable code, readable charset (exclude look-alikes `0/o/1/l`), lowercase. Not a first name (GDPR — no PII in URLs), not the course slug (too long), not word-pairs. On the branded domain after `/go/` it reads as a normal short link.
   - **DONE (S87):** platform `short_links` table (0240) + `_shared/short-link.ts` (mint + resolve) + `go-resolve` EF; and the SITE `/go/<code>` route (switchable-site repo: `netlify/functions/go.js` + netlify.toml `/go/*` rewrite). **Verified live end to end** — `switchable.org.uk/go/<code>` 302s to the correct thank-you page; unknown code → homepage.
   - **ONLY REMAINING = the platform emit-flip.** Make `buildFastrackUrl` (route-lead.ts, 3 call sites in the Brevo attribute builders — `SW_FASTRACK_URL` at ~936/1182/1298) + `buildFastrackUrlForSms` (sms-utility.ts, `fireFastrackLinkSms`) async, mint a code via `mintShortLink(sql, submissionId)` and emit `switchable.org.uk/go/<code>` instead of the long URL — **with a graceful fallback to the long URL if mint fails** (zero risk of broken links). Then redeploy netlify-lead-router + fastrack-receive + sms-fastrack-prompt-cron + the other route-lead importers, and **verify with a real test send** (SMS + a nurture email) that the rendered link is `/go/<code>` and resolves. Deliberately NOT done S87 — it's a live email-attribute + SMS refactor, do it fresh with a test send. Once done, both SMS and emails go short automatically (site route already live).
3. **Watch the B2B initial keeps auto-firing** on employer leads (verified once on Andy).
4. **CARRIED S82 (owner decides):** revenue-backfill button + revenue/profit on the tracker (~£2,100 collected, `billed_amount` null on every enrolment, `crm.billing_events` empty).
5. **Optional polish:** Ltd/Limited trim in B2B SMS ("Riverside Training Limited"); switch off `sms_utility_enabled`/`sms_chaser_enabled` on the 3 demo providers.
6. **Multi-provider employer routing (only if launching Instant Forms for other providers).** `employer-lead-core` hardcodes Riverside as `primary_routed_to`; the dedup is already provider-agnostic but routing isn't. A design was drafted (payload `provider` field, validated, Riverside default, DQ on unknown) but NOT built this session.
7. **CARRIED:** Clara B2B consent review; Notion Tech Stack date bump; revoke leaked GitHub PAT (S81); verify B2C CAPI on next organic DQ lead (S81).
8. **CARRIED (grew): 14-EF `_shared` sweep** — many EFs bundle the changed `_shared` modules and run old code (no live risk). Redeploy to keep deployed = committed.

Note: Work Hub capture blocked again (`get_task_capture_key` permission denied over the MCP). Steps 1-6 live here only; the two big ones are finish-sheet-removal and pretty-links.

## Decisions and open questions

- **Number-less SMS applies to ALL sms-enabled providers** (owner decision), not EMS-only.
- **`sms_log.comm_type` (0238) and `crm.enrolments.lost_reason` (0239) both have CHECK constraints** — any new value needs a migration. (sendSms swallows an insert failure silently — a bad comm_type fails invisibly; noted as a robustness follow-up.)
- **Auto-dedup keeps the FIRST arrival.** Andy was manually kept as the richer SECOND — automation can't predict richness, so first-wins is the default; re-mark by hand for exceptions.
- **Sheets retired** (0 providers). Future providers onboard to the portal.
- **Open (carried S82):** presumed-billing policy; revenue backfill.

## Watch items

- **B2B initial SMS auto-fire** — verified once (Andy); keep an eye it keeps firing on real employer leads.
- **Cross-channel dupes** now caught automatically; but Andy already got 2 SMS + 2 provider emails before the dedup shipped (pre-dedup, not clawed back).
- **CARRIED: Meta spend stale** in `ads_switchable.meta_daily` since 1 July.
- `platform/weekly-notes.md` has an uncommitted change not from this session (Sasha's Monday output); left as-is.

## Next session

- **Folder:** `platform/`
- **First task:** Finish the sheet-code removal (owner pulls WYK/CD Google access in parallel), then the pretty-links audit across SMS + email.
- **Cross-project:** Pretty links (step 2) likely needs `switchable/site` (Mable — build the `/f/{token}` short-link) and `switchable/email` (Wren — email deep-links). Flag to their handoffs when the shortener approach is decided.
