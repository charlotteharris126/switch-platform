---
name: Provider portal MVP scoping
description: Phase 4 provider-facing portal (read + outcome marking) brought forward to replace the failing sheet-based outcome capture
type: scoping
---

# Provider Portal MVP — Scoping

**Status:** Draft for owner sign-off.
**Created:** 2026-05-08.
**Author:** Claude (platform session).
**Replaces:** the sheet → DB mirror scoping (`sheet-mirror-scoping.md`). Mirror was the bridge to this; if we go portal-first, the bridge is throwaway code.
**Retires:** Google Sheets as the per-provider lead delivery surface, the per-sheet Apps Script appender (`provider-sheet-appender-v2.gs`), the `SHEETS_APPEND_TOKEN` secret, the per-provider sheet setup playbook step, and the planned `sheet-edit-mirror` + `pending-update-confirm` Edge Functions.
**Builds toward:** Phase 4 marketplace (provider self-serve invoicing, dispute submission, credit balances) — schema and routes designed so the v2 additions slot in without rework.

---

## Why this, why now

EMS rarely updates the sheet. WYK and Courses Direct are early-stage on the same path. The sheet-mirror plan from 30 April assumed providers were touching the sheet and we just needed to interpret what they wrote — Channel A (deterministic Status column) and Channel B (AI-interpreted Updates column) both depend on a provider edit firing. **No edit, no signal.** Eight days of operating data shows that's the dominant failure mode, not misinterpretation.

