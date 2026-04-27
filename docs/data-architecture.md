# Data Architecture - Switchable Ltd

**Status:** Live in production. Pilot schemas implemented; Sessions 3 and 3.3 operational. Session 5 (2026-04-21 evening) extends `leads.submissions` for multi-provider self-funded routing and adds `crm.providers.cc_emails`.
**Last updated:** 2026-04-21 (Session 5 - self-funded canonical columns + cc_emails)
**Schema versioning:** see `.claude/rules/schema-versioning.md` and Postgres addendum therein.

---

## Purpose

Single source of truth for the structure of the Switchable Ltd business database. Every table, every column, every relationship lives here first. Migrations in `platform/supabase/migrations/` implement this design; they do not define new things without this doc being updated first.

## Principles

1. **One database, namespaced by domain.** One Supabase project, multiple Postgres schemas. Logical separation, physical colocation.
2. **Schemas reflect business domains, not team boundaries.** A learner dashboard (Phase 2) will span `leads`, `learners`, and `crm`. Schemas are not silos.
3. **Raw payloads preserved.** Every ingested submission or webhook keeps its original JSON in a `raw_payload` column for audit and replay.
4. **Schema version on every ingested contract.** Lead payloads, webhook payloads, provider import rows all carry `schema_version`. Covered by `.claude/rules/schema-versioning.md`.
5. **Derived state is a view, not a duplicated column.** Daily KPI roll-ups, attribution joins, provider performance scores are all views over source tables. Source of truth stays singular.
6. **Timestamps are `TIMESTAMPTZ`.** Every timestamp column stores timezone. Never `TIMESTAMP WITHOUT TIME ZONE`. UK operation today, international tomorrow.
7. **Soft delete, not hard delete.** Rows marked `archived_at` rather than removed, except for idempotent retry cleanup. Audit trail matters more than disk space.
8. **RLS on by default.** Every table has Row Level Security enabled. No table is world-readable. Access is granted explicitly per role.

## Schemas (pilot + near-term)

| Schema | Purpose | Phase |
|---|---|---|
| `ads_switchable` | Switchable B2C ad performance, daily granularity, per platform | Pilot |
| `ads_switchleads` | SwitchLeads B2B ad performance | Near-term (when B2B ads launch) |
| `leads` | Form submissions, routing decisions, gateway captures | Pilot |
| `crm` | Providers, enrolments, disputes, billing | Pilot |
| `audit` | Workspace-wide change log for admin / provider / system writes | Pilot (live since migration 0013) |
| `social` | Multi-brand organic social: drafts, engagement targets, post analytics, OAuth tokens | Pilot (Session G — migration 0029) |

## Schemas (deferred, design placeholders)

| Schema | Purpose | Phase |
|---|---|---|
| `reference` | Reference data owned by the platform - postcode → region lookup, course metadata if it graduates from YAML, etc. | Session 5.1 (next) |
| `learners` | Deduplicated learner records for subscription stream | Phase 2 |
| `recruitment` | Recruitment lead gen stream (separate consent scope) | Phase 3 |
| `marketplace` | Provider self-serve, ad/sponsorship space | Phase 4-5 |

These appear in design only except `reference`, which is scoped to ship in Session 5.1. Tables for the other schemas get designed when the income stream is triggered, not now.

### Planned: `reference.postcodes` (Session 5.1)

Local postcode → region lookup loaded from the ONS Postcode Directory (quarterly refresh). Removes the dependency on any external postcode API; serves the router's region-derivation at capture time, and Iris / Mira regional analytics. Deferred from Session 5 because the ONS CSV is ~200MB and needs an owner download + apply step. Until it ships, `leads.submissions.region` stays NULL for self-funded submissions; the column exists but is not populated.

Shape (draft, finalised when the ONS CSV is loaded):
```sql
CREATE TABLE reference.postcodes (
  postcode       TEXT PRIMARY KEY,   -- uppercase, no space (e.g. 'PE166LS')
  postcode_pretty TEXT NOT NULL,     -- canonical display form (e.g. 'PE16 6LS')
  region         TEXT NOT NULL,      -- ONS region (e.g. 'East of England')
  country        TEXT NOT NULL,      -- 'England' | 'Wales' | 'Scotland' | 'Northern Ireland'
  loaded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## Schema: `ads_switchable`

Ad performance data for Switchable learner acquisition. One row per day per ad per platform.

### `ads_switchable.meta_daily`

Daily Meta (Facebook + Instagram) ad performance.

```sql
CREATE TABLE ads_switchable.meta_daily (
  id              BIGSERIAL PRIMARY KEY,
  date            DATE NOT NULL,
  ad_account_id   TEXT NOT NULL,
  campaign_id     TEXT NOT NULL,
  campaign_name   TEXT,
  adset_id        TEXT,
  adset_name      TEXT,
  ad_id           TEXT NOT NULL,
  ad_name         TEXT,

  -- Spend and reach
  spend           NUMERIC(10, 2) NOT NULL DEFAULT 0,
  impressions     INTEGER NOT NULL DEFAULT 0,
  reach           INTEGER,
  frequency       NUMERIC(6, 3),
  clicks          INTEGER NOT NULL DEFAULT 0,

  -- Derived metrics (store for convenience, recalc on insert if needed)
  ctr             NUMERIC(6, 5),
  cpc             NUMERIC(10, 2),
  cpm             NUMERIC(10, 2),

  -- Conversions (from Meta Ads API, attributed by pixel/CAPI)
  leads           INTEGER NOT NULL DEFAULT 0,
  cost_per_lead   NUMERIC(10, 2),

  -- Segmentation tags (helpful for dashboards; derived from campaign/ad naming convention)
  funding_segment TEXT, -- 'funded' | 'loan' | 'self'

  -- Ingestion metadata
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload     JSONB,

  UNIQUE (date, ad_id)
);

