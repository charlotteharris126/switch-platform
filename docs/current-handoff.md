# Platform Handoff, Session 42, 2026-05-12

## Current state

Switchable for Business v1 backend shipped. Riverside seeded as fourth pilot provider (PPA v2, employer-apprenticeship lead type, 60-day flip). 12 new migrations applied (0122-0133). Per-provider SLA template system live: each provider carries its own first-attempt hours, attempts-required, attempt-window, stale-attempt hours, presumed-flip days. Auto-flip cron rewritten to honour per-provider thresholds AND gate on `auto_flip_enabled=true AND sla_accepted_at IS NOT NULL`. First-sign-in SLA acceptance page in portal (admin-only accept). Day-before warning + post-flip notification crons wired. Sheet status sync from portal to provider sheet keeps the two from drifting. Provider agreement page in portal renders PPA bullets + SLA thresholds. Brevo URL backfill semantics fixed (first-submission referral_code, latest-submission fastrack URL). Two view bugs caught + fixed (hardcoded `3` free cap, learner-only billable state, hardcoded 14-day overdue threshold).

## What was done this session

- **Switchable for Business backend (Mable's brief, Wed 13 May launch).** Migration 0122 adds `lead_type` discriminator + 14 employer columns + `routing_outcome` + `terms_accepted_at` + composite index. Migration 0125 extends `email_log` CHECK with `s4b_employer_u1` + `s4b_employer_ud`. Migration 0126 rewrites `upsert_enrolment_outcome` with extended status + lost_reason whitelists covering both lead types. New Edge Function `netlify-employer-lead-router` (mirrors `_shared/route-lead.ts` patterns verbatim after first attempt invented columns — bit captured in memory).
- **Riverside provider seeded.** data-ops/026 inserts `riverside-training`, PPA v2, dual-route, Employer Lead only at launch, Project Management L4 first. Same script seeds `sla_provider_obligations` + `sla_switchleads_obligations` arrays for all four pilots (v1/v2 wording divergence).
- **Per-provider SLA template system.** Migration 0127 adds 5 SLA columns to `crm.providers` with PPA v1 defaults (24h / 6 attempts / 7-day window / 36h stale / 14-day flip). v2 providers updated to 24h / 6 / 14-day window / 120h stale / 60-day flip. CD set to 17-day flip as grace for Marty (ClickUp `869d90fkr` to revert to 14 once active).
- **SLA acceptance gate.** Migration 0128 adds `auto_flip_enabled` (default true), `sla_accepted_at`, `sla_accepted_by_user_id` (FK), `sla_accepted_version`. `require-provider.ts` redirects to `/provider/sla-agreement` when not accepted or version drift. New page is admin-only-accept (checkbox-gated submit, sign-out button, Brevo-delivered logo). Server Actions split (SLA_VERSION in `version.ts` because "use server" can only export async).
- **Auto-flip cron rewritten per-provider.** Migration 0129: `crm.run_enrolment_auto_flip` now uses each provider's `sla_presumed_flip_days`, picks `presumed_employer_signed` vs `presumed_enrolled` from `lead_type`, gates on `auto_flip_enabled AND sla_accepted_at IS NOT NULL`. Migration 0130 adds `provider_presumed_flipped` email_type. Migration 0131 schedules `email-presumed-flipped-cron-daily` at 07:00 UTC. New Edge Function `email-presumed-flipped-cron` sends batched per-provider post-flip notice with 7-day dispute deadline. `email-presumed-warning-cron` patched per-provider aware (day-12 v1 / day-58 v2) + gates.
- **Portal-to-sheet status sync.** New `app/lib/sheet-status-sync.ts` helper fires from Server Actions on major transitions only (skips sub-states: attempts, in_progress, meeting_booked). Uses `SHEETS_APPEND_TOKEN` (same secret already wired into every per-sheet `lead_append_*` Apps Script). Apps Script `sheet-edit-mirror` STATUS_MAP extended with employer values (engaged, in_progress, signed, not_signed, presumed signed).
- **Provider agreement page in portal.** `/provider/agreement` renders SLA thresholds + PPA obligations (yours + ours) from new `crm.providers` columns. Notion link hidden when `agreement_notion_page_id` is null. Header reworked from "Before you start, let's re-confirm" through several drafts to land on "Your SLA agreement" + softened intro after Charlotte feedback on AI-flavoured fragments and passive-aggressive tone.
- **Admin provider page.** Added badges for SLA acceptance state, PPA version, auto-flip OFF.
- **Two view bugs caught + fixed.** Migration 0132 rewrites `vw_provider_billing_state` to use `crm.providers.free_enrolments_remaining` as per-provider cap (was hardcoded `3` → showed Riverside as "3 free remaining" instead of 1) AND adds employer success states (`signed`, `presumed_employer_signed`) to `billable_or_pending_count`. Migration 0133 fixes `vw_provider_performance` (count `signed` alongside `enrolled`) and `vw_needs_status_update` (per-provider `sla_presumed_flip_days` threshold instead of hardcoded 14, plus cleaner "open or no enrolment" actioned-leads logic).
- **Data reconciliation.** Lead 128 (Jyotika Mark) orphan fixed via `crm.ensure_open_enrolment`. data-ops/025 backfilled 101 historic leads with intake stamps + 9 cohort-decline closures (cannot_reach intentionally excluded from closure transition).
- **Brevo URL backfill semantics fix.** `backfill-referral-fastrack-urls` patched: uses first submission per email for `referral_code` (stable share-with-friend links), latest submission for fastrack URL (current course intent). Dry-run after patch: ~20 contacts changed (mix of swaldby-class learner referrals stabilising + two historical drift corrections). Applied clean.
- **Memory updates.** `feedback_mirror_existing_code_dont_paraphrase_briefs.md` (bit on `netlify-employer-lead-router` invented columns). `project_netlify_deploys_everywhere.md` (we deploy via Netlify, not Vercel). `feedback_verify_funding_figures_before_publishing.md` extended for source-wording drift.

## Next steps

1. **Owner: invite Andy (EMS cutover).** `/admin/providers/enterprise-made-simple` → send portal invite. EMS sheet republish from DB before invite (per Session 41 prereq). First-sign-in flow now lands on SLA agreement page; Andy must accept before reaching portal home.
2. **Owner: invite Jane (Riverside).** `/admin/providers/riverside-training` once Mable's S4B Edge Function is wired in Netlify and first employer lead has flowed end-to-end. SLA agreement page renders v2 thresholds (24h / 6 / 14d window / 120h stale / 60d flip).
3. **Owner: invite Marty (CD cutover).** `/admin/providers/courses-direct`. 17-day flip grace is in place; ClickUp `869d90fkr` tracks reverting to 14 once Marty is actively working leads.
4. **Wren: 3 Brevo templates.** `BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING` (day-before notice), `BREVO_TEMPLATE_PROVIDER_PRESUMED_FLIPPED` (post-flip 7-day dispute window notice), `BREVO_TEMPLATE_U1_EMPLOYER` (employer welcome on Mable's S4B form). Wren is on with it.
5. **Owner: republish EMS + WYK sheets from DB** before sending invites (current sheet content predates portal-driven sync; republish brings them to the canonical projection).
6. **Owner: mark 25 `sheet_drift_detected` dead-letter rows resolved** on `/admin/errors` once sheets republished.
7. **Followup ticket: per-provider `sla_dispute_deadline_days`.** Migration 0129 currently hardcodes the 7-day dispute window. Lower priority — flip to per-provider when first PPA negotiation lands a different number.

## Decisions and open questions

**Decisions made:**

- **`lead_type` discriminator on `leads.submissions`, not parallel table.** Reason: most columns are shared between learner + employer; a parallel table would force every consumer (portal, admin, views, crons) to UNION across two shapes for no schema gain. Discriminator + 14 employer-only columns is cleaner and keeps the index footprint small.
- **Sheet sync from portal fires on major transitions only.** Sub-states (attempt_1/2/3, in_progress, meeting_booked) skip sheet push. Reason: providers don't track sub-states in sheets; firing the sheet write on every micro-transition adds noise + Apps Script quota burn for no benefit. Major transitions (open, enrolled, signed, cannot_reach, lost, presumed_*) cover the full set of what sheets care about.
- **SLA acceptance is per-provider, not per-user.** One row in `crm.providers` covers every user on that provider. Reason: SLA terms are a commercial document binding the provider entity, not individual employees; once admin accepts, everyone on the provider benefits. Only `provider_admin` role sees the accept button; `provider_user` sees the agreement display only.
- **Auto-flip gated on BOTH `auto_flip_enabled AND sla_accepted_at IS NOT NULL`.** Belt-and-braces. `auto_flip_enabled` is the per-provider kill switch; SLA acceptance is the consent precondition. Riverside auto-flip will not fire until Jane accepts the v2 SLA in portal.
- **CD presumed-flip set to 17 days, not 14.** Grace for Marty's currently-stuck leads. Reverts to 14 once Marty is actively working leads (ClickUp `869d90fkr`).
- **Brevo `referral_code` uses first submission per email; `fastrack URL` uses latest.** Reason: referral codes need to be stable so previously-shared `?ref=` links keep working. Course intent needs to be current. Two CTEs in the backfill query keep them independent.
- **Dispute window stays hardcoded 7 days for now.** All four pilot PPAs (v1 and v2) carry 7 days. Promotes to per-provider column only when first negotiated divergence lands.

**Open questions:**

- **Per-provider `sla_dispute_deadline_days` column.** Hardcoded 7 in `crm.run_enrolment_auto_flip`. Promote when needed.

## Watch items

- **Mable's S4B Edge Function deploy.** `netlify-employer-lead-router` shipped to Supabase; owner still needs to wire the per-form webhook on Netlify Forms for `s4b-employer-lead-v1`. Site-wide webhook will defensively ignore the form (added to ignore-list in `netlify-lead-router`). Test 3 confirmed clean end-to-end on a staged submission.
- **Day-12 warning + day-of-flip + day-after notice email chain.** First fires when a v1 provider's open lead crosses day-12 (and provider has accepted SLA + auto-flip on). Wren's three templates are the missing piece; until they land, the cron will skip send and log instead of erroring.
- **Auto-flip cron first scheduled fire.** 06:00 UTC daily. Gated, so no flips will land until at least one provider has accepted SLA AND has a lead old enough. Worth eyeballing the cron run log on first activation.
- **CD 17-day grace.** Ticket `869d90fkr` tracks the revert. Default is 14.
- **Net `_http_response` null-status pair** still outstanding from Sessions 40-41. Not blocking.

## Next session

- **Folder:** `platform`
- **First task:** Owner confirms which provider(s) got invited and reports first-sign-in UX (SLA acceptance + landing on portal home). Investigate any errors from `/admin/errors` queued in the meantime.
- **Cross-project:** Wren (`switchable/email`) owes 3 Brevo templates. Pushed in step 5 below to `switchable/email/docs/current-handoff.md`.
