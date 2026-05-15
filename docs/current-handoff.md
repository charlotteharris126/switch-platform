# Platform Handoff, Session 47, 2026-05-15

## Current state

EMS regional contact branching shipped end-to-end on the platform side. New JSONB column `crm.providers.regional_contacts`, EMS row populated with George/Jake/Nick mapped by LA, four Edge Functions redeployed. U1 funded ack now passes `SW_PROVIDER_CONTACT_BLOCK` as a pre-rendered HTML paragraph naming the specific rep + the mobile number their call will come from, empty string for non-EMS leads. Goes live the moment Wren drops the placeholder into the U1_FUNDED Brevo template.

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
- **Cross-project push written into `switchable/email/docs/current-handoff.md`** at the top of Wren's Next steps. Action, sample rendered HTML, three-rep LA map, two-lead test path. Uses `params.` not `contact.` (per-send variable, no Brevo attribute setup needed).

## Next steps

1. **Wren drops `{{ params.SW_PROVIDER_CONTACT_BLOCK }}` into the live U1_FUNDED Brevo template.** Ask is in switchable/email handoff. Until it lands, every U1 funded send carries the new param but the template ignores it.
2. **First real EMS funded lead post-Wren-edit, verify end-to-end.** Submit at `/funded/counselling-skills-tees-valley/` selecting Redcar; the U1 email should show "Nick from Enterprise Made Simple..." + 07842 444 808 in its own paragraph. Eyeball Edge Function logs to confirm `SW_PROVIDER_CONTACT_BLOCK` populated correctly.
3. **Non-EMS sanity check.** Submit a WYK or Courses Direct funded lead; the U1 should render as before, no broken paragraph or stray whitespace where the param would have landed.
4. **Watch invited portal users walk through.** Andy, Jake, George, Nick (EMS) and Jane, Freya (Riverside) still at `status='invited'` from Session 46. Audit rows should land cleanly per the c5f62c2 fix.
5. **First real B2C ad-driven lead, confirm full chain.** Eyeball Edge Function logs end-to-end: DB insert → upsertLearnerInBrevo → U1 funded ack → U2 to EMS provider → sheet append → portal renders.
6. **Optional env vars** in Supabase Vault when ready: `BREVO_SENDER_EMAIL_LEADS = hello@switchleads.co.uk`, `OWNER_CC_ALL_EMAILS = hello@switchable.careers`.
7. **Launch WYK + Courses Direct portals** when ready: flip `portal_enabled = true` and invite teams from `/admin/providers/<id>`.
8. **Lead-assignment "in session" lock (Phase 2).** Deferred from Session 46. Re-trigger when collision risk emerges.
9. **Tighten data-ops audit-log template** (carry forward from Session 44). Future scripts capture `before_value` via SELECT into a variable, write audit row only when UPDATE actually mutated.
10. **WYK + CD sheet-vs-DB reconcile** (carry forward, backlog 869d994nb).
11. **`/provider/leads` N+1 + cursor siblings** (carry forward, backlog 869d994qf).
12. **`RealtimeRefresh lead_notes` subscription scope** (carry forward, backlog 869d994t5).
13. **RLS `(SELECT fn())` wrap on `crm.disputes` + `leads.fastrack_submissions`** (carry forward, backlog 869d994un).
14. **Solis carry-forward.** Schema naming decision `ads_business` vs `ads_switchable_business`. `crm.employer_signings` design before first Riverside Employer Signed event.
15. **CLI migration registry cleanup.** `supabase migration list --linked` shows 0141 through 0145 in local but not remote. Production schema is correct (columns exist, portal working, Daniel through SLA). Run `supabase migration repair --status applied 0141 0142 0143 0144 0145` at a calm moment so the next `supabase db push` doesn't try to re-apply.

## Decisions and open questions

**Decisions:**

- **Per-provider regional contact mapping lives in `crm.providers.regional_contacts` JSONB**, not a dedicated table. Reason: v1 is one provider with five LA entries; JSONB keeps shape additions free (future fields like subject prefix, calendly link, working hours) without migrations. Reassess against a dedicated table only if a second provider adopts the pattern.
- **Pre-render the HTML block server-side and pass as a single transactional param.** Per `feedback_brevo_no_liquid_conditionals.md`, Brevo `{% if %}` rendering is unreliable across sends and splitting templates per audience would double maintenance. Empty string for non-EMS leads means one template placeholder, drop it once, works for everyone.
- **`params.` not `contact.`** for the new block. Per-send transactional param means no Brevo attribute setup is needed and the attribute-wiring backfill rule (`platform/CLAUDE.md` pre-broadcast gate) does not apply.
- **0145 + data-ops 038 applied via Supabase SQL Editor, not `supabase db push`.** CLI metadata showed 0141 through 0145 unrecorded on remote, but 0141 through 0144 had clearly been applied (portal working, Daniel through SLA). Per `feedback_verify_deploy_state.md`, using SQL Editor matched the established Session 46 pattern and avoided a repair-then-push divergence on production.

**Open questions:** none this session.

## Watch items

- **First EMS funded lead after Wren's template change.** Confirm `SW_PROVIDER_CONTACT_BLOCK` renders with the right rep + phone for the LA selected. Spot-check a Redcar lead (Nick) and a Stockton lead (George) once volume allows.
- **Non-EMS funded U1 send.** Confirm the empty-string param renders as nothing once Wren's edit is live (no broken paragraph or stray whitespace).
- **CLI migration registry drift.** 0141 through 0145 in local but not remote per `supabase migration list --linked`. Production correct. Repair at a calm moment per Next steps #15.
- **Audit row lands on every new SLA acceptance** (carry from Session 46). Check `audit.actions WHERE action='accept_sla' ORDER BY id DESC` after each invited user completes their flow.
- **`SLA: X/N accepted` badge** on `/admin/providers/<id>` reflects each new acceptance accurately (carry from Session 46).
- **TEST_MODE = false** in Supabase Vault. Re-verify before any session that might trigger a real B2B submission.
- **First real cohort_decline fastrack** (carry from Session 44, untested under migration 0139).
- **First fire of `dead-letter-alert-hourly` cron** (carry from Session 44).
- **First real B2B Riverside submission** (carry from Session 46). Full chain: `source_form='s4b-employer-lead-v1'`, U1 + U2 + sheet append, B2B_* attributes populate.

## Next session

- **Folder:** `platform`
- **First task:** Check whether Wren has dropped `{{ params.SW_PROVIDER_CONTACT_BLOCK }}` into the U1_FUNDED Brevo template. If yes, submit a Redcar test lead at `/funded/counselling-skills-tees-valley/` and verify the U1 email shows Nick + 07842 444 808 in its own paragraph; then eyeball Edge Function logs for the same submission to confirm the param populated. If Wren has not done it yet, leave a note and move on to portal team-walkthrough watching (Andy/Jake/George/Nick/Jane/Freya).
- **Cross-project:** switchable/email — push written at the top of Wren's Next steps with action, sample rendered HTML, three-rep LA map, two-lead test path. Push closes when Wren confirms the template change is live.
