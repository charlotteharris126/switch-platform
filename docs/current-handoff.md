# Platform: Current Handoff: 2026-05-02 (Session 21) — Sheet → DB mirror live, admin dashboard polish, HubSpot scoping, Meta ads ingest started

**Session type:** Multi-day mixed build. Opened with a strategy conversation (owner losing track of provider activity in sheets), pivoted into a full design + ship of the sheet → DB mirror with optional AI layer, then dashboard polish on three surfaces, then a paused HubSpot integration awaiting provider reply, then opened a Meta ads ingestion build that's mid-token-setup.

**Session opened:** 2026-04-30 (mid-afternoon, after Session 20 close)
**Session closed:** 2026-05-02

---

## What we worked on

### 1. Sheet → DB mirror — full hybrid build

**The need:** owner had no consolidated view of provider activity. Providers were updating Status and Notes columns in their Google Sheets independently and the database never advanced past `open`. Pipeline state across three pilot providers was unmanageable.

**Design (`platform/docs/sheet-mirror-scoping.md`):** two channels behind one Apps Script `onEdit` trigger.
- **Channel A — Status column.** Deterministic mapping of the provider's existing dropdown (open / enrolled / presumed enrolled / cannot reach / lost) to `crm.enrolments.status`. Auto-applied silently, no email, no approval. Anomalies (regression, post-billing override, unmapped value) email the owner.
- **Channel B — Notes column.** AI-interpreted via Claude Haiku 4.5. PII-redacted before the API call. Returns a structured suggestion (`implied_status`, `confidence`, `summary`). Status-implying suggestions queue in `crm.pending_updates` and email the owner with HMAC-signed Approve / Reject / Override links. No auto-apply, even on high confidence — every suggestion needs explicit owner click.

