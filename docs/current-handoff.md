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

Switchable for Business v1 backend tested end-to-end and ready for Wed paid traffic (2026-05-13). All four legs (DB insert + sheet append + U1 + U2) verified clean via six owner-test submissions, all flagged and cleaned up. Dashboard views hardened to exclude test rows, 19 missing FK indexes added on hot provider-portal paths, silent Apps Script sheet-append failure mode closed in `_shared/route-lead.ts`, and the standalone `/provider/agreement` page folded into `/provider/account` so the admin `/preview` surface now picks it up. Only outstanding gap is `BREVO_TEMPLATE_U1_EMPLOYER` (Wren delivering); without it employers still get no acknowledgement email but every other leg fires cleanly. Three test U2s leaked to Jane mid-session before TEST_MODE landed — Charlotte sent ignore-and-delete note.

## What was done this session

**Addendum 3 (late session) — dashboard reconciliation, perf pass, agreement UX:**
- **0136 / 0137** — Dashboard views (`crm.vw_provider_billing_state`, `crm.vw_provider_performance`) extended to exclude `is_dq=true` rows. 0136 introduced a bug (providers with only-test enrolments disappeared instead of showing zeros); 0137 fixed it by pushing the filter into `count(*) FILTER (WHERE …)` clauses rather than top-level WHERE.
- **Data-ops 027** — deleted 6 stale `status='open'` test enrolment rows from `crm.enrolments` (3 Riverside today + 3 EMS from late-April). Submissions kept for audit (`is_dq=true`, `dq_reason='owner_test*'`).
- **`_shared/route-lead.ts` silent sheet-append failure fix.** Previous `catch { return { ok: true }; }` after `res.json()` treated any non-JSON Apps Script response as success. Replaced with explicit `{ ok: false, error: 'apps script: unparseable response …' }`. Root cause of **submission 267 (Christy Clarence, real Hartlepool lead, 4 May)** marked `delivery_status='sent'` in DB but never actually appended to EMS sheet — sat 8 days uncalled before EMS-sheet-vs-DB diff surfaced it. Recovered by manually adding to Andy's sheet. All five functions importing `_shared/route-lead.ts` redeployed: `netlify-lead-router`, `netlify-employer-lead-router`, `routing-confirm`, `admin-test-email`, `admin-brevo-resync`.
- **0138** — 19 missing FK indexes added across `crm.*` / `leads.*` / `audit.*`. Provider portal hot paths covered (`crm.lead_notes.{provider_user_id, author_user_id}`, `crm.enrolments.routing_log_id`, `crm.sheet_edits_log.submission_id`, `crm.billing_events.*`, `crm.support_requests.provider_user_id`, `leads.submissions.parent_submission_id`); rest is admin/audit hygiene. `crm.sheet_edits_log` was already 57.6% sequential scans on 191 rows.
- **Agreement folded into Account.** Standalone `/provider/agreement` nav tab removed. PPA summary + SLA thresholds + both-sides obligations + Notion reference now render as a "Pilot agreement" card inside `/provider/account` (visible to all team roles). Same card now appears inside `/admin/preview/[provider_id]/account` so Charlotte can see each provider's agreement when viewing-as. Components extracted to `app/app/provider/agreement-section.tsx` with exported `AGREEMENT_COLUMNS` constant for the parent pages.
- **`/provider/agreement` kept as a redirect** to `/provider/account` so bookmarks/email links still resolve. `provider-shell.tsx` `Active` type narrowed: nav is now Home / Leads / Support / Account.
- **Migration drift cleared.** 0134 + 0135 had been applied via SQL editor without `supabase_migrations.schema_migrations` rows. Repaired via `supabase migration repair --status applied 0134 / 0135` before pushing 0136 / 0137 / 0138.

**Session 43 main work (earlier):**
- **`netlify-employer-lead-router` Edge Function rewritten in three passes** after Charlotte's first happy-path test exposed:
  - Sheet append payload shape was `{mode:"append", fields:{"Submission ID":...}}` (sheet header names, no token); Apps Script v2 appender returned `{ok:false, error:'unauthorized'}` silently. Rewritten to mirror `_shared/route-lead.ts` verbatim: `{token, mode:"append", submission_id, ...}` (flat snake_case payload keys, token in body).
  - Post-route fan-out `Promise.allSettled` now logs each leg's rejection by name (`post-route leg sheet-append failed:`). Previously swallowed individual leg failures.
  - `TEST_MODE` + `OWNER_TEST_EMAIL` env-var pair added. When `TEST_MODE='true'`, U2 (provider notification) redirects to `OWNER_TEST_EMAIL`, cc_emails stripped, subject prefixed `[TEST]`. If TEST_MODE=true but OWNER_TEST_EMAIL not set, U2 skips entirely. Replaces the SQL-swap-then-test pattern that failed safely-three-times today.
