# Platform Handoff, Session 46, 2026-05-15

## Current state

Portal is launched. Riverside (Jane admin + Freya user) and EMS (Andy + Daniel admins, Jake + George + Nick users) invited at ~15:00-15:15. Daniel walked the full new-user flow at 15:20-15:26 — first real provider through welcome + SLA. Welcome deck v3 (audience-aware, SLA as final slide, admin-only team slide), per-user SLA acceptance with audit trail, B2B attribute upsert with provider trust line, U2 sender split, real-provider gate bypassed, and admin preview matching real provider view all shipped this session. Test data cleared across Riverside + EMS portal queries. WYK + Courses Direct still pre-launch (portal_enabled=false, no team invited).

## What was done this session

- **B2B Brevo attributes wired.** Migration 0142 added `crm.providers.b2b_trust_line`. Data-ops 032 backfilled Riverside with Wren's canonical prose. `netlify-employer-lead-router.upsertEmployerInBrevo` now upserts `FIRSTNAME` + `B2B_COMPANY_NAME` / `B2B_ROLE_TITLE` / `B2B_INTEREST` / `B2B_CANDIDATE_IN_MIND` / `B2B_URGENCY` / `B2B_LEVY_STATUS` / `B2B_SECTOR` / `B2B_COMPANY_SIZE` / `B2B_EXISTING_APPRENTICES` / `B2B_HEADCOUNT_ESTIMATE` / `B2B_STANDARD` / `B2B_LEAD_TYPE` / `B2B_MATCHED_PROVIDER` / `B2B_PROVIDER_NAME` / `B2B_PROVIDER_TRUST_LINE` / `B2B_ROUTING_OUTCOME` / `B2B_FIRST_SUBMISSION_AT` before U1 ack send. Wren's U1-employer template can drop in `{{contact.B2B_PROVIDER_NAME}}` + `{{contact.B2B_PROVIDER_TRUST_LINE}}` + `{{contact.B2B_STANDARD}}` without hardcoded Riverside text.
- **Provider RLS excludes is_dq.** Migration 0143 patched `provider_read_submissions` to add `AND is_dq IS NOT TRUE`. Riverside portal stops showing 16 historical test rows the moment it lands.
- **Per-user SLA acceptance.** Migration 0144 added `sla_accepted_at` + `sla_accepted_version` to `crm.provider_users`. `requireProviderUser` reads user-level instead of provider-level; SLA gate also skipped when `skipWelcomeGate=true` so the welcome deck's final slide handles the tick. Every team member accepts individually with an audit row per acceptance.
- **Welcome deck v3.** SLA folded into the deck as the final slide (tick + "I agree, take me in" → markWelcomeAndSlaAccepted writes both timestamps + audit). Admin-only "Bringing your team in" slide inserted before the SLA terminator for users where role=`provider_admin`. Home slide adds the timer/Overdue badge mention. Automations slide drops the auto-flip clock line. Billing slide replaced with Support slide. HeroVisual loses the dead "Enrolments 30d / 0" stat. AutomationsVisual trimmed to 2 rows per audience. New SupportVisual + AddUsersVisual + SlaSlide components.
- **Demo providers seeded.** Data-ops 035 + 036 created `demo-b2b` (apprenticeship, v2, employer deck) and `demo-b2c` (gov-funded, v1, learner deck). Charlotte walked the demo-b2b flow end-to-end at 14:36 — first verification the welcome+SLA path works.
- **Riverside contact updated.** Data-ops 033 swapped contact from Jane Preston / `<\tjane@...>` (mangled) to Freya Kelly / `Freya.Kelly@riverside-training.co.uk`. U2 greeting matches the actual recipient.
- **U2 lead-notification sender split.** New brand `switchleads_leads` in `_shared/brevo.ts` reading `BREVO_SENDER_EMAIL_LEADS`. Switched on `_shared/route-lead.ts` (B2C funded U2), `netlify-employer-lead-router` (B2B U2), and the presumed-warning + presumed-flipped crons. `resolveBrandSender` falls back to `BREVO_SENDER_EMAIL` when the LEADS env var is unset, so safe deploys without the env var. Charlotte sets `BREVO_SENDER_EMAIL_LEADS=hello@switchleads.co.uk` when ready.
- **Real-provider invite gate bypassed.** Admin Server Action sends `x-allow-real: true` so the demo-only fence in `provider-invite-link` doesn't block production invites.
- **`portal_enabled=true` flipped on EMS + Riverside.** Required before `provider-invite-link` accepts the invite request (gate fires when false).
- **U2 emails carry sheet fallback.** Both B2C funded U2 and B2B employer U2 now render the sheet link below the portal CTA when both are present.
- **OWNER_CC_ALL_EMAILS helper.** Added `appendOwnerCc()` to `_shared/brevo.ts`. Env var unset by default; when set, every `sendBrevoEmail` + `sendTransactional` call cc's the owner for launch monitoring.
- **Audit-trail bug fixed.** `markWelcomeAndSlaAccepted` was calling the audit RPC via the admin client (NULL `auth.uid()` → `audit.log_provider_action` rejected with `insufficient_privilege`, silent fail in the catch). Switched to the authenticated supabase client for the RPC. Same fix on the standalone `/provider/sla-agreement/actions.ts`. Daniel's missed audit row backfilled via data-ops 037.
- **Admin preview matches real provider view.** `/admin/preview/<id>/leads` and `/admin/preview/<id>/home` now apply the same is_dq filter as the production RLS policy. Two-step query for home (load non-DQ submission IDs first, then scope enrolments + fastrack to those IDs) — the earlier nested-relation supabase-js filter silently dropped every row and made the preview report "every lead tried" when EMS had 58 open enrolments.
- **Admin provider detail SLA badge fixed.** Was reading the historical per-provider column; now derives from `crm.provider_users.sla_accepted_at` and shows `SLA: X/N accepted`.
- **Provider /leads gains a Region column** (learner view only — sourced from `leads.submissions.region`).
- **B2B_STANDARD attribute added** to upsertEmployerInBrevo so Wren's U1-employer template can reference `{{contact.B2B_STANDARD}}`.
- **Data-ops 030, 031, 033, 034, 035, 036, 037 applied** through the session.

