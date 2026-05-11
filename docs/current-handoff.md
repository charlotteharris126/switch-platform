# Platform Handoff, Session 40, 2026-05-11

## Current state

Single source of truth confirmed across all three live providers (EMS, WYK, CD) after a deep data-integrity day. Sheet ↔ DB ↔ Brevo all converged at zero drift, daily 06:00 UTC drift detection cron live, bidirectional reconcile panel on `/errors` for any future drift. View-as-provider preview (Home / Leads / Account) shipped for the admin surface so any provider can be reviewed before cutover. Five queued portal asks shipped this session (cohort filter, free-text outcome notes, lead source breakdown, filter pill restyle with pretty labels, team user removal with audit trail, bulk update expanded to four modes). Page consolidation: `/data-ops` merged into `/errors` as one dashboard for all data-layer attention.

## What was done this session

- **016 WYK reconcile finally executed.** Diagnosed mid-session that data-ops/016 was authored 2026-05-09 but never run — audit cross-check across data-ops scripts confirmed it was the only gap (audit-mechanism worked for 014, 015, 017, 018, 019; only 016 had zero entries). Owner ran the SQL paste; 10 audit entries landed; 9 open WYK leads flipped to terminal, sub 96 INSERTed with status='lost'.
- **Sheet drift detection + cure built end-to-end.** New `sheet-drift-reconcile-daily` Edge Function + migration 0115 scheduling at 06:00 UTC. New `reconcile-sheet-to-db` Edge Function (sheet → DB direction) + reconcile panel on `/errors` (bidirectional cure: pick provider, Check drift, Apply sheet → DB or Push DB → sheet). `republish-provider-sheet` retained for the DB → sheet direction. New `_shared/sheet-status.ts` for the canonical DB → sheet label projection used by both sides.
- **Apps Script appender extended with three new modes** on `provider-sheet-appender-v2.gs`: `read_all_status` (drift detection), `read_rows_missing_submission_id` (backfill discovery), `write_submission_ids` (backfill apply). Owner re-pasted on EMS / WYK / CD sheets twice (one per script revision).
- **Legacy Submission ID backfill** built as one-shot tool on `/errors` Data ops section. New Edge Function `backfill-sheet-submission-ids` matches blank-ID sheet rows to DB leads via email + course + submitted_at proximity, includes children in candidate pool, tracks assignedIds in-batch so no duplicate IDs land. Owner ran it on all three providers: EMS 123/124, WYK 13/14, CD 2/2 matched.
- **Owner hand-fixes** on edge cases the matcher couldn't auto-resolve: lm.sbai EMS row 37 (course mismatch — sheet had SMM, DB had Counselling; resolved to sub 122 + course corrected on sheet), naomi WYK row 13 (sub 96 dedup-child anomaly), kcrowther94 + glennisadamson EMS re-application duplicates (3 cells).
- **Bugs caught and fixed today:**
  - BIGINT-as-string: postgres.js returns BIGINT columns as strings, causing submission_id filters between Edge Functions to silently drop everything. Fixed in `republish-provider-sheet` + `reconcile-sheet-to-db` with explicit Number() coercion on the wire.
  - Server Action timeout: Netlify's ~26s cap on Server Action responses meant big republish jobs (EMS 142 leads) blew past, page-error-boundary crashed. Added try/catch in `reconcile-sheet-panel.tsx` for all three call paths (dry-run, apply sheet→DB, apply DB→sheet) with friendly "job may still be running, re-run Check drift" message.
  - Republish scope: now accepts `submission_ids` filter so the panel can pass only the drift candidates (82 vs all 142 routed for EMS) — runs at 50ms inter-write delay instead of 100ms.
  - Re-application matcher gap: original backfill matched email + course only, assigning parent IDs to all child re-application sheet rows. Hardened to (a) include children in candidates, (b) track assignedIds in-batch, (c) prefer candidates with closest `submitted_at` to sheet row's submitted_at.
  - Lost-fastrack misclassification: lead 375 (Lisa Parker, fastrack → DQ → Lost) was showing in "Needs your attention → Fastrack leads" on the home dashboard. Fixed by sharing a FASTRACK_SETTLED set across `/provider/page.tsx`, `/admin/preview/[id]/home/page.tsx`, and `leads-table.tsx` (counts, filter, isActionRow).