CREATE INDEX ON ads_switchable.meta_daily (date);
CREATE INDEX ON ads_switchable.meta_daily (campaign_id, date);
CREATE INDEX ON ads_switchable.meta_daily (funding_segment, date);
```

### `ads_switchable.google_daily` (future - Google Ads launch)

Same shape as `meta_daily`, columns adjusted for Google Ads specifics (e.g. `keyword_id`, `match_type` replace `ad_id` where different). Stub only; not designed in detail until Google Ads launches.

### `ads_switchable.tiktok_daily` (future)

Same shape. Stub only.

---

## Schema: `ads_switchleads`

SwitchLeads B2B ad performance. Activates when B2B paid ads launch (see `.claude/rules/business.md`, currently on hold).

Tables: same shape as `ads_switchable`. Stubbed for now.

---

## Schema: `leads`

All lead-related data: form submissions, routing decisions, and gateway captures for soft-DQ handling. This schema is the heart of the business.

### `leads.submissions`

Every form submission from any Switchable landing page. One row per submission. The raw event record.

```sql
CREATE TABLE leads.submissions (
  id                         BIGSERIAL PRIMARY KEY,
  schema_version             TEXT NOT NULL DEFAULT '1.0',
  submitted_at               TIMESTAMPTZ NOT NULL,

  -- Source (from lead payload schema)
  page_url                   TEXT,
  course_id                  TEXT,
  provider_ids               TEXT[] NOT NULL DEFAULT '{}',
  region_scheme              TEXT,
  funding_category           TEXT, -- gov | self | loan (top-level, added migration 0017)
  funding_route              TEXT, -- specific scheme name (free_courses_for_jobs, lift_futures, etc.)

  -- Attribution
  utm_source                 TEXT,
  utm_medium                 TEXT,
  utm_campaign               TEXT,
  utm_content                TEXT,
  fbclid                     TEXT,
  gclid                      TEXT,
  referrer                   TEXT,

  -- Learner details - funded shape (set for switchable-funded submissions; NULL for self-funded)
  first_name                 TEXT,
  last_name                  TEXT,
  email                      TEXT,
  phone                      TEXT,
  la                         TEXT,
  age_band                   TEXT,
  employment_status          TEXT,
  prior_level_3_or_higher    BOOLEAN,
  can_start_on_intake_date   BOOLEAN,
  outcome_interest           TEXT,
  why_this_course            TEXT,

  -- Learner details - self-funded shape (added Session 5, migration 0011; set for
  -- switchable-self-funded submissions; NULL for funded). Additive - no existing
  -- consumer reads these yet.
  postcode                   TEXT,
  region                     TEXT, -- populated by router JOIN on reference.postcodes; NULL until Session 5.1 loads the ONS directory
  reason                     TEXT, -- why considering a course
  interest                   TEXT, -- course interest area
  situation                  TEXT, -- current situation (employed / between work / etc.)
  qualification              TEXT, -- qualification sought (certificate / diploma / etc.)
  start_when                 TEXT, -- readiness band (immediately / within 3 months / exploring)
  budget                     TEXT, -- stated budget band
  courses_selected           TEXT[], -- course slugs / titles the learner selected (multi-course forms)

  -- Consent
  terms_accepted             BOOLEAN NOT NULL DEFAULT false,
  marketing_opt_in           BOOLEAN NOT NULL DEFAULT false,

  -- Routing state (updated by the Edge Function after the owner confirms routing)
  is_dq                      BOOLEAN NOT NULL DEFAULT false,
  dq_reason                  TEXT,
  primary_routed_to          TEXT, -- provider_id; null if DQ or multi-route
  routed_at                  TIMESTAMPTZ,

  -- Funnel linkage (added in migration 0005). NULL for submissions that arrived
  -- before partial tracking existed or without client-side JS (ad blocker, etc.).
  -- Join key to leads.partials for drop-off analytics.
  session_id                 UUID,

  -- Audit
  raw_payload                JSONB NOT NULL,
  archived_at                TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON leads.submissions (email);
CREATE INDEX ON leads.submissions (submitted_at DESC);
CREATE INDEX ON leads.submissions (primary_routed_to);
CREATE INDEX ON leads.submissions (course_id);
CREATE INDEX ON leads.submissions (funding_route, submitted_at DESC);
CREATE INDEX ON leads.submissions (is_dq, submitted_at DESC);
CREATE INDEX ON leads.submissions (session_id) WHERE session_id IS NOT NULL;

-- Session 3.3 (migration 0010): partial unique index on Netlify's submission id
-- Enforces idempotency for netlify-leads-reconcile back-fills against the webhook
-- fast path. Partial because pre-webhook rows (curl tests, manual back-fills) have
-- no Netlify id in raw_payload.id.
CREATE UNIQUE INDEX leads_submissions_netlify_id_uniq
    ON leads.submissions ((raw_payload->>'id'))
 WHERE raw_payload->>'id' IS NOT NULL;
```

**Writers:** Two Edge Functions write to `leads.submissions`, both routing their insert through the shared `_shared/ingest.ts` module so the row shape is identical either way:
- `netlify-lead-router` - the fast path. Receives Netlify's outgoing webhook POST per submission; inserts immediately and returns 200; owner notification email fires as a post-response background task via `EdgeRuntime.waitUntil()`. Session 3.3 (2026-04-21) decoupled the email from the HTTP response to stop Netlify's webhook timing out during slow Brevo calls - see `platform/docs/changelog.md` for the incident that drove this.
- `netlify-leads-reconcile` - the safety net. Hourly cron (`30 * * * *`) reads the last 24h of Netlify submissions via REST API and back-fills anything missing. `ON CONFLICT DO NOTHING` against the partial unique index above means overlapping runs can never produce duplicates. Emits an email alert to the owner whenever it has to act (sign that the fast path degraded).

### `leads.routing_log`

Every routing decision made by the Edge Function (or whatever serverless layer replaces it later). A submission can have multiple routing entries (if routed to multiple providers, or re-routed after dispute).

```sql
CREATE TABLE leads.routing_log (
  id                BIGSERIAL PRIMARY KEY,
  submission_id     BIGINT NOT NULL REFERENCES leads.submissions(id) ON DELETE RESTRICT,
  provider_id       TEXT NOT NULL REFERENCES crm.providers(provider_id),
  routed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  route_reason      TEXT NOT NULL, -- 'primary' | 'rotation' | 'shared' | 'redelivery' | 'gateway_*'
  delivery_method   TEXT NOT NULL, -- 'email' | 'webhook' | 'both'
  delivery_status   TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'failed'
  delivered_at      TIMESTAMPTZ,
  error_message     TEXT,

  n8n_execution_id  TEXT, -- LEGACY name from when n8n was the chosen tool (decision reversed 2026-04-18). Populated with the Edge Function request_id for traceback. Column rename deferred to keep migration churn low while the column has no rows; cleanup ticket on ClickUp.
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON leads.routing_log (submission_id);
CREATE INDEX ON leads.routing_log (provider_id, routed_at DESC);
CREATE INDEX ON leads.routing_log (delivery_status) WHERE delivery_status != 'sent';
```

### `leads.gateway_captures`

DQ soft-capture rows - learners who did not qualify for the primary offer but are worth capturing for an alternative journey (loan-funded, waitlist, recruitment flag). Per the Gateway Patterns table in `switchable/site/docs/funded-funnel-architecture.md`.

```sql
CREATE TABLE leads.gateway_captures (
  id              BIGSERIAL PRIMARY KEY,
  submission_id   BIGINT NOT NULL REFERENCES leads.submissions(id) ON DELETE RESTRICT,
  gateway_type    TEXT NOT NULL, -- 'loan_funded' | 'self_funded' | 'waitlist_region' | 'waitlist_intake' | 'recruitment_flag' | 'business_support_flag' | 'signpost_out'
  tag             TEXT, -- e.g. region slug, sector code, notes
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON leads.gateway_captures (gateway_type, created_at DESC);
CREATE INDEX ON leads.gateway_captures (submission_id);
```

### `leads.partials`

Progressive capture of multi-step form sessions. One row per `session_id` - upserted every time the learner advances a step. Contains answers to the non-PII steps only (preference/intent data: reason, interest, situation, qualification, start timing, budget, etc.). PII is never written here; it lives on `leads.submissions` after final submit.

**Purpose:** funnel drop-off analytics. Which step loses people, which answer patterns correlate with drop-off, which traffic sources convert through which steps. Powers Iris's ad optimisation and Mira's weekly KPI narrative.

**Lifecycle:** client generates a UUID in sessionStorage on page load, sends it to the `netlify-partial-capture` Edge Function on every step change. On final Netlify submit, the same `session_id` rides along and `netlify-lead-router` flips `is_complete = true` on the matching partial. Incomplete partials older than 90 days are purged by a pg_cron job (see `platform/supabase/migrations/0004_add_leads_partials.sql`). Complete partials are retained indefinitely - they join to `leads.submissions` for funnel-to-conversion analysis.

**GDPR posture:** `session_id` is a random UUID not tied to identity. `answers` carries preference data only, no PII. `user_agent` + `fbclid` in aggregate could be quasi-identifying, hence the 90-day purge on incomplete rows.

```sql
CREATE TABLE leads.partials (
  id              BIGSERIAL PRIMARY KEY,
  session_id      UUID NOT NULL UNIQUE,
  schema_version  TEXT NOT NULL DEFAULT '1.0',

  -- Form context
  form_name        TEXT NOT NULL, -- 'switchable-self-funded' | 'switchable-funded'
  page_url         TEXT,
  course_id        TEXT,
  funding_category TEXT, -- gov | self | loan (mirrors leads.submissions; added migration 0017)
  funding_route    TEXT,

  -- Progress
  step_reached    INTEGER NOT NULL DEFAULT 1,
  answers         JSONB NOT NULL DEFAULT '{}'::jsonb, -- non-PII step answers

  -- Attribution (must follow the same UTM convention as ads_switchable.meta_daily:
  -- utm_campaign = Meta campaign_id, utm_content = Meta ad_id - enforced at ad creation)
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  utm_content     TEXT,
  fbclid          TEXT,
  gclid           TEXT,
  referrer        TEXT,

  -- Device segmentation
  user_agent      TEXT,
  device_type     TEXT, -- 'mobile' | 'tablet' | 'desktop' (computed client-side)

  -- Completion flag (flipped by netlify-lead-router on final submit)
  is_complete     BOOLEAN NOT NULL DEFAULT false,

  -- Per-session abuse cap (incremented on every upsert)
  upsert_count    INTEGER NOT NULL DEFAULT 1,

  -- Timestamps
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON leads.partials (form_name, last_seen_at DESC);
CREATE INDEX ON leads.partials (last_seen_at) WHERE is_complete = false; -- drives the purge job
CREATE INDEX ON leads.partials (utm_campaign, utm_content) WHERE utm_campaign IS NOT NULL;
CREATE INDEX ON leads.partials (step_reached, is_complete);
```

**Upsert semantics** (enforced by the Edge Function, not the schema): `INSERT ... ON CONFLICT (session_id) DO UPDATE SET step_reached = GREATEST(partials.step_reached, EXCLUDED.step_reached), answers = partials.answers || EXCLUDED.answers, last_seen_at = now(), updated_at = now()`. `GREATEST` prevents out-of-order upserts from regressing the furthest-reached step.

### `leads.dead_letter`

Webhooks or submissions that failed to process. The backstop that prevents data loss during Supabase or Edge Function outages.

```sql
CREATE TABLE leads.dead_letter (
  id                BIGSERIAL PRIMARY KEY,
  source            TEXT NOT NULL, -- 'netlify_forms' | 'edge_function_routing' | 'meta_api' | etc.
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload       JSONB NOT NULL,
  error_context     TEXT,
  replayed_at       TIMESTAMPTZ,
  replay_submission_id BIGINT REFERENCES leads.submissions(id)
);

CREATE INDEX ON leads.dead_letter (replayed_at) WHERE replayed_at IS NULL;
```

---

## Schema: `crm`

Provider relationship, enrolments, disputes, billing. Replaces the current Google Sheet.

### `crm.providers`

One row per training provider. Direct replacement for the current provider Sheet.

```sql
CREATE TABLE crm.providers (
  provider_id         TEXT PRIMARY KEY, -- slug, e.g. 'enterprise-made-simple'
  company_name        TEXT NOT NULL,
  contact_name        TEXT,
  contact_email       TEXT NOT NULL,
  contact_phone       TEXT,
  crm_webhook_url     TEXT,

  -- Commercial
  pilot_status        TEXT NOT NULL DEFAULT 'pilot', -- 'pilot' | 'post-pilot'
  pricing_model       TEXT NOT NULL, -- 'per_enrolment_flat' | 'per_enrolment_percent'
  per_enrolment_fee   NUMERIC(10, 2),
  percent_rate        NUMERIC(5, 4),
  min_fee             NUMERIC(10, 2),
  max_fee             NUMERIC(10, 2),
  free_enrolments_remaining INTEGER DEFAULT 3, -- pilot credit

  -- Lifecycle
  active              BOOLEAN NOT NULL DEFAULT true,
  onboarded_at        TIMESTAMPTZ,
  agreement_signed_at TIMESTAMPTZ,
  agreement_notion_page_id TEXT, -- reference to Notion agreement page

  -- Free-text
  notes               TEXT,

  -- Temporary sheet integration (Session 3, 2026-04-20). Retires with the
  -- Phase 4 provider dashboard, at which point crm.enrolments becomes the
  -- source of truth and the Apps Script webhooks are decommissioned.
  sheet_id            TEXT, -- Google Sheet spreadsheet ID, human-readable reference
  sheet_webhook_url   TEXT, -- Apps Script web app URL; NULL = skip sheet append

  -- Additional notification recipients (added Session 5, migration 0012). CC'd
  -- on every provider notification from routing-confirm. Ranjit at Courses
  -- Direct is the first use case (co-director on 4pm strategy calls).
  cc_emails           TEXT[] NOT NULL DEFAULT '{}',

  archived_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON crm.providers (active) WHERE archived_at IS NULL;
```

**Sheet integration flow (pilot, transitional):** the `routing-confirm` Edge Function reads `sheet_webhook_url` for the confirmed provider and POSTs a full-fat lead payload to that Apps Script web app. From Session 5 onwards, the canonical Apps Script lives at `platform/apps-scripts/provider-sheet-appender-v2.gs` and reads the sheet's own header row to decide which payload fields to write in which order - a single script serves every provider regardless of which headers they prefer. A shared `SHEETS_APPEND_TOKEN` (Edge Function secret) verifies the caller inside the script. Sheets retire when the Phase 4 provider dashboard ships.

**Why full-fat payload + header-driven Apps Script:** pre-Session 5, the Edge Function knew which fields the sheet cared about and the Apps Script hardcoded column order. That pattern forced a new Apps Script variant per provider. v2 inverts the responsibility: the Edge Function sends every available field, the sheet's header row is the source of truth for which fields get written and in which order. Adding a new provider is a sheet-creation task, not a code change.

### `crm.provider_courses`

Many-to-many link between providers and courses they run. Courses themselves live as YAML in the Switchable site repo (`switchable/site/data/courses/`) - this table references them by slug and represents the provider-course relationship, including priority and capacity.

```sql
CREATE TABLE crm.provider_courses (
  id              BIGSERIAL PRIMARY KEY,
  provider_id     TEXT NOT NULL REFERENCES crm.providers(provider_id),
  course_slug     TEXT NOT NULL, -- references switchable/site/data/courses/<slug>.yml
  priority        INTEGER NOT NULL DEFAULT 1, -- routing order if multiple providers
  monthly_capacity INTEGER, -- null = uncapped
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, course_slug)
);

CREATE INDEX ON crm.provider_courses (course_slug, active, priority);
```

### `crm.enrolments`

One row per lead-to-provider routing that could lead to enrolment. Status machine tracks the 14-day auto-presume → 7-day dispute window described in `.claude/rules/business.md`.

```sql
CREATE TABLE crm.enrolments (
  id                    BIGSERIAL PRIMARY KEY,
  submission_id         BIGINT NOT NULL REFERENCES leads.submissions(id) ON DELETE RESTRICT,
  routing_log_id        BIGINT REFERENCES leads.routing_log(id),
  provider_id           TEXT NOT NULL REFERENCES crm.providers(provider_id),

  status                TEXT NOT NULL DEFAULT 'open',
  -- Status values:
  -- 'open'              - sent to provider, awaiting update
  -- 'contacted'         - provider reached learner
  -- 'enrolled'          - provider confirms enrolment
  -- 'presumed_enrolled' - auto-set after 14 days if no update
  -- 'not_enrolled'      - provider confirms no enrolment
  -- 'disputed'          - provider or learner dispute raised
  -- 'billed'            - invoice issued via GoCardless
  -- 'paid'              - payment collected

  sent_to_provider_at   TIMESTAMPTZ NOT NULL,
  status_updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  presumed_deadline_at  TIMESTAMPTZ, -- sent_to_provider_at + 14 days
  dispute_deadline_at   TIMESTAMPTZ, -- presumed_deadline_at + 7 days

  -- Billing
  billed_amount         NUMERIC(10, 2),
  billed_at             TIMESTAMPTZ,
  paid_at               TIMESTAMPTZ,
  gocardless_payment_id TEXT,

  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON crm.enrolments (provider_id, status);
CREATE INDEX ON crm.enrolments (status) WHERE status IN ('open', 'contacted', 'presumed_enrolled');
CREATE INDEX ON crm.enrolments (presumed_deadline_at) WHERE status = 'open';
CREATE INDEX ON crm.enrolments (submission_id);
```

### `crm.disputes`

```sql
CREATE TABLE crm.disputes (
  id              BIGSERIAL PRIMARY KEY,
  enrolment_id    BIGINT NOT NULL REFERENCES crm.enrolments(id),
  raised_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  raised_by       TEXT NOT NULL, -- 'provider' | 'learner' | 'owner'
  reason          TEXT NOT NULL,
  resolution      TEXT, -- 'upheld' | 'overruled' | 'refunded' | 'no_action'
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT,
  notes           TEXT
);

CREATE INDEX ON crm.disputes (enrolment_id);
CREATE INDEX ON crm.disputes (resolved_at) WHERE resolved_at IS NULL;
```

### `crm.providers` — Session C additions (migration 0016)

Three columns added to support future auto-routing and multi-billing-model flexibility:

- `first_lead_received_at TIMESTAMPTZ` — anchor for the "newness boost" in future auto-routing scoring. Backfilled from `leads.routing_log` on migration.
- `auto_route_enabled BOOLEAN NOT NULL DEFAULT false` — per-provider opt-in for auto-routing once the scoring system goes live. Manual today.
- `billing_model crm.billing_model NOT NULL DEFAULT 'retrospective_per_enrolment'` — enum with three values (`retrospective_per_enrolment`, `prepaid_credits`, `per_lead`). Ready for a credits-model provider or marketplace pricing without rework.

### `crm.routing_config`

Single-row ("singleton" primary key) config table holding global routing knobs. Migration 0016.

```sql
CREATE TABLE crm.routing_config (
  id                    TEXT PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
  mode                  TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'monitor' | 'auto'
  weight_enrolment_rate NUMERIC NOT NULL DEFAULT 0.5,
  weight_deadline       NUMERIC NOT NULL DEFAULT 0.3,
  weight_newness        NUMERIC NOT NULL DEFAULT 0.2,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            UUID REFERENCES auth.users(id)
);
```

`mode = 'manual'` means the admin chooses providers manually (pilot default). `monitor` runs the scoring algorithm silently for review. `auto` lets the system route without owner confirmation for providers where `auto_route_enabled = true`.

### `crm.provider_credits`

Dormant until the first credits-model provider signs. Migration 0016.

```sql
CREATE TABLE crm.provider_credits (
  id              BIGSERIAL PRIMARY KEY,
  provider_id     TEXT NOT NULL UNIQUE REFERENCES crm.providers(provider_id),
  balance         NUMERIC NOT NULL DEFAULT 0,
  last_topup_at   TIMESTAMPTZ,
  last_spent_at   TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `crm.billing_events`

Model-agnostic billable event log. One row per event. Billing model on the provider determines how events roll up into invoices. Migration 0016.

```sql
CREATE TABLE crm.billing_events (
  id                BIGSERIAL PRIMARY KEY,
  provider_id       TEXT NOT NULL REFERENCES crm.providers(provider_id),
  event_type        TEXT NOT NULL, -- 'enrolment_confirmed' | 'lead_delivered' | 'credit_debit' | 'credit_topup' | 'manual_adjustment'
  amount_gbp        NUMERIC,
  amount_credits    NUMERIC,
  enrolment_id      BIGINT REFERENCES crm.enrolments(id),
  submission_id     BIGINT REFERENCES leads.submissions(id),
  description       TEXT,
  invoiced_at       TIMESTAMPTZ,
  invoice_reference TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        UUID REFERENCES auth.users(id)
);
```

Per-enrolment billing fires one `enrolment_confirmed` row per confirmed enrolment. Per-lead billing (future marketplace) fires one `lead_delivered` row per routed lead. Credits model fires `credit_debit` on each routed lead and `credit_topup` on each provider payment.

---

## Schema: `social`

Multi-brand organic social automation. Drafts, engagement targets, OAuth tokens, post analytics. Designed from day one for both Switchable Ltd brands (SwitchLeads B2B and Switchable B2C) and multiple channels (LinkedIn personal, LinkedIn company, Meta facebook, Meta instagram, TikTok). Brand and channel are first-class columns so the same `/social` admin module serves every brand × channel combination.

Migration 0029 (Session G.1). Build sequencing, UI page list, OAuth flow detail, Edge Function inventory, push-notification implementation, and future-extensibility notes live in [`platform/docs/admin-dashboard-scoping.md`](admin-dashboard-scoping.md) § Session G — this file owns the schema.

**Brand values:** `'switchleads'` (B2B provider-facing) | `'switchable'` (B2C learner-facing).

**Channel values:** `'linkedin_personal'` (a person's LinkedIn account) | `'linkedin_company'` (a brand's LinkedIn company page) | `'meta_facebook'` (a brand's Facebook page) | `'meta_instagram'` (a brand's Instagram business account) | `'tiktok'` (a brand's TikTok account). The `(brand, channel)` pair identifies a unique posting surface.

**Token encryption.** OAuth `access_token` and `refresh_token` ciphertext live in `vault.secrets` (Supabase Vault, pgsodium-backed). Migration 0029 enables `pgsodium` (and `pgcrypto` for `gen_random_uuid()`); the OAuth callback route in Session G.2 calls `vault.create_secret()` to store ciphertext and stores only the returned UUID on `social.oauth_tokens.access_token_secret_id` / `refresh_token_secret_id`. Edge Functions decrypt via a SECURITY DEFINER helper added in Session G.3 (mirroring the `public.get_shared_secret()` pattern from migration 0019) — that helper enforces an allowlist over which secret rows can be read. Migration 0029 also defensively `REVOKE`s `vault.decrypted_secrets` access from `authenticated` and `anon`. Admin UI never surfaces raw tokens. Per `.claude/rules/data-infrastructure.md` §5.

**RLS posture.** Admin role only at this stage. Every table has RLS enabled with deny-all-by-default; explicit `FOR ALL` policies grant access to authenticated admin users via `admin.is_admin()` (the same helper from migration 0014). Views set `WITH (security_invoker = true)` so they inherit the underlying tables' RLS rather than running as the view owner (Postgres default would bypass RLS — that would have leaked OAuth metadata via `vw_channel_status`). Schema-level `GRANT USAGE ON SCHEMA social TO authenticated` plus per-table SELECT/INSERT/UPDATE grants are required; without them Postgres rejects queries before RLS runs. Append-only tables (`post_analytics`, `engagement_log`) ship without DELETE in their grants — the RLS policy is permissive across all actions but the absence of the privilege enforces append-only at the database layer. Phase 4 may extend specific tables for provider-facing access; not in scope for migration 0029.

**Append-only tables.** `post_analytics` (time-series performance snapshots) and `engagement_log` (ICP-tagging history) are audit-relevant. They have SELECT/INSERT/UPDATE granted but not DELETE. UPDATE is allowed for typo correction; deletion would require a future migration that explicitly grants DELETE to a maintenance role.

**`post_analytics.draft_id` ON DELETE RESTRICT.** Deleting a published draft does NOT silently destroy its analytics history. A draft can only be removed after analytics rows are explicitly cleaned up — that explicit step is the audit trail.

### `social.drafts`

Content drafts in the review pipeline. One row per drafted post. Status moves `pending → approved → published` (or `rejected` / `failed`). Cron-generated by `social-draft-generate` (Mon + Thu); reviewed in `/social/drafts`; published by `social-publish` cron when `status='approved' AND scheduled_for <= now()`.

```sql
CREATE TABLE social.drafts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  brand                       TEXT NOT NULL,                                -- 'switchleads' | 'switchable'
  channel                     TEXT NOT NULL,                                -- 'linkedin_personal' | 'linkedin_company' | 'meta_facebook' | 'meta_instagram' | 'tiktok'
  scheduled_for               TIMESTAMPTZ,                                  -- when it should publish once approved
  status                      TEXT NOT NULL DEFAULT 'pending',              -- 'pending' | 'approved' | 'rejected' | 'published' | 'failed'
  content                     TEXT NOT NULL,
  pillar                      TEXT,                                         -- content pillar from the brand's social config
  hook_type                   TEXT,                                         -- e.g. 'contrarian' | 'building-in-public' | 'provider-win' | 'learner-story'
  cron_batch_id               UUID,                                         -- groups drafts by cron run
  approved_by                 UUID REFERENCES auth.users(id),
  approved_at                 TIMESTAMPTZ,
  edit_history                JSONB,                                        -- [{edited_at, before, after}] — learns from owner's edits
  rejection_reason_category   TEXT,                                         -- 'voice' | 'topic_off' | 'factual_wrong' | 'duplicate' | 'timing' | 'other' — required when status='rejected'
  rejection_reason            TEXT,                                         -- optional free-text alongside the category
  external_post_id            TEXT,                                         -- platform-specific post URN/ID after publish
  published_at                TIMESTAMPTZ,
  publish_error               TEXT,                                         -- captured on status='failed' for retry/debug
  schema_version              TEXT NOT NULL DEFAULT '1.0',
  CHECK (brand IN ('switchleads', 'switchable')),
  CHECK (channel IN ('linkedin_personal', 'linkedin_company', 'meta_facebook', 'meta_instagram', 'tiktok')),
  CHECK (status IN ('pending', 'approved', 'rejected', 'published', 'failed')),
  CHECK (status <> 'rejected' OR rejection_reason_category IS NOT NULL)
);
CREATE INDEX ON social.drafts (brand, channel, status);
CREATE INDEX ON social.drafts (status, scheduled_for) WHERE status = 'approved';
```

### `social.engagement_targets`

Curated list of accounts to engage with regularly. "Brand" here means whose audience we're trying to reach via this engagement (a SwitchLeads target is an ITP director / sector commentator / FE journalist; a Switchable target — when activated — is an adult-learning sector voice or careers commentator). The same person can legitimately be a target for both brands.

```sql
CREATE TABLE social.engagement_targets (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  added_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  brand                    TEXT NOT NULL,                                  -- 'switchleads' | 'switchable'
  channel                  TEXT NOT NULL DEFAULT 'linkedin_personal',      -- which channel we engage from
  name                     TEXT NOT NULL,
  company                  TEXT,
  title                    TEXT,
  profile_url              TEXT NOT NULL,                                  -- LinkedIn / Twitter / Instagram URL depending on channel
  why_target               TEXT,                                           -- short note: ICP director / sector commentator / FE journalist / etc.
  posting_cadence_estimate TEXT,                                           -- 'weekly' | 'monthly' | 'irregular' | 'unknown'
  last_engaged_at          TIMESTAMPTZ,                                    -- when we last commented on/liked their content
  last_followed_back_at    TIMESTAMPTZ,                                    -- when they last engaged with our content
  status                   TEXT NOT NULL DEFAULT 'active',                 -- 'active' | 'retired' | 'paused'
  source                   TEXT,                                           -- 'rosa_pipeline' | 'manual' | 'thea_proposed' | 'sector_search'
  last_reviewed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),             -- quarterly review trigger
  notes                    TEXT,
  CHECK (brand IN ('switchleads', 'switchable')),
  CHECK (status IN ('active', 'retired', 'paused')),
  UNIQUE (brand, profile_url)
);
CREATE INDEX ON social.engagement_targets (brand, status);
```

### `social.engagement_queue`

Specific posts to comment on this week. Populated by `social-engagement-ingest` Edge Function from forwarded LinkedIn notification emails (Gmail filter forwards `notifications-noreply@linkedin.com`). Brand is inferred via JOIN to `engagement_targets` — no separate column.

```sql
CREATE TABLE social.engagement_queue (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_id            UUID NOT NULL REFERENCES social.engagement_targets(id) ON DELETE CASCADE,
  post_url             TEXT NOT NULL,
  post_preview         TEXT,                                              -- excerpt parsed from the notification email
  detected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),                -- when we received the notification
  drafted_comment      TEXT,                                              -- AI-drafted angle for this specific post
  status               TEXT NOT NULL DEFAULT 'pending',                   -- 'pending' | 'commented' | 'dismissed' | 'expired'
  commented_at         TIMESTAMPTZ,
  notification_sent_at TIMESTAMPTZ,                                       -- when we push-notified the admin's phone
  expires_at           TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '48 hours'),  -- auto-expire 48h after detection
  CHECK (status IN ('pending', 'commented', 'dismissed', 'expired'))
);
CREATE INDEX ON social.engagement_queue (status, detected_at);
CREATE INDEX ON social.engagement_queue (target_id);
```

### `social.post_analytics`

Time-series performance per published post. `social-analytics-sync` runs daily and pulls metrics for posts <30 days old via the relevant provider API. Brand is inferred via JOIN to `drafts`.

```sql
CREATE TABLE social.post_analytics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        UUID NOT NULL REFERENCES social.drafts(id) ON DELETE RESTRICT,
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  impressions     INT,
  reactions       INT,
  comments        INT,
  shares          INT,
  clicks          INT,
  follower_count  INT                                                     -- snapshot of total followers on the channel at capture time
);
CREATE INDEX ON social.post_analytics (draft_id, captured_at DESC);
```

### `social.engagement_log`

Manual ICP tagging of engagers (until volume justifies automation). `brand` is denormalised here for easier filtering — set on insert from the joined `drafts` row.

```sql
CREATE TABLE social.engagement_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        UUID REFERENCES social.drafts(id) ON DELETE SET NULL,
  brand           TEXT NOT NULL,
  engager_name    TEXT NOT NULL,
  engager_company TEXT,
  engager_title   TEXT,
  engagement_type TEXT,                                                  -- 'comment' | 'reaction' | 'share' | 'profile_view'
  is_icp          BOOLEAN NOT NULL DEFAULT false,
  notes           TEXT,
  tagged_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  tagged_by       UUID REFERENCES auth.users(id),
  CHECK (brand IN ('switchleads', 'switchable'))
);
CREATE INDEX ON social.engagement_log (brand, is_icp);
```

### `social.oauth_tokens`

Per-`(brand, channel)` OAuth tokens for autonomous publishing. Each posting surface has its own token. The owner's personal LinkedIn OAuth token is reused across brand contexts (one token, used in posting flows tagged with either brand) — represented as one row with `brand='switchleads'` (the default brand for her personal account currently); if Switchable cross-posting from her personal account becomes regular, add a second row with `brand='switchable'` against the same underlying token.

`access_token` and `refresh_token` are encrypted at rest via Supabase Vault. The migration enables `pgsodium`, uses `vault.create_secret()` on insert, reads decrypted via `vault.decrypted_secrets` from Edge Functions only.

```sql
CREATE TABLE social.oauth_tokens (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand                TEXT NOT NULL,                                    -- 'switchleads' | 'switchable'
  channel              TEXT NOT NULL,                                    -- 'linkedin_personal' | 'linkedin_company' | 'meta_facebook' | 'meta_instagram' | 'tiktok'
  provider             TEXT NOT NULL,                                    -- 'linkedin' | 'meta' | 'tiktok' (the OAuth provider, separate from channel)
  external_account_id  TEXT,                                             -- LinkedIn member URN, Facebook page ID, etc.
  access_token_secret_id  UUID NOT NULL,                                 -- references vault.secrets(id) — encrypted access token
  refresh_token_secret_id UUID,                                          -- references vault.secrets(id) — encrypted refresh token (nullable; LinkedIn personal does not issue refresh tokens)
  expires_at           TIMESTAMPTZ,
  scopes               TEXT[],
  last_refreshed_at    TIMESTAMPTZ,
  authorised_by        UUID REFERENCES auth.users(id),
  authorised_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (brand IN ('switchleads', 'switchable')),
  CHECK (channel IN ('linkedin_personal', 'linkedin_company', 'meta_facebook', 'meta_instagram', 'tiktok')),
  CHECK (provider IN ('linkedin', 'meta', 'tiktok')),
  UNIQUE (brand, channel)
);
```

### `social.push_subscriptions`

Web Push subscriptions per admin user. Used by `social-engagement-ingest` to send push notifications when a target posts. Cascade-delete on user removal.

```sql
CREATE TABLE social.push_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL,
  keys_p256dh  TEXT NOT NULL,
  keys_auth    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, endpoint)
);
```

### Views

All views set `WITH (security_invoker = true)` so they inherit the underlying tables' RLS rather than running as the view owner. Without this flag, Postgres views default to running as the owner and would bypass RLS — that is a leak path, especially for `vw_channel_status` which surfaces OAuth metadata.

```sql
CREATE VIEW social.vw_pending_drafts
  WITH (security_invoker = true) AS
  SELECT * FROM social.drafts
   WHERE status = 'pending'
   ORDER BY brand, scheduled_for NULLS LAST;

CREATE VIEW social.vw_post_performance
  WITH (security_invoker = true) AS
  SELECT d.id, d.brand, d.channel, d.pillar, d.content, d.published_at,
         MAX(pa.impressions)                          AS latest_impressions,
         MAX(pa.reactions + pa.comments + pa.shares)  AS latest_engagement
    FROM social.drafts d
    LEFT JOIN social.post_analytics pa ON pa.draft_id = d.id
   WHERE d.status = 'published'
   GROUP BY d.id;

CREATE VIEW social.vw_engagement_queue_active
  WITH (security_invoker = true) AS
  SELECT q.id, q.post_url, q.post_preview, q.drafted_comment, q.detected_at,
         t.brand, t.name AS target_name, t.company AS target_company, t.profile_url AS target_profile_url
    FROM social.engagement_queue q
    JOIN social.engagement_targets t ON t.id = q.target_id
   WHERE q.status = 'pending' AND q.expires_at > now()
   ORDER BY q.detected_at DESC;

CREATE VIEW social.vw_targets_due_review
  WITH (security_invoker = true) AS
  SELECT * FROM social.engagement_targets
   WHERE status = 'active' AND last_reviewed_at < now() - INTERVAL '90 days';

CREATE VIEW social.vw_rejection_patterns
  WITH (security_invoker = true) AS
  SELECT brand, rejection_reason_category, COUNT(*) AS reject_count,
         DATE_TRUNC('week', updated_at) AS week
    FROM social.drafts
   WHERE status = 'rejected'
   GROUP BY brand, rejection_reason_category, week
   ORDER BY week DESC, reject_count DESC;

CREATE VIEW social.vw_channel_status
  WITH (security_invoker = true) AS
  SELECT brand, channel, provider, external_account_id, expires_at,
         CASE
           WHEN expires_at IS NULL                            THEN 'no_expiry'
           WHEN expires_at > now() + INTERVAL '7 days'        THEN 'healthy'
           WHEN expires_at > now()                            THEN 'expiring_soon'
           ELSE 'expired'
         END AS health_status
    FROM social.oauth_tokens
   ORDER BY brand, channel;
```

---

## Schema: `audit`

Append-only audit trails. Writes only through the admin dashboard. Reads by `readonly_analytics` (Sasha, Mira, Iris) and `authenticated` admin users via RLS.

### `audit.actions`

Tamper-evident log of every write performed via the admin dashboard (route confirm, enrolment status update, provider edit, error replay, GDPR erase). Migration 0013 / re-applied via 0016 catch-up.

```sql
CREATE TABLE audit.actions (
  id              BIGSERIAL PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id   UUID NOT NULL REFERENCES auth.users(id),
  actor_email     TEXT NOT NULL,
  surface         TEXT NOT NULL, -- 'admin' | 'provider' | 'system'
  action          TEXT NOT NULL, -- e.g. 'lead.route_confirm', 'enrolment.set_status'
  target_table    TEXT,
  target_id       TEXT,
  before_value    JSONB,
  after_value     JSONB,
  context         JSONB,
  ip_address      INET,
  user_agent      TEXT
);
```

Append-only — never UPDATE or DELETE rows. Dashboard Server Actions write; `readonly_analytics` reads for governance audits.

### `audit.erasure_requests`

GDPR right-to-erasure log. Populated by Session F. Migration 0016.

```sql
CREATE TABLE audit.erasure_requests (
  id                   BIGSERIAL PRIMARY KEY,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  requester_email      TEXT NOT NULL,
  identity_verified_at TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'verifying' | 'in_progress' | 'completed' | 'rejected'
  rejection_reason     TEXT,
  supabase_result      JSONB,
  brevo_result         JSONB,
  netlify_result       JSONB,
  meta_capi_result     JSONB,
  google_ads_result    JSONB,
  completed_at         TIMESTAMPTZ,
  processed_by         UUID REFERENCES auth.users(id),
  notes                TEXT
);
```

One row per erasure request. Per-system JSONB fields record the receipt from each downstream system so the erasure is provable end-to-end.

---

## Views (derived / analytical)

These are read-only analytical surfaces, not source of truth. Defined in migration files, queryable by Metabase and agents.

### `public.vw_attribution`

Joins `leads.submissions` against `ads_switchable.meta_daily` on campaign/ad UTM conventions. Shows which ad generated which lead.

```sql
CREATE VIEW public.vw_attribution AS
SELECT
  s.id AS submission_id,
  s.submitted_at,
  s.course_id,
  s.primary_routed_to,
  s.utm_campaign,
  s.utm_content,
  m.date AS ad_date,
  m.campaign_id,
  m.campaign_name,
  m.ad_id,
  m.ad_name,
  m.spend AS ad_daily_spend,
  m.cost_per_lead AS ad_daily_cpl
FROM leads.submissions s
LEFT JOIN ads_switchable.meta_daily m
  ON m.ad_id = s.utm_content
 AND m.date = DATE(s.submitted_at);
```

Naming convention the ads team must follow: `utm_campaign` = Meta campaign_id, `utm_content` = Meta ad_id. Set in ad URL parameters at campaign creation.

### `public.vw_weekly_kpi`

One row per ISO week. Powers Mira's KPI scorecard.

```sql
CREATE VIEW public.vw_weekly_kpi
WITH (security_invoker = true) AS
WITH weekly_leads AS (
  SELECT
    date_trunc('week', submitted_at) AS week_start,
    COUNT(*) AS total_submissions,
    COUNT(*) FILTER (WHERE NOT is_dq) AS qualified_leads,
    COUNT(*) FILTER (WHERE is_dq) AS dq_leads,
    COUNT(DISTINCT primary_routed_to) FILTER (WHERE primary_routed_to IS NOT NULL) AS providers_served
  FROM leads.submissions
  GROUP BY 1
),
weekly_spend AS (
  SELECT
    date_trunc('week', date) AS week_start,
    SUM(spend) AS meta_spend
  FROM ads_switchable.meta_daily
  GROUP BY 1
),
weekly_enrolments AS (
  SELECT
    date_trunc('week', sent_to_provider_at) AS week_start,
    COUNT(*) AS enrolments_this_week
  FROM crm.enrolments
  WHERE status IN ('enrolled', 'presumed_enrolled', 'billed', 'paid')
  GROUP BY 1
)
SELECT
  wl.week_start,
  wl.total_submissions,
  wl.qualified_leads,
  wl.dq_leads,
  wl.providers_served,
  ws.meta_spend,
  we.enrolments_this_week
FROM weekly_leads wl
LEFT JOIN weekly_spend ws      USING (week_start)
LEFT JOIN weekly_enrolments we USING (week_start)
ORDER BY wl.week_start DESC;
```

Uses CTEs rather than correlated subqueries to avoid Postgres "ungrouped column in subquery" error when grouping by a date_trunc expression.

### `public.vw_funnel_dropoff`

Joins `leads.partials` to `leads.submissions` on `session_id`. One row per session, flattened for dashboarding. Lets Metabase pivot on step_reached × form_name × utm_campaign × device_type and cross-reference against whether the session ultimately converted. Defined in migration 0005 alongside the `session_id` column that makes the join possible.

```sql
CREATE VIEW public.vw_funnel_dropoff
WITH (security_invoker = true) AS
SELECT
  p.session_id,
  p.form_name,
  p.course_id,
  p.funding_route,
  p.step_reached,
  p.answers,
  p.utm_source,
  p.utm_medium,
  p.utm_campaign,    -- = Meta campaign_id per the attribution convention
  p.utm_content,     -- = Meta ad_id per the attribution convention
  p.fbclid,
  p.gclid,
  p.referrer,
  p.device_type,
  p.user_agent,
  p.is_complete,
  p.first_seen_at,
  p.last_seen_at,
  s.id              AS submission_id,
  s.submitted_at,
  s.is_dq,
  s.dq_reason,
  s.primary_routed_to
FROM leads.partials p
LEFT JOIN leads.submissions s
  ON s.session_id = p.session_id;
```

Typical query pattern (drop-off by step × campaign):
```sql
SELECT utm_campaign, step_reached,
       COUNT(*) AS sessions,
       COUNT(*) FILTER (WHERE is_complete) AS converted
FROM public.vw_funnel_dropoff
GROUP BY 1, 2
ORDER BY 1, 2 DESC;
```

More views added as dashboards need them - one view per headline metric.

### `crm.vw_provider_performance` (Session C, migration 0016)

Rolling 30-day enrolment ratio per active provider. Inputs for the future auto-routing scoring algorithm and for the Session E health bar.

```sql
CREATE VIEW crm.vw_provider_performance
  WITH (security_invoker = true) AS
-- per-provider: leads_30d, enrolments_30d, enrolment_rate_30d
-- Filtered to active = true AND archived_at IS NULL
```

Null `enrolment_rate_30d` where `leads_30d = 0` so consumers can filter cleanly.

### `leads.vw_needs_status_update` (Session C, migration 0016)

Routed leads older than 14 days where no non-open enrolment outcome exists. Feeds the "needs attention" panel in the Session D admin dashboard and doubles as an audit signal — if this view ever has rows, the system needs human attention.

```sql
CREATE VIEW leads.vw_needs_status_update
  WITH (security_invoker = true) AS
-- leads routed > 14 days ago, not DQ, not archived,
-- with no enrolments row in status ('enrolled','not_enrolled','disputed','presumed_enrolled')
-- ORDER BY routed_at ASC
```

### `public.vw_admin_health` (Session C, migration 0016)

Single-row snapshot of the headline counters rendered on the admin dashboard topbar (Session E) and the "Run full audit" button output.

```sql
CREATE VIEW public.vw_admin_health
  WITH (security_invoker = true) AS
SELECT
  leads_last_7d,             -- submissions in last 7 days
  unrouted_over_48h,         -- qualified, unrouted, > 48h old
  errors_over_7d,            -- dead_letter unresolved > 7 days (stale)
  errors_unresolved_total,   -- dead_letter unresolved
  needs_status_update_count; -- rows in leads.vw_needs_status_update
```

---

## Access roles

Supabase creates four roles on day one. Each consumer of the DB uses its scoped role, not the superuser key.

| Role | Reads | Writes | Used by |
|---|---|---|---|
| `readonly_analytics` | All tables, all views | Nothing | Metabase connection, read-only Postgres MCP for agents |
| `n8n_writer` | All tables | `leads.*`, `crm.enrolments` status transitions, `leads.dead_letter` | Supabase Edge Functions (role name is legacy from the reversed n8n decision, 2026-04-18 - permissions unchanged, rename deferred to avoid a cosmetic-only migration) |
| `ads_ingest` | Nothing | `ads_*` tables only | Meta/Google/TikTok daily pull scripts |
| `owner` (service role) | All | All | Migrations, manual fixes, incident recovery |

RLS policies enforce these at row level where relevant (for example, a future provider dashboard role reads only rows where `provider_id = auth.uid()`).

---

## Attribution convention - critical

For the `vw_attribution` view to work, every ad URL must follow this UTM convention:

- `utm_source` - platform (`meta`, `google`, `tiktok`, `linkedin`)
- `utm_medium` - always `paid`
- `utm_campaign` - platform's campaign_id
- `utm_content` - platform's ad_id
- `utm_term` - optional, for keyword in Google Ads

If a campaign launches without this convention, attribution fails silently (joins return NULL). Iris's campaign briefs must include these UTMs. Enforced by pre-launch review, not by the database.

---

## Migration strategy

See `.claude/rules/data-infrastructure.md` and `.claude/rules/schema-versioning.md`.

- Initial migration: `0001_init_pilot_schemas.sql` - creates all four pilot schemas and tables above.
- Subsequent migrations: one file per logical change, timestamp-prefixed.
- Never edit a past migration. Always add a new one.
- Every migration tested against a local Supabase instance or staging project before running against production.

---

## Not in this design (deliberately)

- **Learner identity resolution.** Dedup across submissions (same email, different forms) deferred until learners schema exists in Phase 2. For now, one submission = one row, duplicates welcome.
- **Provider auth.** No provider logins yet. Provider data is read-only from providers' perspective. Phase 4.
- **Full audit log.** Only `leads.submissions` and `leads.dead_letter` carry raw payloads. Full cross-table audit waits for Phase 2 `audit` schema if/when compliance demands it.
- **Real-time events.** Everything is request-driven or batch: Edge Function webhooks on form submit, daily pulls for ads, manual updates for provider status. No streaming or live subscriptions.
- **Encryption at column level.** Supabase encrypts at rest by default. Column-level encryption for PII waits until regulatory driver (ROPA or similar).

---

## Open questions (resolve during implementation)

1. Should `course_id` live in a `courses` table inside the DB, or stay as YAML and be referenced by slug? Current bias: stay YAML, courses are low-volume and Git-trackable. Revisit if course count exceeds 50.
2. Dead letter replay - automatic retry (e.g. scheduled Edge Function every 15 min) or manual-only? Bias: manual, visible via Metabase dashboard, owner triggers replay.
3. Provider Sheet migration cutover - dual-write for a week, or cutover instantly? Bias: dual-write for 1-2 weeks, verify reconciliation, then retire Sheet.
4. Metabase self-host vs cloud - owner decision pending.

---

## Referenced by

- `switchable/site/docs/funded-funnel-architecture.md` - links here for storage layer details
- `.claude/rules/data-infrastructure.md` - governance rules bind all changes to this doc
- `.claude/rules/schema-versioning.md` - schema_version field discipline
- `platform/CLAUDE.md` - project context
