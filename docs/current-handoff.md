# Platform Handoff, Session 32, 2026-05-05

## Current state

Email platform rearchitecture: Phase 1 + 2a + 2b + 3a + 6a all shipped and deployed in this session. Shadow mode is **log-only** (new transactional path writes `crm.email_log` rows but does NOT call Brevo — old automations remain the actual sender during the parity window). Cutover target Thursday 2026-05-08 after the 48h parity window. Phase 3a closed the consent-writeback gap (webhook now flips `marketing_opt_in` + pushes attribute to Brevo on unsub/spam). Phases 3b/3c/3d (channel-state push at every contact upsert, backfill, daily reconcile cron) and 6b (admin/automations status page) queued for next session.

## What was done this session

**Phase 2a — sendTransactional + U1 hook:**
- `_shared/brevo.ts`: new `sendTransactional({sql, templateId, recipient, params, submissionId, emailType, forceResend?})` helper. Idempotent on `crm.email_log` (submission_id, email_type), retries 429/5xx with 250ms/1s/4s backoff, dead-letters on final failure, marks `metadata.shadow=true` while shadow mode on.
- `_shared/route-lead.ts`: new `sendU1Transactional` hook fires after `upsertLearnerInBrevo` for both auto-route and manual-confirm. Branches `BREVO_TEMPLATE_U1_FUNDED` (gov/loan) vs `BREVO_TEMPLATE_U1_SELF`. Skips silently for re-applications, missing email, null funding, or unset template env.
- Env vars set in Vault: `BREVO_TEMPLATE_U1_FUNDED=5`, `BREVO_TEMPLATE_U1_SELF=10`, `BREVO_SHADOW_MODE=true`.
- `routing-confirm` + `netlify-lead-router` redeployed.
- End-to-end smoke test passed: submission 288, real Brevo send, `brevo_message_id` populated, two U1s arrived in test inbox.

**Phase 2b — stalled + chaser + U4:**
- New Edge Function `email-stalled-cron`: daily 09:00 UTC, Phase-2-gated (EXISTS u1_*_funded/self in email_log), throttled 250ms.
- New Edge Function `email-u4-cron`: daily 09:30 UTC, same gate. Scheduled job over DB trigger by spec amendment.
- `admin-brevo-chase`: refactored to dual-fire chaser via `sendTransactional` with `forceResend=true`. Per-row `transactional` field added to results.
- Migrations 0076 + 0077: cron schedules.
- Migration 0078: split `email_type='chaser'` into `chaser_funded` + `chaser_self` to match Charlotte's actual Brevo template setup. Required because spec assumed one chaser template.
- Env vars set: `BREVO_TEMPLATE_STALLED_FUNDED=17`, `STALLED_SELF=19`, `CHASER_FUNDED=6`, `CHASER_SELF=12`, `U4_FUNDED=22`, `U4_SELF=24`.
- All three functions redeployed.

**Phase 6a — admin dashboard email visibility:**
- Lead detail page (`app/admin/leads/[id]/page.tsx`): new "Email log" Card with chronological `crm.email_log` table (status badges, shadow/forced metadata pills, brevo_message_id).
- Leads list (`app/admin/leads/page.tsx`): new "U1" column. Per-row badge — green for sent/delivered/opened/clicked, red "missing" for routed Phase-2 leads with no U1 row, dash for DQ/unrouted/pre-Phase-2.
- Auto-deploys via Netlify on push to main.

**Shadow mode flipped from real-send to log-only** mid-session after Charlotte flagged duplicate-email concern:
- `sendTransactional` now short-circuits when `BREVO_SHADOW_MODE=true`: writes the `email_log` queued row, immediately flips to `status='sent'`, returns without calling Brevo. `metadata.shadow_log_only=true` set on insert. `brevo_message_id` stays NULL — the unambiguous signal.
- Lead detail page metadata pill renders "log-only" with tooltip explaining old automation handled the actual send.
- All 5 callers redeployed. Three real leads (288, 290, 292) received duplicate U1s before the switch took effect; small one-off brand impact, contained.

**Phase 3a — webhook consent writeback (migration 0079):**
- Migration 0079: column-level `GRANT UPDATE (marketing_opt_in)` + `functions_writer_consent_updates` RLS policy on `leads.submissions`.
- `brevo-event-webhook`: on unsub/spam/complaint events, now flips `marketing_opt_in=false` on every matching `leads.submissions` row AND pushes `SW_CONSENT_MARKETING=false` to Brevo via `upsertBrevoContact`. Both best-effort (consent_history already logged + Brevo channel-level unsub already in place).
- Function redeployed.

