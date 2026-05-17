# Platform Handoff, Session 50, 2026-05-17

## ⚡ INBOUND FROM switchable/email (Wren) 2026-05-17 — DEADLINE TOMORROW MIDDAY UK

Wren is shipping a "last chance to apply" marketing broadcast tomorrow 18 May PM, targeting open `smm-for-ecommerce` leads who haven't fastracked. The broadcast's Brevo audience filter needs a `SW_FASTRACKED` boolean attribute by **midday Monday 18 May UK** to filter cleanly. Two distinct deliverables, full spec preserved below in Next steps #1.

**Fallback if not hit:** Wren pulls audience via DB SQL for this one send; attribute work catches up after. Broadcast doesn't gate on you, but Brevo-native filter is preferred.

## Current state

Channel B (AI Notes) approvals now write status back to the provider sheet, closing the biggest single source of sheet drift. The post-insert URL refresh gap that silently re-seeded the Brevo backfill panel is patched at its main mutation site (`backfill-client-nonce`). All 12 outstanding sheet-drift dead-letter rows cleared via republish; the 30 stale Brevo URL contacts re-pushed. Three `/admin/errors` UX bugs fixed (Lead-not-found, removed Submission ID panel, renamed + clarified Brevo panel). Flagged-for-Claude rows now surface as a dedicated card so the next platform session sees the backlog at session-start. Wren's broadcast deadline tomorrow midday is the immediate priority.

## What was done this session

