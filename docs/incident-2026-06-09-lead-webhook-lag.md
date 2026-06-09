# Incident note — lead webhook lag (2026-06-09)

Author: Sasha (platform). Status: interim mitigation shipped; root cause open (needs dashboard logs + a Mira/owner architecture decision).

## Symptom
Owner received repeated "Reconcile back-filled 1 lead" alerts and noticed lead notification emails arriving minutes late and out of order. Fear was that leads weren't routing.

## What was confirmed (live, 2026-06-09)
- **No lead lost, all routed.** Every non-DQ lead today is in `leads.submissions` and routed to EMS (`routing_log.delivery_status = 'sent'`). The DQ one (Rose, 581) correctly didn't route.
- **The fast path (Netlify outgoing webhook → `netlify-lead-router`) is intermittently not delivering.** Hard evidence: `submit_to_insert` (computed `created_at - submitted_at`):
  - 1–4 Jun, all courses: 2s every time (healthy).
  - From 8 Jun evening onward: a mix of 2s (fast/webhook) and 72s–7min (slow), where the slow ones land exactly on reconcile ticks → inserted by the backfill, not the webhook.
  - Controlled test 2026-06-09: scripted submit landed only on the 10-min sweep (169s); a recreated webhook did not fix it.
- **The router function is healthy.** Unauthenticated POST returns 200 in ~0.85s; reconcile re-delivers the identical payloads through it successfully. No `leads.dead_letter` rows for router insert-failures today → the router is not receiving-and-erroring; Netlify simply isn't delivering those calls.
- **Not the course, not the front-end earnings fix.** All funded courses share one form (`switchable-funded`) + one webhook; Sunderland only looks singled out because it's the sole active campaign. The earnings template fix shipped 9 Jun morning, after the lag already existed.

## Root cause (high confidence, not yet log-confirmed)
This is the **known ~3% Netlify outgoing-webhook drop documented in migration 0202** (~3% over 90 days, 0 permanently lost). It became visible on 8 Jun because (a) the Sunderland EMS campaign raised lead volume, so 3% is now more leads in absolute terms, and (b) reconcile was sped to every 10 min that day, so it now emails an alert on each catch (previously hourly + silent). The flaky link is **Netlify's outgoing-webhook delivery layer**, not our function or config.

## Interim mitigation — SHIPPED this session (owner-authorised)
- Migration `0204`: reconcile cron `*/10` → `*/2`. Worst-case recovery now ~2–4 min (was ~10).
- `netlify-leads-reconcile` redeployed with a 2-min grace window (so the faster sweep doesn't race the healthy ~97% webhook → no false alerts, no dropped re-delivered emails) and now actually writes the `reconcile_backfill` dead_letter row it always claimed to.

## Delivery + notification fully verified (audit, 2026-06-09)
- `audit.actions` records `provider_notified` + `sheet_appended` per routed lead (via `log_system_action_v1`). For all 5 of today's real leads (575–578, 580): `provider_notified = true`, `sheet_appended = true`, no error. EMS was emailed for every lead (delayed on the 2 slow ones, never dropped). Learner emails confirmed in `crm.email_log` (`u1_funded`) for all 5, also delayed-not-dropped on the slow ones.
- Correction to an earlier worry: the EMS notification IS auditable — in `audit.actions` (not `crm.email_log`, which only carries learner transactional sends). "Was the provider told?" is always answerable. A future nicety would be to also mirror provider sends into `crm.email_log` for one-stop auditing, but it is not a gap.
- Even reconcile-recovered leads (578, 580) show `provider_notified = true` → the backfill re-delivery fully notifies provider + learner, not just files the row. The earlier "emails torn down on the reconcile path" hypothesis is disproven.
- Cleanup done: test rows 584, 585 archived (migration 0205).

## Open — needs owner/Mira
1. **Confirm the failure mode in the dashboard** (Sasha can't reach these from a laptop session):
   - Netlify → Forms → the `netlify-lead-router` outgoing webhook → delivery log: are deliveries failing (status/timeout) or not being attempted?
   - Supabase → Functions → `netlify-lead-router` logs from 8 Jun evening: is there an invocation at each lead's submit time, or only at reconcile time?
2. **Durable fix (architecture decision — Mira signs off):** stop depending on Netlify's best-effort webhook as the sole primary path. Recommended option: add a **client-side direct POST** from the form to `netlify-lead-router` (or a Netlify Function) at submit, alongside the existing Netlify capture. Idempotency (`ON CONFLICT` on the Netlify submission id) already prevents double-routing, so a dual path is safe and makes delivery independent of Netlify's webhook reliability. Reconcile stays as the backstop.

## Cleanup pending
Test rows 584, 585 (WEBHOOKTEST diagnostic submissions, DQ, un-routed) to be archived (mirror migration 0203).