**Diagnostics:**
- Investigated kieranwrites@gmail.com auto-resubmissions (3 today). Diagnosed: same browser session_id across all three suggests a tab-still-open or test-runner re-firing the form. System handled correctly (allowlist DQ'd 289 + 291, no provider routed, no email_log rows for those). Charlotte chose to leave the residual Brevo contact alone; will exit legacy automation naturally.

## Next steps

1. **Tonight + tomorrow (Charlotte):** run U1 parity check via the new dashboard view (leads list U1 column). Look for any "missing" red badges on routed Phase-2 leads. None expected. If anything's red, flag.
2. **Thursday 2026-05-08 (cutover):** Charlotte pings Sasha "ready for cutover". Sasha runs wider query covering U1 + stalled + chaser + U4. If green, flips `BREVO_SHADOW_MODE=false` + redeploys 5 functions (`routing-confirm`, `netlify-lead-router`, `email-stalled-cron`, `email-u4-cron`, `admin-brevo-chase`). Charlotte then disables old utility automations in Brevo same day (Phase 4).
3. **Phase 3b (next platform session):** make `upsertBrevoContact` push channel-subscription state to Brevo on every contact upsert (not just attribute). Research Brevo's exact channel-state API endpoint first — couple of candidates (`emailBlacklisted`, channel-level subscription endpoints) need confirming before code.
4. **Phase 3c (next platform session):** one-off backfill script `data-ops/00XX_backfill_email_campaigns_channel.ts`. Batches of 100, 250ms inter-call delay, halts on >0.5% error rate per batch, checkpoint-resumable. Owner reviews dry-run output before live run.
5. **Phase 3d (next platform session):** new `brevo-consent-reconcile-daily` Edge Function + cron migration. 04:00 UTC daily. Pulls Brevo channel state, compares to Supabase `marketing_opt_in`, auto-corrects, alerts if drift > 2%.
6. **Phase 6b (lower priority):** `/admin/automations` status page showing each cron's last run, recent send counts, failure counts, latest failures. Failure alert email at >3 consecutive utility send failures. ~30-60 min platform.
7. **Phase 5 (Charlotte-led, after Phase 3 complete):** build N1/N2/N3 nurture, referral cold-lead, referral lost-lead automations in Brevo with `SW_CONSENT_MARKETING=true` entry filters.
8. **Standing:** Courses Direct HubSpot integration dormant pending Ranjit's form URL. iris-daily-flags first scheduled run still pending verification.

## Decisions and open questions

- **Shadow mode switched from real-send to log-only** mid-session. Why: Charlotte flagged real-send shadow's "every routed lead gets 2 U1s" as not worth the rendering-verification benefit. Trade-off: lose end-to-end Brevo deliverability check for U1 self / stalled / chaser / U4 in the shadow window. Mitigated by: U1 funded already verified end-to-end this morning; the others use identical code paths with different template IDs.
- **Pre-Phase-2 lifecycle gate** on stalled + U4 crons (`EXISTS u1_*_funded/self in email_log`). Why: prevents pre-Phase-2 leads from being re-stalled/re-U4'd on top of whatever the old automation already did. Acceptable risk: pre-Phase-2 in-flight leads at cutover time lose access to utility emails (small cohort, 1-2 weeks of overlap). Alternative (backfilling email_log rows) was rejected — would mean re-sending utility emails to historical learners.
- **Chaser email_type split (migration 0078)** — spec assumed one chaser template, Charlotte's Brevo has funded (id 6) + self (id 12). Splitting matches the funded/self pattern used by U1, stalled, U4.
- **Phase 3a only this session, not full Phase 3.** Why: 3b touches Brevo channel-state API (research needed), 3c writes to thousands of production contacts (needs dry-run + green-light), 3d is new cron with compliance impact. All three deserve fresh-head treatment. Owner accepted the framing.
- **Open question: Brevo channel-state API endpoint for Phase 3b.** Brevo offers a few mechanisms (`emailBlacklisted` boolean, list-level unsubscribes, dedicated channel endpoints). Need to research and pick before coding. Doesn't block tonight or Thursday cutover.

## Watch items

- **🔴 Shadow mode monitoring + cutover target Thursday 2026-05-08.** Tonight + tomorrow Charlotte runs the dashboard parity check (U1 column on leads list). Thursday cutover sequence in step 2 of Next steps.
- **Three real leads received duplicate U1s today** before the log-only switch took effect (submissions 288, 290, 292 — recipients charliemarieharris+phase2a@icloud.com, krithigudipally76@gmail.com, kayleighxaviagray@gmail.com). One-off, contained, no further action.
- **Kieran's residual Brevo contact** still in legacy automation — Charlotte chose to leave it (will exit SF8 sequence naturally). Watch for further automated form re-submissions from the same browser session_id (`ddfa3877-838f-4c70-9c44-c0c2ff74e1f1`).
- **First scheduled `iris-daily-flags` run** (08:30 UTC daily) — still pending verification per Session 31. Tomorrow morning 09:30 BST is the first opportunity.
- **First scheduled `email-stalled-cron-daily` run** (09:00 UTC tomorrow) and `email-u4-cron-daily` (09:30 UTC tomorrow). Both will return `candidates: 0` initially because no Phase-2 lead has hit day-4 yet. That's the correct empty case; verify via `net._http_response` showing 200.
- **DKIM/SPF/DMARC for switchable.org.uk** — Charlotte ongoing with Brevo. Required before Thursday cutover for deliverability confidence.
- **Courses Direct HubSpot integration** dormant pending Ranjit's form URL.
- **EMS Susan auto-flip billing trigger** — first billable enrolment forecast imminent.
- **Phase 3a smoke test deferred** — no live unsub/spam event yet to exercise the new writeback path. First real event will exercise it.

## Next session

- **Folder:** platform/
- **First task:** Phase 3b — research Brevo's channel-state API endpoint, then make `upsertBrevoContact` push channel-subscription state on every contact upsert (not just attribute). Spec at `platform/docs/email-platform-rearchitecture-spec.md` Phase 3.
- **Cross-project:** switchable/email/ Phase 5 (N1/N2/N3 + referral automations in Brevo) is gated on Phases 3b + 3c + 3d completing. Pushed an updated entry to switchable/email/docs/current-handoff.md reflecting Phase 1+2+3a shipped, cutover Thursday, Phase 5 still gated. Charlotte's parallel pre-cutover task: DKIM/SPF/DMARC for switchable.org.uk.
