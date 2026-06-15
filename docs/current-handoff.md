# Platform Handoff, Session 75, 2026-06-15

## Current state
Server-side Meta Conversions API for the Lead event is live for both brands (B2C + B2B), fired directly from the lead routers as an owned, monitored path alongside the browser pixel + Stape, deduped by the shared event_id. Built after B2B server events were found silently dropped (only browser events recording in Events Manager). B2C verified live (HTTP 200, events_received 1); B2B awaits verification on the next real employer lead. Session 74's private-pay work is shipped but still has its own open verification items (carried forward below).

## What was done this session
- **Root cause found:** B2B CAPI showed browser-only events. The conversion only travelled the unmonitored browser→GTM→Stape→Meta chain (free Stape tier, auto-disables on low traffic), so a failure was silent. The Stape B2B subdomain (`b2b.switchable.org.uk`) and the GTM forwarder URL + the Stape CAPI tag config all checked out, so the fix is an owned redundant server path, not a Stape patch.
- **Migration 0213 (applied):** `leads.submissions.event_id/fbp/fbc` (the dedup key + cookies the routers already received via meta-dedup.js hidden inputs but discarded) + new table `leads.capi_log` (per-send audit). Additive; column grants to `functions_writer`; not exposed to `readonly_analytics`.
- **`_shared/meta-capi.ts` (new):** `sendCapiLead` (SHA-256 hashes PII, rebuilds fbc from fbclid, POSTs Lead to graph.facebook.com v21, never throws) + `logCapiSend`.
- **Routers wired:** `netlify-employer-lead-router` (B2B, pixel 1386293849929367, value 400, content_category employer_lead) on the routed path; `netlify-lead-router` + `_shared/ingest.ts` (B2C, pixel 1163964622558929) for PRIMARY leads only (`parent_submission_id IS NULL` AND event_id present), matching the browser-pixel population.
- **Value-mapping bug caught by the live test:** funded leads are `funding_category='gov'` (not `'funded'`); first code tagged them £100. Fixed to `gov→150 / else→100` and redeployed.
- **Migration 0214 (applied):** `capi-reconcile-daily` cron (08:10 UTC, active) — compares expected vs successfully-sent CAPI per brand over 25h and emails the owner on any gap/failure. New EF deployed, verify_jwt=false, x-audit-key auth.
- **Deploys:** 0213+0214 pushed (history was in sync, no repair needed); `netlify-lead-router`, `netlify-employer-lead-router`, `netlify-leads-reconcile`, `capi-reconcile-daily` deployed. `META_CAPI_ACCESS_TOKEN` set by owner (System User, never-expire, both pixels).
- **Governance:** data-architecture.md + changelog updated; full plan at `docs/capi-server-side-scoping-2026-06-15.md`.

## Next steps
1. **Verify B2B CAPI** on the next real employer lead: check its `leads.capi_log` row reads http_status 200 / events_received 1 (deliberately not tested to avoid a junk lead to Riverside).
2. **Rotate the access token:** it was pasted into chat twice. Owner regenerates (System User → Generate New Token → Never), then swap the `META_CAPI_ACCESS_TOKEN` Supabase secret.
3. (Carried from S74) Send a Brevo test of template `76` against a contact whose course has a start date to confirm `SW_COURSE_INTAKE_DATE` renders.
4. (Carried from S74) Verify the Netlify builds landed (admin app + switchable-site): EMS preview shows Saranya with a "Private pay" badge + "bill them directly" banner.
5. (Carried from S74) Watch the first brand-new private-pay lead end to end: auto-routes, shows "Private pay", appears in the portal with the price, gets template 76.

## Decisions and open questions
- **Keep Stape, add an owned server path** for the Lead event. Stape isn't the fault; the lack of monitoring + single fragile chain was. The server send is the guarantee; the daily reconcile is the alarm.
- **Fire CAPI for primary leads only** (`parent_submission_id IS NULL`), matching the browser pixel, so re-applications/children don't inflate paid-lead counts.
- **Value:** B2B 400; B2C gov 150 / else 100. NB DB enum is `gov`/`self`/null, never `funded`.
- (S74) Private-pay leads auto-route with no owner approval; `is_dq` stays true; `accepts_private` is per-provider-per-course.
- Open: none blocking.

## Watch items
- **B2B CAPI unverified** until the next real employer lead lands (B2C proven).
- **Exposed token** still live until rotated (step 2).
- The pre-existing `trx.json` Deno type error in `route-lead.ts` persists (does not block deploy).
- (S74) Saranya (639) got the funded U1 pre-fix (can't unsend); her `private_price_quoted` is NULL (predates the column).
- (S74) Confirm the late-session Netlify builds (admin app + switchable-site) rendered before relying on portal/site display.

## Next session
- **Folder:** platform
- **First task:** verify the B2B `capi_log` row on the next real employer lead, and rotate the exposed CAPI token + update the secret.
- **Cross-project:** switchable/ads-business (Solis) — the B2B CAPI tracking gap from her S14 handoff is now fixed server-side; pushed to her handoff and the existing Hub task `e4c1b06a` (`switchable-ads`) updated (CAPI-value half done, sector-diversify remains). Iris (switchable/ads) benefits too but no action needed there.