The fix is changing where state lives. If the only way a provider sees their leads is by logging into a portal — same place they mark outcomes — the friction graph flips. Today: open email → open Google Sheets → find row → edit dropdown → done (currently doesn't happen). Portal: click email link → land on lead → click outcome button → done. Same number of clicks, but every click is in one place we own, with audit, RLS, and a "Heena hasn't logged in for 5 days" tile on the admin side.

Secondary unlocks: Apps Script + per-sheet setup retires (one less moving part per onboarding, ~10 min saved per provider). `SHEETS_APPEND_TOKEN` retires (one secret rotation cadence gone). Sheet-mirror Edge Function build (~3 days) is avoided entirely. Phase 4 marketplace billing module gets its first surface.

---

## Design (one paragraph)

A new `/provider/*` route tree at `app.switchleads.co.uk` (host already wired Session A, currently a placeholder page). Magic-link auth via Supabase Auth — provider clicks a button on a Brevo email, lands logged-in. New `crm.provider_users` table maps Supabase auth users to providers (multi-user per provider from day one — EMS could have multiple advisers). RLS overlays on existing `leads.submissions` × `crm.enrolments` × `leads.routing_log` filter every read to `provider_id IN (SELECT provider_id FROM crm.provider_users WHERE auth_user_id = auth.uid())`. Three v1 surfaces: `/provider/leads` (list, filterable by status), `/provider/leads/[id]` (detail, all routed payload fields, redacted as appropriate), and the same detail page hosts the outcome-marking form (same vocabulary as the existing admin enrolment form: contacted / enrolled / not enrolled / disputed / cannot reach). Every state change writes through a new `audit.log_provider_action` helper to `audit.actions` — same append-only pattern as admin, separate actor type. Brevo emails switch from "check your sheet" to "view in portal", deep-linking to the lead detail page (token-authed magic-link if not already signed in). Sheets stay live for a 14-day parallel period, then become read-only audit copies and the appender deploys are removed.

---

## What's in the v1 MVP

### Provider-facing
- **Magic-link login** at `app.switchleads.co.uk/login`. Email → Supabase Auth one-time link → portal home. No passwords, no MFA in v1. Session length 30 days.
- **Provider home (`/provider`)**: counts (open / contacted / enrolled this month / awaiting outcome > 7 days), list of "needs attention" leads (open and routed > 5 days ago), most recent 10 routed leads.
- **Leads list (`/provider/leads`)**: every lead RLS-scoped to this provider, sortable by routed-at, filterable by status. Columns: name, course, routed-at, current status, days-since-routed.
- **Lead detail (`/provider/leads/[id]`)**: full routed payload (name, contact details, course, funding category, eligibility flags, intent answers, fastrack answers if present), routing-log timestamps, current `crm.enrolments.status`. Above-the-fold action: outcome buttons (Contacted / Enrolled / Not enrolled / Cannot reach / Disputed). Each click writes through a Server Action.
- **Inline outcome marking**: same vocabulary as admin (`crm.enrolments.status` enum). Disputed opens a free-text reason field that lands in `crm.disputes` (raised_by='provider'). Enrolled fires the same billing-trigger path as admin marking enrolled. No confirmation dialogs in v1 — outcome buttons are reversible by clicking a different one (audit chain captures the history).
- **Account page (`/provider/account`)**: read-only this provider's contact details, billing model, free-3 progress, signed PPA link. Logout button. No edits in v1.

### Admin-facing (changes to existing surfaces)
- **`/admin/providers/[id]`** gains: last-login-at, total leads viewed, total outcomes marked, "active in last 7 days" badge.
- **`/admin/providers`** list gains: last-login column, sortable.
- **`/admin/leads/[id]`** gains: provider-side activity panel (when did the provider open this lead, what outcomes did they set in what order). Powered by `audit.actions` filtered to provider actor.
- **New tile on `/admin`**: "providers without recent login" (configurable threshold, default 5 days).

### Behind the scenes
- **Migration 0091**: `crm.provider_users` table (provider_id, auth_user_id UNIQUE, role TEXT default 'provider_admin', invited_at, last_login_at, status). RLS policies overlaying `leads.submissions`, `crm.enrolments`, `leads.routing_log`, `crm.disputes`. `audit.log_provider_action` helper.
- **Migration 0092**: `crm.providers.portal_enabled` BOOLEAN default false (per-provider feature flag during cutover so we don't ship to all three at once).
- **New Edge Function `provider-magic-link`**: takes a provider_id + email + return_path, looks up the matching `crm.provider_users` row, calls Supabase Auth to send a magic link with the deep-link as the redirect. Used by Brevo email templates and admin "send portal invite" button.
- **Brevo template updates**: provider notification template "new lead routed" gets a "View in portal" button (one-click magic link). Existing "check your sheet" template retired at end of cutover.
- **Owner invite flow**: Admin clicks "invite user" on `/admin/providers/[id]` → enters provider contact email → Edge Function creates `crm.provider_users` row + sends magic link. Provider lands logged in.

---

## What's NOT in the v1 MVP (deferred to v2 / Phase 4 proper)

- **Self-serve invoicing**: portal does not show invoices yet. Build in Tier 2 item #12 (billing module) once first billable enrolment confirms. v1 portal surfaces enrolment counts and free-3 progress only, which is the input billing needs.
- **Dispute submission UI**: v1 captures disputed status + reason via text field. A dedicated `/provider/disputes` queue with file upload + back-and-forth lands in v2.
- **Provider-side reporting**: no analytics for the provider in v1 (their own conversion rates, response-time trends, etc.). Read-only own data only.
- **Multi-user provisioning UI**: provider admin cannot invite their own teammates in v1. Owner invites via admin dashboard. Self-invite ships in v2 once we trust the auth surface.
- **MFA**: deferred to v2. Pilot pen-test (ticket [869d0hwxz](https://app.clickup.com/t/869d0hwxz)) gates onboarding provider #4+. MFA enforcement ships before that gate.
- **Notifications inside the portal**: no in-app bell / toast for new leads in v1. Email remains the trigger surface.
- **Mobile-optimised UI**: desktop-first. Responsive layout, but no native app, no push notifications.
- **Provider-facing social analytics**: ruled out for v1 per `admin-dashboard-scoping.md` — Phase 4 v2 territory.
- **Bulk outcome marking**: provider can only mark one lead at a time in v1. Admin already has bulk operations on the build queue (item #2); same pattern can extend to provider in v2.

---

## Cutover plan (per-provider)

Same playbook for each of EMS, WYK, Courses Direct. Run sequentially, not in parallel — one provider at a time so failure mode is contained.

1. **Pre-flight (admin)**: confirm `crm.provider_users` row created, magic link tested in dev, RLS policies firing correctly on staging, sheet still live and writable.
2. **Day 0 — invite**: admin sends portal invite via dashboard. Provider lands in portal. Sheet stays primary.
3. **Days 0–14 — parallel**: lead routing notifications go to BOTH the existing sheet append AND the new portal email. Sheet append continues. Portal becomes the recommended surface in the email body. Track per-provider portal logins via the new admin tile.
4. **Day 7 check**: if provider hasn't logged in, owner nudges (call or warm email — same Tuesday catch-up surface). If they have logged in but haven't marked an outcome, owner nudges with specifics ("you opened Aaron's lead but haven't marked it yet").
5. **Day 14 — cutover**: emails switch to portal-only. Sheet append continues for 7 more days as belt-and-braces. After day 21, sheet append disabled, sheet becomes a frozen audit copy, Apps Script trigger removed.
6. **Per-provider rollback**: any cutover step can revert to "sheet primary, portal optional" by flipping `crm.providers.portal_enabled` to false. No code change needed.

EMS goes first — they're the ones with the active update-failure problem and the highest lead volume. WYK second once EMS is stable. Courses Direct third once their sheet integration goes live (still pending sheet setup per Session 35 handoff).

---

## Auth model decisions

- **Supabase Auth, magic-link only.** No passwords. Email enters a one-time-use token, expires in 60 minutes, single-use. Session refresh handled by Supabase client.
- **Session length 30 days.** Re-auth required after 30 days of inactivity. On suspicious-activity heuristic (different IP + new browser), force re-auth.
- **`crm.provider_users` is the join table.** Not a column on `crm.providers`, because EMS will likely want multiple users (Andy + an adviser) and Riverside likely too. One auth user can map to one provider (multi-tenant comes much later if ever).
- **`role` column** on `crm.provider_users` defaults to `provider_admin`. Reserved values for v2: `provider_user` (read + outcome marking, no settings access), `provider_billing` (sees invoices, cannot mark outcomes). v1 only uses `provider_admin`.
- **No SSO in v1.** Google Workspace SSO is a v2 nice-to-have if a provider asks. None have.

---

## RLS overlay (additive, no admin disruption)

Migration 0091 adds policies, doesn't replace. Existing admin policies stay. Pattern (sketch — exact SQL drafted in implementation):

```sql
-- New provider role created in this migration
CREATE ROLE provider_user;

-- Provider can SELECT only their own routed leads
CREATE POLICY "providers_read_own_submissions" ON leads.submissions
  FOR SELECT TO provider_user
  USING (
    primary_routed_to IN (
      SELECT provider_id FROM crm.provider_users
      WHERE auth_user_id = auth.uid() AND status = 'active'
    )
  );

-- Provider can UPDATE only crm.enrolments rows for their own leads
CREATE POLICY "providers_update_own_enrolments" ON crm.enrolments
  FOR UPDATE TO provider_user
  USING (
    provider_id IN (
      SELECT provider_id FROM crm.provider_users
      WHERE auth_user_id = auth.uid() AND status = 'active'
    )
  )
  WITH CHECK (... same condition ...);
```

Policies for: `leads.submissions` (SELECT), `crm.enrolments` (SELECT + UPDATE), `leads.routing_log` (SELECT), `crm.disputes` (INSERT + SELECT own), `crm.providers` (SELECT own row only). Audit log writes through the helper, which sets `actor_type='provider'` and pulls `auth.uid()` itself — provider code never passes actor.

---

## Build sequence

Six sessions, ~10–14 hours focused total. Each session ships a deployable state — no half-built features sitting in a branch.

### Session P1 — Schema + auth foundation (~2 hours)
- Migration 0091: `crm.provider_users` table, RLS policies, `audit.log_provider_action` helper, `provider_user` Postgres role, GRANTs.
- Migration 0092: `crm.providers.portal_enabled` flag.
- `crm.provider_users` exposed in supabase-js (per `feedback_supabase_expose_new_schema` — Data API settings step on owner side).
- `data-architecture.md` updated with the new table and policy block.
- Deploy to production. No user-visible change yet (no portal routes wired).
- **Done when**: a hand-inserted `crm.provider_users` row + manual magic-link test from Supabase dashboard returns a session that, when used in the supabase JS client, can SELECT only that provider's submissions.

### Session P2 — Provider routes scaffold + magic-link Edge Function (~2 hours)
- `provider-magic-link` Edge Function: takes provider_id + email + return_path, calls Supabase Auth, returns sent status. Token-authed (admin-only caller).
- `/provider/login` page (email input → magic link sent confirmation).
- `/provider/auth/callback` route (Supabase standard flow).
- `/provider` placeholder page replaced with a "you are logged in as [provider]" gated page.
- Layout shell with provider-facing nav (Leads / Account / Logout).
- Auth middleware redirects unauthed `/provider/*` to login.
- **Done when**: admin-side test invite from a hand-rolled curl call sends a magic link, click lands the user in the portal home.

### Session P3 — Leads list + detail + outcome marking (~3 hours)
- `/provider/leads` server-rendered list, RLS-scoped, filterable by status.
- `/provider/leads/[id]` detail page mirroring the admin detail layout but provider-RLS-scoped.
- Outcome-marking Server Action: writes to `crm.enrolments`, fires `audit.log_provider_action`. Same vocabulary as admin enrolment form.
- Disputed status path: opens a textarea, on submit writes `crm.disputes` row.
- Provider home tile data: open / contacted / enrolled-this-month / awaiting-outcome counts.
- **Done when**: a test provider account can see their leads, mark an outcome, see the change reflected immediately, and the admin dashboard shows the same change.

### Session P4 — Brevo template switch + admin invite UI (~2 hours)
- New Brevo template: "new lead routed" with portal deep link. Old "check your sheet" template kept but stops being used post-cutover.
- Admin "Send portal invite" button on `/admin/providers/[id]` calling the Edge Function.
- Admin "providers without recent login" tile on `/admin`.
- Last-login-at column on `/admin/providers` list.
- **Done when**: admin clicks invite on EMS provider page, EMS contact gets a magic-link email, click lands them in the portal.

### Session P5 — EMS cutover (~1 hour active + 14 days passive)
- Flip `portal_enabled=true` for EMS, send invite, deep-link new lead emails.
- Daily check: did Andy log in? Mark outcomes? Sheet still updated? Track on the admin tile.
- Day 14: switch EMS lead emails to portal-only, sheet stays appendable but recommended surface is portal.
- Day 21: disable EMS sheet append (form-allowlist update + appender redeploy with EMS removed), Apps Script trigger removed from sheet.
- **Done when**: EMS is portal-only, no sheet writes for ~3 days, no dropped outcomes, owner is happy with cadence.

### Session P6 — WYK cutover (~1 hour active + 14 days passive)
Same shape as P5. Courses Direct follows on the same playbook once their sheet setup completes (gating per Session 35 handoff).

### Pre-Phase-4 pen-test gate (post-MVP, before provider #4 onboards)
Pen-test on the live portal per ticket [869d0hwxz](https://app.clickup.com/t/869d0hwxz) before Riverside or any post-pilot provider onboards. MFA enforcement ships in the same window. This is NOT in the build hours above — it's an external blocker on going beyond the three pilot providers.

---

## What this does NOT do (deliberately)

- **No write to `leads.submissions`.** Providers only update `crm.enrolments` and `crm.disputes`. Original lead payload is immutable from the provider side.
- **No bulk operations in v1.** One lead, one click. Multi-select extends both surfaces (admin + provider) in a later session.
- **No file upload in v1.** Disputed reason is text only. File upload (proof docs) lands with the v2 dispute UI.
- **No retroactive sheet history backfill.** All historical leads are in the DB already (migrations 0001 onwards). Portal shows DB state from day one. Sheets stay frozen as audit copies, not migrated.
- **No real-time push.** Admin dashboard already uses Supabase realtime; provider portal does not subscribe in v1. Polling on page load is enough for pilot volume.
- **No mobile app.** Responsive web only.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Provider doesn't log in | Same nudge cadence as today (Tuesday call). Plus admin tile "providers without recent login" surfaces it before Tuesday. Worst case: revert to sheet primary via `portal_enabled=false`. |
| Provider marks wrong outcome by misclick | Outcomes are reversible — click a different button. Audit chain captures the history. Same risk model as the existing admin form. |
| RLS policy bug leaks one provider's leads to another | Migration includes RLS test queries that assert "user A sees only provider A's rows" at apply time. `/ultrareview` mandatory before deploying 0091. |
| Magic link forwarded externally | Single-use, 60-minute expiry. Session bound to the click — forwarded link after first click is dead. |
| Provider session hijack | 30-day session, refresh on each request. Suspicious-activity heuristic forces re-auth. MFA at pen-test gate. Pilot acceptable risk for three providers we know personally. |
| Sheet → portal data drift during 14-day parallel | Portal reads DB; DB is the same source the sheets sync from. Drift impossible by construction. The risk is provider marks outcome in BOTH sheet and portal — sheet append doesn't write back to DB (sheet is downstream), so portal always wins, sheet shows stale on conflict (acceptable during cutover). |
| Cutover lands during a hot lead week | EMS first, slow rollout, per-provider flag, instant revert. Pause the rollout for any week with > expected lead volume. |
| Edge Function provider-magic-link compromised | Token-authed, admin-only. Same secret-handling discipline as `route-lead.ts`. Rotation cadence in `secrets-rotation.md`. |

---

## Open decisions (need owner sign-off)

1. **Outcome marking includes Disputed in v1, or text-only "report issue" with admin-side triage?** Recommendation: include Disputed with simple text reason. Owner sees it on `/admin/leads/[id]` next session, can refine the workflow once we see real disputes shape.
2. **Provider account page is read-only in v1, or do we let them update their own contact email?** Recommendation: read-only. Self-edit risks (auth email vs comms email mismatch, locked out of magic link). Self-edit ships in v2 with proper audit + admin override.
3. **Cutover sequencing across providers — strict serial, or two-at-once after EMS proves the path?** Recommendation: strict serial through v1. Cost is two extra weeks of waiting; benefit is failure mode contained to one provider at a time.
4. **Apps Script appender retirement timing — at provider cutover Day 21, or after all three providers have cut over?** Recommendation: per-provider retirement. EMS cutover at Day 21 retires the EMS sheet's appender deploy; WYK and CD remain appendable until their own Day 21. Cleaner audit, less coordination cost.

---

## Cross-references

- `platform/docs/admin-dashboard-scoping.md` — Phase 4 long-term scope (this MVP is the first slice)
- `platform/docs/data-architecture.md` — `crm.providers`, `crm.enrolments`, `audit.actions` source of truth
- `platform/docs/sheet-mirror-scoping.md` — superseded by this doc; mark as deprecated on owner sign-off
- `platform/docs/provider-onboarding-playbook.md` — updated post-cutover to remove sheet setup and add portal invite step
- `platform/docs/infrastructure-manifest.md` — new function and table rows added on deploy
- `platform/docs/secrets-rotation.md` — `SHEETS_APPEND_TOKEN` retires post-final-cutover
- `.claude/rules/data-infrastructure.md` — governance binding (impact assessment lives in commit message + changelog row per the rule)
- `.claude/rules/schema-versioning.md` — migration 0091 + 0092 are additive, no payload schema bump
- ClickUp [869d0hwxz](https://app.clickup.com/t/869d0hwxz) — pre-Phase-4 pen-test, gates onboarding provider #4+

---

## Sign-off

Pending: owner review of recommendation, the four open decisions, and the build-sequence shape. On sign-off, this doc is the spec for Sessions P1 through P6 and `sheet-mirror-scoping.md` is marked deprecated.
