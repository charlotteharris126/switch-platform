# Infrastructure Manifest - Switchable Ltd Platform

**Purpose:** single source of truth for every piece of production infrastructure that must exist for the platform to function. Any row marked "critical" that is missing or disabled = silent lead loss or broken governance. Verified at every platform session-start and by Sasha's Monday scan.

**Last verified:** 2026-05-07 (Session 34 — email rearch cutover ritual completed today: BREVO_SHADOW_MODE flipped to false, 4 Edge Functions deployed, migrations 0080-0085 applied, 8 legacy Brevo automations disabled, data-ops/013 backfill ran with 47 mutations. Phase 4 closeout (migrations 0086, 0088) deferred to next session per safer split.)

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
| `routing-confirm` | Yes | One-click handler for owner confirm links. Verifies HMAC token, INSERTs `leads.routing_log`, UPDATEs `leads.submissions.primary_routed_to`, POSTs row to provider Apps Script webhook, sends PII-free provider notification email, and (Phase 2a, 2026-05-05) fires the U1 transactional send via `_shared/route-lead.ts` → `sendU1Transactional` → `sendTransactional`. Same hook fires from `netlify-lead-router` auto-route. U1 send is silently skipped until `BREVO_TEMPLATE_U1_FUNDED`/`_SELF` env vars are set. **Must deploy with `--no-verify-jwt`** - auth is the signed token in the query string. Session 3 (2026-04-20). | Dashboard → Edge Functions; clicking a confirm link from a test notification email returns a "Routed" page and the EMS sheet gains a row | 2026-04-20 |
| `admin-brevo-resync` | No | Manual operational tool: re-fires the Switchable learner Brevo upsert for a list of already-routed submission ids without touching routing state. Use after Brevo attribute composition changes or matrix.json shape changes that leave existing contacts with stale attributes. POST `{ submissionIds: number[] }`, auth via `x-audit-key`. Returns per-id status + skip reasons. Skips DQ, archived, and never-routed leads. **Must deploy with `--no-verify-jwt`** - auth is the audit-key header. Session 17 (2026-04-29). | POST to function URL with one known submission id (e.g. recent test lead), expect `{results:[{id,status:"ok"}]}` and a Brevo contact with refreshed attributes | 2026-04-29 |
| `sheet-edit-mirror` | Yes (Channel A and Channel B both live) | Receives `onEdit` POSTs from the `provider-sheet-edit-mirror.gs` Apps Script trigger. Channel A (column=`Status`) maps to `crm.enrolments.status` deterministically and applies the transition. Channel B (column=`Notes`) calls Claude Haiku with PII-redacted note text and queues an AI suggestion in `crm.pending_updates`, emailing the owner with HMAC-signed Approve/Reject/Override links. Notes with no implied status change are logged as `note_only` and appended to `crm.enrolments.notes`. All edits land in `crm.sheet_edits_log`. Auth: `Authorization: Bearer <SHEETS_APPEND_TOKEN>`. **Must deploy with `--no-verify-jwt`**. Migration 0047. `CHANNEL_B_ENABLED=true`, `ANTHROPIC_API_KEY` and `PENDING_UPDATE_SECRET` all set. **Known limitation:** Channel B approvals update `crm.enrolments` only — no write-back to the sheet Status cell. Sheet may show stale status after a Channel B approval. Acceptable until Phase 4 retires sheets. | POST a test edit per the curl example in the function README; expect 200 with `action="rejected"` (no enrolment) and a row in `crm.sheet_edits_log`. End-to-end: add a note to a real provider sheet, confirm `crm.sheet_edits_log` row appears within ~10 seconds. | 2026-05-04 (end-to-end verified: notes reaching function, Claude interpreting, note_only and ai_suggested paths both confirmed) |
| `pending-update-confirm` | Yes (Channel B) | Handles Approve/Reject/Override clicks from AI suggestion emails. Verifies HMAC token (binds `pending_update_id` + `action` + 7-day expiry), idempotent on `crm.pending_updates.status` (must be `pending`). Approve/Override both apply the chosen status to `crm.enrolments` and sync Brevo. Returns a small confirmation HTML page. **Must deploy with `--no-verify-jwt`** — auth is the signed token. Migration 0047. | Trigger a test note edit, click Approve on the resulting email, confirm `crm.pending_updates.status = 'approved'` and `crm.enrolments.status` reflects the choice. | 2026-05-04 (Approve path verified end-to-end) |
| `meta-ads-ingest` | Yes | Daily pull of yesterday's per-ad spend, impressions, leads, and CTR from the Meta Marketing API into `ads_switchable.meta_daily`. Idempotent via the unique `(date, ad_id)` index. Failures land in `leads.dead_letter` with `source='meta-ads-ingest'`. Auth via `META_ACCESS_TOKEN` (long-lived system user token). Triggered by `meta-ads-ingest-daily` cron at 08:00 UTC; can be POSTed manually with optional `?date=YYYY-MM-DD` for backfill. **Must deploy with `--no-verify-jwt`** so the cron-triggered HTTP call (no JWT) can reach it. | POST `?date=YYYY-MM-DD` against the function URL, response JSON reports `inserted` count. Then `SELECT COUNT(*) FROM ads_switchable.meta_daily WHERE date = '<that date>'` should match. | 2026-05-03 (post-migration-0052 widening of `ctr` column) |
| `iris-daily-flags` | Yes (advisory; flag-only, no auto-pause) | Daily ads-performance flag computation per `switchable/ads/docs/iris-automation-spec.md`. Reads from `meta_daily`, `v_ad_to_routed`, `v_ad_baselines`, `leads.submissions`. Writes to `ads_switchable.iris_flags`. Implements P1.2 (fatigue), P2.1 (daily health, requires migration 0060 columns populated), P2.2 (CPL anomaly), P2.3 (pixel/CAPI drift, account-wide). 7-day suppression rule prevents duplicate notified flags. SET LOCAL ROLE iris_writer wraps the INSERT transaction. Optional `?date=YYYY-MM-DD` query param to recompute against a specific day; defaults to `current_date - 1`. **Must deploy with `--no-verify-jwt`** — auth is the audit-key header. Migration 0056-0058 dependencies. Iris stage 2 (2026-05-03). | POST manually with `?date=2026-05-02` against function URL; response JSON reports `candidates`, `inserted_notified`, `inserted_suppressed`, per-automation breakdown. Then `SELECT automation, severity, COUNT(*) FROM ads_switchable.iris_flags GROUP BY 1,2` should reflect the candidates. | Pending first deploy |
| `brevo-event-webhook` | Yes (Phase 1 + 3a of email rearchitecture) | Receives Brevo webhook events (delivered/opened/clicked/hard_bounce/soft_bounce/spam/unsubscribed) and updates `crm.email_log.status` for the matching `brevo_message_id` row. For `unsubscribed` and `spam` events, also writes a `crm.consent_history` row, flips `marketing_opt_in=false` on every `leads.submissions` row matching the recipient email (functions_writer via migration 0079 grants), and pushes `SW_CONSENT_MARKETING=false` as an attribute update to the Brevo contact. Brevo's own channel-level unsubscribe is already in place when the user clicks the unsub link; this function keeps our DB and Brevo's contact attribute in sync. Auth: shared-secret bearer in `Authorization` header (Brevo's Token-auth method auto-prepends `Bearer ` to the value field, so paste only the hex into Brevo, never `Bearer <hex>`). Constant-time compared against `BREVO_WEBHOOK_SECRET`. Deploy with `--no-verify-jwt` — auth is the bearer header, not Supabase JWT. Migrations 0073/0074/0079 dependencies. | POST a sample Brevo event JSON to function URL with the bearer header set; expect 200 with `{processed: 1, ...}` and a row in `crm.email_log` (if a matching brevo_message_id existed) or `crm.consent_history` (if event was unsubscribed/spam). POST without bearer should return 401. | 2026-05-05 (commissioned + Phase 3a writeback added) |
| `email-stalled-cron` | Yes (Phase 2b) | Daily 09:00 UTC scan for day-4 open leads (Phase-2-gated: only leads with a `u1_funded`/`u1_self` row in `crm.email_log` qualify, so pre-Phase-2 leads are excluded from being re-stalled). Fires the stalled email through `sendTransactional` per row; idempotent and dead-lettered via the helper. Throttled 250ms between sends. Returns counts JSON. Auth: x-audit-key. Deploy with `--no-verify-jwt`. Migration 0076 (cron). Phase 2b of email rearchitecture, 2026-05-05. | POST manually with the `x-audit-key` header against the function URL; response JSON reports `candidates`, `sent`, `skipped`, `failed`, `missing_template_env`. Then `SELECT COUNT(*) FROM crm.email_log WHERE email_type LIKE 'stalled_%' AND triggered_at > now() - interval '5 minutes'` should equal `sent`. | Pending first deploy |
| `email-u4-cron` | Yes (Phase 2b) | Daily 09:30 UTC scan for enrolled / presumed_enrolled leads (Phase-2-gated like stalled-cron). Fires the U4 enrolment-confirmation email through `sendTransactional`. Scheduled job over DB trigger by design — sync trigger calling Brevo would block writers of `crm.enrolments` if Brevo is slow; ~24h max latency on U4 acceptable per spec amendment 2026-05-05. Auth: x-audit-key. Deploy with `--no-verify-jwt`. Migration 0077 (cron). Phase 2b of email rearchitecture, 2026-05-05. | POST manually with the `x-audit-key` header against the function URL; response JSON reports the same shape as stalled-cron. | Pending first deploy |
| `email-sunset-cron` | Yes (Phase 5 prerequisite) | Daily 03:00 UTC two-phase engagement-based sunset for marketing-consenting Switchable contacts. Phase 1: contacts with ≥180 days of email history but no opens/clicks in last 180 days AND no re-engagement sent yet → fire `sendTransactional(BREVO_TEMPLATE_RE_ENGAGEMENT)`. Phase 2: contacts re-engaged ≥14 days ago with no opens since → flip `marketing_opt_in=false`, push `SW_CONSENT_MARKETING=false` + channel=unsubscribed to Brevo, log to `crm.consent_history`. Asymmetric — only marketing channel suppressed, transactional continues. Auth: x-audit-key. Deploy with `--no-verify-jwt`. Migration 0088 (cron + email_type extension). Phase 5 deliverability backstop, 2026-05-07. **Dormant until `BREVO_TEMPLATE_RE_ENGAGEMENT` env var is set** — Phase 1 silently skips every candidate via `sendTransactional`'s missing-template branch until then. Phase 2 still runs (only fires for contacts that received the re-engagement). | POST manually with the `x-audit-key` header against the function URL; response JSON reports `reengagement.{candidates,sent,skipped,failed,missing_template_env}` and `suppression.{candidates,suppressed,failed}`. | Pending first deploy |

**Owner-test domain list** - exact-match, case-insensitive, in `_shared/ingest.ts` as `OWNER_TEST_DOMAINS`:
- `switchable.org.uk`
- `switchable.careers`
- `switchable.com`
- `switchleads.co.uk`
- `charlie-harris.com`

**Owner-test email list** - exact-match, case-insensitive, in `_shared/ingest.ts` as `OWNER_TEST_EMAILS`:
- `charliemarieharris@icloud.com`
- `kieranwrites@gmail.com`

Update the constant + redeploy whenever a new owner-owned domain starts being used for testing.

---

## Cron Jobs

Scheduled tasks. `readonly_analytics` reads via the `public.vw_cron_jobs` SECURITY DEFINER view (migrations 0006 + 0007 - pg_cron filters `cron.job` by ownership so a direct SELECT returns zero rows for non-owners, hence the view).

| Name | Critical | Schedule | Purpose | Verify | Last verified |
|---|---|---|---|---|---|
| `netlify-forms-audit-hourly` | Yes | `0 * * * *` | Catches webhook drift within 60 min of disablement. Replaced in Session 3.3 (data-ops/004) to fix a 1000ms HTTP timeout inherited from its dashboard-UI origin; now 10000ms. | `SELECT jobname, schedule, active FROM public.vw_cron_jobs WHERE jobname = 'netlify-forms-audit-hourly'` - expect active=true. Then confirm the pg_net response isn't timing out: `SELECT status_code, timed_out FROM net._http_response WHERE created > now() - interval '2 hours' ORDER BY created DESC LIMIT 3` - expect status_code=200, timed_out=false. | 2026-04-21 |
| `netlify-leads-reconcile-hourly` | Yes | `30 * * * *` | Hourly pull from Netlify API → back-fill any submissions the webhook didn't deliver. 10000ms HTTP timeout. Emails owner if any back-fill occurred. Session 3.3 defence against webhook auto-disable. | `SELECT jobname, schedule, active FROM public.vw_cron_jobs WHERE jobname = 'netlify-leads-reconcile-hourly'` - expect active=true. Run-now via Supabase dashboard → response JSON includes `backfilled` count. | 2026-04-21 |
| `purge-stale-partials` | No | `0 3 * * *` | Deletes incomplete partials >90 days (GDPR) | `SELECT jobname, schedule, active FROM public.vw_cron_jobs WHERE jobname = 'purge-stale-partials'` | - |
| `meta-ads-ingest-daily` | Yes | `0 8 * * *` | Triggers `meta-ads-ingest` Edge Function once a day at 08:00 UTC (09:00 BST) to pull yesterday's per-ad metrics into `ads_switchable.meta_daily`. Without it, `/admin/profit` and `/admin/ads` (when stage 4 ships) go stale. | `SELECT jobname, schedule, active FROM public.vw_cron_jobs WHERE jobname = 'meta-ads-ingest-daily'`, expect active=true. After 08:01 UTC: `SELECT id, status_code, timed_out FROM net._http_response ORDER BY created DESC LIMIT 5` should show a 200 from the function call, and `SELECT MAX(date) FROM ads_switchable.meta_daily` should equal yesterday's date. | 2026-05-03 |
| `iris-daily-flags` | Yes | `30 8 * * *` | Triggers `iris-daily-flags` Edge Function once a day at 08:30 UTC (09:30 BST), 30 min after the meta-ads-ingest cron so yesterday's spend is settled before flag computation reads it. Writes to `ads_switchable.iris_flags`. | `SELECT jobname, schedule, active FROM public.vw_cron_jobs WHERE jobname = 'iris-daily-flags'`, expect active=true. After 08:31 UTC: function response in `net._http_response` should be 200 with `candidates`, `inserted_notified`, `inserted_suppressed` keys. | Pending first scheduled run |
| `email-stalled-cron-daily` | Yes (Phase 2b) | `0 9 * * *` | Triggers `email-stalled-cron` once a day at 09:00 UTC (10:00 BST). Phase-2-gated stalled email send. Migration 0076. | `SELECT jobname, schedule, active FROM public.vw_cron_jobs WHERE jobname = 'email-stalled-cron-daily'`, expect active=true. After 09:01 UTC: `SELECT id, status_code, timed_out FROM net._http_response WHERE created > now() - interval '1 hour' ORDER BY created DESC LIMIT 5` should show a 200 from the function call, and any leads stalled that day should have a `crm.email_log` row with `email_type LIKE 'stalled_%'`. | Pending first scheduled run |
| `email-u4-cron-daily` | Yes (Phase 2b) | `30 9 * * *` | Triggers `email-u4-cron` once a day at 09:30 UTC (10:30 BST), 30 min after stalled-cron so the day's order is stable. Phase-2-gated U4 send. Migration 0077. | `SELECT jobname, schedule, active FROM public.vw_cron_jobs WHERE jobname = 'email-u4-cron-daily'`, expect active=true. After 09:31 UTC: same verification pattern as stalled-cron-daily; check `crm.email_log` for `u4_*` rows. | Pending first scheduled run |
| `email-sunset-cron-daily` | Yes (Phase 5 prerequisite) | `0 3 * * *` | Triggers `email-sunset-cron` once a day at 03:00 UTC (04:00 BST), 1h before `brevo-consent-reconcile-daily` so any sunset-driven channel flips have settled before the reconcile pass reads state. Migration 0088. | `SELECT jobname, schedule, active FROM public.vw_cron_jobs WHERE jobname = 'email-sunset-cron-daily'`, expect active=true. After 03:01 UTC: response in `net._http_response` should be 200 with `reengagement` + `suppression` keys. | Pending first scheduled run |

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
| `META_ACCESS_TOKEN` | `meta-ads-ingest` | Meta Business Manager → System users → Generate token (long-lived, scopes: `ads_read`, `ads_management`). Bound to the Switchable Ads Account system user. | Yes - see `secrets-rotation.md` |
| `META_AD_ACCOUNT_ID` | `meta-ads-ingest` | Meta Ads Manager URL (e.g. `act_1234567890`); not strictly secret but lives in env to avoid hardcoding | n/a |
| `BREVO_WEBHOOK_SECRET` | `brevo-event-webhook` | Generated via `openssl rand -hex 32`. Same value pasted into Brevo dashboard webhook config as `Authorization: Bearer <SECRET>` custom header. Phase 1 of email rearchitecture. | Yes - see `secrets-rotation.md` |
| `BREVO_TEMPLATE_U1_FUNDED` | `routing-confirm` + `netlify-lead-router` (via `_shared/route-lead.ts` → `sendTransactional`) | Numeric Brevo template id. Set when Charlotte creates the funded U1 in Brevo's Transactional template section (NOT Campaigns). Skipped silently in `sendU1Transactional` until set. Phase 2a of email rearchitecture. Currently `5`. | n/a (template id, not a secret) |
| `BREVO_TEMPLATE_U1_SELF` | `routing-confirm` + `netlify-lead-router` (via `_shared/route-lead.ts` → `sendTransactional`) | Numeric Brevo template id for the self-funded U1. Same setup posture as the funded variant. Phase 2a of email rearchitecture. Currently `10`. | n/a (template id, not a secret) |
| `BREVO_TEMPLATE_STALLED_FUNDED` | `email-stalled-cron` | Numeric Brevo template id for the funded stalled (day-4 "have you heard from your provider yet?") email. Skipped silently in the cron until set. Phase 2b of email rearchitecture. Currently `17`. | n/a (template id, not a secret) |
| `BREVO_TEMPLATE_STALLED_SELF` | `email-stalled-cron` | Numeric Brevo template id for the self-funded stalled email. Phase 2b. Currently `19`. | n/a (template id, not a secret) |
| `BREVO_TEMPLATE_CHASER_FUNDED` | `admin-brevo-chase` | Numeric Brevo template id for the funded SF2 chaser. Migration 0078 split the original `chaser` email_type into funded/self to match the actual Brevo template setup. Per-funded-route skip if missing. Currently `6`. Phase 2b. | n/a (template id, not a secret) |
| `BREVO_TEMPLATE_CHASER_SELF` | `admin-brevo-chase` | Numeric Brevo template id for the self-funded SF2 chaser. Currently `12`. Phase 2b. | n/a (template id, not a secret) |
| `BREVO_TEMPLATE_U4_FUNDED` | `email-u4-cron` | Numeric Brevo template id for the funded U4 enrolment-confirmation email. Skipped silently until set. Phase 2b. Currently `22`. | n/a (template id, not a secret) |
| `BREVO_TEMPLATE_U4_SELF` | `email-u4-cron` | Numeric Brevo template id for the self-funded U4. Phase 2b. Currently `24`. | n/a (template id, not a secret) |
| `BREVO_SHADOW_MODE` | `_shared/brevo.ts` `sendTransactional` (any caller) | `true` (default) tags every `crm.email_log` row with `metadata.shadow=true` so the Phase 2 parallel-run period is filterable. Set to `false` only after ≥48h of parity verification across U1, stalled, chaser, U4. Phase 2 of email rearchitecture. Cutover to `false` ran 2026-05-05. | n/a (env flag, not a secret) |
| `BREVO_TEMPLATE_RE_ENGAGEMENT` | `email-sunset-cron` | Numeric Brevo template id for the sunset re-engagement email ("haven't heard from you in a while" prompt). Switchable brand, learner-facing, marketing-tone-not-required since it's targeting the dormant edge of the list. Skipped silently in `sendTransactional` until set, so the cron's Phase 1 work goes dormant. Phase 5 deliverability backstop. | n/a (template id, not a secret) |

---

## Postgres roles and RLS

Scoped roles that consumers authenticate as. All tables have RLS on.

| Role | Purpose | Used by | Verify |
|---|---|---|---|
| `readonly_analytics` | SELECT on all tables + `cron.job` (from migration 0006) | Postgres MCP for agents, Metabase (when set up) | `SELECT rolname FROM pg_roles WHERE rolname = 'readonly_analytics'` |
| `functions_writer` | Full access to `leads.*`, write to `crm.enrolments`, read providers | Edge Functions (`SET LOCAL ROLE` pattern) | `SELECT rolname FROM pg_roles WHERE rolname = 'functions_writer'` |
| `ads_ingest` | Full access to `ads_*` schemas | Future Meta/Google/TikTok daily pulls | `SELECT rolname FROM pg_roles WHERE rolname = 'ads_ingest'` |
| `iris_writer` | INSERT on `ads_switchable.iris_flags` only; SELECT on `ads_switchable.meta_daily`, `leads.submissions`, `leads.routing_log` (plus `v_ad_to_routed` and `v_ad_baselines` once stages 1b/1c ship). USAGE on `ads_switchable` + `leads` schemas. No other access. | Future `iris-daily-flags` Edge Function (stage 2 of new ads dashboard) | `SELECT rolname FROM pg_roles WHERE rolname = 'iris_writer'` |

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

Disabled / dropped production infrastructure. Kept here so future audits don't flag a gap and so a rollback path is documented.

### Brevo utility automations (disabled 2026-05-07 cutover, archived not deleted)

Disabled at the cutover that flipped utility sends from Brevo automations onto the Transactional API path. Templates moved to Brevo "Archived" folder. Retained off-but-present for 90 days post-cutover (until 2026-08-05) per spec rollback policy. Do not delete before then.

| Automation | Replaced by | Disabled | Delete after |
|---|---|---|---|
| U1 funded welcome | `routing-confirm` + `_shared/route-lead.ts` → `sendTransactional(BREVO_TEMPLATE_U1_FUNDED)` | 2026-05-07 | 2026-08-05 |
| U1 self welcome | `routing-confirm` + `_shared/route-lead.ts` → `sendTransactional(BREVO_TEMPLATE_U1_SELF)` | 2026-05-07 | 2026-08-05 |
| Stalled funded (day 4) | `email-stalled-cron` daily 09:00 UTC → `sendTransactional(BREVO_TEMPLATE_STALLED_FUNDED)` | 2026-05-07 | 2026-08-05 |
| Stalled self (day 4) | `email-stalled-cron` daily 09:00 UTC → `sendTransactional(BREVO_TEMPLATE_STALLED_SELF)` | 2026-05-07 | 2026-08-05 |
| Chaser funded (SF2) | `admin-brevo-chase` → `sendTransactional(BREVO_TEMPLATE_CHASER_FUNDED, forceResend=true)` | 2026-05-07 | 2026-08-05 |
| Chaser self (SF2) | `admin-brevo-chase` → `sendTransactional(BREVO_TEMPLATE_CHASER_SELF, forceResend=true)` | 2026-05-07 | 2026-08-05 |
| U4 funded enrolment | `email-u4-cron` daily 09:30 UTC → `sendTransactional(BREVO_TEMPLATE_U4_FUNDED)` | 2026-05-07 | 2026-08-05 |
| U4 self enrolment | `email-u4-cron` daily 09:30 UTC → `sendTransactional(BREVO_TEMPLATE_U4_SELF)` | 2026-05-07 | 2026-08-05 |

**Verify retired state:** Brevo dashboard → Automations → status filter "Off" should show all 8 listed above. If any flips back to "Active", investigate before proceeding (the Transactional path would now duplicate-send).

### Database columns

_None retired yet._ Migration 0086 (drops `crm.enrolments.last_chaser_at` and adds `crm.vw_enrolments_chaser_state` view) is written and reviewed but **not yet applied to production** — deferred to next platform session for safer split (cutover stabilises 24-48h before stacking the schema-drop on top). Code lives at `platform/supabase/migrations/0086_drop_last_chaser_at.sql`. When applied, this section gets the row.

---

## Change log for the manifest itself

| Date | Change |
|---|---|
| 2026-04-19 | Initial manifest, post-incident (webhook-disabled outage). Seeded from Session 2 infra state. |
| 2026-04-21 | Session 3.3 - added `netlify-leads-reconcile` Edge Function + `netlify-leads-reconcile-hourly` cron, noted audit-cron timeout fix. |
| 2026-04-21 | Session 5 - Apps Script v2 canonical from this date; Courses Direct + WYK Digital added to provider deployments table pending sheet setup. SHEETS_APPEND_TOKEN reference updated to name both v1 and v2 scripts as valid deployments. |
| 2026-04-29 | EMS migrated v1 → v2 (driven by multi-cohort cohort intake columns). All three pilot sheets now on v2. FIELD_MAP gained `preferredintake` and `acceptableintakes` entries, redeployed on all three sheets in lockstep. Live-lead verified end-to-end on EMS multi-cohort page. |
| 2026-05-03 | Added `meta-ads-ingest` Edge Function row, `meta-ads-ingest-daily` cron row (08:00 UTC), and `META_ACCESS_TOKEN` + `META_AD_ACCOUNT_ID` secret rows. All three landed in production before this manifest entry; this update closes the doc-vs-prod drift carried over from Session 22. |
| 2026-05-03 | Added `iris_writer` Postgres role row. Created in migration 0056 (Iris stage 1a). Will be wired to a future `iris-daily-flags` Edge Function (stage 2). |
| 2026-05-04 | Updated `sheet-edit-mirror` and `pending-update-confirm` rows to reflect live status. Both functions active and end-to-end verified. Channel B live (`CHANNEL_B_ENABLED=true`). Known limitation noted: no write-back from DB to sheet Status cell after Channel B approval. |
| 2026-05-05 | Phase 2a of email rearchitecture: added `BREVO_TEMPLATE_U1_FUNDED`, `BREVO_TEMPLATE_U1_SELF`, `BREVO_SHADOW_MODE` env-var rows. Updated `routing-confirm` row to mention the new U1 transactional hook in `_shared/route-lead.ts`. Same hook fires from `netlify-lead-router` auto-route path. No new function or migration this step — `sendTransactional` lives in `_shared/brevo.ts` and writes to `crm.email_log` (live since migration 0073). |
| 2026-05-05 | Phase 2b of email rearchitecture: added `email-stalled-cron` + `email-u4-cron` Edge Function rows, `email-stalled-cron-daily` (09:00 UTC) + `email-u4-cron-daily` (09:30 UTC) cron rows (migrations 0076 + 0077), and 5 new template-id env vars (`BREVO_TEMPLATE_STALLED_FUNDED/SELF`, `BREVO_TEMPLATE_CHASER`, `BREVO_TEMPLATE_U4_FUNDED/SELF`). `admin-brevo-chase` updated in place to dual-fire chaser via `sendTransactional` with `forceResend=true` (legacy list-add still runs in shadow mode). Pre-Phase-2 leads are excluded from the new stalled/U4 paths via the `EXISTS u1_funded/u1_self in email_log` lifecycle gate. |
| 2026-05-05 | Migration 0078 split `crm.email_log.email_type` value `chaser` into `chaser_funded` + `chaser_self` to match the actual Brevo template setup (id 6 funded, id 12 self). `BREVO_TEMPLATE_CHASER` env var replaced with `BREVO_TEMPLATE_CHASER_FUNDED` + `BREVO_TEMPLATE_CHASER_SELF`. `admin-brevo-chase` redeployed with funded/self branching on `funding_category`. Chaser dual-fire now active end-to-end. |
| 2026-05-05 | Phase 3a: migration 0079 added column-level UPDATE grant + RLS policy on `leads.submissions.marketing_opt_in` for `functions_writer`. `brevo-event-webhook` redeployed to flip `marketing_opt_in=false` on unsub/spam events and push `SW_CONSENT_MARKETING=false` to the Brevo contact attribute. Phases 3b/3c/3d (channel sync at upsert, backfill, reconcile cron) queued for next session. |
| 2026-05-07 | Cutover ritual ran (Session 34, evening): `BREVO_SHADOW_MODE=false` set in Supabase Vault. 4 Edge Functions deployed (`brevo-consent-reconcile-daily`, `email-failure-alert-daily`, `email-presumed-warning-cron`, `sheet-edit-mirror`-redeploy with row_email cross-check). 6 migrations applied via `supabase db push --linked`: 0080 (auto-flip pause record), 0081 (reconcile cron schedule), 0082 (lost_reason CHECK expansion), 0083 (failure-alert cron), 0084 (presumed_warning email_type), 0085 (presumed_warning cron). 8 legacy utility automations disabled in Brevo dashboard, templates archived. `data-ops/013_backfill_email_campaigns_channel.ts --apply` ran with 47 mutations, 178 skipped, 0 errors final. Migration 0080 patched to be idempotent (DO/IF EXISTS guard) after first apply attempt failed: the manual `cron.unschedule('enrolment-auto-flip-daily')` from Tuesday's incident response had already removed the job, so the unguarded unschedule threw XX000. Backfill script `data-ops/013` patched to use `field_changed='email_campaigns_subscription'` (lowercase, matches CHECK constraint) — first apply attempt failed with constraint violation; ~30 contacts got Brevo-blocked during the failed run before consent_history INSERT failed, leaving an audit-row gap (see next session's repair task). |
| 2026-05-07 | _Code written, deferred for safer split:_ Migration 0086 (drops `crm.enrolments.last_chaser_at`, adds `crm.vw_enrolments_chaser_state` view, rewrites `crm.fire_provider_chaser` to stop dual-write, backfill historical chaser sends from enrolments → email_log). Three dashboard files updated (layout/leads/actions) to consume the view / derive from email_log. Reviewed by 2 sub-agents, fixes applied. Awaiting next platform session, after cutover stabilises ≥24h. |
| 2026-05-07 | _Code written, deferred for safer split:_ `email-sunset-cron` Edge Function + Migration 0088 (cron schedule + `re_engagement` email_type + `sunset_suppression` source). Two-phase 180-day-no-engagement → re-engage → 14-day-grace → suppress, asymmetric (marketing channel only). Dormant for Phase 1 until `BREVO_TEMPLATE_RE_ENGAGEMENT` is set in Supabase Vault. Phase 5 deliverability backstop required before marketing automations turn on. Awaiting next platform session. |
