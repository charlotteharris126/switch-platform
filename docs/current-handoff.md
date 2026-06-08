# Platform Handoff, Session 68, 2026-06-08

## Current state
The EMS team-leading (Introduction to Management, Sunderland, AEB) funnel is wired and tested end to end on the platform side. A real-lead test surfaced a standing Netlify-to-router webhook delivery lag, now fixed: the backfill auto-recovers and routes missed leads every 10 min (verified live). One form-side bug remains for Mable: `earnings_band` lands empty on the lead. Earlier this session: Work Hub agent-write path, ClickUp task cutover, and per-device MCP scoping.

## What was done this session
- **earnings_band end to end** (migration 0200): column on `leads.submissions`; mapped in `_shared/ingest.ts` (insert) + `_shared/route-lead.ts` (interface, 3 SELECTs, provider-sheet payload); appender FIELD_MAP; portal lead-detail field. `dq_reason` is free text (accepts `over_income_threshold`, no change). Deployed netlify-lead-router, netlify-leads-reconcile, routing-confirm.
- **EMS Sunderland caller**: data-op 039 added `regional_contacts.by_la.sunderland` = Andrea Clarke / 07792 102 367 (applied + verified). Drives the learner SMS + welcome "who's calling" line. Email fan-out confirmed: Andy (to) + Charlotte (owner cc) + Daniel (catch-all `provider_user`); Tees Valley reps correctly excluded for Sunderland leads.
- **Fastrack AEB capture**: migration 0201 (`leads.fastrack_submissions.earnings_reconfirmed`); `fastrack-receive` captures it + surfaces "Earnings under £30k reconfirmed" in the EMS fastrack summary (FCFJ summaries byte-unchanged); qualified-ack email now fires for AEB (`earnings_reconfirmed`) as well as FCFJ (`l3_reconfirmed`).
- **Webhook-lag fix (the big one)**: diagnosed a standing Netlify->router delivery lag (~3% of leads over 90 days delivered >2 min late, mostly >10 min; 15 dropped + caught by the backfill; **0 permanently lost**). `netlify-leads-reconcile` now RE-DELIVERS missed leads through `netlify-lead-router` (full insert + route + email/SMS) instead of inserting un-routed; cron hourly -> `*/10` (migration 0202). **VERIFIED**: stuck test lead 570 auto-recovered + routed to EMS, no double-send (idempotency held).
- **Test-lead cleanup**: archived 569 + 570 (migration 0203, soft archive; portal list filters `archived_at IS NULL`).
- **Work Hub agent-write + ClickUp cutover** (earlier this session): vault-key capture path (`get_task_capture_key`, migration 0194 added-then-dropped 0197, plus 0198, 0199); Backlog + Completed columns + 30-day purge (0195, 0196); `/handoff` + ticketing rule + `/prime-project` rewired ClickUp->Hub; MCP connectors scoped per-device in `~/.claude.json`.

## Next steps
1. **Switch to Mable (switchable/site): fix `earnings_band` landing empty** — the form isn't populating the hidden `h-earnings` field at submit (the value is in the partial-tracker but null on the lead: 568, 569, 570). Platform side is correct; it's a form-JS fix. Verify it lands as `under_30k` on a real lead.
2. **Watch webhook delivery** — confirm the next real leads land in seconds (not lagged). If lags persist, pull Netlify's outgoing webhook delivery log for `switchable-funded` (Netlify-side vs our-side).
3. **SW_LOST_REASON Brevo enum**: register `fastrack-earnings-over` if that attribute is a Category type, else Brevo silently drops it on the rare over-£30k fastrack DQ (Wren, low-urgency).
4. **Rotate 3 leaked credentials** (GitHub PAT, Notion key, DB password found in `~/.zsh_history`) — separate security task, owner-driven.
5. **Carries**: ClickUp cutover remaining (wire Rosa/Nell agents to `task-upsert`); billing reconciliation (`/admin/billing`); Codex security backlog.

## Decisions and open questions
- **Webhook-lag fix = reconcile re-delivers through the router + 10-min cron.** Why: 0 leads lost historically but ~3% lagged/dropped and needed manual routing; this makes recovery automatic + fast, and idempotency (ON CONFLICT on the Netlify id) prevents double-routing if the webhook later catches up.
- **Agent DB-write = vault key + EF (`get_task_capture_key`)**, not a per-device secret. Why: per-device secrets fail the iCloud-sync + "no writing outside workspace" rules; the vault-fetch keeps the read-only role read-only and needs zero device setup.
- **Open**: is the webhook lag a tonight-only Netlify wobble or a standing issue? Needs the next-leads timing + the Netlify delivery log to confirm.

## Watch items
- Webhook delivery timing on the next real leads (netlify_received -> created_at gap should be seconds).
- `earnings_band` empty on every lead until Mable fixes the form.
- The `*/10` reconcile now fires provider emails/SMS on recovery; watch for any unexpected double-sends (idempotency should prevent).
- SW_LOST_REASON Brevo enum (rare over-£30k fastrack DQ).

## Next session
- **Folder:** switchable/site (Mable)
- **First task:** fix the form so `earnings_band` populates the hidden field at submit; verify it saves as `under_30k` on a real routed lead.
- **Cross-project:** pushed to `switchable/site/docs/current-handoff.md` (the empty-`earnings_band` form bug added to Next steps; AEB fastrack note + brief already there). Webhook fix is platform-only.
