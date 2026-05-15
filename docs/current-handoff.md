# Platform Handoff, Session 47, 2026-05-15

## Current state

Two U1 funded ack improvements live end-to-end. (1) EMS regional contact branching: `crm.providers.regional_contacts` JSONB populated for EMS, `SW_PROVIDER_CONTACT_BLOCK` transactional param carries a pre-rendered HTML paragraph naming the regional rep + their mobile number. Placeholder live in the Brevo U1_FUNDED template. (2) U1 funded template split by fastrack state: `sendU1Transactional` branches on `submission.fastracked_at`, post-fastrack reads the new `BREVO_TEMPLATE_U1_FUNDED_POST_FASTRACK` Vault key (set by Wren) and falls back to the pre-fastrack template if unset. Self-funded path unchanged.

## What was done this session

- **Migration 0145 written + applied via Supabase SQL Editor.** Adds `crm.providers.regional_contacts JSONB` (additive, nullable, no schema_version bump).
- **Data-ops 038 written + applied.** Populates EMS row with flat-by-LA mapping: George Taylor (07955 265 739) for Stockton-on-Tees + Hartlepool, Jake Balfour (07931 601 801) for Middlesbrough + Darlington, Nick Rodgers (07842 444 808) for Redcar and Cleveland. Audit row logged via `audit.log_system_action`.
- **`_shared/route-lead.ts` extended.** New `RegionalContactEntry` + `RegionalContacts` interfaces, `regional_contacts` field added to `ProviderRow`, SELECT clause in `routeLead` updated to include the new column.
- **`renderProviderContactBlock` helper added.** Resolves `provider.regional_contacts?.by_la?.[submission.la]` and pre-renders one `<p>` paragraph using `escapeHtml` for every field. Returns empty string when no mapping applies (every non-EMS provider, or EMS lead with no LA / unmapped LA).
- **`SW_PROVIDER_CONTACT_BLOCK` transactional param wired into `sendU1Transactional`.** Per-send param, not a Brevo contact attribute, so no contact backfill required.
- **`admin-test-email` and `admin-brevo-resync` SELECTs extended** to include `regional_contacts`, keeping `ProviderRow` shape consistent across every fetch site.
- **Four Edge Functions redeployed.** `routing-confirm`, `netlify-lead-router`, `admin-test-email`, `admin-brevo-resync`. All read the new column and pass the new param.
- **`platform/docs/data-architecture.md` updated** with the new column under "Provider trust content" (added 0145 line, shape documented).
- **`platform/docs/changelog.md` entry added** at top dated 2026-05-15 (Session 46, late).
- **Cross-project push written into `switchable/email/docs/current-handoff.md`** at the top of Wren's Next steps. Action, sample rendered HTML, three-rep LA map, two-lead test path. Uses `params.` not `contact.` (per-send variable, no Brevo attribute setup needed). Resolved same session: Wren's `{{ params.SW_PROVIDER_CONTACT_BLOCK }}` placeholder live in U1_FUNDED template, local export updated at `switchable/email/html-exports/u1-funded.html`.
- **U1 funded template split by fastrack state.** Wren pushed mid-session: pre-fastrack vs post-fastrack templates should differ (drop the "Get a head start" CTA on post-fastrack leads, since they've already done it). Built in Brevo by Wren + Vault secret `BREVO_TEMPLATE_U1_FUNDED_POST_FASTRACK` set. Platform-side: `sendU1Transactional` extended to branch on `submission.fastracked_at != null`, mirroring the existing `templateEnvName → parseEnvInt → null-check` shape. Falls back to `BREVO_TEMPLATE_U1_FUNDED` when the new env var is unset (safe rollback). Self-funded path unchanged. `email_type` stays `u1_funded` for both variants so `(submission_id, email_type)` idempotency unaffected. No DB migration. `routing-confirm` + `netlify-lead-router` redeployed.
- **`platform/docs/infrastructure-manifest.md` updated** with new `BREVO_TEMPLATE_U1_FUNDED_POST_FASTRACK` row + fallback note on existing `BREVO_TEMPLATE_U1_FUNDED` row.
- **`platform/docs/changelog.md` second Session 47 entry added** for the fastrack split, on top of the regional contacts entry.

## Next steps

1. **Verify both U1 funded improvements on the next real EMS funded lead.** Test path:
   - Lead 1 (pre-fastrack): submit at `/funded/counselling-skills-tees-valley/` selecting Redcar, close the thank-you page WITHOUT completing fastrack → owner-confirm → U1 should be pre-fastrack template (with "Get a head start" button), AND should contain Nick + 07842 444 808 in its own paragraph from `SW_PROVIDER_CONTACT_BLOCK`.
   - Lead 2 (post-fastrack): submit the same form, complete fastrack on the thank-you page → owner-confirm → U1 should be post-fastrack template ("Thanks for sending the extra details across" line, no fastrack button), AND should contain Nick + 07842 444 808 paragraph.
   - Eyeball Edge Function logs to confirm `templateEnvName` resolved as expected on each.
2. **Non-EMS sanity check.** Submit a WYK Camden funded lead post-fastrack: post-fastrack template with no contact block, no broken paragraph or stray whitespace where the param would have landed.
3. **Watch invited portal users walk through.** Andy, Jake, George, Nick (EMS) and Jane, Freya (Riverside) still at `status='invited'` from Session 46. Audit rows should land cleanly per the c5f62c2 fix.
4. **First real B2C ad-driven lead, confirm full chain.** Eyeball Edge Function logs end-to-end: DB insert → upsertLearnerInBrevo → U1 funded ack → U2 to EMS provider → sheet append → portal renders.
5. **Optional env vars** in Supabase Vault when ready: `BREVO_SENDER_EMAIL_LEADS = hello@switchleads.co.uk`, `OWNER_CC_ALL_EMAILS = hello@switchable.careers`.
6. **Launch WYK + Courses Direct portals** when ready: flip `portal_enabled = true` and invite teams from `/admin/providers/<id>`.
7. **Lead-assignment "in session" lock (Phase 2).** Deferred from Session 46. Re-trigger when collision risk emerges.
8. **Tighten data-ops audit-log template** (carry forward from Session 44). Future scripts capture `before_value` via SELECT into a variable, write audit row only when UPDATE actually mutated.
9. **WYK + CD sheet-vs-DB reconcile** (carry forward, backlog 869d994nb).
10. **`/provider/leads` N+1 + cursor siblings** (carry forward, backlog 869d994qf).
11. **`RealtimeRefresh lead_notes` subscription scope** (carry forward, backlog 869d994t5).
12. **RLS `(SELECT fn())` wrap on `crm.disputes` + `leads.fastrack_submissions`** (carry forward, backlog 869d994un).
13. **Solis carry-forward.** Schema naming decision `ads_business` vs `ads_switchable_business`. `crm.employer_signings` design before first Riverside Employer Signed event.
14. **CLI migration registry cleanup.** `supabase migration list --linked` shows 0141 through 0145 in local but not remote. Production schema is correct (columns exist, portal working, Daniel through SLA). Run `supabase migration repair --status applied 0141 0142 0143 0144 0145` at a calm moment so the next `supabase db push` doesn't try to re-apply.

## Decisions and open questions

**Decisions:**

- **Per-provider regional contact mapping lives in `crm.providers.regional_contacts` JSONB**, not a dedicated table. Reason: v1 is one provider with five LA entries; JSONB keeps shape additions free (future fields like subject prefix, calendly link, working hours) without migrations. Reassess against a dedicated table only if a second provider adopts the pattern.
- **Pre-render the HTML block server-side and pass as a single transactional param.** Per `feedback_brevo_no_liquid_conditionals.md`, Brevo `{% if %}` rendering is unreliable across sends and splitting templates per audience would double maintenance. Empty string for non-EMS leads means one template placeholder, drop it once, works for everyone.
- **`params.` not `contact.`** for the new block. Per-send transactional param means no Brevo attribute setup is needed and the attribute-wiring backfill rule (`platform/CLAUDE.md` pre-broadcast gate) does not apply.
- **0145 + data-ops 038 applied via Supabase SQL Editor, not `supabase db push`.** CLI metadata showed 0141 through 0145 unrecorded on remote, but 0141 through 0144 had clearly been applied (portal working, Daniel through SLA). Per `feedback_verify_deploy_state.md`, using SQL Editor matched the established Session 46 pattern and avoided a repair-then-push divergence on production.
- **U1 funded split via two templates rather than Liquid conditional inside one template.** Per `feedback_brevo_no_liquid_conditionals.md`. `SW_FASTRACK_COMPLETED` is already pushed as a transactional param but unreliable when used inside `{% if %}`. Two-template split is the established pattern (matches the U1_FUNDED vs U1_SELF split already in production).
- **Post-fastrack env var falls back to pre-fastrack** rather than skipping the send when unset. Reason: deploy order should be flexible; if Charlotte rolls back the new template for any reason, fastracked leads keep receiving the original (working) template instead of silently skipping.

**Open questions:** none this session.

## Watch items

- **First real funded lead post-deploy.** Confirm both new behaviours fire together: correct template variant (pre vs post fastrack) AND `SW_PROVIDER_CONTACT_BLOCK` rendering the right rep + phone for the LA selected. Spot-check a Redcar pre-fastrack (Nick + fastrack button) and a Redcar post-fastrack (Nick + "Thanks for sending the extra details across").
- **Non-EMS funded U1 send.** Empty-string contact block should render as nothing, no broken paragraph or stray whitespace.
- **CLI migration registry drift.** 0141 through 0145 in local but not remote per `supabase migration list --linked`. Production correct. Repair at a calm moment per Next steps #15.
- **Audit row lands on every new SLA acceptance** (carry from Session 46). Check `audit.actions WHERE action='accept_sla' ORDER BY id DESC` after each invited user completes their flow.
- **`SLA: X/N accepted` badge** on `/admin/providers/<id>` reflects each new acceptance accurately (carry from Session 46).
- **TEST_MODE = false** in Supabase Vault. Re-verify before any session that might trigger a real B2B submission.
- **First real cohort_decline fastrack** (carry from Session 44, untested under migration 0139).
- **First fire of `dead-letter-alert-hourly` cron** (carry from Session 44).
- **First real B2B Riverside submission** (carry from Session 46). Full chain: `source_form='s4b-employer-lead-v1'`, U1 + U2 + sheet append, B2B_* attributes populate.

## Next session

- **Folder:** `platform`
- **First task:** Run the two-lead test from Next steps #1: one Redcar pre-fastrack + one Redcar post-fastrack at `/funded/counselling-skills-tees-valley/`. Both U1 emails should render the regional contact paragraph (Nick + 07842 444 808). The pre-fastrack email keeps the "Get a head start" button; the post-fastrack email replaces it with "Thanks for sending the extra details across". Eyeball Edge Function logs on each to confirm `templateEnvName` resolved as expected.
- **Cross-project:** switchable/email, both Session 47 pushes (regional contact block + U1 funded fastrack split) are now resolved end-to-end. Wren's handoff already reflects this. No outstanding push from platform.
