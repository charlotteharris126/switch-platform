# Platform Handoff, Session 64, 2026-06-03

## Current state
Switchable Labs got its platform layer this session: a live `/admin/labs` funnel page, the conversion-tracking data path, and a PII-minimisation fix that locks signup emails away from the reporting role (plus a new workspace standard for it). Labs is now Mable's project for website work, tying back to platform only for data/EF work. The Codex security backlog (provider login binding, ingestion auth, etc.) is still untouched and remains the main outstanding platform work.

## What was done this session
- **Built `/admin/labs`** (admin.switchleads.co.uk, Tools → Labs): per-tool funnel (runs → £17 clicks → signups + conversion %, bots excluded, sessions deduped) + recent signups. Reads `labs.events` via service-role-only RPCs `admin_labs_funnel()` + `admin_labs_recent_signups()` (migration 0183).
- **PII minimisation (0184):** revoked raw `labs.events` SELECT (incl email) from `readonly_analytics`; added email-free view `labs.events_analytics` for the reporting role. Verified live as the role: base table denied, view readable, no email column.
- **New governance standard:** `.claude/rules/data-infrastructure.md` §6a — reporting role never reads raw PII, gets a direct-identifier-free view; new PII tables ship this shape in the creating migration.
- **Self-corrected after Codex re-audit (0185):** dropped an inert admin RLS policy added in 0184; reworded "identifier-free" → "direct-identifier-free" across rule + arch doc + changelog.
- **`labs-event` EF hardened:** stores email only on `signup`; origin allowlist narrowed (dropped `*.netlify.app` wildcard → `labs.switchable.org.uk` + this site's alias/previews + localhost). Verified spoofed netlify.app origin → 403. Deployed.
- Migrations 0183/0184/0185 pushed; `labs-event` deployed; admin app committed + pushed; changelog + data-architecture doc updated.

## Next steps
1. **Security backlog (main work, Codex order, untouched this session):** provider login OTP binding (#1) → Netlify ingestion auth (#5) → lock down `editorial.fire_netlify_blog_build` (#6, migration) → 5 missing `verify_jwt=false` config blocks (#8) → app-code batch in one branch/deploy (#3 redirect sanitize, #7/#11 getUser helper, #9 Vault secret, #10 bulk-audit RETURNING, #13 drop SVG upload type). Accepted-noise notes only: #2 admin allowlist dual source, #12 public analytics endpoints.
2. **`leads.submissions` PII follow-up (NEW, ticket 869dja09z):** apply the §6a standard to leads — revoke `readonly_analytics` raw SELECT (email/name/phone), expose an identifier-free view, point agent queries at it. Has live consumers, so impact-assess every reader first; do deliberately, not in one sweep.
3. **Labs platform items, deferred to the ad-budget gate (ticket 869dja78d items 7-9):** `labs-event` event dedupe (client `event_id` + unique index), recursive payload size cap, optional short-lived server-issued event token. Not needed until Labs ad spend.
4. **SMS delivery tracking via pull (low):** cron EF calling `GET /v3/transactionalSMS/statistics/events`, update `crm.sms_log.status` by `messageId`. Redeploy the corrected `brevo-sms-event-webhook` as dormant push-fallback. No migration.
5. **Carries from S62-63:** `crm.billing_events` empty despite confirmed pulls (Nell/Mira shared); auto-flip cron + day-12 warning (migration 0097 unapplied); CMS Phase 2 build-script flip; demand-aggregation view (Mira PUSH); Provider OS V1 scoping (Mira PUSH); Wren broadcast-gating PUSH; reconcile panel-apply proper fix; `sql.json` type-check cleanup + lint (56 problems).

## Decisions and open questions
**Decisions:**
- Labs data stays off the public data API (schema not exposed); the email table has no API surface, read only by service-role RPCs behind the admin login. Most conservative for a table of emails; RLS fails closed. If ever exposed, admin policy + grants get added then.
- Admin funnel reads via SECURITY DEFINER RPCs granted to `service_role` only, called with the service client — not the standard server-client `.schema()` path, precisely because the schema is deliberately off the API.
**Open questions:**
- Carries: `crm.billing_events` (what writes to it, why nothing has); chaser 24h resend window (owner decides if a same-day repeat chase is ever needed — from S63).

## Watch items
- **Admin app rebuild:** confirm `/admin/labs` renders on admin.switchleads.co.uk after the latest Netlify deploy.
- `labs.events` holds two bot-flagged test rows (ids 1, 2) — filtered from all funnel numbers.
- Brevo sender reputation post the S63 spam complaint; `chaser_self` armed but never run live; `brevo-sms-event-webhook` is the pre-correction version, dormant; `crm.billing_events` still empty; drift digest ~87; `edge_function_partial_capture` connection-pool errors (free-tier ceiling).

## Next session
- **Folder:** platform
- **First task:** Start the security backlog at provider login OTP binding (#1), or DB-side quick wins (#6 migration + #8 config blocks) for a shorter session.
- **Cross-project:** Labs is now Mable's (website); platform ties back for data/EF only. `leads.submissions` PII follow-up (869dja09z) and the deferred Labs EF items (869dja78d) live here. PII-reporting standard added workspace-wide (`.claude/rules/data-infrastructure.md`).
