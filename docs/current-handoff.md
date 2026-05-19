# Platform Handoff, Session 54, 2026-05-19

## Current state

S53's full next-steps list shipped: Netlify ↔ DB reconciler, DB ↔ Brevo full SW_* reconciler, drift-digest-daily, and the 024 + 025 orphan cleanup. New status pills on every reconciler card give Charlotte at-a-glance drift state on /admin/errors. Five new/changed Edge Functions deployed; one new pg_cron schedule live, one retired, one queued behind the next morning's fires.

## What was done this session

- **Netlify ↔ DB reconciler card.** Replaced the S53 placeholder. `netlify-leads-reconcile` Edge Function gained an `apply: false` dry-run mode (no insert/dead-letter/alert/referral); panel mirrors the Sheet ↔ DB shape. Server action `netlifyReconcileAction`, new `ReconcileNetlifyPanel`.
- **DB ↔ Brevo full SW_* reconciler.** New Edge Function `brevo-attribute-reconcile`. Walks every Brevo contact, projects each through the canonical `upsertLearnerInBrevo` / `upsertLearnerInBrevoNoMatch` builders, diffs per attribute. Per-attribute drift breakdown + drifting-contacts sample list. Apply re-fires the canonical upsert path. Replaces the 024 (REFERRAL_URL + FASTRACK_URL only) panel.
- **Route-lead.ts refactor (pure builders).** Extracted `buildLearnerBrevoAttributes` + `buildLearnerBrevoAttributesNoMatch` from inside `upsertLearnerInBrevo` / `upsertLearnerInBrevoNoMatch`. No behaviour change to the live path — same attrs pushed; reconciler now imports the same builders for its projection.
- **Brevo reconciler perf fix.** First S54 build ran ~50s on 200 contacts (sequential per-contact SQL, max:1 pool), beyond Netlify's 26s Server Action cap; Charlotte hit the timeout on first use. Refactored into two passes: pass 1 (read-only) evaluates every contact in parallel inside each Brevo page; pass 2 (apply only) re-fires upserts sequentially with throttle. Pool bumped to max:8.
- **Daily drift digest.** New Edge Function `drift-digest-daily`. Reads every unreplayed `leads.dead_letter` row from the last 25h, groups by source, sends one summary email at 06:30 UTC. Quiet days send nothing.
- **`sheet-drift-reconcile-daily` email suppressed.** Cron still writes dead_letter rows so the digest reads them; per-cron email send is dormant.
- **Data-ops 040.** Schedules `drift-digest-daily` at 06:30 UTC and unschedules `dead-letter-alert-hourly` in one transaction. Calls `public.get_shared_secret('AUDIT_SHARED_SECRET')` at fire time — no plaintext secret in `cron.job`.
- **024 + 025 orphan cleanup.** Deleted: `run-024-panel.tsx`, `runBackfillAction` + `callBackfillFunction` + `BackfillSpotCheck/Summary/Result` types from `data-ops/actions.ts`, `backfill-referral-fastrack-urls/` Edge Function source, `backfill-client-nonce/` Edge Function source, both `[functions.*]` entries in `supabase/config.toml`. Migration **0153_drop_count_client_nonce_pending.sql** drops the orphan RPC.
- **Config.toml additions.** `brevo-attribute-reconcile` + `drift-digest-daily` added to `[functions.*]` declarations.
- **Status pills on every reconciler card.** New `ReconcilerStatusPill` component on `/admin/errors`: green Aligned when zero, amber count + last-seen timestamp when non-zero. Wired into Sheet, Netlify, and Brevo cards (Meta + Internal DB sanity already had inline status). Reads counts off the existing `leads.dead_letter` server fetch — no extra round-trips.
- **Brevo daily cron (data-ops 041).** `brevo-attribute-reconcile-daily` at 06:15 UTC, fires the function with `apply: false, log_drift: true`. New `log_drift` body param writes one summary `brevo_attribute_drift` dead_letter row when contacts_with_drift > 0. Clean runs leave no row.
- **Sheet pill bug fix.** Initial pill counted only last-25h dead_letter rows; the sheet-drift cron deduplicates so Tuesday's drift never gets re-logged on Wednesday/Thursday, which would silently flip the pill to Aligned. Per-source window policy fixes this: sheet ignores age (unresolved = standing drift), netlify + brevo keep 25h event-window semantics.
- **Owner-applied SQL.** Charlotte applied migration 0153, data-ops 040, and data-ops 041 this session via Supabase SQL editor. Verified `drift-digest-daily` smoke-test returns 200 OK.

## Next steps

