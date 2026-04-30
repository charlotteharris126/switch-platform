# Infrastructure Manifest - Switchable Ltd Platform

**Purpose:** single source of truth for every piece of production infrastructure that must exist for the platform to function. Any row marked "critical" that is missing or disabled = silent lead loss or broken governance. Verified at every platform session-start and by Sasha's Monday scan.

**Last verified:** 2026-04-21 (Session 5 - multi-provider routing: migrations 0011 + 0012, router + routing-confirm refactored, Apps Script v2, WYK Digital seeded)

**How to use this file:**
- Every critical row has a `Verify` command or dashboard location - copy-paste to check
- `Last verified` gets updated when a check is run and confirmed present
- If a check fails: do NOT edit the manifest. Fix the missing infra, then re-verify, then update `Last verified`
- New critical infrastructure added to production → add a row here in the same session it ships
- Retired infrastructure → move to the "Retired" section at the bottom with date, don't delete

---

## Edge Functions

Deployed functions that the live pipe depends on. Verify via `supabase functions list` (requires CLI login) or Supabase dashboard → Edge Functions.

| Name | Critical | Purpose | Verify | Last verified |
|---|---|---|---|---|
| `netlify-lead-router` | Yes | Receives Netlify form webhook, normalises via shared `_shared/ingest.ts`, INSERTs to `leads.submissions` (idempotent via migration 0010's unique partial index), dead-letters on DB failure. Auto-flags owner-test submissions on insert (`OWNER_TEST_DOMAINS` + `OWNER_TEST_EMAILS` in `_shared/ingest.ts`). **Session 3.3 rearchitecture (2026-04-21):** responds 200 the instant the insert commits; owner notification email runs as a post-response background task via `EdgeRuntime.waitUntil` so Netlify's webhook is never held waiting on Brevo. **Must deploy with `--no-verify-jwt`** so Netlify's webhook (no JWT) can reach it. | Dashboard → Edge Functions; POST test submission from an owner-owned domain → lands in `leads.submissions` with `is_dq=true, dq_reason='owner_test_submission', archived_at` set | 2026-04-21 |
| `netlify-forms-audit` | Yes | Cross-checks allowlist vs Netlify form/webhook state, flags drift into `leads.dead_letter` | Trigger via cron `Run now`; response `status: "clean"` | 2026-04-19 |
| `netlify-leads-reconcile` | Yes | Hourly safety-net: reads last 24h of Netlify submissions via REST API, back-fills anything missing from `leads.submissions` via shared `_shared/ingest.ts`. Writes `leads.dead_letter` row per back-fill (`source='reconcile_backfill'`). Emails the owner if any back-fill occurred. Defends against webhook auto-disable (Netlify disables after 6 non-2xx responses; happened 2026-04-19 and 2026-04-21). **Must deploy with `--no-verify-jwt`** - auth is the `x-audit-key` header. Session 3.3 (2026-04-21). | Supabase dashboard → Edge Functions; trigger via cron `Run now`; response JSON reports `backfilled` count and `netlify_seen` | 2026-04-21 |
| `netlify-partial-capture` | No | Partial funnel tracking (per `leads.partials`) | Dashboard → Edge Functions | 2026-04-19 |
| `routing-confirm` | Yes | One-click handler for owner confirm links. Verifies HMAC token, INSERTs `leads.routing_log`, UPDATEs `leads.submissions.primary_routed_to`, POSTs row to provider Apps Script webhook, sends PII-free provider notification email. **Must deploy with `--no-verify-jwt`** - auth is the signed token in the query string. Session 3 (2026-04-20). | Dashboard → Edge Functions; clicking a confirm link from a test notification email returns a "Routed" page and the EMS sheet gains a row | 2026-04-20 |
| `admin-brevo-resync` | No | Manual operational tool: re-fires the Switchable learner Brevo upsert for a list of already-routed submission ids without touching routing state. Use after Brevo attribute composition changes or matrix.json shape changes that leave existing contacts with stale attributes. POST `{ submissionIds: number[] }`, auth via `x-audit-key`. Returns per-id status + skip reasons. Skips DQ, archived, and never-routed leads. **Must deploy with `--no-verify-jwt`** - auth is the audit-key header. Session 17 (2026-04-29). | POST to function URL with one known submission id (e.g. recent test lead), expect `{results:[{id,status:"ok"}]}` and a Brevo contact with refreshed attributes | 2026-04-29 |
| `sheet-edit-mirror` | Yes (Channel A live; Channel B gated) | Receives `onEdit` POSTs from the `provider-sheet-edit-mirror.gs` Apps Script trigger. Channel A (column=`Status`) maps to `crm.enrolments.status` deterministically and applies the transition. Channel B (column=`Updates`) is gated on `CHANNEL_B_ENABLED` env flag — when on, calls Claude Haiku with PII-redacted note text and queues an AI suggestion in `crm.pending_updates`, emailing the owner with HMAC-signed Approve/Reject/Override links. All edits land in `crm.sheet_edits_log`. Auth: `Authorization: Bearer <SHEETS_APPEND_TOKEN>`. **Must deploy with `--no-verify-jwt`**. Migration 0047 (2026-04-30). | POST a test edit per the curl example in the function README; expect 200 with `action="rejected"` (no enrolment) and a row in `crm.sheet_edits_log`. End-to-end: change a Status cell on a real provider sheet, watch the enrolment row transition. | Pending Phase 1 deploy |
| `pending-update-confirm` | Yes (Channel B only — does nothing until Channel B activates) | Handles Approve/Reject/Override clicks from AI suggestion emails. Verifies HMAC token (binds `pending_update_id` + `action` + 7-day expiry), idempotent on `crm.pending_updates.status` (must be `pending`). Approve/Override both apply the chosen status to `crm.enrolments` and write a `Disputes` row if applicable. Returns a small confirmation HTML page. **Must deploy with `--no-verify-jwt`** — auth is the signed token. Migration 0047 (2026-04-30). | After Channel B activates: trigger a test note edit, click each of Approve/Reject/Override on the resulting email, confirm `crm.pending_updates.status` transitions and `crm.enrolments.status` reflects the choice. | Pending Phase 2 deploy |

**Owner-test domain list** - exact-match, case-insensitive, in `netlify-lead-router/index.ts` as `OWNER_TEST_DOMAINS`:
- `switchable.org.uk`
- `switchable.careers`
- `switchable.com`
- `switchleads.co.uk`

Update the constant + redeploy whenever a new owner-owned domain starts being used for testing.

---

## Cron Jobs

Scheduled tasks. `readonly_analytics` reads via the `public.vw_cron_jobs` SECURITY DEFINER view (migrations 0006 + 0007 - pg_cron filters `cron.job` by ownership so a direct SELECT returns zero rows for non-owners, hence the view).

| Name | Critical | Schedule | Purpose | Verify | Last verified |
|---|---|---|---|---|---|
| `netlify-forms-audit-hourly` | Yes | `0 * * * *` | Catches webhook drift within 60 min of disablement. Replaced in Session 3.3 (data-ops/004) to fix a 1000ms HTTP timeout inherited from its dashboard-UI origin; now 10000ms. | `SELECT jobname, schedule, active FROM public.vw_cron_jobs WHERE jobname = 'netlify-forms-audit-hourly'` - expect active=true. Then confirm the pg_net response isn't timing out: `SELECT status_code, timed_out FROM net._http_response WHERE created > now() - interval '2 hours' ORDER BY created DESC LIMIT 3` - expect status_code=200, timed_out=false. | 2026-04-21 |
| `netlify-leads-reconcile-hourly` | Yes | `30 * * * *` | Hourly pull from Netlify API → back-fill any submissions the webhook didn't deliver. 10000ms HTTP timeout. Emails owner if any back-fill occurred. Session 3.3 defence against webhook auto-disable. | `SELECT jobname, schedule, active FROM public.vw_cron_jobs WHERE jobname = 'netlify-leads-reconcile-hourly'` - expect active=true. Run-now via Supabase dashboard → response JSON includes `backfilled` count. | 2026-04-21 |
| `purge-stale-partials` | No | `0 3 * * *` | Deletes incomplete partials >90 days (GDPR) | `SELECT jobname, schedule, active FROM public.vw_cron_jobs WHERE jobname = 'purge-stale-partials'` | - |

Run history: `SELECT jobname, status, start_time, return_message FROM public.vw_cron_runs JOIN public.vw_cron_jobs USING (jobid) ORDER BY start_time DESC LIMIT 20`

---

## Netlify outgoing webhooks

These fire into `netlify-lead-router`. Without them, submissions don't reach the DB.

| Site | Webhook | Critical | Purpose | Verify | Last verified |
|---|---|---|---|---|---|
| switchable.org.uk | Site-wide "Any form" → `https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-lead-router` | Yes | Captures every lead-producing form submission | Netlify → Forms → Settings & usage → outgoing webhooks; OR `netlify-forms-audit` output reports `status: "clean"` | 2026-04-19 |

**Incident precedent:** 2026-04-19 this webhook was found disabled. One lead (Katy) was lost and back-filled manually. See `changelog.md` for the incident write-up. The hourly audit + manifest verification are the defences against a repeat.

---

## Edge Function secrets

Runtime env vars for Edge Functions. Set via Supabase Dashboard → Edge Functions → Manage secrets.

| Secret | Used by | Source | Rotation tracked? |
|---|---|---|---|
| `SUPABASE_DB_URL` | all four functions | Supabase auto-injected - no action | n/a (platform-managed) |
| `SUPABASE_URL` | `netlify-lead-router` (to build confirm-link base URL) | Supabase auto-injected | n/a (platform-managed) |
| `NETLIFY_API_TOKEN` | `netlify-forms-audit` + `netlify-leads-reconcile` | Netlify User settings → Applications → Personal access tokens | Yes - see `secrets-rotation.md` |
| `NETLIFY_SITE_ID` | `netlify-forms-audit` + `netlify-leads-reconcile` | Netlify site settings (public ID, not a secret strictly) | n/a |
| `AUDIT_SHARED_SECRET` | `netlify-forms-audit` + `netlify-leads-reconcile` + both hourly cron headers | Any long random string | Yes - see `secrets-rotation.md` |
| `BREVO_API_KEY` | `netlify-lead-router` + `routing-confirm` + `netlify-leads-reconcile` (via `_shared/brevo.ts`) | Brevo → Settings → SMTP & API → API Keys | Yes - see `secrets-rotation.md` |
| `BREVO_SENDER_EMAIL` | `netlify-lead-router` + `routing-confirm` + `netlify-leads-reconcile` (via `_shared/brevo.ts`) | Verified sender in Brevo; currently `charlotte@switchleads.co.uk` | Yes - see `secrets-rotation.md` |
| `SHEETS_APPEND_TOKEN` | `routing-confirm` (sends in body); must match TOKEN constant in every deployed `provider-sheet-appender-v2.gs` (canonical from Session 5) and any remaining v1 deployments | Generated via `openssl rand -hex 32` | Yes - see `secrets-rotation.md` |
| `ROUTING_CONFIRM_SHARED_SECRET` | `netlify-lead-router` (signs) + `routing-confirm` (verifies) | Generated via `openssl rand -hex 32` | Yes - see `secrets-rotation.md` |

---

## Postgres roles and RLS

Scoped roles that consumers authenticate as. All tables have RLS on.

| Role | Purpose | Used by | Verify |
|---|---|---|---|
| `readonly_analytics` | SELECT on all tables + `cron.job` (from migration 0006) | Postgres MCP for agents, Metabase (when set up) | `SELECT rolname FROM pg_roles WHERE rolname = 'readonly_analytics'` |
| `functions_writer` | Full access to `leads.*`, write to `crm.enrolments`, read providers | Edge Functions (`SET LOCAL ROLE` pattern) | `SELECT rolname FROM pg_roles WHERE rolname = 'functions_writer'` |
| `ads_ingest` | Full access to `ads_*` schemas | Future Meta/Google/TikTok daily pulls | `SELECT rolname FROM pg_roles WHERE rolname = 'ads_ingest'` |

RLS verification: `SELECT schemaname, tablename, rowsecurity FROM pg_tables WHERE schemaname IN ('leads','crm','ads_switchable') AND rowsecurity = false` - expect zero rows.

---

## Form allowlist

Declared canonical list of forms on switchable.org.uk that are allowed to post into our pipe.

| Resource | Critical | Source of truth | Verify |
|---|---|---|---|
| `form-allowlist.json` | Yes | `switchable/site/deploy/data/form-allowlist.json` (enforced at build by `audit-site.js`) | `curl -sS https://switchable.org.uk/data/form-allowlist.json | jq '.schema_version, (.allowlist \| length)'` - expect `"1.0"` and non-zero count |

---

## External tool dependencies

Third-party services the live pipe calls out to.

| Tool | Critical | Used by | Purpose | Failure mode | Account |
|---|---|---|---|---|---|
| Brevo (transactional email) | Yes | `netlify-lead-router`, `routing-confirm` | Owner notification email + provider notification email + owner sheet-append fallback | Send fails → logged via `console.error`; function continues. Routing still persists; Charlotte loses the email notification for that lead. Netlify notification still fires as a backup channel. | Owned by `hello@switchable.careers`; sender domain `switchleads.co.uk` verified with DKIM+SPF |
| Google Apps Script (per provider sheet) | Yes | `routing-confirm` (via `crm.providers.sheet_webhook_url`) | Appends the lead row to the provider's Google Sheet | Append fails → `leads.dead_letter` row written + owner paste-manually email sent; routing still persists. Per-provider isolation: one failing script affects only that provider's sheet. | Owner's Google account; script published as Web app ("Execute as: me, Anyone has access") |

---

## Apps Script deployments (per provider)

Canonical script: `platform/apps-scripts/provider-sheet-appender-v2.gs` (header-driven FIELD_MAP; one script, any sheet headers). All three pilot provider sheets now run v2 as of 2026-04-29. v1 file (`provider-sheet-appender.gs`) retained in repo as historical reference only — no live deployments use it.

Onboarding new providers: follow `platform/docs/provider-onboarding-playbook.md`.

| Provider | Sheet ID | Web app URL (in `crm.providers.sheet_webhook_url`) | Script version | Status |
|---|---|---|---|---|
| `enterprise-made-simple` | `1ABX9p_5OQUS3kLD1ztvFYSccozoTOmt7RiiDBg4IOuU` | `https://script.google.com/macros/s/AKfycbw35aTlElUvxdU3zh-EwLeI0M_XUfLKHQoU08xewvz2Xgoz-UCbRa_4k4rE5k2sKT4R-Q/exec` | v2 | Live. Migrated v1 → v2 on 2026-04-29 to enable cohort intake columns ("Preferred intake" / "Acceptable intakes") for multi-cohort EMS courses (Counselling Tees Valley, SMM Tees Valley). URL preserved across migration (New version, not New deployment). End-to-end verified with live lead. |
| `courses-direct` | `1BUVA70N2AwFbAidUJLf1LTUyUUncTu1hfVbx9AwnES0` | `https://script.google.com/macros/s/AKfycbz35Ua3omaTpIFt32I9LvK3UMvGfelpX6EdoEXkWAbK4QS1trUi3u2xUAHSSx2HGeXbWA/exec` | v2 | Live. Sheet + Apps Script v2 deployed; `auto_route_enabled=true`. First lead received 2026-04-21. Self-funded shape (no cohort intake columns needed). |
| `wyk-digital` | `1VnRWpLyujEZidZ6PrWuQEvjFtiHmzYvohR-rHyKex0E` | `https://script.google.com/macros/s/AKfycbxOp-eNqR8IPt1vymxH4PgbYNMleqwjjZLq1ZAM2QPOweMhMQGOQEW0o9zPPYAXtn4M/exec` | v2 | Live. Sheet + Apps Script v2 deployed; `auto_route_enabled=true`. First lead received 2026-04-21 (Ruby Marle, Laura Hawdon). LIFT Digital Marketing Futures is single-cohort, no intake columns needed. |

---

## Backups

| Thing | Critical | Setup | Verify |
|---|---|---|---|
| Supabase daily auto-backup | Yes | Enabled by default on free tier, 7-day retention | Supabase → Database → Backups - most recent < 24h old |
| Quarterly test-restore | Yes | Owner-triggered | Log in `docs/changelog.md` under an "Incident-response drill" entry |
| Monthly manual export of `crm.providers` + `leads.submissions` | Yes | Owner-triggered | Local file, date in filename |

---

## Session-start verifier

At the start of every `platform/` session, Claude should verify the critical rows in this manifest - in order:

1. `SELECT jobname, schedule, active FROM public.vw_cron_jobs` - confirm `netlify-forms-audit-hourly` is present and active.
2. Trigger `netlify-forms-audit` ad-hoc (or check last `cron.job_run_details` row for it) - confirm `status: "clean"` or flag real discrepancies.
3. Check `leads.dead_letter` for rows added in the last 24h - flag loudly if any.
4. Confirm Netlify site-wide webhook is active (via the audit run; no direct API check needed beyond that).
5. Check `leads.submissions` count against yesterday - sudden zero = probable silent outage.

If any critical row is off: stop session work, fix first, update `Last verified` when green.

---

## Retired infrastructure

Nothing retired yet.

---

## Change log for the manifest itself

| Date | Change |
|---|---|
| 2026-04-19 | Initial manifest, post-incident (webhook-disabled outage). Seeded from Session 2 infra state. |
| 2026-04-21 | Session 3.3 - added `netlify-leads-reconcile` Edge Function + `netlify-leads-reconcile-hourly` cron, noted audit-cron timeout fix. |
| 2026-04-21 | Session 5 - Apps Script v2 canonical from this date; Courses Direct + WYK Digital added to provider deployments table pending sheet setup. SHEETS_APPEND_TOKEN reference updated to name both v1 and v2 scripts as valid deployments. |
| 2026-04-29 | EMS migrated v1 → v2 (driven by multi-cohort cohort intake columns). All three pilot sheets now on v2. FIELD_MAP gained `preferredintake` and `acceptableintakes` entries, redeployed on all three sheets in lockstep. Live-lead verified end-to-end on EMS multi-cohort page. |
