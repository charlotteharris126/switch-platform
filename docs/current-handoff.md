# Platform: Current Handoff: 2026-04-30 (Session 20 closed) — open-row backfill, /admin/leads upgrades, Brevo 3-state push + reconcile, status-driven auto-sync

**Session type:** Long mixed session. Started by diagnosing a reporting defect (only 1 open enrolment row of 113 routed leads), pivoted into the dashboard upgrades that flow downstream, then took on the queued no-match Brevo build, then bridged DB ↔ Brevo into a single source of truth, then closed the third write path so every status change pushes to Brevo automatically.

**Session opened:** 2026-04-30 morning
**Session closed:** 2026-04-30 evening

---

## What we worked on

### 1. Open-row backfill + auto-create at routing time (migrations 0042 + 0043)

- Diagnosed: 113 routed leads but only 16 rows in `crm.enrolments` (12 enrolled + 3 presumed_enrolled + 1 open). 95 active routed leads (91 parents + 4 re-application children) had no row at all. The `/admin/leads` page comment claiming an open row was inserted at routing time was aspirational and never shipped.
- Migration `0042_ensure_open_enrolment.sql` — adds `crm.ensure_open_enrolment(p_submission_id BIGINT, p_routing_log_id BIGINT, p_provider_id TEXT)`. SECURITY DEFINER, idempotent on `(submission_id, provider_id)` via `ON CONFLICT DO NOTHING`. Granted to `functions_writer` and `authenticated`. `functions_writer` keeps zero direct grants on `crm.enrolments` — all writes route through this RPC or `crm.upsert_enrolment_outcome`.
- `_shared/route-lead.ts` — write phase now captures the inserted `routing_log` row id and calls `crm.ensure_open_enrolment` inside the same transaction. Atomic with the routing_log insert + submissions update; if any step fails, the routing rolls back.
- Migration `0043_backfill_open_enrolments.sql` — walks `leads.routing_log` joined to `leads.submissions`, calls `crm.ensure_open_enrolment` for every active routed parent (non-DQ, non-archived, `parent_submission_id IS NULL`). Result: before=17, after=108, inserted=91. First attempt aborted on a brittle "newly inserted vs already-existing" 1-minute-window counter that mis-counted lead 221 (Kirsty McCabe) which had routed during the deploy window — fixed with a simple before/after total comparison. Lead 221 also confirmed Phase 1 working live before Phase 2 ran.
- Stale comment on `/admin/leads/page.tsx` fallback fixed.
- `data-architecture.md` updated with the open-row creation principle.

### 2. /admin/leads upgrades (Lead status / Routed split, multi-select, paste-emails, bulk action)