- **Migration 0134** added `crm.providers.site_slug TEXT` (nullable) + partial unique index `WHERE site_slug IS NOT NULL`. Riverside backfilled to `'riverside'`. Groundwork for v2 multi-apprenticeship-provider redirect.
- **Migration 0135** exposed `free_enrolments_cap` on `crm.vw_provider_billing_state` SELECT. Admin UI updated in lockstep: selects new column, displays `used / cap` (was `remaining / 3`). Riverside (PPA v2 cap=1) now renders as `0 / 1`.
- **Admin lead detail page (`/admin/leads/[id]`)** branched on `lead_type`. Employer leads render Company + apprenticeship card; learner leads keep Course + qualification card. Contact card shows Role instead of postcode/LA/region for employers. Fastrack + referral cards stay learner-only.
- **Apps Script v2 appender** (`platform/apps-scripts/provider-sheet-appender-v2.gs`) FIELD_MAP extended with 19 employer / B2B aliases. Funded provider scripts unaffected.
- **Riverside data fix.** `UPDATE crm.providers SET free_enrolments_remaining = 1 WHERE provider_id = 'riverside-training'` (was 3, semantically wrong for PPA v2 cap of 1).
- **Test cleanup (pre-data-ops-027).** Submissions 401, 408, 410, 411, 412, 413 marked `is_dq=true, dq_reason='owner_test'`. Open enrolment rows for 410-412 deleted manually mid-session (3 EMS test enrolments later swept by data-ops 027).
- **Cross-project closures from Mable:** phone leading-zero strip site-side (commit 85cc319); INCLUDE-block tripwire site-side (commit 38d763f).
- **Iris's session_id tracker fix** — `/business/*` and `/funded/thank-you/` now wired with `partial-tracker.js`.

## Next steps