- **Diagnosed sheet drift end-to-end.** Truly open drift was 12 rows, not 73 (61 already `replayed_at`-stamped by the cron's self-clean; an earlier query filter on `replay_submission_id IS NULL` missed them). Root cause of new drift: Channel B (`pending-update-confirm`) updates `crm.enrolments` and Brevo on approve/override but never writes back to the sheet's Status cell.
- **Patched `pending-update-confirm`** (commit `a98182f`). Added `pushStatusToSheet` mirroring the fastrack-receive pattern: looks up provider + submission, projects DB status through `statusToSheetLabel`, POSTs to the appender via `update_by_submission_id` mode. Failures land in `leads.dead_letter` with source `channel_b_sheet_writeback`. Deployed.
- **Cleared the 12 outstanding drift rows.** Republished EMS / WYK Digital / Courses Direct via `/admin/errors`. Drift cron's self-clean will mark the rows `replayed_at` at next 06:00 UTC run.
- **Fixed `/admin/errors` "Lead not found" cosmetic bug.** `postgres@3` returns bigint columns as JS strings, preserved through JSON.stringify → JSONB → parse. The page's `typeof === "number"` check on `raw_payload.submission_id` silently dropped every sheet_drift / channel_b_sheet_writeback / fastrack_form / fastrack_side_effect / reconcile_backfill row. Replaced with coerce-both helper.
- **Removed Legacy Submission ID backfill panel** from `/admin/errors` (work was done across all providers).
- **Renamed and clarified the Brevo URL backfill panel.** Was "024: Brevo URL backfill" with terse implementation jargon. Now "Brevo: refresh learner referral & fastrack URLs" with plain-English explanation, when-to-run guidance, what the dry-run number means, and last-applied date pulled out.
- **Built the Flagged-for-Claude card** on `/admin/errors`. Surfaces resolved dead-letter rows whose audit note contains "Flagged for next session" from last 60 days. Amber-tinted, above the unresolved errors list. Next platform session sees the backlog at session-start.
- **Diagnosed why the Brevo URL backfill keeps showing drift.** `route-lead.ts` pushes `SW_REFERRAL_URL` / `SW_FASTRACK_URL` once at lead insert. Post-insert mutations of `client_nonce` / `referral_code` / `course_id` / `marketing_opt_in` don't trigger re-push. Of 166 opted-in leads since 1 April, 65 had their `client_nonce` set AFTER insert (via the 025 backfill).
- **Patched `backfill-client-nonce`** to call `crm.sync_leads_to_brevo(ARRAY[ids])` after every apply run. RPC is async via `net.http_post`, so it doesn't block the writer. Deployed.
- **Applied the existing 30 mutating Brevo contacts** via `/admin/errors` → Brevo panel. Current Brevo URL drift now zero.
- **Saved two memory entries:** `postgres@3` bigint-as-string gotcha (feedback), Brevo URL post-insert refresh pattern (project).
- **Inbound push from Mable** logged earlier today: `.track()` wiring is live across the four newly-allowed forms (commit `8f5e9b0`). Dependency cleared — Watch item #1 below is now active watching, not pending.

## Next steps

1. **`SW_FASTRACKED` attribute + `u-fastrack-qualified` transactional template (Wren ask, hard deadline tomorrow midday UK).**
   - **Attribute:** create `SW_FASTRACKED` boolean in Brevo dashboard. Wire `SW_FASTRACKED: false` at routing time in `_shared/route-lead.ts` (both `upsertLearnerInBrevo` and `upsertLearnerInBrevoNoMatch`). Wire write-on-flip in `fastrack-receive` after the child-row insert + parent `fastracked_at` stamp: call `upsertBrevoContact` with `SW_FASTRACKED: true`. The same upsert can refresh other SW_* attrs as a free side effect (useful — also re-pushes `SW_FASTRACK_URL`).
   - **Backfill:** via `admin-brevo-resync` panel pattern (just used 2026-05-16 for 356 contacts). For every Brevo contact with a parent `leads.submissions` row, set `SW_FASTRACKED = (fastracked_at IS NOT NULL)`. Same pass refreshes `SW_FASTRACK_URL`.
   - **Email type:** new `u-fastrack-qualified` transactional template. Trigger condition inside `fastrack-receive` after child-row insert: `cohort_confirmed === true AND l3_reconfirmed === false`. Send via `sendTransactional` in `_shared/brevo.ts`. Template ID TBD from Wren. Template reuses existing `SW_PROVIDER_CONTACT_BEFORE` / `SW_PROVIDER_PHONE` / `SW_PROVIDER_CONTACT_AFTER` composition — no new attribute wiring for content. Idempotency in `crm.email_log` on `(submission_id, 'u_fastrack_qualified')`. Add `'u_fastrack_qualified'` to whatever enum / check constraint governs `email_type` (migration if needed). Legal basis: contract — goes regardless of marketing_opt_in.
   - **Docs:** update `switchable/email/CLAUDE.md` attribute list 21 → 22 (Wren can take this); log both attribute + email_type in `platform/docs/changelog.md` on ship.
   - **Sequencing:** trigger is independent of the broadcast send. No hard deadline on the trigger itself, but ideally live within a few days of broadcast.
2. **Watch tomorrow's 07:00 BST drift email.** Should report 0 new drift rows. That's the Channel B writeback validation. Any non-zero count needs investigating.
3. **Watch `leads.dead_letter` for source `channel_b_sheet_writeback`.** Should stay empty. Any entry there = the new writeback path is failing.
4. **Verify the rebuilt `/admin` overview** across all period buckets (carry from S49). Click 2d / 7d / 14d / 30d / lifetime / custom; confirm scoreboard math rolls up correctly.
5. **Watch `leads.partials`** for `s4b-employer-lead-v1`, `switchable-waitlist`, `switchable-waitlist-enrichment`, `fastrack-funded-v1`. Mable's `.track()` is live; rows should land within hours. Any one still at zero after 24h = that form's wiring needs investigation.
6. **Per-provider CPL / CPE / P/L scoreboard.** Design the campaign → provider mapping (`crm.providers.ad_campaigns text[]` OR `ads_switchable.campaign_provider_map`) so those columns can join the rollup (carry from S49).
7. **CLI migration registry drift `0141-0145`** local but not on remote per `supabase migration list --linked` (carry from S47). Production correct.
8. **Brevo orphan deletion** once Wren confirms `u1-funded` template is verified live on a real EMS or WYK lead. Delete the orphan `SW_PROVIDER_CONTACT_BLOCK` attribute + `u1-funded-post-fastrack` template (carry from S48-49).
9. **Optional follow-up: extend working-hours timer** to callback + stale-attempt (carry from S48).
10. **Carries from S47-49 still open.** Invited portal users at `status='invited'`; WYK + Courses Direct portal launch when ready; lead-assignment in-session lock (Phase 2); data-ops audit-log template tighten; WYK + CD sheet-vs-DB reconcile; `/provider/leads` N+1 + cursor siblings; RealtimeRefresh `lead_notes` subscription scope; RLS `(SELECT fn())` wrap on `crm.disputes` + `leads.fastrack_submissions`.
11. **Solis carries.** Schema naming `ads_business` vs `ads_switchable_business`; `crm.employer_signings` design before first Riverside Employer Signed event.

## Decisions and open questions

**Decisions:**

- **Channel B sheet writeback ships as best-effort + dead-letter**, mirroring fastrack-receive. Why: simplest cure for the biggest sheet drift source; retry / escalation logic isn't worth building pre-portal retirement.
- **`fastrack-receive` sheet write NOT touched.** Already best-effort + dead-letter; 1 case in 73 historic drift rows didn't warrant a change.
- **Auto-republish on drift NOT added.** With Channel B writeback fixed and Brevo URL refresh patched, no new drift expected from these surfaces. Revisit if drift accumulates anyway.
- **Drift cron's `lost_reason` logic NOT changed.** Already correctly guarded (`if sheetRow.lost_reason !== undefined`); historic `lost_reason` rows were from before the guard. Sheets without a Lost Reason column won't trip the check.
- **Brevo URL refresh patched at `backfill-client-nonce` only.** Sites that flip `marketing_opt_in=false` (sunset cron, brevo-event-webhook, brevo-consent-reconcile-daily) deliberately not patched: those contacts are being unsubscribed anyway, so stale URLs on their Brevo card never get used.
- **Flag for Claude surfaced as a separate panel on `/admin/errors`** (Option B over honesty-rename). Why: cheapest way to make the button do what it promises; next platform session sees the backlog naturally at session-start. 60-day window keeps the list focused.
- **`/admin/errors` lead-link uses bigint-as-string coercion.** Same gotcha will bite any future raw_payload reader; coerce-both is the durable fix.

**Open questions:** None this session.

## Watch items

- **Tomorrow's 07:00 BST drift email** — should report 0 new drift. Validates Channel B writeback.
- **`leads.dead_letter` source `channel_b_sheet_writeback`** — should stay empty.
- **`leads.partials` for `s4b-employer-lead-v1`, `switchable-waitlist`, `switchable-waitlist-enrichment`, `fastrack-funded-v1`** — Mable's wiring live; rows should populate within hours.
- **`/admin` slowness post-`b518dcc`** — Charlotte confirmed "platform does seem a little faster". Continue monitoring tab-refocus + first-click lag.
- **Wren's `u1-funded` template publish** (carry from S48-49). Verify on next real EMS Tees Valley funded lead + WYK Camden non-EMS lead before deleting Brevo orphans.
- **CLI migration registry drift `0141-0145`** local but not on remote (carry from S47).
- **`TEST_MODE = false`** in Supabase Vault — re-verify before any session that might trigger a real B2B submission.
- **First real `cohort_decline` fastrack** (carry from S44).
- **First fire of `dead-letter-alert-hourly` cron** (carry from S44).
- **First real B2B Riverside submission** (carry from S46-47).
- **Invited portal users walking through** (Andy / Jake / George / Nick EMS, Jane / Freya Riverside; all still at `status='invited'`).
- **First Friday-late or Saturday-routed lead post-S48 deploy.** Confirm overdue badge does NOT fire over weekend per working-hours timer.
- **First real B2C ad-driven lead, full chain.**
- **Audit row on every new SLA acceptance** (carry from S46-47).
- **`SLA: X/N accepted` badge on `/admin/providers/<id>`** (carry from S46-47).

## Next session

- **Folder:** `platform`
- **First task:** Wren's `SW_FASTRACKED` + `u-fastrack-qualified` work (Next-step #1). Hard deadline midday Monday 18 May UK on the attribute + wiring + backfill. Read tomorrow's 07:00 BST drift email first (5 min) to confirm Channel B writeback is clean, then dive into Wren's spec.
- **Cross-project:** Wren's full ask sits in this handoff and originated from `switchable/email/docs/current-handoff.md`. Mable's `/refer/` page-view beacon ask is still in `switchable/site/docs/current-handoff.md` — not started this session. Wren's U1 referral CTA prominence ask is also still in `switchable/email/docs/current-handoff.md`.