1. **First-fire verification 06:00-06:30 UTC tomorrow (2026-05-20).** Watch the three crons land in order: `sheet-drift-reconcile-daily` 06:00 → `brevo-attribute-reconcile-daily` 06:15 → `drift-digest-daily` 06:30. If digest email arrives and pills update, the loop is verified end-to-end. If silent, check `public.vw_cron_runs`.
2. **Remote Edge Function deletion.** `supabase functions delete backfill-referral-fastrack-urls --project-ref igvlngouxcirqhlsrhga` then same for `backfill-client-nonce`. Repo source already gone, so they can't be redeployed.
3. **Auto-flip cron + day-12 warning email (carries from S51).** Migration 0097 written, not applied. EMS has 37 stale leads pending the day-12 warning template + cron before any flips fire. Reopen scope: Brevo warning template, provider heads-up emails, Mira's activity-gate framework, optional per-provider `auto_flip_enabled` flag.
4. **Per-provider CPL / CPE / P/L scoreboard (carry from S49).** Still queued; no work this session.
5. **Brevo orphan deletion** once Wren confirms `u1-funded` template verified live (carry from S48-49).
6. **Infrastructure-manifest update.** Add `brevo-attribute-reconcile-daily` + `drift-digest-daily` cron rows; remove `dead-letter-alert-hourly` row. Update Last verified timestamps on the cron table.

## Decisions and open questions

**Decisions:**

- **Each reconciler card's pill window matches the cron's dedup posture.** Sheet (deduped, unresolved-ever = standing drift) ignores age; Netlify (event-log per back-fill) uses 25h; Brevo (one summary row per drifty run) uses 25h. Why: a single window across all three would either drop standing sheet drift or treat event-log rows as standing.
- **Secrets fetched at cron fire time, not hardcoded.** Both data-ops 040 + 041 call `public.get_shared_secret('AUDIT_SHARED_SECRET')` inside the cron body. Why: Supabase masks secrets after creation so a hardcoded placeholder requires extracting from another cron's command. Vault-fetch propagates rotations automatically and keeps no plaintext in `cron.job`.
- **`log_drift` as opt-in body param, not always-on.** Brevo reconciler only writes a summary dead_letter row when called with `log_drift: true`. Why: ad-hoc on-demand "Check drift" panel calls shouldn't pollute dead_letter; only the daily cron leaves a signal.
- **One bundled commit per logical chunk, not per file.** Six commits ship S54: Netlify card, Brevo reconciler, Brevo perf fix, drift digest + orphan cleanup, status pills, sheet pill bug fix. Reviewable history without micro-commits.
- **Pure-builder refactor on route-lead.ts is no-behaviour-change by design.** The two extracted functions return the same dict that was inlined before; the upsert helpers now just call them. Why: the reconciler imports the same builders so its projection is exactly what the live upsert path produces — no drift between live and reconciler.

**Open questions:**

- **Cron cadence for the Brevo reconciler.** Daily today. Could move to twice-daily if drift surface area grows once Switchable for Business adds more contact attributes. Revisit after 2-3 weeks of run data.
- **Pill timestamp precision.** Currently shows formatAgo (e.g. "2h ago"). Owner could prefer absolute clock time. No strong signal either way today.

## Watch items

- **Tomorrow 06:00-06:30 UTC** — first natural fire of the three reconciler crons. Inbox should see one digest email (or nothing if quiet). Pills on /admin/errors should refresh on next page load.
- **`brevo_attribute_drift` row format.** First production-fire row in `leads.dead_letter` from the new daily cron. Confirm raw_payload includes the expected keys (contacts_with_drift, per_attribute_drift, ran_at) so the digest renders it readably.
- **Pill behaviour on standing sheet drift.** If any provider's sheet drift sits unresolved from prior days, the Sheet pill should now show the count regardless of age (fix in 6e5a540).
- **`dead-letter-alert-hourly`** — confirmed unscheduled (S54 data-ops 040). If anything still fires it after today, the unschedule didn't take.
- **Carries from S52 still open.** crm.email_log rows 504-506 (employer chaser webhook events), first natural Riverside attempt transition by Freya without manual SQL, leads.dead_letter sources `channel_b_sheet_writeback` (S50) + `edge_function_brevo_chase_employer` (S52) should stay empty.
- **Carries from S51 still open.** Auto-flip + day-12 warning (migration 0097 still unapplied), `u_fastrack_qualified` row in `crm.email_log`, invite-claim audit via `public.log_system_action_v1`, `TEST_MODE = false` re-verification before any B2B test submission.
- **Wren brief from S52.** Utility SMS for funded learners — two-trigger flow spec at `switchable/email/docs/sms-utility-design.md`, no new push needed this session.

## Next session

- **Folder:** `platform`
- **First task:** Verify the new cron loop fired cleanly overnight (06:00 sheet → 06:15 brevo → 06:30 digest); confirm pills updated on /admin/errors and one digest email landed. Then sweep the older S51 carries — auto-flip cron + day-12 warning email reopened scope is the biggest unblocking move for Charlotte's billing path.
- **Cross-project:** No new pushes needed. Wren's S4B chaser template polish (S52 carry) stays on his S17 handoff.