- Bulk enrolment outcome update: checkbox column on the leads table, master checkbox in the header (with indeterminate state), sticky action bar appears when ≥1 row selected, status button group (open / enrolled / presumed_enrolled / cannot_reach / lost), conditional lost-reason picker, optional notes textarea, "Apply to N" button. Dispute stays single-lead. Server Action loops `crm.upsert_enrolment_outcome` per submission so audit rows are written per lead, returns succeeded / failed counts.
- Status / Routed columns split: "Lead status" shows the actual outcome (Open / Enrolled / Presumed enrolled / Cannot reach / Lost / DQ / Unrouted) with the Reapplied badge alongside; "Routed" column moved to the rightmost position. Status badge label fix: `enrol.status='open'` no longer collapsed to "Routed".
- Lead status filter: started as a single-select pill row, owner asked for multi-select dropdown — refactored to `DropdownMenuCheckboxItem` with comma-separated URL param. Trigger button shows "Any" / single label / "N selected".
- Paste-emails filter: textarea takes a paste of comma- or newline-separated emails, applies on blur or Cmd/Ctrl+Enter. Active count shown as a pill next to the label. Server splits the URL param and filters via case-insensitive `ilike-OR` clauses (Supabase doesn't expose `ilike-IN`). Honoured at every stage.
- Files: `app/app/admin/leads/page.tsx`, `app/app/admin/leads/filters.tsx`, `app/app/admin/leads/bulk-actions.ts` (new), `app/app/admin/leads/bulk-selection.tsx` (new).

### 3. Apps Script v2 prior-note bug — root-caused and patched

- Investigated reported defect: lead 216 (Julie Orange-Benjamin, smm) routed to EMS but the "Previously applied for counselling-skills-tees-valley" note didn't appear on the EMS sheet. `lookupPriorSubmissionNote` query verified directly — DOES find a match for 216. Audit logs show `sheet_appended: true`. No dead_letter row.
- Root cause: `apps-scripts/provider-sheet-appender-v2.gs` FIELD_MAP had no entries for `notes` / `note` / `comment` / `comments`. The script's own line-154 comment said Notes was a manual column. But `route-lead.ts` line 629 said the opposite — Apps Script v2 recognised those headers. Aspirational comment, not actual code. Cross-course duplicate notes have been silently dropped on every provider's sheet since each migrated off v1 (EMS Session 5; WYK Digital + Courses Direct during their onboarding).
- Canonical source patched. Owner redeployed all 3 providers' bound scripts.

### 4. No-match Brevo build (3-state SW_MATCH_STATUS)

- Spec at `platform/docs/no-match-brevo-build.md`. Was queued as the planned first job today; we picked it up after the enrolment work.
- `_shared/route-lead.ts` — refactored `upsertLearnerInBrevo` to branch on `funding_category`. Self-funded skips matrix.json entirely (their `course_id` is a YAML id, not a page slug; matrix lookup was silently failing) and reads `SW_SECTOR` from `submission.interest`. Added `composeBrevoCourseContext` helper. Added `SW_DQ_REASON` to attribute set (populated when `is_dq=true`).
- New exported `upsertLearnerInBrevoNoMatch(sql, submissionId, matchStatus)` — covers `no_match` + `pending` states. Provider attributes empty. Fetches the SubmissionRow internally so callers don't have to assemble it.
- `SubmissionRow` interface gains `dq_reason: string | null`; `routeLead`'s SELECT updated to populate it.
- `netlify-lead-router/index.ts` wiring: DQ or 0 candidates → `upsertLearnerInBrevoNoMatch(..., "no_match")`; email-confirm flow (2+ candidates, or 1 candidate without auto-route) → `upsertLearnerInBrevoNoMatch(..., "pending")` before notifying owner. Auto-route + re-application paths unchanged (matched via `routeLead`).

### 5. SW_ENROL_STATUS attribute (lifecycle segmentation)

- `upsertLearnerInBrevo` reads `crm.enrolments.status` for the (submission, provider) pair and pushes it as `SW_ENROL_STATUS`. LEFT JOIN-equivalent: empty string if no row.
- `upsertLearnerInBrevoNoMatch` hard-codes `SW_ENROL_STATUS=""` — those contacts aren't in the lifecycle yet.
- DB enum `cannot_reach` mapped to Brevo Category value `cannot_contact` at the upsert boundary (`ENROL_STATUS_DB_TO_BREVO` lookup in `_shared/route-lead.ts`). Owner confirmed Brevo Category uses `cannot_contact`. DB stays canonical.

### 6. Brevo backfill (DB ↔ Brevo single source of truth)

- 38 dead_letter 429 errors on first attempt — fired 7 parallel batches of 25 with no throttle. Brevo's contacts API rate-limited.
- Fixed by:
  - `upsertLearnerInBrevo` + `upsertLearnerInBrevoNoMatch` now return `{ ok: boolean; error?: string }`. Failure still writes `dead_letter` (preserving observability) but callers that care can branch on it.
  - `admin-brevo-resync` reports the real per-id status (was always returning `ok` because helpers caught their own errors and returned void). 250ms throttle between Brevo calls inside the loop.
  - Resync function extended to handle DQ leads (push as `no_match` with `SW_DQ_REASON`) and unrouted-qualified leads (push as `pending`). Routed leads keep the existing matched path.
- Re-fired backfill with single batch of all 166 (53 DQ + 113 routed), `pg_net` timeout 200s, sequential server-side processing with throttle. Result: 166 "ok"s, zero dead_letter failures.
- Verified live by GETting Luana Martinez (lead 159) directly via the new `admin-brevo-inspect` Edge Function. Brevo's API returns Category attributes as numeric indices (e.g. `SW_ENROL_STATUS=4` = `cannot_contact`); dashboard decodes them. Owner confirmed all 16 attributes visible in the Brevo dashboard view (they were initially "hidden attributes" in the dashboard UI — owner unhid them).
- Pre-backfill Brevo contact count was ~16 because `BREVO_LIST_ID_SWITCHABLE_UTILITY` env var was only recently set; pre-29-April leads silently skipped via the early-return guard. Backfill created the missing ~150 contacts; existing ones were updated. 6 duplicate emails dedupe to 160 unique contacts.

### 7. New Edge Function: admin-brevo-inspect

- POST endpoint at `/functions/v1/admin-brevo-inspect`. Read-only debug GET against Brevo's contact API by email. Auth via `x-audit-key`. `verify_jwt = false` in `config.toml`. Returns the raw Brevo response so we can see exactly what's stored vs what the dashboard renders.
- Surfaced the "Brevo Category attributes return numeric indices in API responses" behaviour during the SW_ENROL_STATUS rollout — the dashboard was the cache concern, not the upsert.
- Permanent operational tool, registered in changelog.

### 8. Status-driven Brevo auto-sync (migrations 0044 + 0045)

- Closes the gap where DB-side enrolment status changes didn't push to Brevo. Now every status change syncs automatically.
- Migration `0044_sync_leads_to_brevo.sql` — adds `crm.sync_leads_to_brevo(BIGINT[])`. SECURITY DEFINER. Uses `public.get_shared_secret('AUDIT_SHARED_SECRET')` + `pg_net.http_post` to fire `admin-brevo-resync` async with the supplied submission ids. Returns the request_id immediately. Granted to `authenticated`.
- Server Actions wired:
  - `markEnrolmentOutcome` (single-lead) calls `sync_leads_to_brevo([id])` after a successful upsert.
  - `markEnrolmentOutcomeBulk` collects successfully-updated ids, fires once at the end of the loop. So a 50-lead bulk action = one Edge Function call (which then loops with its 250ms throttle), not 50 parallel calls.
- Migration `0045_auto_flip_calls_brevo_sync.sql` — `crm.run_enrolment_auto_flip` rewritten to collect every flipped submission_id (separate from the existing `v_sample` BIGINT[] which stays capped at 10 for telemetry) and fire one `crm.sync_leads_to_brevo` call at the end. Public function shape unchanged. The 3-4 May presumed_enrolled flips for the ~6 oldest EMS leads will sync to Brevo without intervention.
- All three enrolment-status write paths (single-lead form, bulk action, cron) now push to Brevo automatically.

### 9. Owner-side Brevo work (in flight / done during session)

- `SW_ENROL_STATUS` Category attribute added in Brevo with values `open` / `enrolled` / `presumed_enrolled` / `cannot_contact` / `lost`.
- `SW_MATCH_STATUS` Category attribute added with values `matched` / `pending` / `no_match` (was missing — caused the test resync's first attempt to silently drop ALL the new attributes; Brevo's behaviour is to drop the entire attribute update if any single key isn't defined as a Contact Attribute).
- U1 funded + U1 self automations paused for the backfill window. Still pending unpause (see Next steps).
- All 3 providers' bound Apps Scripts redeployed with the canonical v2 + new `notes` / `note` / `comment` / `comments` FIELD_MAP entries.

---

## Current state

DB ↔ Brevo are reconciled. Every lead state in the database has a corresponding Brevo contact with the correct attribute shape; every status change pushes to Brevo automatically across all three write paths (Server Actions + cron). `/admin/leads` ships the bulk action + Lead status filter + paste-emails filter; the Brevo `SW_ENROL_STATUS` attribute updates within seconds of any owner-driven status edit. Email-side U2/U3/U4 build is unblocked.

---

## Next steps

In priority order:

1. **Owner: unpause U1 funded + U1 self automations in Brevo.** They've been paused throughout the backfill window; with 160 contacts now correctly attributed, the entry filter (`SW_MATCH_STATUS=matched AND SW_FUNDING_CATEGORY in (gov, loan)`) routes only the right leads through.
2. **Owner: verify `switchable/email/CLAUDE.md` attribute count is current.** Latest edit lists 17 attrs incl. FIRSTNAME/LASTNAME — quick read-through to confirm SW_DQ_REASON + SW_ENROL_STATUS are in the namespacing block (the linter showed they're already there; just verify).
3. **Three platform secrets overdue rotation** (`BREVO_API_KEY`, `SHEETS_APPEND_TOKEN`, `ROUTING_CONFIRM_SHARED_SECRET`). Ticket `869d0a9q7`. Carrying since 22 Apr.
4. **Quarterly backup restore test** (data-infrastructure rule). Not done this quarter.
5. **Continue platform queue:** Meta ad spend ingestion (#1, blocked on FB device-trust), anomaly detection / Sasha extension (#3).
6. **Watch the 3-4 May auto-flip.** Migration 0045 should flip ~6 oldest EMS leads from `open` → `presumed_enrolled` and push the new state to Brevo automatically. Sasha's Monday scan on 5 May will surface anything that didn't fire.

Carry-forward unchanged from Session 19:
- 2 unresolved sheet-append rows from 23 April (id 89, 90) at the 7-day flag line — owner triage still pending.
- Mira's THE priority for the week is Rosa pipeline reset in `switchleads/outreach/` — not platform.

---

## Decisions / open questions

**Decisions made this session:**

- Re-application children deliberately stay row-less in `crm.enrolments`. Outcome lives on the parent (`leads.submissions.parent_submission_id IS NULL` filter on the backfill).
- DB enum stays `cannot_reach`; Brevo Category stays `cannot_contact`. Translation lives at the upsert boundary (`ENROL_STATUS_DB_TO_BREVO` map in `_shared/route-lead.ts`). Cleaner than renaming either side.
- Bulk action does NOT cover dispute. Dispute carries per-lead reason text and stays on the single-lead form at `/admin/leads/[id]`.
- `/admin/leads` Lead status filter is multi-select via `DropdownMenuCheckboxItem`, not single-select pills. URL param comma-separated. Owner UX preference for ≤6 options is button group; multi-select breaks that rule and requires a panel.
- Paste-emails filter is honoured at every stage (not gated by `stage='all'` like the other filters). It's a hard intent: "show me these specific people".
- Brevo helpers return `{ok, error?}` AND write `dead_letter` on failure. Routing-side callers ignore the result (best-effort posture preserved); resync-side callers thread the result back into the per-id status response.
- 250ms throttle between Brevo calls inside `admin-brevo-resync`. Single-batch backfill with `pg_net` timeout 200s preferred over parallel batches with sleeps (avoids SQL Editor upstream timeout).

**Open questions:**

- Cross-course duplicates (e.g. Julie 209+216, Sue 7+203, Jade 174+175+176) — by design they're separate parents per migration 0026's `(LOWER(email), course_id)` dedup partition. Owner mused on whether to archive them; settled on no — they're real second-course enquiries, the prior-note on the sheet is the cross-course signal. Jade's three submissions in 4 minutes look like clicking around the site rather than three deliberate enquiries; owner can archive 175 + 176 if she wants but isn't blocking on it.
- The owner-built archive feature on `/admin/leads/[id]` is still scoped (admin-dashboard-scoping.md) but not built. No bulk archive yet either. If the cross-course misfire pattern recurs, this becomes higher priority.
- `OWNER_TEST_DOMAINS` (in `_shared/ingest.ts`) does NOT cover `ignoreem.com`-style synthetic test emails — they flow through normal routing and require manual archive. Decision affects whether to add the constant + redeploy. Not blocking. (Carries from Session 19.)

---

## Next session

- **Currently in:** `platform/`. Reconcile complete; status changes auto-sync; bulk action shipped.
- **Next recommended:** `switchleads/outreach/`. Mira's THE priority for the week is the Rosa pipeline reset (Apollo top-up + 11 stale outreach tasks). Platform's queue is steady-state — secrets rotation + backup test are owner-action, no urgent blockers.
- **First thing to tackle (if back in platform):** rotate the three overdue secrets, then quarterly backup restore test.
- **First thing to tackle (if `switchleads/outreach/`):** read Rosa's weekly notes + the To-contact queue, run the Apollo top-up of ~20 contacts, work through the 6 Connection-sent stale (14-19 days) and 5 Chase-DM stale (5 days).