**Migration 0047 — `crm.sheet_edits_log` + `crm.pending_updates`.** Audit row per sheet edit. Pending queue for AI suggestions. RLS enabled with `admin_read_*` + `analytics_read_*` SELECT policies and `GRANT SELECT TO authenticated` (initially missed; fixed mid-session — RLS policy alone isn't enough, base table grant must precede). Both tables added to `supabase_realtime` publication for dashboard auto-refresh.

**Edge Function `sheet-edit-mirror` (deployed).** Auth via `Authorization: Bearer SHEETS_APPEND_TOKEN` reusing the appender's secret. Bug fixes during build: lead IDs in sheets are formatted `SL-YY-MM-NNNN` (zero-padded submission_id), not raw numeric — added `parseLeadId()` to extract; `submission_id` FK enforcement required validating before logging anomaly rows; `crm.providers.company_name` not `name`, `leads.submissions.course_id` not `course_slug`. Status vocabulary expanded with `cannot_reach` and `lost` to match the provider sheets' actual dropdown.

**Edge Function `pending-update-confirm` (deployed).** HMAC-signed token (binds pending_update_id + action + 7-day expiry). Approve / Reject / Override flow. Soft-fails with 503 when `PENDING_UPDATE_SECRET` not set, so deploys cleanly during Phase 1 before Channel B is activated.

**Apps Script `provider-sheet-edit-mirror.gs`.** Installable `onEdit` trigger. Watches `Status` and `Notes` (canonical headers, header alias map handles "Comments" etc.). Renamed `TOKEN` → `MIRROR_TOKEN` to avoid clash with the appender's existing const in the shared Apps Script project scope. Logs every step on debug for diagnosing trigger flow. Deployed to all three pilot sheets (EMS, WYK Digital, Courses Direct).

**Channel B activation.** Owner + Clara confirmed the Switchable privacy policy now lists Anthropic as a sub-processor and the learner consent text covers AI-assisted analysis of provider notes. Set `PENDING_UPDATE_SECRET` (generated via `openssl rand -hex 32`, set via CLI never appearing in chat) and `ANTHROPIC_API_KEY` (paste-into-Supabase-first then generate-in-Anthropic flow). Initial test failed with credit balance 400; topped up; re-tested clean. `OWNER_NOTIFICATION_EMAIL=charlotte@switchleads.co.uk` set so all alert emails route to her.

**End-to-end verification.** Real Status edit on Courses Direct lead → mirrored via Apps Script → audit row written → `crm.enrolments.status = cannot_reach`. Confirmed Channel A round-trip on production data.

### 2. /admin/sheet-activity dashboard page

New page surfacing all sheet edits and pending AI suggestions.

- **Headline tiles:** total edits, mirrored, anomalies, awaiting your call.
- **Pending AI suggestions section** at top of page with inline Approve / Reject / Choose Different buttons per suggestion.
- **Activity feed grouped by lead.** Each lead is a `<details>` block (collapsed by default — page would balloon otherwise). Lead header shows name, course, provider, current status, edit count, latest timestamp; expanding shows the full edit list.
- **Filters:** provider, column (Status / Notes), action (mirrored / anomaly / AI suggested), date range (1 / 7 / 30 days).
- **Realtime refresh** subscribes to `crm.sheet_edits_log` and `crm.pending_updates` so changes appear live without manual reload.
- **Inline Approve / Reject / Override** call the new `crm.resolve_pending_update(BIGINT, TEXT, TEXT)` SECURITY DEFINER RPC (migration 0048). Pattern matches `fire_provider_chaser` — dashboard's `authenticated` role gets `EXECUTE` on the RPC, not direct table writes. RPC handles `pending_updates` flip, enrolment status update, dispute insert, audit row, all atomic.

Files: `app/app/admin/sheet-activity/page.tsx`, `actions.ts`, `pending-actions.tsx` (client component for the buttons).

### 3. Other dashboard surfaces

- **Overview "Needs your attention" tile** — added "AI suggestions" tile with pending count, links to /actions. Grid widened to 5 columns. Realtime refresh subscribes to `pending_updates`.
- **Actions page** — new "AI suggestions" Card at the top with the same inline Approve / Reject / Choose Different buttons as /sheet-activity, sorted to the top above unrouted / approaching-flip / presumed-enrolled.
- **HealthBar** — topbar placeholder ("Session E") replaced with live counters from `public.vw_admin_health`. Five clickable pills (Leads 7d, Unrouted >48h, Stale errors, Open errors, Needs update), tone-coloured by severity.
- **Last chaser column on /admin/leads** — fixed "today" misreading. Was using elapsed-hours floor; now compares en-GB calendar date keys in Europe/London.
- **Analytics nav** — moved from main Lifecycle group into Tools alongside Ad spend / Social / Agents / Data health.

### 4. /admin/errors page redesign

Owner reported "no idea what these mean, no value out of it". Investigation showed 45 of 45 unresolved errors hit the `DEFAULT_EXPLANATION` fallback because three sources (`edge_function_brevo_upsert`, `edge_function_brevo_upsert_no_match`, `edge_function_brevo_chase`) had no `SOURCE_EXPLANATIONS` entry.

- Added plain-English explanations for the three missing sources.
- Added a `severity` field per source: `fix` (red, action needed) / `clean` (orange, self-resolves) / `info` (grey, audit only). Cards now sort by severity so action-needed surfaces first.
- New top-of-page explainer maps the three pill colours to plain English.
- New `bulkMarkSourceResolved` server action + `BulkResolveButton` client component for `clean`/`info` sources — wipes the 30+ row backlog in one click rather than per-row.
- Charlotte said "still not right, come back to this" — flagged for follow-up.

### 5. HubSpot two-way integration (paused)

Ranjit (Courses Direct) asked if leads can be pushed to HubSpot in addition to the sheet. Designed two-way: outbound lead push + inbound status updates so the sheet becomes a background audit log only.

- **Migration 0049 — `crm_webhook_token` column on `crm.providers`.** File only. Not yet applied (was paused before owner ran it via SQL editor).
- **`route-lead.ts` extension — `pushToProviderCrm()`.** Local edits, not deployed. Pushes a flat-shape + HubSpot-shape (`fields: [{name, value}, ...]`) JSON body to `crm.providers.crm_webhook_url` after a successful sheet append. Failure is non-fatal (sheet already got the row); persists to `leads.dead_letter`. Field set covers both funded and self-funded shapes; receiver picks via `.filter(v => v !== null)`.
- **Edge Function `crm-webhook-receiver` (deployed).** Provider-agnostic inbound endpoint. Token in URL query string identifies the provider via `crm.providers.crm_webhook_token`. Accepts our enum directly + common HubSpot lifecycle stages. Audits to `crm.sheet_edits_log` with `column_name='CRM'` so the activity page picks it up.
- **Status mapping caveat:** receiver hardcodes a generous alias list; per-provider mapping not built. v1 acceptable.
- **Email sent to Ranjit** asking for: HubSpot form API submission URL, custom Lead status property with our 5 values, Workflow firing on status change with webhook including contact email + our Lead ID. Soft on Workflow tier requirement (Operations Hub Starter+) with Zapier as fallback.
- **Memory note saved** at `~/.claude/projects/-Users-.../memory/project_hubspot_integration_pending.md` covering resume steps when Ranjit replies.

### 6. Meta ads ingestion (mid-build)

Charlotte got into the developer Facebook account; we're standing up the daily ad spend pull so the existing dashboard tiles (`metaSpendThis`, `metaIngestionLive`) light up.

- **Edge Function `meta-ads-ingest` (deployed).** POST endpoint, `x-audit-key` header auth via `AUDIT_SHARED_SECRET` (Vault). Pulls ad-level daily insights from `https://graph.facebook.com/v22.0/act_<id>/insights` with `level=ad`, `time_increment=1`, full field set. Idempotent upsert on `(date, ad_id)`. Pagination handled (50-page safety bound). Optional body `{ since, until }` for backfills; default last 7 days for daily cron. Failures persist to `leads.dead_letter`. Token redacted in any logged URLs.
- **Walked owner through Meta app creation** (developers.facebook.com → Create App → Business type → add Marketing API product). Charlotte hadn't created the app yet — that's where she paused.
- **Token + account ID setup pending.** Once app is created, next steps are: System User in Business Settings, generate token with `ads_read` scope (set to never expire), copy ad account numeric ID. Then `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID` go into Supabase secrets via the paste-destination-first pattern (memory: secret_handover_order).
- **Schedule pending.** Once token works and a backfill succeeds, add a daily pg_cron job to call the function via the same Vault-backed AUDIT_SHARED_SECRET pattern as `netlify-leads-reconcile-hourly`.

---

## Current state

Sheet → DB mirror is shipped end-to-end with both channels live; HubSpot two-way is paused awaiting Ranjit's HubSpot setup; Meta ads ingestion is deployed and waiting on Charlotte to finish creating the Meta app and generate the access token.

---

## Next steps

1. **Finish Meta ads token setup.** Charlotte's mid-flow on creating the developer Meta app. Once done: System User in Business Settings → assign ad account → generate token with `ads_read` scope → set `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID` Supabase secrets via paste-destination-first. Then trigger a backfill (`POST /meta-ads-ingest` with `{"since":"2026-04-15","until":"<today>"}` and `x-audit-key` header). Verify rows appear in `ads_switchable.meta_daily`. Schedule the daily cron.
2. **Revisit /admin/errors UX.** Charlotte said "still not right, come back to this". Need her to clarify what's missing — likely: hide info-tier rows by default, or summarise rather than list, or surface only the 0 fix-tier as the relevant attention figure.
3. **Resume HubSpot integration when Ranjit replies.** Resume steps in `~/.claude/projects/-Users-.../memory/project_hubspot_integration_pending.md`. Apply migration 0049, deploy local route-lead.ts edits, set Courses Direct's webhook URL + token, send Ranjit the inbound URL.
4. **Daily digest cron for sheet mirror.** Original scoping mentioned `sheet-mirror-daily-digest` (09:00 UK summary email). Not built. Owner has the dashboard tile + AI suggestion emails so this is lower priority than originally scoped.
5. **Pending-updates auto-expire cron.** Mentioned in scoping. 7-day expiry sweep against `resolver_token_expires_at`. Two lines of pg_cron. Deferred until pending volume warrants.
6. **Provider onboarding playbook** — update with the new Status / Notes column expectations and the `provider-sheet-edit-mirror.gs` install steps. Untouched in this session.

---

## Decisions / open questions

**Decisions made:**
- Hybrid sheet mirror design: deterministic for Status, AI-suggest-then-approve for Notes. No auto-apply on AI even at high confidence — owner click required.
- PII redaction (email + phone) before any Claude API call, supporting GDPR data minimisation (Decision 3 in scoping).
- Anthropic listed as sub-processor in privacy policy — Charlotte + Clara handled mid-session.
- Channel B activation gated on Phase 0 legal sign-off; gate cleared this session.
- HubSpot integration uses Forms API (works on free tier) for outbound, requires Operations Hub Starter+ for inbound webhooks (Workflows).
- HubSpot custom property recommended over reusing HubSpot's default lifecyclestage values — avoids clashing semantics.
- Sheet activity grouped by lead with collapsible details — flat row list would balloon.
- Dashboard writes use SECURITY DEFINER RPCs (matching `fire_provider_chaser` pattern), not direct grants on tables.

**Open questions:**
- Does Ranjit have the HubSpot tier needed for Workflows webhooks? Email sent flagged this; awaiting reply.
- What's specifically "still not right" on /admin/errors. Need more direct feedback before redesign.
- Should `/admin/errors` "Open errors" health-bar pill exclude info-tier rows? Currently it counts all 45 even though most are audit-only.
- Sheet activity page filter pills include "Anomalies" but not all anomaly types (queued, rejected, ai_error are different colours but one pill). May want finer breakdown later.

---

## Next session

- **Currently in:** `platform/` — data infrastructure, admin dashboard, Edge Functions.
- **Next recommended:** stay in `platform/`. The Meta ads token setup is the only blocker on lighting up the ad-spend tiles, which Iris and Mira need for weekly reports. After that, /admin/errors UX revisit while it's fresh in Charlotte's mind.
- **First thing to tackle:** finish the Meta app creation + System User token + first backfill. Should be a 30-minute session with Charlotte on the Meta side and me prompting her through each step.