## Next steps

1. **Watch the other invited users walk through.** Andy, Jake, George, Nick (EMS) and Jane, Freya (Riverside) still at `status='invited'`. Each will follow the same path Daniel did. Verify their audit rows land cleanly (the audit bug fix shipped at c5f62c2; subsequent acceptances should write rows automatically). Query: `SELECT id, action, actor_email, created_at FROM audit.actions WHERE action='accept_sla' ORDER BY id DESC`.
2. **First real B2C ad-driven lead → confirm full chain.** Eyeball Edge Function logs end-to-end: DB insert → upsertLearnerInBrevo → U1 funded ack → U2 to EMS provider → sheet append → portal renders. Same eyeball check on the B2B side when paid traffic generates an employer lead.
3. **Optional env vars** in Supabase Vault when ready:
   - `BREVO_SENDER_EMAIL_LEADS = hello@switchleads.co.uk` — splits lead-notification sender from `support@`. Until set, the LEADS brand falls back to `BREVO_SENDER_EMAIL` via `resolveBrandSender`.
   - `OWNER_CC_ALL_EMAILS = hello@switchable.careers` (or wherever) — cc's owner on every Edge Function email for launch monitoring.
4. **Launch WYK + Courses Direct** when ready: `UPDATE crm.providers SET portal_enabled = true WHERE provider_id IN ('wyk-digital','courses-direct')` + invite their respective teams from `/admin/providers/<id>`.
5. **Lead-assignment "in session" lock (Phase 2).** Charlotte's idea earlier today: claim-on-open + "Take over" admin override + auto-release on status update. Deferred from this session. Re-trigger when collision risk emerges (currently 1-2 users per provider).
6. **Tighten data-ops audit-log template (carry forward).** Future data-ops scripts capture `before_value` via a SELECT into a variable; write audit row only when the UPDATE actually mutated something. Carries from Session 44.
7. **WYK + Courses Direct sheet-vs-DB reconcile (carry forward).** Backlog 869d994nb. Drift reconciler self-heals; verify near-zero each Monday for two weeks then close.
8. **`/provider/leads` N+1 + cursor siblings (carry forward).** Backlog 869d994qf.
9. **`RealtimeRefresh lead_notes` subscription scope (carry forward).** Backlog 869d994t5.
10. **RLS `(SELECT fn())` wrap on `crm.disputes` + `leads.fastrack_submissions` (carry forward).** Backlog 869d994un.
11. **Solis carry-forward.** Schema naming decision `ads_business` vs `ads_switchable_business`. `crm.employer_signings` design before first Riverside Employer Signed event fires.

