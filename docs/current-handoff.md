# Platform Handoff, Session 53, 2026-05-19

## Current state

Six admin fixes shipped end-to-end alongside two new DB safety mechanisms (migrations 0151 + 0152). Riverside is unblocked through the Engaged stepper, the provider portal now surfaces a Calling pill on employer view, admin parity for learner/employer U1 + chasers is closed, the portal-to-sheet sync no longer disagrees with the daily drift reconciler, and `/admin/errors` is reshaped into a four-card Reconciliations group with a working Clear-all on Flagged-for-Claude. Sheet drift on EMS + Riverside cleared via the republish tool.

## What was done this session

- **Migration 0151 `enrolments_status_check_includes_employer.sql`.** Dropped + re-added the CHECK with the full learner + employer taxonomy. Closed the gap migration 0126 left open (admin RPC was extended for employer statuses, table-level CHECK was not). Provider portal direct `.update()` on `crm.enrolments` now accepts `engaged / in_progress / signed / not_signed / presumed_employer_signed`. Freya's "Engaged" click unblocked.
- **Migration 0152 `stamp_client_nonce_on_funded_insert.sql`.** New `leads.stamp_client_nonce_if_funded()` PL/pgSQL function + BEFORE INSERT trigger on `leads.submissions`. Stamps `gen_random_uuid()` when funding_category is gov/loan and incoming `client_nonce` is NULL. Closes the upstream leak the 025 backfill panel was mopping up. Pending count stays at 0 forever.
- **Provider portal Calling pill.** `app/app/provider/leads/leads-table.tsx`: added `{ value: "calling", label: "Calling" }` to `EMPLOYER_FILTER_DEFS`. Filter case + count logic were already wired; the only gap was the pill on Freya's view. Existing `attempt_1/2/3_no_answer` leads on Riverside now filterable.
- **Admin learner/employer parity.** `/admin/leads` U1 badge folds `u1_funded / u1_self / s4b_employer_u1` into one map; last-chaser column folds `chaser_funded / chaser_self / s4b_employer_chaser`. `/admin/automations` catalogue extended with three employer entries (`s4b_employer_u1 / s4b_employer_chaser / s4b_employer_ud`). Comments updated to dual-audience semantics.
- **Send-chaser button dispatch.** `fireProviderChaser` server action in `app/app/admin/leads/bulk-actions.ts` now looks up `lead_type` per submission and splits the batch across `crm.fire_provider_chaser` (learner) + `crm.fire_employer_chaser` (employer). Same dispatch pattern already on the auto-fire path (`markOutcomeAction`). Sub #496 surfaced this — clicking Send chaser returned `status='ok'` but `admin-brevo-chase` silently skipped on `!funding_category`.
- **Sheet-status alignment, 3 file edits.** `app/lib/sheet-status-sync.ts` now pushes every non-`open` state to the sheet (was: skipped sub-states). `supabase/functions/_shared/sheet-status.ts` `statusToSheetLabel` + `sheetLabelToStatus` extended for employer taxonomy. Push-direction + reconciler projection now agree, closing the recurring "sheet drift" email loop. Provider sheet dropdowns updated on EMS / WYK / CD / Riverside ahead of deploy.
- **Republished EMS + Riverside.** Existing 7-row drift batch cleared via the `/admin/errors` reconcile panel. Tomorrow's 06:00 reconcile expected to land at 0 rows.
- **`/admin/errors` reshape.** Dropped the noncePending alert + 025 backfill panel + "Data ops - one-shot fixes" wrapper. New Reconciliations group with four cards: Sheet ↔ DB (existing) / Netlify ↔ DB (placeholder, real reconciler queued) / DB ↔ Brevo (URLs-only today, broader version queued) / Meta ↔ DB (now its own card). Internal DB consistency check promoted to its own `InternalSanityCard` outside the reconciliations group.
- **Flagged-for-Claude Clear-all.** New `bulkClearClaudeFlags` server action + `ClearClaudeFlagsButton` component. Appends `[claude flag cleared <ts>]` marker to `error_context`; panel filter excludes cleared rows. Audit trail (including the original "Flagged for next session" note) preserved verbatim.
- **Component cleanup.** Deleted `app/app/admin/data-ops/run-client-nonce-panel.tsx` + the `runNonceBackfillAction` server action. The `backfill-client-nonce` Edge Function + `public.count_client_nonce_pending` RPC stay live (no-op with trigger 0152) and queue for deletion next session.
- **`data-architecture.md`** updated with the dual-state-machine status taxonomy block (learner + employer migration history 0028 → 0091 → 0151).
- **Six commits pushed to origin/main:** `0de5a79 / 2fccb14 / 24f7688 / 96b871f / 3dc632f / 01cb686 / aefb8e9 / 7e2ea24 / c1ca6a6`. Edge Functions redeployed: `republish-provider-sheet`, `reconcile-sheet-to-db`, `sheet-drift-reconcile-daily`, `pending-update-confirm`.