- **View-as-provider preview complete.** `/preview/[provider_id]/{home,leads,account}` all live, lands on `/home` by default. Tabs: Home / Leads / Account / Exit. Read-only — no Server Actions wired, action surfaces hidden. PreviewHeader gives a persistent "Viewing as X — Read-only" banner across all three views.
- **`ProviderHomeView` extracted** to `app/provider/home-view.tsx`. Both `/provider/page.tsx` (real provider) and `/admin/preview/[id]/home/page.tsx` (preview) now call the same view. Removed ~150 lines of duplicated JSX + helpers from the live page in the same pass.
- **Three queued portal asks shipped:**
  - Cohort + course filters on `/provider/leads` — dropdowns next to status pills, intake date parsed from intake id format `<region>-<YYYY-MM-DD>` for sort + label. Hidden when provider has only one course / no cohort ids on file.
  - Free-text outcome notes (migration 0116: `crm.enrolments.outcome_note` TEXT). Provider portal exposes the textarea on both Lost and Cannot reach pickers (refactored "Cannot reach" from one-click to a confirm-gated picker for parity). Note renders inline under the current status block on `/provider/leads/[id]`.
  - Lead source breakdown on `ProviderHomeView` — last 30 days routed leads grouped by `utm_source` (empty bucketed as "direct"), top 5, simple per-source bar chart. Both live home and admin preview home use it.