## Decisions and open questions

**Decisions made:**

- **Per-user SLA acceptance** replaces per-provider. Reason: managers don't always forward the SLA on to new staff, so transitive consent within a team isn't safe. Every team member accepts individually with an audit row per acceptance. Per-provider columns on `crm.providers` stay as historical first-acceptance markers but are no longer read at the gate.
- **Welcome deck folds SLA into its final slide.** New flow: sign in → welcome deck → SLA tick on last slide → portal. Standalone `/provider/sla-agreement` is kept for version-bump re-acceptance after the user is already past welcome.
- **`x-allow-real: true` always sent from admin invite Server Action.** Original gate intended RLS proof + /ultrareview + pen-test gate before lifting; in practice RLS proof is documented, /ultrareview unavailable, pen-test pending. Charlotte's launch judgement carries the decision.
- **`BREVO_SENDER_EMAIL_LEADS` falls back to `BREVO_SENDER_EMAIL`.** Safer than failing on missing env var. Until LEADS is set, lead notifications send from `support@`. Once set, switch to `hello@` automatically.
- **Admin preview matches RLS by replicating the filter in app code,** not by switching to the authenticated client. Admin client bypasses RLS and we need that for cross-provider data, but we manually mirror `primary_routed_to = X AND is_dq IS NOT TRUE` on the queries.
- **Demo-only fence on `provider-invite-link` stays in the function** as defence-in-depth even though the admin UI bypasses it. Belt-and-braces against a future caller that doesn't know to send the header.

**Open questions:**

- The audit RPC requires `auth.uid()`. The bug surfaced because every Server Action calling it via the admin client silently fails. Future Server Actions that want to audit need to use the authed client. Worth a code-search sweep of every `admin.rpc("log_provider_action*"` to confirm the rest of the codebase isn't silently dropping audit rows in the same way.
- Standalone `/provider/sla-agreement` is the version-bump re-acceptance path; the audit fix applied to its Server Action too. Worth a test once SLA_VERSION bumps to confirm the version-bump path still audits cleanly.

## Watch items

- **First Wed/Thu real B2B Riverside submission.** Confirm `source_form='s4b-employer-lead-v1'`, full U1 + U2 + sheet append chain runs, B2B_PROVIDER_NAME + B2B_PROVIDER_TRUST_LINE + B2B_STANDARD attributes populate on the Brevo contact.
- **Audit row lands on every new SLA acceptance.** Check `audit.actions WHERE action='accept_sla' ORDER BY id DESC` after each invited user completes their flow. The fix is deployed; rows should appear without further intervention.
- **`SLA: X/N accepted` badge** on `/admin/providers/<id>` reflects each new acceptance accurately as team members come through.
- **TEST_MODE in Supabase Vault confirmed `false`** earlier today. Re-verify before any session that might trigger a real B2B submission.
- **First real cohort_decline fastrack** (carry from Session 44 — untested under migration 0139).
- **First fire of `dead-letter-alert-hourly` cron** (carry from Session 44).

## Next session

- **Folder:** `platform`
- **First task:** Open `/admin/providers/enterprise-made-simple` and `/admin/providers/riverside-training`, scan team status. Confirm any newly-completed welcome+SLA flows wrote audit rows. If anyone's still at `status='invited'` past tomorrow, gentle follow-up. Then eyeball Edge Function logs for the first real B2B paid-traffic submission (likely Wed/Thu) end-to-end.
- **Cross-project:** Wren (U1-employer template now wired with B2B_PROVIDER_NAME + B2B_PROVIDER_TRUST_LINE + B2B_STANDARD — she can drop hardcoded Riverside text and the template will render dynamically; also lead-notification sender will switch to `hello@switchleads.co.uk` once Charlotte sets `BREVO_SENDER_EMAIL_LEADS`). Nell (Riverside + EMS launched today, Daniel first through; team-adoption tracking is now possible per-user on `crm.provider_users.welcome_completed_at` + `sla_accepted_at`).