1. **Wed 2026-05-13 paid traffic launch** — eyeball Edge Function logs for the first real Riverside submission. Verify all four legs (DB insert + sheet append + U1 + U2) fire cleanly. Per-leg logger will name any failure.
2. **Wren: 3 Brevo templates.** `BREVO_TEMPLATE_U1_EMPLOYER` (employer ack — degrades Wed UX until set, but doesn't break the flow), `BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING` (day-before warning), `BREVO_TEMPLATE_PROVIDER_PRESUMED_FLIPPED` (post-flip dispute window). Latter two only matter once Riverside has open enrolments past day-58.
3. **WYK + Courses Direct sheet-vs-DB reconcile.** EMS-vs-sheet diff this session surfaced one ghost (Christy Clarence) from the silent Apps Script failure window. Same pattern could exist on WYK and Courses Direct — neither has been diffed. Charlotte to paste their sheets, Sasha runs the same diff query she ran for EMS (distinct emails in `leads.submissions` filtered by `primary_routed_to`, `archived_at IS NULL`, `is_dq IS NOT TRUE`).
4. **Provider portal `/provider/leads` N+1 + 500-row sibling fetch.** List page fetches enrolments in a second round-trip after submissions (should be in initial `Promise.all`). Lead detail loads 500 leads for prev/next nav (should be cursor-style: 1 row before + 1 row after current `routed_at`). Bulk-mark action does 3 sequential `SELECT`s where 1 join would do. None urgent until any provider crosses ~500 active leads; worth scheduling before that.
5. **`RealtimeRefresh` `lead_notes` subscription unfiltered.** Currently broadcasts every lead note across every lead to the list page (debounced refresh, but thrashes at scale). Add `filter=submission_id=in.(loaded_lead_ids)` or drop `lead_notes` from list-page subscription entirely and keep it only on lead detail.
6. **Two RLS policies need `(SELECT fn())` wrapping.** `crm.disputes.provider_read_own_disputes` and `leads.fastrack_submissions.provider_read_fastrack_submissions` use unscoped scalar subqueries that re-call `crm.provider_user_provider_id()` per row. Standard Supabase optimisation: wrap as `(SELECT crm.provider_user_provider_id())` so Postgres evaluates once per query. 10-100× speedup at scale on those tables.
7. **Carry forward from Session 42:** owner invites for Andy (EMS), Jane (Riverside, post-first-lead), Marty (CD); republish EMS + WYK sheets from DB before sending invites; mark 25 `sheet_drift_detected` dead-letter rows resolved on `/admin/errors`.
8. **Add session_id coverage to Monday weekly health report.** Track `count(*) FILTER (WHERE session_id IS NULL) / count(*)` on `leads.submissions` weekly. If above ~10%, flag (Mable's tracker gap doesn't reopen silently).
9. **Followup ticket (low priority):** per-provider `sla_dispute_deadline_days` column to replace hardcoded 7-day window in `crm.run_enrolment_auto_flip`. Promote when first PPA negotiation lands a different number.
10. **v2 multi-apprenticeship-provider redirect strategy** — when second apprenticeship provider signs, decide between Netlify form-success-URL branching / client-side action rewrite / `crm.providers.site_slug` mapping. Migration 0134 is groundwork for option C.
11. **Solis Session 2 carry-forward (2026-05-12):**
   - **Schema naming: `ads_business` vs `ads_switchable_business`** for the B2B ads schema. Recommend `ads_switchable_business`. Decide before building the B2B Meta ad data ingest. Update `data-architecture.md` first, ship migration after.
   - **`crm.employer_signings` table design** (or `crm.enrolments` extension with `enrolment_type` discriminator) for closed-loop B2B attribution. Becomes urgent at first Riverside Employer Signed event. Owner approves table shape before migration.

## Decisions and open questions

**Decisions made:**

- **`is_dq IS NOT TRUE` is the single source of truth for "exclude from provider dashboards".** Reason: today's 6 test submissions exposed that the views were counting any routed row regardless of dq flag. Pushed the filter into views (0136/0137); future tests stop polluting counts automatically even if not archived. A dedicated `is_test` column would be cleaner long-term but adds a migration; deferred.
- **Non-JSON Apps Script responses are always failures.** Reason: silent `catch { return ok:true }` pattern in `_shared/route-lead.ts` was the root cause of Christy Clarence (submission 267) sitting in DB as routed-to-EMS but absent from sheet for 8 days. Apps Script always returns HTTP 200 even on errors; only a parseable JSON body with `ok===true` is a real success signal. New rule encoded in the function.
- **Agreement folded into Account, not its own nav tab.** Reason: once-per-pilot reference doesn't merit a top-level nav slot. Folding it into Account also means the admin `/preview/[provider_id]/account` surface picks it up — Charlotte can see each provider's agreement from the impersonation view without a separate `/preview/.../agreement` page.
- **TEST_MODE env-var primitive over SQL-swap-then-test.** Reason: SQL-swap pattern requires editing `contact_email` before the test, reverting after; today three test U2s leaked to Jane because the swap was skipped. TEST_MODE is in code, not data, can't be silently mid-state, and emits a log line.
- **UI displays free credits as `used / cap`, not `remaining / cap`.** Reason: Charlotte's mental model is "X used out of Y allowed".
- **`free_enrolments_cap` appended at end of `vw_provider_billing_state` SELECT.** Reason: Postgres `CREATE OR REPLACE VIEW` rejects column position changes.
- **No backfill of historic NULL session_id rows.** Reason: tracker not in DOM at submit time means there's nothing to recover.

**Open questions:**

- None new this session. Open question from Session 42 (per-provider `sla_dispute_deadline_days`) still parked.

## Watch items

- **Wed first real Riverside submission.** Logs are the source of truth. If sheet append fails or U2 doesn't fire, per-leg logger will name which.
- **TEST_MODE confirmed `false`** in Supabase Vault before Wed traffic. Charlotte flipped it back at session close. Worth confirming again Wed morning before paid traffic flips on.
- **`BREVO_TEMPLATE_U1_EMPLOYER` env var unset** — function warns-and-skips. Employer acks miss until Wren delivers and owner pastes ID in Vault.
- **Three test U2s leaked to Jane today** (lead IDs 410, 411, 412). Charlotte sent ignore-and-delete note. Watch for any reply / confusion from Jane Wed morning.
- **Christy Clarence (submission 267)** — manually added to EMS sheet today after 8 days unsent. Watch for Andy's first contact note; if she's already moved on, no recovery. No billing impact regardless (within EMS's first-3-free allowance).
- **Carry-forward from Session 42** still live: auto-flip cron first scheduled fire (06:00 UTC daily, gated on SLA acceptance + auto_flip_enabled), Net `_http_response` null-status pair from Sessions 40-41.

## Next session

- **Folder:** `platform`
- **First task:** Eyeball Wed launch end-to-end on first real Riverside submission — Edge Function logs (all four legs), sheet row, DB row, U1 lands, U2 lands at Jane (not owner). Investigate `/admin/errors` for anything queued.
- **Cross-project:** No new cross-project pushes from this session. Wren still owes 3 Brevo templates (carried from Session 42). Mable's S4B work fully closed.