- **`/data-ops` merged into `/errors`** as one dashboard. Live reconcile + Data ops one-shot panels (024, 025, sheet ID backfill) live together. `/data-ops` URL kept as a redirect for old bookmarks. Sidebar Data ops link removed.
- **Admin-gated cards on `/provider/account`** — "Your business" + "Pricing" cards now hidden from team members on the `provider_user` role (commercial terms admin-only).
- **`free_enrolments_remaining` display dropped** from both real and preview account pages — counter has no decrement path so surfacing it misleads providers. Revisit when billing logic hardens.
- **Action-needed pill restyled** to match the other FilterPills on `/provider/leads` (rose tone — red outline default, red filled when active). The prominent special-case rendering above the filter row is gone; sits inline with the rest.
- **Course + cohort filters converted from dropdowns to pill rows** with pretty labels. `courseDisplayName` strips known region suffixes and Title-cases (with SMM / CRM acronym handling); `cohortDisplayName` renders the parsed intake date in friendly form ("26 May"). Hidden when the provider has only one course / no cohort ids on file. Per-pill count next to each label so the provider sees distribution at a glance.
- **Team user removal on `/provider/account`** for admin role. New `removeProviderUserAction` Server Action with hard guard rails (must be active provider_admin, can't remove self, can't remove the last active admin — count-check before commit). Soft delete via `status='removed'`; audit row via the existing `public.log_provider_action_v1` wrapper so the admin audit page picks it up alongside outcome marks. Confirmation step before commit. Both `/provider/account` and `/admin/preview/[id]/account` queries filter `status='removed'` out of the team list.
- **Bulk update expanded** to four modes on the BulkBar: "Tried, no answer" (advances each lead's attempt count per its current state — `open→1, 1→2, 2→3`, anything past attempt_3 or terminal skips), "Meeting booked", "Cannot reach", "Lost…" (with reason picker as before). `bulkMarkOutcomeAction` accepts the expanded enum; "enrolled" deliberately not in the bulk set — too consequential, stays on per-lead. Audit context carries the `bulk_mode` tag so the admin audit page can group bulk events by intent.
- **Fastrack-settled fix:** lead 375 (Lisa Parker, fastrack → DQ → Lost) was showing in "Needs your attention → Fastrack leads" on home + "Fastrack" filter pill counts on `/provider/leads`. Now excluded across all three surfaces via a shared `FASTRACK_SETTLED` set (`lost`, `enrolled`, `presumed_enrolled`).

## Next steps

1. **Build read-only preview lead detail.** New page at `/admin/preview/[provider_id]/leads/[lead_id]` so the click-through from preview leads list stays in the preview namespace instead of routing to `/admin/leads/[lead_id]`. Cleanest implementation: extract `app/provider/leads/[id]/page.tsx` (559 lines) into a presentational `<LeadDetailView>` component mirroring the `ProviderHomeView` pattern; preview page renders without action callbacks so write surfaces hide. ~45 min of careful refactor.
2. **Riverside + auto-flip framework planning session.** Paired discussion before any code. Covers: `lead_type` schema field (`learner` | `employer`), status enum extension or parallel table for employer leads (`employer_signed`, `presumed_employer_signed`), 60-day vs 14-day auto-flip cron variants, Mira's activity-gate framework, day-12 Brevo warning templates (learner + provider), per-provider `auto_flip_enabled` flag, "providers taking the mick" framing (activity tracking and consequences), notification preferences split inside the same conversation. Riverside soft launches Wed 13 May via Mable's dedicated `netlify-employer-lead-router` Edge Function + Google Sheet, so platform doesn't block — but a stopgap "treat employer leads as generic" approach buys ~1-2 weeks before proper schema work needs to ship.
3. **EMS portal cutover.** Operational milestone, sequenced after read-only preview lead detail is built (so Andy can be walked through what he'll see). Steps: seed `provider_users` row for Andy with `role='provider_admin'`, flip `enterprise-made-simple.portal_enabled=true`, send passkey invite via existing `provider-invite-link` flow, confirm Andy can sign in and only sees EMS-routed leads, run a few outcome marks together. WYK + CD follow the same pattern after EMS's first week looks clean.
4. **Hourly cron health check 2 null status_codes.** `net._http_response` showed 2 null status_codes in the last 24h alongside 62 clean 200s. Probably transient. Worth a 5-min look at which cron + when, but not blocking.

## Decisions and open questions

**Decisions made:**

- **DB is canonical for everything except consent.** Sheet, Brevo attributes, portal, admin are all surfaces over the DB. Consent (unsub/bounce) flows Brevo → DB via `brevo-event-webhook`. Captured in `/errors` reconcile panel copy + handoff for permanence.
- **Auto-push DB → sheet is not worth building before sheet retirement.** Adding real-time push on every admin write would add 250-500ms latency to every status change and a flaky-Apps-Script failure mode. Sheets retire when each provider migrates to the portal anyway. 24h drift cron + one-click cure is sufficient until then.
- **`/data-ops` merged into `/errors`.** Single dashboard for all data-layer attention. Different mental models (live state vs historical one-shot) wasn't pulling its weight as a page split.
- **Free-text outcome notes scoped to terminal outcomes only.** Lost + Cannot reach get the optional note textarea. Progress states (open / attempt_X / Meeting booked / Enrolled) don't — the natural next move is the context, not a frozen note.
- **Fastrack-settled set: lost + enrolled + presumed_enrolled.** `cannot_reach` stays in the fastrack "active" pool because a returning learner can still be picked up.
- **Notification preferences deferred into the 0097 planning session.** Charlotte's call: providers shouldn't opt out of things that affect their SLA, so the preference shape needs framing inside the broader "what gates billing / what surfaces inactivity" conversation, not as an isolated UX toggle.

**Open questions:**

- **Riverside lead_type schema shape.** Options: enum on `leads.submissions`, parallel `employer_leads` table, or scope-by-provider (provider has lead_type column, submissions inherit). Decided in the planning session.
- **Auto-flip 0097 trigger criteria.** Activity-gated (skip when provider has logged something), or pure age-gated (flip everything older than X), or hybrid. Mira's framework feeds this.
- **Preview lead detail click destinations.** Should clicks within the preview lead detail (e.g. fastrack details, add note) navigate to preview equivalents, or grey out? Decide while building.

## Watch items

- **Daily drift cron first scheduled run, 06:00 UTC tomorrow (2026-05-12).** Expect `new_drift_total: 0` across all three providers. If non-zero, the daily summary email lands and the new drift dead_letter rows surface on `/errors`.
- **Mable's Switchable for Business launch Wed 13 May.** First employer leads route via the new Edge Function + dedicated Riverside sheet. Platform stays generic for now; if anything goes sideways, leads still appear in `leads.submissions` (via the routing path Mable's building) and `/errors` would catch issues.
- **Sub 96 (Naomi Oikonomou) and sub 122 (lm.sbai)** — both hand-fixed today via manual sheet edits. Confirm next time you open the EMS / WYK sheets that the manual rows still show the corrected IDs (no provider edits have rolled them back).
- **EMS pilot: Andy's auto-presumed count check** carried from Clara's handoff (not platform-side, but worth surfacing since it gates first billing).
- **`net._http_response` null-status pair** in last 24h. Worth one query to identify which job + diagnose; not blocking.

## Next session

- **Folder:** `platform`
- **First task:** Build read-only preview lead detail at `/admin/preview/[provider_id]/leads/[lead_id]` by extracting `/provider/leads/[id]/page.tsx` into a shared `LeadDetailView` component (mirror the `ProviderHomeView` pattern). Preview renders without action callbacks so write surfaces hide. Then update the leads-table `linkPrefix` in admin preview from `/admin/leads/` to `/preview/[id]/leads/`.
- **Cross-project:** Riverside lead_type planning needs cross-input from `switchleads/clients/` (Nell — pilot status, terminology, comms) and `switchable/site/` (Mable — what the form / Edge Function produces). When that planning session starts, push to both their handoffs.