## Next steps

1. **Build the real Netlify ↔ DB reconciler.** Replace the placeholder card on `/admin/errors`. Compare Netlify Forms API received-submission counts to `leads.submissions` row counts over a rolling window. Mirror the Sheet ↔ DB panel shape (dry-run + drift list). Open: Netlify API auth + the form ID to count surface. Per-form or aggregate?
2. **Extend the DB ↔ Brevo reconciler to every SW_* attribute.** Currently only checks `SW_REFERRAL_URL` + `SW_FASTRACK_URL` (legacy 024 panel). Pull every contact, project DB through the same shape `upsertLearnerInBrevo` uses, diff per attribute, return per-attribute breakdown. New Edge Function `brevo-attribute-reconcile` forked from `backfill-referral-fastrack-urls`.
3. **Drift digest consolidated email cron.** Replace the daily sheet-drift email + hourly dead-letter alert with one daily digest at 06:30 UTC covering Sheet / Brevo / Meta / new dead-letters. Quiet days send nothing. Charlotte's preference (recorded 2026-05-19): fold the hourly alert into the daily at current volumes.
4. **Delete the orphaned 025 surfaces.** With trigger 0152 in place: drop `public.count_client_nonce_pending` RPC, remove the `backfill-client-nonce` Edge Function, audit any other consumers, drop the actions wrapper if nothing else uses it.
5. **Dry-run UX on republish panel** should show per-row diff (sheet="X" → would write "Y") rather than `leads_written: 0` hardcoded. Data already exists from the prior "Check drift" call — pure UI plumbing.
6. **"5 skipped (Calling - ambiguous)" wording on drift panel** rephrase to "5 rows in sync, no further action needed" — current wording reads as failure.
7. **Carries from S52 still open.**
   - Webhook events on `crm.email_log` rows 504-506 (employer chaser sub #468 / #486 / #487) — confirm delivered / opened / clicked over the next ~24h.
   - First natural Riverside attempt transition without manual SQL — validates auto-fire end-to-end.
   - Auto-flip + day-12 warning email (carries from S51). Migration 0097 written, not applied. EMS has 37 stale leads pending the day-12 warning template + cron before any flips fire.
   - Watch `leads.dead_letter` source `channel_b_sheet_writeback` — should stay empty (S50 carry).
   - Watch `leads.dead_letter` source `edge_function_brevo_chase_employer` — should stay empty (S52 carry).
   - Brevo URL backfill panel should stay at ≤2 mutations (S51 carry).
   - Per-provider CPL / CPE / P/L scoreboard (S49 carry).
   - Brevo orphan deletion once Wren confirms `u1-funded` template verified live (S48-49 carry).
   - Wren brief: utility SMS for funded learners — two-trigger flow spec at `switchable/email/docs/sms-utility-design.md` (S52 carry). **Update 2026-05-19:** body delivery is in-TS template literals inside `sendOutboundMessage`, NOT Brevo-stored SMS templates. One Brevo SMS API key env var, no per-variant template IDs.

## Decisions and open questions

**Decisions:**

- **Trigger-level guarantee over per-path defensive logic for `client_nonce`.** Every present and future insert path is automatically protected — single place to maintain, no risk of forgetting a new path.
- **Status taxonomy widened in lockstep across CHECK + TS + sheet projection.** Migration 0126 had only extended the admin RPC whitelist; the table CHECK and the reconciler projection were learner-only. 0151 closes the table-CHECK gap; today's `sheet-status.ts` edit closes the reconciler-projection gap. Lesson: when extending one half of a dual-coupled system, sweep for the other half in the same session.
- **Push every non-`open` portal status to the sheet.** Reverses the pre-0519 design ("sub-states deliberately don't push"). The reverse-direction reconciler always expected `Calling / Meeting booked`, so the push-direction skip was producing recurring false drift. Aligning both directions stops the loop. Provider sheet dropdowns extended on 2026-05-19 ahead of the deploy.
- **Internal DB sanity card promoted out of the Meta ↔ DB card.** It's self-consistency maths (`routing_log` count vs unique people minus duplicates), not a cross-system reconcile. Separating makes both cards' purpose clearer.
- **Netlify ↔ DB placeholder card included rather than omitted.** Communicates the four-card target shape to Charlotte at-a-glance even though only three of the four have working reconcilers today. The placeholder card explicitly says "Not built yet" and points to next-session work.
- **Drift digest folds the hourly dead-letter alert into the daily.** At current volumes, the 24h delay on a Brevo outage or allowlist 502 is acceptable. Can flip back to hourly if volume grows.

**Open questions:**

- **Brevo reconciler attribute scope.** Full SW_* set or curated subset? Some attributes are time-sensitive (`SW_FASTRACK_COMPLETED` flips when learner fastracks) and others are static (`SW_COURSE_NAME`). Default recommendation: all SW_* attrs, single projection function, full reconcile. Confirm at build time.
- **Cron cadence for the Brevo reconciler.** Daily, weekly, or panel-only? Recommend panel-only first, add cron after a few weeks of drift data informs cadence.

## Watch items

- **`crm.email_log` rows 504-506** — Brevo webhook events landing over the next ~24h (S52 carry).
- **First natural Riverside attempt transition by Freya** on a fresh employer lead — validates the auto-fire path end-to-end without manual SQL.
- **Tomorrow's 06:00 sheet drift reconcile cron** should land at 0 rows for both EMS + Riverside after today's republishes. If non-zero, the new push/projection alignment didn't hold.
- **`leads.dead_letter` sources** `channel_b_sheet_writeback` (S50 carry), `edge_function_brevo_chase_employer` (S52 carry) — should stay empty.
- **Chaser auto-fire volume** for learner + employer paths — up to 4 emails per recipient per week worst case (S52 carry).
- **`BREVO_TEMPLATE_S4B_EMPLOYER_CHASER` template content** — placeholder copy from S52, Wren refines next email session (S17 carry on Wren's side).
- **Brevo URL backfill panel** — should stay at ≤2 mutations (S51 carry).
- **First `u_fastrack_qualified` row in `crm.email_log`** (S51 carry).
- **First invite-claim audit row via `public.log_system_action_v1`** (S51 carry — Andy / Nick / Jane).
- **`TEST_MODE = false`** in Supabase Vault — re-verify before any session that might trigger a real B2B submission (S51 carry).

## Next session

- **Folder:** `platform`
- **First task:** Build the real Netlify Forms API ↔ DB count reconciler — replace the placeholder card on `/admin/errors`. Mirror the Sheet ↔ DB panel shape (Check drift + dry-run summary). Then extend the DB ↔ Brevo reconciler to cover every SW_* attribute (forks `backfill-referral-fastrack-urls`). Then design + ship the daily drift digest email cron and delete the orphaned 025 surfaces (`count_client_nonce_pending` RPC + `backfill-client-nonce` Edge Function).
- **Cross-project:** Wren has the S4B employer chaser template polish on his S17 handoff (carry from S52). No new pushes needed this session.
