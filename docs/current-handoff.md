# Platform Handoff, Session 44, 2026-05-13

## Current state

Wed paid traffic is live; Emma Newton (submission 416) was the first real fastrack-funded learner to hit the new code path and surfaced a latent RLS bug. Migration 0139 closed the gap, data-ops 028 replayed Emma, and an RLS audit script now confirms every `crm.*` table has matching role / grant / policy coverage. Dead-letter is now an active hourly signal (cron 0140 + new `dead-letter-alert-cron`), the sheet-drift reconciler is no longer noisy (case-insensitive, no-lost-reason-column aware, self-cleans stale alerts), and today's 35-row drift backlog is cleared. All four pilot providers operationally fine.

## What was done this session

- **Emma Newton (submission 416) end-to-end.** Reported `l3_reconfirmed=true` on fastrack contradicting her form's `prior_level_3_or_higher=false`. Expected auto-DQ to `status='lost'` didn't fire — diagnosed as `code=42501` RLS violation when `fastrack-receive` tried `INSERT INTO crm.lead_notes` inside the auto-DQ transaction under `SET LOCAL ROLE functions_writer`. Same transaction included the enrolment UPDATE; INSERT failed RLS, whole transaction rolled back, enrolment stayed `open`.
- **0139 fix.** `crm.lead_notes` now has `n8n_write_lead_notes` policy (`FOR ALL TO functions_writer USING/WITH CHECK true`) mirroring the pattern on `crm.enrolments`. Plus explicit GRANT to `functions_writer`. Root cause: GRANT existed (via default privileges) but no permissive policy targeted the role — the inverse of the "policy without grant" pattern documented in memory.
- **Data-ops 028 replay.** Manually UPDATEd Emma's enrolment 536 → `status='lost', lost_reason='l3_mismatch_self_reported'`, inserted the system note, audit row, marked dead_letter resolved. Script ran 6 min after Charlotte's admin-UI manual flip had already moved status to 'lost' (no reason), so WHERE clause didn't match; fixed with a follow-up UPDATE.
- **0140 + new Edge Function `dead-letter-alert-cron`.** Hourly cron at 5 past, reads unreplayed `leads.dead_letter` rows from last 65 min, summarises via Brevo email to owner. Excludes `source='sheet_drift_detected'` (those have their own daily channel). Closes the "honest signal sitting silent" gap that let Emma's failure go 8 hours unnoticed.
- **Data-ops 029 RLS audit script.** Three queries cross-check role-targeted policies against table GRANTs. Caught the lead_notes bug retroactively ("WRITE GRANT BUT NO POLICY — RUNTIME 42501 RISK"); confirmed clean post-0139. Worth a Monday-cycle run from Sasha.
- **Sheet-drift reconciler noise reduction (`sheet-drift-reconcile-daily`).**
  - Case-insensitive status comparison: provider sheets carry "Presumed Enrolled" (title-case E), canonical label is "Presumed enrolled" (lowercase e) — was flagging every Presumed lead daily as cosmetic drift. Fixed.
  - Skip `lost_reason` drift check when sheet has no Lost Reason column: pilot sheets (EMS, WYK, CD) only carry Status, not Lost Reason — was flagging every Lost lead with a reason daily as structurally-unresolvable drift. Fixed.
  - Self-clean stale dead_letter rows: each run, any prior `sheet_drift_detected` row whose drift key (submission_id × kinds) isn't present in the current run gets `replayed_at = now()` automatically. Drift now converges; no growing pile.
- **Today's 35-row backfill cleared.** Manual `UPDATE leads.dead_letter SET replayed_at = now()` cleared the cosmetic + structural cases. `/admin/errors` count back to near-zero.
- **Submission ID backfill panel run.**
  - EMS: 1 match (Christy Clarence, sub 267) — applied; Submission ID now populated on Andy's sheet row.
  - WYK: 1 unmatched (row 17 had no email — turned out to be a stray 's', Charlotte deleted it).
  - CD: panel reported clear, but reconciler flagged Jyotika Mark (sub 128) as missing_from_sheet. Charlotte confirmed she IS in Marty's sheet — diagnosed as wrong cell contents in the Submission ID column (whitespace / wrong type / wrong value). Charlotte to retype `128` cleanly.
- **`dead-letter-alert-cron` source filter.** Built it during initial scope without the sheet-drift exclusion; added the filter when realising the alert would duplicate the daily drift email at 35 rows/hour.

## Next steps

