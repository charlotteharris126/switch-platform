# Platform Handoff, Session 72, 2026-06-12

## Current state
Data health (`/admin/errors`) and the daily digest email now separate real failures from routine drift, and the dead_letter backlog was reset to a clean slate (migration 0206). EMS and Riverside sheet vs DB drift was reconciled this session with the database treated as the trusted source throughout; the sheet reconcile panel gained four push directions and a relabelled, honest status pill.

## What was done this session
- **Data health overhaul (deployed).** `app/app/admin/errors/page.tsx`: added plain-English `SOURCE_EXPLANATIONS` for the six drift sources that fell through to "Unknown error -> Flag for Claude". `drift-digest-daily` EF: split "Needs you" vs "Routine, no action" and leads with the count (the 06:12 email confirmed it reads "All clear" on a routine day). `brevo-attribute-reconcile` EF: auto-resolves its own prior summary rows each run so the Brevo logs stop accumulating (ticket e2b2615f). Sheet-drift cron already self-cleans.
- **Clean-slate wipe.** Migration 0206 resolved 100 routine/transient/test dead_letter rows. Left `brevo_attribute_drift` (14, needs a Brevo Re-sync) and `reconcile_backfill` (3, owner ack) deliberately.
- **"4 bugs" investigated, all non-bugs.** fastrack #1005 = a test submission; netlify_audit #998 = transient (URL live); labs_event x2 = transient blip during the 3 Jun 0184/0185 deploy (functions_writer inserts fine since, verified 4 events in `labs.events_analytics`); brevo_transactional_sms = Brevo SMS credits ran out (owner top-up).
- **Sheet reconcile panel, four DB->sheet capabilities added** (`reconcile-sheet-panel.tsx`): "Push selected DB -> sheet", "Push these N to sheet" (for billing-guarded skipped rows), "Push whole sheet from DB" (full republish), and a visible list of the db-fresher submission_ids. Status pill relabelled "Aligned" -> "No drift flagged" (grey) with a "reflects the last daily check, not live" note. DB-sanity card now renders the reconciliation as an explicit equation.
- **EMS + Riverside reconciled.** Established via `crm.sheet_edits_log` provenance that the DB is the trusted side (DB changed after the sheet's last edit on all 42 EMS leads; Riverside has zero edit-log rows, its sheet is one-way). EMS pushed DB->sheet via the panel. Riverside's last 6 (stuck at `open` in the sheet while DB had Attempt 1/2/3) fixed by typing the values into the sheet directly, because the whole-sheet push times out with no result box.
- **Cross-project (switchable/site, done in this session):** team-leading page `legacy` intake-id fix + new `cohort-ssot` audit guard shipped (commit db384d4 in the switchable-site repo). New EMS course `build-an-online-shop-tees-valley` verified wired end to end (routing, sheet, email/SMS, fastrack, portal).

## Next steps

**⚡ NEW push 2026-06-12 (from switchable/site S75, Mable) — private-pay routing + billing. REQUIRED before any paid traffic points at private-pay.** The private-pay fallback is LIVE on the funded funnel (commit c8634e6) but is NOT operational until platform wires it. A funded-DQ learner can now choose to pay: the site submits the main `switchable-funded` form with hidden `pay_route=private` (+ `dq=true`, `dq_reason`). Until you branch on it, `netlify-lead-router` treats it as a normal funded lead (`pay_route` only in `raw_payload`), so a paying learner lands with EMS looking FUNDED (free) when they do not qualify. Build per `switchable/site/docs/private-pay-platform-spec.md`: (a) add `leads.submissions.pay_route` column (additive, no schema bump); (b) branch `netlify-lead-router` on `pay_route=private` -> route to provider as a private/self-funded enrolment, keep `funding_category=gov`, bill the standard flat £150 EMS fee, and do not let `dq=true` short-circuit it to gateway-capture; (c) provider-sheet "Pay Route" column via the v2 appender; (d) "paying privately" on the learner portal. Then the `fastrack-receive` EF changes (trees A/B, spec section 5) are the follow-on, and Mable builds the front-end once your field contract exists. Filed in the Work Hub (`area_tag: platform`, id `bb9ef572`).

1. Make `republish-provider-sheet` run in the **background** with a "started, check back in ~1 min" response (mirror the `brevo-attribute-reconcile` async pattern), so a big sheet (Riverside ~40 rows) stops timing out and silently showing no result box.
2. Decide whether **one-way provider sheets auto-republish on DB status change**. Root cause of the recurring Riverside drift: when Freya logs call attempts in the portal (DB), nothing pushes DB->sheet until a manual republish, so the sheet drifts to stale `open`. EMS mirrors back so it self-corrects; Riverside does not.
3. Tighten the sheet-drift copy: "self-healing" overclaims for stuck cases. Say "clears once reconciled".
4. Consolidate the reconcile panel (now four push buttons) into a cleaner two-direction design.
5. Carried from S71: durable lead-webhook fix decision (direct-POST vs accept the 2-min backup, Mira's call) + `client_nonce` dedup scope; billing reconciliation (`/admin/billing`); ClickUp cutover (wire Rosa/Nell to task-upsert); rotate BREVO_API_KEY + ROUTING_CONFIRM_SHARED_SECRET + the 3 leaked `~/.zsh_history` creds.

## Decisions and open questions
- **Decision: the database is the trusted source of truth for sheet vs DB drift on EMS and Riverside, so reconcile is always DB -> sheet, never sheet -> DB.** WHY: providers work via the portal/DB; the sheets are stale (EMS mirrors back but lags) or one-way (Riverside never syncs back). Verified against `crm.sheet_edits_log`. Trusting the DB preserved EMS enrolments (#247, #302) that a sheet->DB apply would have wrongly marked lost.
- Decision: cleared the routine dead_letter backlog (0206) to restore "anything unresolved = a real problem", rather than leave 109 routine rows.
- Open: should one-way sheets auto-republish on status change (step 2)? Owner/Mira call.
- Open: panel button consolidation (step 4).

## Watch items
- Tomorrow's 06:00 sheet-drift cron + 06:30 digest: EMS should show no drift; Riverside should show 0 after the manual fix; the section pills should now read honestly ("No drift flagged", not a false "Aligned").
- The 14 `brevo_attribute_drift` rows persist until Charlotte runs DB <-> Brevo "Check drift" -> "Re-sync" (genuinely reconciles the contacts, then auto-resolves via the redeployed cron).
- 3 `reconcile_backfill` rows (today's recovered leads, verified handled, Olamide #604 reached EMS) persist until owner clicks "Mark all resolved".
- Brevo SMS sending stays down until credits topped up.
- Confirm the redeployed `brevo-attribute-reconcile` auto-resolve works on the next daily run (the two Brevo sources should stop accumulating).

## Next session
- **Folder:** platform (Sasha)
- **First task:** Wire private-pay routing + billing (the ⚡ push at the top of Next steps): `pay_route` column + `netlify-lead-router` branch + provider sheet + portal. It is blocking a live feature on the funnel. Then `republish-provider-sheet` background-mode and the one-way-sheet auto-republish decision for Mira.
- **Cross-project:** switchable/site (Mable) - team-leading `legacy` fix + `cohort-ssot` audit guard shipped (commit db384d4, switchable-site repo); build-an-online-shop EMS course verified live. Pushed to switchable/site handoff: confirm the **provisional EMS qualification + awarding body** for build-an-online-shop (was due 2026-06-11, now overdue) and the team-leading `intakes:` normalisation.