1. **Wed/Thu first 24h smoke check.** Tomorrow's 06:00 UTC sheet-drift email — expect near-zero. Anything left after this morning's cleanup is genuine work, not noise. Confirm Jyotika #128 clears on this run (Charlotte's manual retype lands today).
2. **First real Riverside submission Wed.** Still carried from prior handoff. Eyeball Edge Function logs end-to-end (DB insert + sheet append + U1 + U2). Per-leg logger will surface any failure by name.
3. **Wren: 3 Brevo templates.** `BREVO_TEMPLATE_U1_EMPLOYER`, `BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING`, `BREVO_TEMPLATE_PROVIDER_PRESUMED_FLIPPED`. First one degrades Wed UX until set.
4. **Tighten data-ops audit-log template.** Today's data-ops 028 hardcoded the audit row's `before_value` instead of SELECTing live state, so when status was already 'lost' (admin UI click) by the time the script ran, the audit row falsely claimed "open → lost" with the data-ops as actor. Fix: future data-ops scripts capture `before_value` via a SELECT into a variable, write the audit row only when the UPDATE actually mutated something. New ticket created on Backlog.
5. **WYK + Courses Direct sheet-vs-DB reconcile (carry forward).** Backlog ticket 869d994nb. Today's panel-and-manual sweep partially addresses the silent-ghost class for WYK and CD; ticket can be reframed as "any remaining silent ghosts past 2026-05-12 will surface via reconciler with new noise-free rules; verify near-zero drift each Monday for two weeks then close".
6. **Provider portal `/provider/leads` N+1 + cursor siblings (carry forward).** Backlog 869d994qf. Trigger: any provider crosses 500+ active leads.
7. **`RealtimeRefresh` `lead_notes` subscription scope (carry forward).** Backlog 869d994t5.
8. **RLS `(SELECT fn())` wrap on `crm.disputes` + `leads.fastrack_submissions` (carry forward).** Backlog 869d994un. Trigger: either table crosses ~1000 rows.
9. **Carry forward from Session 42-43.** Owner invites for Andy / Jane / Marty; republish EMS + WYK sheets from DB before sending invites (mostly done in spirit via today's reconcile work); `BREVO_TEMPLATE_U1_EMPLOYER` env after Wren delivers.
10. **Solis carry-forward.** Schema naming decision `ads_business` vs `ads_switchable_business` before B2B Meta ad ingest. `crm.employer_signings` design before first Riverside Employer Signed event fires.

## Decisions and open questions

**Decisions made:**

- **`is_dq IS NOT TRUE` is the single source of truth for "exclude from dashboards".** Carries forward from prior addendum; confirmed by new RLS audit pass that no other table is misconfigured around test/disqualified rows.
- **`crm.lead_notes` follows the n8n_write_* pattern.** Adopted from `crm.enrolments` precedent. Mirror this for any future table that needs Edge Function INSERT under `functions_writer` role.
- **Dead-letter is the active signal.** Hourly cron, owner-emailed, source-filtered to avoid duplication with dedicated channels (sheet drift, presumed warnings, etc). Future failure modes go to dead_letter; surface within an hour.
- **Sheet-drift reconciler self-cleans.** Drift state converges to truth automatically. No more manually clicking "I've handled this" per row.
- **Sheet structure asymmetry recognised.** Provider sheets carry status only; lost_reason lives in DB and is not part of the sheet contract. Reconciler no longer enforces parity on a field the sheet structurally can't hold.
- **`fastrack-receive` was right all along.** The auto-DQ logic and `l3_mismatch_flag` detection have been correct since shipped. The regression was purely on the RLS side, surfacing only when the lead_notes INSERT block was added to the transaction.

**Open questions:**

- Does Jyotika #128 clear on tomorrow's 06:00 reconcile? If not, deeper diagnosis on Marty's sheet column types. Watch.
- Same fastrack auto-DQ path exists for `cohort_decline`: technically the same RLS gap was fixing it too, but no real-traffic test has fired since 0139 landed. Watch for the first cohort_decline fastrack and confirm clean auto-DQ.

## Watch items

- **First fire of `dead-letter-alert-hourly` cron** (5 past the next hour). Empty hour = no email, that's the expected steady state.
- **Tomorrow's 06:00 sheet-drift-reconcile-daily email.** Expect near-zero. Jyotika #128 should NOT appear (Charlotte retyped Submission ID).
- **First real Riverside submission Wed.** Per prior handoff; same eyeball test still applies.
- **TEST_MODE confirmed `false`** in Supabase Vault before Wed paid traffic peaks. Confirm again Wed morning.
- **`BREVO_TEMPLATE_U1_EMPLOYER` env unset.** Function warns-and-skips; no breakage, just no employer ack email until set.
- **First real cohort_decline fastrack.** Untested in production under 0139. Should auto-DQ cleanly; watch the first one.

## Next session

- **Folder:** `platform`
- **First task:** Confirm overnight self-heal worked — tomorrow's 06:00 sheet-drift-reconcile-daily email is near-zero (with Jyotika #128 cleared), and the hourly dead-letter alert has fired at least once cleanly OR stayed quiet (both = success). Then eyeball Wed launch end-to-end on the first real Riverside submission.
- **Cross-project:** None this session. Wren still owes 3 Brevo templates (carried from Session 42).
