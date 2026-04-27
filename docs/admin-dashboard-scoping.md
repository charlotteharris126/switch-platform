# Admin Dashboard MVP — Scoping Doc

**Status:** Decisions 1, 2, 3 locked 2026-04-22 (platform Session 5.3 follow-on).
**Owner:** Charlotte
**Built by:** Claude pair-programming with Charlotte in the loop
**First build session:** Session A (next platform session)
**Related:** [platform/CLAUDE.md](../CLAUDE.md), [.claude/rules/data-infrastructure.md](../../.claude/rules/data-infrastructure.md), [.claude/rules/schema-versioning.md](../../.claude/rules/schema-versioning.md), [business.md Phase 4](../../.claude/rules/business.md), Clara ticket on GDPR retention (created at handoff)

This is the single source of truth for the admin dashboard build. Sessions A-F implement what this doc describes. If reality drifts from the doc, update the doc — never the other way round.

---

## North star

Build the platform underneath both Switchable and SwitchLeads. Phase 1 ships an admin UI that replaces the manual SQL + email-confirm workflow Charlotte runs today. Phase 4 adds provider-facing routes on the same codebase. Phase 2-3 absorbs Metabase. Phase 4-5 evolves into the marketplace where providers buy leads.

The MVP is the admin layer. Every architectural choice in MVP is made with the Phase 4 provider portal and Phase 4-5 marketplace in mind, so we never paint into a corner.

---

## Architecture

### One codebase, two subdomains

```
GitHub repo: switch-platform
        │
        ▼
Netlify project (single deployment)
        │
        ├─ admin.switchleads.co.uk   ← internal admin UI (Charlotte, Sasha, future hires)
        └─ app.switchleads.co.uk     ← provider portal (Phase 4 — providers log in to see their leads, billing, enrolments)
        │
        ▼
Supabase production (existing)
Supabase staging (free tier, used only for destructive testing in Session F)
```

Hostname-based middleware in Next.js routes the request to the right surface. Same auth flow, same data layer, same design system, shared components.

### Stack

- **Next.js 15** (App Router) + TypeScript
- **shadcn/ui** for components, **Tailwind** for styling
- **Supabase Auth** (TOTP MFA enforced) for login
- **Supabase Postgres** (existing) for data
- **Netlify** for hosting + automatic deploys on push to GitHub `main` (same provider as switchable.careers + switchleads.co.uk — stack consolidation)
- **Renovate** (or Dependabot) for dependency updates

### Repo

`github.com/[org]/switch-platform`. Private. Not part of the iCloud-synced `Switch-Claude/` workspace — the workspace owns docs, agents, copy, and architectural decisions; the repo owns code.

### Environments

| | Purpose | Where |
|---|---|---|
| **Production** | Live system everyone uses | Netlify + Supabase production |
| **Staging** | Safe testing for destructive operations (GDPR DELETEs in Session F) | Free Supabase project, Netlify Preview deploys |
| **Local** | Throwaway dev preview when editing code | Charlotte's Mac, Next.js dev server, points at staging Supabase |

Nothing important persists on the Mac. Code lives in GitHub. Data lives in Supabase. Hosting is Netlify. Mac is an editor.

---

## Security baseline

Built INTO the dashboard from day one. Not a separate workstream, not a post-launch audit. Per `.claude/rules/data-infrastructure.md` plus dashboard-specific additions:

1. **Auth**: Supabase Auth, TOTP MFA enforced for every internal user. Email allowlist gate before MFA challenge.
2. **Authorisation**: Postgres RLS on every table. Admin role bypasses some policies (auditable). Provider role (Phase 4) sees only `provider_id = auth.uid()` rows.
3. **Audit log**: every write through the dashboard inserts a row into `audit.actions` (user, timestamp, table, row_id, before, after). Tamper-evident.
4. **Secrets**: Netlify env vars only. No secrets in iCloud-synced files. Annual rotation per `data-infrastructure.md` §5.
5. **IP allowlist on `admin.*`** (optional, low cost): Netlify Edge Function restricts admin login to known IPs. Provider portal stays open.
6. **Dependency monitoring**: Renovate opens PRs on CVE-driven updates. Monthly review window.
7. **Pre-Phase-4 pen-test**: third-party penetration test before opening provider portal to providers. ClickUp Backlog: [869d0hwxz](https://app.clickup.com/t/869d0hwxz).

The two existing site-security tickets ([869cy863d](https://app.clickup.com/t/869cy863d) SwitchLeads, [869cy863f](https://app.clickup.com/t/869cy863f) Switchable) cover anonymous-visitor / static-site OWASP. They do not cover the dashboard's threat surface (auth, multi-tenant, PII at rest). The pen-test ticket above does.

---

## MVP scope — 7 features

### 1. Login + MFA + role check
Email + password + TOTP code. Allowlist of internal user emails. Sessions via Supabase Auth. Role determined by membership in `auth.users` metadata + admin allowlist. Logout, password reset, MFA enrolment flow, MFA recovery codes.

### 2. Leads list + detail + GDPR erase
- **List**: read `leads.submissions`. Filter by funding_route, course, provider, date range, DQ status, has_phone, has_postcode. Sort by created_at, route status. Pagination.
- **Detail**: full lead — payload, routing log, enrolment status, dead_letter history, partial-capture history (joined on session_id). Side panel shows the live audit log for this row.
- **GDPR erase**: search by email. Preview every record across Supabase + Brevo + Netlify + Meta CAPI + Google Ads. Confirm + execute the erase pipeline (Session F). Writes `audit.erasure_requests` log with full record.
- **Retention cron**: auto-delete data past retention windows. Periods come from Clara. Non-blocking — cron wires up in Session F or later.
- **Sheets are NOT in the GDPR pipeline.** Sheets retire at Phase 4 and the entire spreadsheet for each provider is deleted at retirement. Per-row deletion not justified for an interim layer.

### 3. Lead routing UI (manual MVP, schema ready for auto-routing)
- For an unrouted lead, see candidate providers (matched via `crm.provider_courses`).
- Click "Route to [provider]" → calls existing `routing-confirm` Edge Function logic from inside the dashboard (replaces the email Confirm-button flow). Email flow stays available as fallback.
- Audit log row written.
- **Schema additions for future auto-routing (ship in Session C, latent):**
  - `crm.providers.first_lead_received_at` (newness anchor)
  - `crm.providers.auto_route_enabled` BOOLEAN DEFAULT false
  - `crm.routing_config` table (global "monitor vs auto" toggle, weighting parameters)
  - `vw_provider_performance` view (rolling 30-day enrolment ratio)
- Phase 2 ticket fires when 3+ providers routinely match on same criteria — see Growth Triggers in `platform/CLAUDE.md`.

### 4. Enrolment outcome management
- For any routed lead, set status: `enrolled`, `not_enrolled`, `disputed`, `presumed_enrolled`. Writes `crm.enrolments`.
- Notes field for context.
- Sheet stays append-only — `routing-confirm` writes a row when lead is routed, that's it.
- **Charlotte manually updates Supabase from the sheet** (sheet has a script that auto-updates status; she copies that into the dashboard).
- **"Needs status update" panel**: lists every routed lead older than 14 days where Supabase status is still `routed`. Doubles as an audit signal — if the panel ever has rows, the system needs human attention.
- 14-day presumed-enrolled cron: NOT in MVP. Sheet script handles it. Phase 4 dependency: when sheets retire, the same logic ships as a Supabase cron.
- 7-day dispute window after billing: `crm.enrolments.billed_at` + 7-day grace check. Status locks after grace. Before grace, dashboard amend → status update + audit row.

### 5. Providers list + edit
- List `crm.providers` with status (onboarding stage, routing live yes/no, last lead received).
- Detail/edit: sheet_webhook_url, cc_emails, per-provider rate, onboarding stage, billing_model, auto_route_enabled.
- New schema fields (Session C):
  - `crm.providers.billing_model` enum DEFAULT `retrospective_per_enrolment`
  - `crm.provider_credits` table (latent until credits-model providers exist)
  - `crm.billing_events` table (every billable event, model-agnostic)

### 6. Dead letter view + replay
- Read `leads.dead_letter`. Filter by source, error_context, age.
- One-click replay → re-runs original payload through `netlify-lead-router` Edge Function.
- Sets `replayed_at` and `replay_submission_id` automatically.
- Audit log row written.

### 7. Health bar + on-demand full audit
- **Live health bar** on every page: leads this week, dead letter rows >7 days, unrouted leads >48h, last cron run status, secrets approaching rotation.
- **"Run full audit" button**: comprehensive single-click check matching Sasha's Monday scan. Cross-checks Netlify Forms count vs Supabase, scans dead_letter ages, verifies cron health, checks migration drift, flags secrets due for rotation, lists any unrouted lead older than 48h. Output: clean / N issues found, drill-down per category.
- Same panel-as-audit pattern: any "needs attention" surface is also a measurable audit signal.

---

## Out of MVP scope (deliberate)

- Charts / metrics dashboard → Metabase covers it for now. Replaced by in-dashboard analytics in Phase 2-3.
- Provider portal routes → Phase 4. Same codebase, added later.
- Billing / invoice generation → separate workstream after first £ paid via GoCardless.
- Activity feed / push notifications → add when there's a real ask.
- Search across everything → list filters cover 95%.
- Custom report builder → Metabase, then in-dashboard analytics.
- Mobile-responsive polish → desktop-first, mobile when needed.
- Admin user management UI → Supabase dashboard handles 1-3 users fine.

---

## Future architecture awareness (not MVP work, but constrains MVP design)

### Charts module replacing Metabase (Phase 2-3)
- Pick a charting library MVP-aligned with the design system: **Recharts** or **Tremor** with shadcn/ui. Both work, both scale.
- Data fetching pattern in MVP must support charts plugging in later — use server components + Supabase server-side queries from day one.
- Trigger: when Metabase has 5+ live dashboards or Charlotte starts asking for in-dashboard charts.

### Marketplace / per-lead pricing (Phase 4-5)
- Schema must support both pay-per-enrolment (current) and per-lead pricing (future).
- `crm.billing_events` table is the abstraction — every billable event is a row, billing model determines how events become invoices.
- Lead exclusivity is a flag on the routing event, not a schema constraint — supports future shared-lead model without rework.

### Provider portal (Phase 4)
- Same codebase, routes added under `app.switchleads.co.uk`.
- Provider sees: their leads (RLS-scoped), enrolment status, billing (credits balance OR outstanding invoices, depending on `billing_model`), invoices for download, dispute submission UI.
- Pre-launch pen-test fires at this trigger — see [869d0hwxz](https://app.clickup.com/t/869d0hwxz).

### Organic social module (Session G — post-MVP)
Added to scope 2026-04-24 as part of scoping the SwitchLeads social automation end-game (Thea agent). See [switchleads/social/CLAUDE.md](../../switchleads/social/CLAUDE.md).

- Internal-only module at `admin.switchleads.co.uk/social`. Not provider-facing.
- Hosts the approval workflow for content drafts generated by Thea's Monday + Thursday cron.
- Drafts are reviewed in-app (approve / edit inline / reject / override schedule). Approved drafts publish via direct LinkedIn API (Marketing Developer Platform access required — see submission doc at `switchleads/social/docs/linkedin-developer-app-submission.md`).
- Same pattern extends to Meta Graph API (Facebook + Instagram) as a second channel once LinkedIn is live — no architectural change, add channel values to the `social.drafts.channel` enum and wire a second publisher Edge Function.

**Why this is a module inside the admin dashboard, not a standalone tool:** consolidates platform surfaces, reuses auth + RLS + audit logging + design system, avoids yet another third-party subscription (Buffer Essentials, Shield, Metricool Advanced, Taplio) with their own data silos and API rebuild risks. The review UI is the kind of thing every serious B2B founder-led presence reinvents eventually — we build it once, cleanly, alongside everything else.

**Out of scope for Session G:** engagement comment automation (LinkedIn does not expose feed-read APIs for personal profiles; commenting stays human-driven — see `switchleads/social/CLAUDE.md`). Inbound DM automation (same constraint). Video content editor (future).

---

## Build sequence — Sessions A through F

Each session is self-contained, ships visible value, and leaves the system in a deployable state. No half-built features sitting in a branch for weeks.

### Session A — Foundation (~1.5-2 hours owner time)
- Scaffold Next.js 15 + TypeScript + shadcn/ui + Supabase client
- Netlify project setup, attach `admin.switchleads.co.uk` + `app.switchleads.co.uk`
- DNS records on the SwitchLeads domain
- Hostname-based routing middleware
- Supabase Auth setup, MFA enforcement, email allowlist
- Login page, logout, password reset, MFA enrolment, MFA recovery codes
- Empty admin shell (sidebar nav, topbar with health bar placeholder, content area, design system in place)
- Renovate / Dependabot enabled
- `audit.actions` table created (used from Session D onwards)
- Deploy to production
- **Done when**: Charlotte logs into `admin.switchleads.co.uk` with MFA and sees an empty dashboard.

### Session B — Read-only data surfaces (~1-1.5 hours)
- Leads list with filters
- Lead detail view (full payload, routing log, dead_letter history, partial captures join)
- Providers list
- Provider detail view (read-only)
- Dead letter list
- All RLS policies in place — admin role only at this stage
- **Done when**: Charlotte browses all operational data without opening Supabase.

### Session C — Schema additions for future-proofing (~45 min)
Single migration file (additive only — no risk to live data):
- `crm.providers.first_lead_received_at` + backfill from `leads.routing_log`
- `crm.providers.auto_route_enabled` BOOLEAN DEFAULT false
- `crm.providers.billing_model` enum DEFAULT 'retrospective_per_enrolment'
- `crm.routing_config` table
- `crm.provider_credits` table (latent)
- `crm.billing_events` table
- `audit.actions` table (already created Session A but rename here if needed)
- `audit.erasure_requests` table
- `vw_provider_performance` view
- `vw_needs_status_update` view (powers the panel in Session D)
- `vw_admin_health` view (powers the health bar in Session E)

Migration logged in `platform/docs/changelog.md` per data-infrastructure rule.

### Session D — Write surfaces + needs-update panel (mostly shipped 2026-04-25)

**Shipped today:**
- ✅ Funding category schema split — migration 0017, all consumers, switchable site form changes, `/new-course-page` skill update
- ✅ Audit log helper functions — `audit.log_action` (admin) + `audit.log_system_action` (cron) — migrations 0020/0021/0023
- ✅ Enrolment outcome form on lead detail page — migration 0022 + Server Action + button group UI
- ✅ Auto-flip cron — `crm.run_enrolment_auto_flip` scheduled daily 06:00 UTC, jobid 6 (migration 0023)
- ✅ Actions tab — `/actions` route with Unrouted + Approaching auto-flip + Presumed enrolled awaiting confirmation
- ✅ Overview tiles rebuild — 9 lifecycle tiles + period selector replacing the raw 4 totals
- ✅ Provider edit form on provider detail page — migration 0024 + Server Action + form UI
- ✅ Favicon — SwitchLeads `/brand/favicon.svg`
- ✅ "Routed/Unrouted" filter excludes archived rows (incident sub-fix)

**Still to build (carrying):**
- Lead routing UI (auto-routing v1 from `auto-routing-design.md` is the chosen path — replaces the original "manual routing button" idea)
- Error replay button (re-fires `netlify-lead-router` with stored payload)
- "Needs status update" panel — partially overlapped by the Actions tab "Approaching 14-day auto-flip" section. Decide if the panel is still needed or if Actions covers it.

**Done when**: Charlotte runs a full week of operations without opening Supabase or sending Confirm-button emails, and the Actions tab is the only place she needs to look for anything that needs doing.

### Session E — Health + on-demand audit (~1-1.5 hours)
- Live health bar (live counters)
- "Run full audit" button (Netlify ↔ Supabase reconciliation, dead letter age scan, cron health, secrets due-date check, migration drift)
- Audit results view (clean / issues, drill-down)
- **Done when**: every Sasha Monday check is one click away, real-time.

### Session F — GDPR erase pipeline (~2-3 hours, depends on Clara)
- Search by email → preview what we hold across Supabase + Brevo + Netlify + Meta + Google
- Confirm + execute erase pipeline:
  - Supabase deletes (transaction)
  - Brevo API contact delete
  - Netlify Forms submission delete
  - Meta CAPI deletion request submitted
  - Google Ads deletion request submitted
- `audit.erasure_requests` log row written
- Retention cron job (uses periods from Clara)
- Email confirmation template to data subject
- **Tested against staging Supabase first**, then promoted to production
- **Done when**: GDPR right-to-erasure is real, provable, and runs automatically for retention.

---

### Session G — Organic social module (post-MVP, ~5-6 hours, multi-brand)

Runs after Sessions A-F ship (admin dashboard MVP). Adds `/social` routes + cron infrastructure for organic social automation across **both Switchable Ltd brands** (SwitchLeads provider-facing + Switchable consumer-facing). Single platform, single codebase, single database — brand is a first-class navigation concept (matches Session I's reporting layer).

Depends on LinkedIn Marketing Developer Platform approval for live company-page publishing — approval is applied for once the module shell is live so reviewers can see the real app URL. Personal-profile publishing (`w_member_social` scope) is granted via the auto-approved Share on LinkedIn product on App 1 and works from day one. During Marketing Developer Platform wait, `/social` supports manual posting workflow for company-page content; personal-profile content publishes autonomously via API.

**Note on partial early build (2026-04-25):** the publishing infrastructure (OAuth callback route, `social.oauth_tokens` table, `social-publish-linkedin` Edge Function, the schema below) was built ahead of the rest of Session G to enable autonomous posting of the first manual-stage content batch (12 posts, 28 Apr → 21 May 2026). That early build follows this spec exactly and survives unchanged into the full Session G ship; only the cron orchestration changes (interim hardcoded crons replaced by table-driven publishing reading `social.drafts`).

**Schema migrations (new `social` namespace, multi-brand):**

```sql
-- New schema
CREATE SCHEMA social;

-- Brand is a first-class concept across every social table.
-- Values: 'switchleads' (B2B provider-facing brand) | 'switchable' (B2C learner-facing brand)
-- Channel identifies the surface: 'linkedin_personal' (Charlotte's personal account) | 'linkedin_company' (a brand's company page) | 'meta_facebook' (a brand's Facebook page) | 'meta_instagram' (a brand's Instagram business account) | 'tiktok' (a brand's TikTok)
-- (brand, channel) together identifies a unique posting surface. e.g. (switchleads, linkedin_company) is the SwitchLeads LinkedIn page; (switchable, meta_instagram) is the Switchable Instagram. Charlotte's personal account is reused across brands as needed: (switchleads, linkedin_personal) is the dominant case for B2B founder content; (switchable, linkedin_personal) is rare cross-posting.

-- social.drafts — content drafts awaiting review or scheduled to publish
CREATE TABLE social.drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  brand TEXT NOT NULL,                           -- 'switchleads' | 'switchable'
  channel TEXT NOT NULL,                         -- 'linkedin_personal' | 'linkedin_company' | 'meta_facebook' | 'meta_instagram' | 'tiktok'
  scheduled_for TIMESTAMPTZ,                    -- when it should publish once approved
  status TEXT NOT NULL DEFAULT 'pending',        -- 'pending' | 'approved' | 'rejected' | 'published' | 'failed'
  content TEXT NOT NULL,
  pillar TEXT,                                   -- content pillar from the brand's social config
  hook_type TEXT,                                -- e.g. 'contrarian' | 'building-in-public' | 'provider-win' | 'learner-story'
  cron_batch_id UUID,                            -- groups drafts by cron run
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  edit_history JSONB,                            -- [{edited_at, before, after}] — learns from Charlotte's edits
  rejection_reason_category TEXT,                -- 'voice' | 'topic_off' | 'factual_wrong' | 'duplicate' | 'timing' | 'other' — required when status='rejected'
  rejection_reason TEXT,                         -- optional free-text alongside the category
  external_post_id TEXT,                         -- platform-specific post URN after publish (LinkedIn URN, Meta post ID, etc.)
  published_at TIMESTAMPTZ,
  publish_error TEXT,                            -- captured error message on status='failed' for retry/debug
  schema_version TEXT NOT NULL DEFAULT '1.0'
);
CREATE INDEX ON social.drafts (brand, channel, status);
CREATE INDEX ON social.drafts (status, scheduled_for) WHERE status = 'approved';
-- CHECK constraint: when status='rejected', rejection_reason_category must be set
ALTER TABLE social.drafts ADD CONSTRAINT rejection_reason_required
  CHECK (status != 'rejected' OR rejection_reason_category IS NOT NULL);

-- social.engagement_targets — curated list of accounts to engage with regularly
-- Brand here means "whose audience are we trying to reach via this engagement?"
-- SwitchLeads targets = ITP directors / FE sector / journalists. Switchable targets (later) = adult-learning sector voices, careers commentators, regional skills figures.
CREATE TABLE social.engagement_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  brand TEXT NOT NULL,                           -- 'switchleads' | 'switchable'
  channel TEXT NOT NULL DEFAULT 'linkedin_personal',  -- which channel we engage from (Charlotte's account is currently the only one)
  name TEXT NOT NULL,
  company TEXT,
  title TEXT,
  profile_url TEXT NOT NULL,                     -- LinkedIn / Twitter / Instagram URL depending on channel
  why_target TEXT,                               -- short note: ICP director / sector commentator / FE journalist / etc.
  posting_cadence_estimate TEXT,                 -- 'weekly' | 'monthly' | 'irregular' | 'unknown'
  last_engaged_at TIMESTAMPTZ,                   -- when we last commented on/liked their content
  last_followed_back_at TIMESTAMPTZ,             -- when they last engaged with our content
  status TEXT NOT NULL DEFAULT 'active',         -- 'active' | 'retired' | 'paused'
  source TEXT,                                   -- 'rosa_pipeline' | 'manual' | 'thea_proposed' | 'sector_search'
  last_reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),  -- quarterly review trigger
  notes TEXT,
  UNIQUE (brand, profile_url)                    -- same person could be a target for both brands legitimately
);
CREATE INDEX ON social.engagement_targets (brand, status);

-- social.engagement_queue — specific posts to comment on this week
-- Populated by social-engagement-ingest Edge Function from forwarded notification emails
CREATE TABLE social.engagement_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_id UUID NOT NULL REFERENCES social.engagement_targets(id),
  post_url TEXT NOT NULL,
  post_preview TEXT,                             -- excerpt parsed from the notification email
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- when we received the notification
  drafted_comment TEXT,                          -- Thea-drafted angle for this specific post
  status TEXT NOT NULL DEFAULT 'pending',        -- 'pending' | 'commented' | 'dismissed' | 'expired'
  commented_at TIMESTAMPTZ,
  notification_sent_at TIMESTAMPTZ,              -- when we push-notified Charlotte's phone
  expires_at TIMESTAMPTZ                         -- auto-mark expired after 48h (engagement loses impact after that)
);
-- brand inferred via JOIN to engagement_targets — no separate column needed

-- social.post_analytics — time-series performance per published post
CREATE TABLE social.post_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID NOT NULL REFERENCES social.drafts(id),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  impressions INT,
  reactions INT,
  comments INT,
  shares INT,
  clicks INT,
  follower_count INT                             -- snapshot of total followers on the channel at capture time
);
-- brand inferred via JOIN to drafts

-- social.engagement_log — manual ICP tagging of engagers (until volume justifies automation)
CREATE TABLE social.engagement_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID REFERENCES social.drafts(id),
  brand TEXT NOT NULL,                           -- denormalised for easier filtering, set on insert from joined draft
  engager_name TEXT NOT NULL,
  engager_company TEXT,
  engager_title TEXT,
  engagement_type TEXT,                          -- 'comment' | 'reaction' | 'share' | 'profile_view'
  is_icp BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  tagged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tagged_by UUID REFERENCES auth.users(id)
);
CREATE INDEX ON social.engagement_log (brand, is_icp);

-- social.oauth_tokens — per-(brand,channel) OAuth tokens for publishing
-- Each posting surface has its own token. Charlotte's personal LinkedIn OAuth token is reused across brand contexts (one token, used in posting flows tagged with either brand) — represented as one row with brand='switchleads' (default brand for her personal account currently); if Switchable cross-posting from her personal account becomes regular, add a second row with brand='switchable' using the same underlying token.
CREATE TABLE social.oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand TEXT NOT NULL,                           -- 'switchleads' | 'switchable'
  channel TEXT NOT NULL,                         -- 'linkedin_personal' | 'linkedin_company' | 'meta_facebook' | etc.
  provider TEXT NOT NULL,                        -- 'linkedin' | 'meta' (the OAuth provider, separate from channel)
  external_account_id TEXT,                      -- the LinkedIn member URN, Facebook page ID, etc.
  access_token TEXT NOT NULL,                    -- encrypted at rest via Supabase Vault (pgsodium-backed)
  refresh_token TEXT,                            -- not all providers issue refresh tokens
  expires_at TIMESTAMPTZ,
  scopes TEXT[],
  last_refreshed_at TIMESTAMPTZ,
  authorised_by UUID REFERENCES auth.users(id),
  authorised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (brand, channel)
);

-- Views for dashboard (all brand-aware)
CREATE VIEW social.vw_pending_drafts AS
  SELECT * FROM social.drafts WHERE status = 'pending' ORDER BY brand, scheduled_for NULLS LAST;

CREATE VIEW social.vw_post_performance AS
  SELECT d.id, d.brand, d.channel, d.pillar, d.content, d.published_at,
         MAX(pa.impressions) AS latest_impressions,
         MAX(pa.reactions + pa.comments + pa.shares) AS latest_engagement
  FROM social.drafts d
  LEFT JOIN social.post_analytics pa ON pa.draft_id = d.id
  WHERE d.status = 'published'
  GROUP BY d.id;

CREATE VIEW social.vw_engagement_queue_active AS
  SELECT q.id, q.post_url, q.post_preview, q.drafted_comment, q.detected_at,
         t.brand, t.name AS target_name, t.company AS target_company, t.profile_url AS target_profile_url
  FROM social.engagement_queue q
  JOIN social.engagement_targets t ON t.id = q.target_id
  WHERE q.status = 'pending' AND q.expires_at > now()
  ORDER BY q.detected_at DESC;

CREATE VIEW social.vw_targets_due_review AS
  SELECT * FROM social.engagement_targets
  WHERE status = 'active' AND last_reviewed_at < now() - INTERVAL '90 days';

CREATE VIEW social.vw_rejection_patterns AS
  SELECT brand, rejection_reason_category, COUNT(*) AS reject_count,
         DATE_TRUNC('week', updated_at) AS week
  FROM social.drafts
  WHERE status = 'rejected'
  GROUP BY brand, rejection_reason_category, week
  ORDER BY week DESC, reject_count DESC;

CREATE VIEW social.vw_channel_status AS
  -- which (brand, channel) surfaces have valid OAuth tokens vs need re-authentication
  SELECT brand, channel, provider, external_account_id,
         expires_at,
         CASE
           WHEN expires_at IS NULL THEN 'no_expiry'
           WHEN expires_at > now() + INTERVAL '7 days' THEN 'healthy'
           WHEN expires_at > now() THEN 'expiring_soon'
           ELSE 'expired'
         END AS health_status
  FROM social.oauth_tokens
  ORDER BY brand, channel;

-- RLS: admin role only until explicitly extended
ALTER TABLE social.drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social.post_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE social.engagement_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE social.oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE social.engagement_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE social.engagement_queue ENABLE ROW LEVEL SECURITY;
-- Policies: admin role read+write everything (with audit log inserts on writes per Sessions A-F pattern); deny-all for everything else
-- oauth_tokens.access_token + refresh_token columns specifically encrypted via Supabase Vault per `.claude/rules/data-infrastructure.md` §5
```

Migration lives in `platform/supabase/migrations/` as `NNNN_add_social_schema.sql`. Update `platform/docs/data-architecture.md` first (source-of-truth lead).

**Brand filter as first-class navigation:** Top-level brand selector in the `/social` nav (defaults to "all brands" view; toggleable to switchleads-only or switchable-only). Every page below honours the selected filter. URL query param `?brand=switchleads` makes filtered views shareable.

**Admin UI pages:**
- `/social` — overview: pending drafts count, active engagement queue count, recent publishes, this week's top-performing post, ICP engagement summary, targets-due-quarterly-review badge, channel-health badges (one per (brand,channel) showing token expiry status from `vw_channel_status`)
- `/social/drafts` — queue of pending drafts, inline approve/edit/reject. Reject requires `rejection_reason_category` selection; optional free-text alongside. Brand filter active.
- `/social/published` — list of published posts with analytics. Brand filter active.
- `/social/published/[id]` — post detail + analytics chart + ICP engagement tag entry
- `/social/analytics` — rollup views: performance by pillar, channel, hook type, time period; rejection-pattern dashboard fed by `vw_rejection_patterns`. Brand filter active.
- `/social/engagement-log` — ICP engager list, repeat-engagers flagged for Rosa (SwitchLeads) or whichever B2C handoff exists for Switchable. Brand filter active.
- `/social/targets` — manage the engagement targets list. Add new (paste profile URL → reminds to click platform notification bell + adds to table), edit existing, retire stale, surface `vw_targets_due_review` rows for quarterly refresh. Brand filter active (each target tagged to a brand).
- `/social/queue` — **mobile-first** view of `vw_engagement_queue_active`. Each row = one specific post to comment on, with Thea's drafted comment. Single big "Comment now" button per row that (a) opens the post via universal link in the platform app, (b) copies the drafted comment to clipboard simultaneously. Tap-mark-done to set `status='commented'`.
- `/social/settings` — channel connection management. Lists every (brand, channel) combination as a card with current health (Connected / Token expiring soon / Token expired / Not connected). For each, a "Connect" or "Reconnect" button initiates the OAuth dance via `/api/auth/{provider}/connect?brand={brand}&channel={channel}`. Once connected, also shows the external_account_id (e.g. LinkedIn URN, Facebook page name) so the admin can verify the right account is linked.

**OAuth integration (Next.js API routes in admin dashboard codebase):**

These routes handle third-party OAuth dances for connecting publishing channels. Distinct from the user-authentication flows already in Sessions A-F (those use Supabase Auth). These routes capture per-channel posting tokens.

- `GET /api/auth/linkedin/connect?brand={brand}&channel={channel}` — initiates LinkedIn OAuth. Constructs the LinkedIn authorization URL with the right scopes for the channel (`w_member_social r_member_social r_liteprofile email` for personal; adds `r_organization_social w_organization_social` for company-page once Marketing Developer Platform approved). Stores `{brand, channel, csrf_state}` in a short-lived cookie. Redirects browser to LinkedIn.
- `GET /api/auth/linkedin/callback?code={code}&state={state}` — handles LinkedIn redirect after authorization. Verifies CSRF state matches cookie. Exchanges authorization code for access + refresh tokens via LinkedIn's token endpoint. Fetches the authenticated user's URN (or company page admin URN). Upserts row in `social.oauth_tokens` keyed on (brand, channel) — encrypted via Supabase Vault. Redirects to `/social/settings?status=connected&channel={channel}`.
- `GET /api/auth/meta/connect?brand={brand}&channel={channel}` — same pattern for Meta (Facebook + Instagram). Out of scope for first ship — added when Switchable starts running Meta channels.
- `GET /api/auth/meta/callback?code={code}&state={state}` — same.

Both `/api/auth/{provider}/callback` routes live on `admin.switchleads.co.uk` (no localhost ever). Redirect URLs registered in the LinkedIn / Meta developer apps point here.

**Edge Functions (new, in `platform/supabase/functions/`):**
- `social-draft-generate` — scheduled (Mon + Thu 07:00 UTC, one run per active brand): pulls past-cycle analytics via the relevant publishing API, reads brand-specific content pillars + ICP signals + `vw_rejection_patterns`, calls Claude API to draft posts, inserts into `social.drafts` with `status='pending'` and the relevant brand tag.
- `social-publish` — scheduled (every 15 min via pg_cron): reads `social.drafts` rows with `status='approved' AND scheduled_for <= now()`. For each row, looks up the OAuth token via `(brand, channel)`, posts via the relevant provider API (LinkedIn UGC Posts API for `linkedin_*`, Meta Graph API for `meta_*`), writes `external_post_id` + `published_at`, sets `status='published'`. On failure, sets `status='failed'` and `publish_error` for retry/debug. Audit log row written per publish attempt.
- `social-analytics-sync` — scheduled (daily 06:00 UTC): pulls post performance via the relevant API for all published posts <30 days old, inserts `social.post_analytics` rows, snapshots follower count.
- `social-engagement-ingest` — webhook endpoint (no schedule). Receives forwarded notification emails (Gmail filter forwards `notifications-noreply@linkedin.com` and equivalents). Parses sender (target name) + post URL. Looks up matching `social.engagement_targets.profile_url` (skip if no match — only listed targets generate queue items). Calls Claude API to draft a contextual comment angle. Inserts `social.engagement_queue` row. Sends push notification to admin's PWA-subscribed device.
- `social-targets-quarterly-flag` — scheduled (Monday 06:30 UTC). Queries `vw_targets_due_review`. If non-empty, surfaces in the relevant brand's social agent's Monday weekly-notes.md and pings the `/social/targets` badge.
- `social-engagement-queue-expire` — scheduled (every 6 hours). Marks `status='expired'` on pending queue rows past `expires_at`.
- `social-token-refresh` — scheduled (daily 04:00 UTC). For every `social.oauth_tokens` row with `expires_at` within 7 days, attempts refresh using `refresh_token` (where the provider supports it). Updates row on success. Surfaces to `/social/settings` health badge on failure (admin must reconnect manually).

**UX patterns (mobile-responsive Next.js + shadcn/ui):**
- **Push notifications** — `/social/queue` registers a service worker on first visit and prompts for push permission. When `social-engagement-ingest` writes a new queue row, the Edge Function POSTs to a Web Push endpoint (using `web-push` library + VAPID keys stored in Supabase env per `.claude/rules/data-infrastructure.md` §5). Charlotte's phone gets a notification: "💬 [Target name] just posted. Comment ready." Tap → opens `/social/queue`. Notification works without an app — PWA standard, supported on iOS 16.4+ and Android.
- **One-tap "Comment now" button** — triggers two actions on click: (a) `navigator.clipboard.writeText(drafted_comment)`, (b) `window.location.href = post_url`. On iOS/Android with the LinkedIn app installed, the URL deep-links into the app at the exact post. Charlotte taps Comment, pastes (long-press → paste), edits if she wants, posts.
- **Reject UX** — clicking Reject opens a small modal with a category dropdown (voice / topic_off / factual_wrong / duplicate / timing / other) and an optional free-text box. Submission writes both fields to `social.drafts`. Cannot reject without picking a category — enforced in DB by the CHECK constraint.
- **Mobile-first not just mobile-friendly** — `/social/queue` and `/social/drafts` both designed primarily for phone use. Desktop is a wider-margin version of the same layout. Native iOS/Android app deferred to Session J or later (only justified once daily phone usage exceeds ~5 sessions a day).

**Quarterly engagement-targets review mechanism (new):**
- `social.engagement_targets.last_reviewed_at` column tracks per-target review dates
- `social.vw_targets_due_review` view surfaces any target with `last_reviewed_at < now() - 90 days`
- `social-targets-quarterly-flag` Edge Function runs every Monday 06:30 UTC; if view is non-empty, flags in Thea's Monday weekly-notes.md
- `/social/targets` page shows a "Due review" badge if the view returns rows
- Backstop: a recurring ClickUp task fires every 90 days as an additional surface (in case the dashboard isn't checked)
- Review action: Charlotte and Thea walk the list, retire stale targets (no posts in 6 weeks, ICP fit drift), promote demoted ones, add new ones surfaced from inbound engagers. Each touched row's `last_reviewed_at` updates.

**Dependencies:**
- LinkedIn `Share on LinkedIn` product (Default Tier, auto-approved) — sufficient for personal-profile publishing via `w_member_social`. Granted on App 1 2026-04-24.
- LinkedIn Marketing Developer Platform approval (applied for once the `/social/settings` page is live and a reviewer can authenticate against it). Gates company-page publishing via `r_organization_social` + `w_organization_social` scopes.
- SwitchLeads company LinkedIn page created with logo + at least 1 post (needed for Marketing Developer Platform approval credibility) — confirmed reviewer-ready 2026-04-25
- Clara: verify both brand privacy policies cover LinkedIn / Meta API data processing as data processors; update Notion + propagate to sites
- Charlotte one-time per-channel setup: complete OAuth dance via `/social/settings` for each (brand, channel) combination. ~30 sec per channel.
- Charlotte one-time setup: Gmail filter rule forwarding notification emails (LinkedIn `notifications-noreply@linkedin.com`, equivalent for Meta when added) to `social-engagement-ingest` webhook endpoint.
- Charlotte per-target setup: click notification bell on each engagement target's profile (one-time per target, ~30 seconds each, surfaced as a checklist in `/social/targets` when adding new targets)
- VAPID keys for Web Push generated and stored in Supabase env at Session G build (one-time)
- Supabase Vault enabled for encrypted token storage (`social.oauth_tokens.access_token` + `refresh_token` columns)
- Meta Graph API integration (Facebook + Instagram): same OAuth + Edge Function pattern. Wired into the schema from day one (channel enum already includes `meta_*`); content + targets activation deferred until Switchable starts running Meta channels.

**Done when (multi-brand, fully fledged):**
- `social.*` schema deployed with brand-aware tables, indexes, views, RLS, and Vault-encrypted token columns
- `/social/settings` lets Charlotte authenticate every (brand, channel) surface via the proper OAuth flow, with no localhost ever in the loop
- `/social/drafts` lets Charlotte approve/edit/reject drafts inline, brand-filtered; reject requires a category, edit history captured automatically
- `social-publish` Edge Function reads approved drafts on a 15-min cron and publishes via the right provider API for the (brand, channel) using the corresponding stored token
- A LinkedIn Personal post inserted as `status='approved'` with a near-future `scheduled_for` publishes autonomously to Charlotte's profile within 15 minutes, no manual step
- A LinkedIn Company post does the same once Marketing Developer Platform approval lands and the company-page OAuth dance is complete
- `social-token-refresh` keeps tokens healthy daily; `/social/settings` channel-health badges surface any expiring/expired tokens to Charlotte before they break publishing
- Post-publish analytics flow back into `social.post_analytics` daily, fed by `social-analytics-sync`
- Thea's Monday weekly-notes.md is auto-populated from `social.vw_post_performance` (brand-filtered to switchleads)
- `/social/queue` works on Charlotte's phone: push notification → tap → see drafted comment → "Comment now" → opens post in app + clipboard has comment ready
- `/social/targets` lets Charlotte add/edit/retire targets per brand; quarterly review surfaces in the badge AND a recurring ClickUp task
- Reject reasons feed back into the next `social-draft-generate` cron cycle via `vw_rejection_patterns`
- Brand filter active across all `/social/*` pages with URL-shareable filtered views

**Build sequence (no patchwork — fully-fledged Session G):**
1. Schema migration deploy (all `social.*` tables + indexes + views + RLS + Vault setup)
2. OAuth callback Next.js routes deploy (`/api/auth/linkedin/connect` + `/api/auth/linkedin/callback`)
3. `/social/settings` page ships (Connect LinkedIn button + channel health UI)
4. Charlotte runs OAuth dance for `(switchleads, linkedin_personal)` via `/social/settings`. Token lands encrypted in `social.oauth_tokens`.
5. `social-publish` Edge Function deploys + scheduled via pg_cron (every 15 min)
6. `social-token-refresh` deploys + scheduled (daily)
7. `/social/drafts` page ships (basic version: list pending, inline approve/edit/reject with category)
8. First 12 posts (from `switchleads/social/docs/drafts-2026-04-27.md`) inserted into `social.drafts` as approved with their `scheduled_for` timestamps. They publish autonomously over the following 4 weeks.
9. Remaining UI pages (`/social` overview, `/social/published`, `/social/analytics`, `/social/engagement-log`, `/social/targets`, `/social/queue`) ship in subsequent passes — not strictly required for the first batch to publish autonomously, but each surfaces additional Session G capability and ships in priority order driven by Charlotte's actual usage.
10. Marketing Developer Platform approval applied for once `/social/settings` is live and reviewer can verify it.
11. Once approval lands: company-page OAuth dance via `/social/settings`, company-page posts unlock.
12. Meta Graph API path activates whenever Switchable starts running Meta channels (same architecture, different provider).

This is the proper Session G build — no interim cron orchestration, no hardcoded post content in cron prompts, no localhost OAuth. Components survive into every subsequent session.

**Implementation specifics platform needs to know:**

- **LinkedIn API endpoints + scopes:**
  - Personal-profile posting: `POST /rest/posts` (or legacy `POST /v2/ugcPosts`) with `Authorization: Bearer {access_token}`, `LinkedIn-Version: 202401` header, `X-Restli-Protocol-Version: 2.0.0` header. Scope required: `w_member_social`. Returns post URN as the response header `x-restli-id`.
  - Personal-profile analytics: `GET /rest/posts/{urn}` for post metadata; engagement stats via `GET /rest/socialActions/{urn}` and `GET /v2/socialMetadata/{urn}`. Scope: `r_member_social`.
  - Company-page posting: same `POST /rest/posts` endpoint with the company URN as author. Scope: `w_organization_social`.
  - Company-page analytics: `GET /rest/organizationalEntityShareStatistics`. Scope: `r_organization_social`.
  - Author URN for personal: fetched from `GET /v2/userinfo` on first OAuth dance, persist to `social.oauth_tokens.external_account_id` as `urn:li:person:{id}`.
  - Author URN for company: fetched from `GET /v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR` to enumerate pages the user admins; admin selects which to connect; persist as `urn:li:organization:{id}`.

- **LinkedIn token refresh nuance:** LinkedIn does NOT issue refresh tokens for personal-profile OAuth (`r_liteprofile` / `w_member_social`). Access tokens last ~60 days then require full re-authentication. For company-page tokens via Marketing Developer Platform, refresh tokens ARE issued. `social-token-refresh` Edge Function handles the company-page refresh flow; for personal-profile, it surfaces an "Expiring soon" badge in `/social/settings` 14 days before expiry so the admin can manually reconnect.

- **Meta Graph API endpoints + scopes** (when activated):
  - Facebook page posting: `POST /{page-id}/feed` with `access_token` query param. Scope: `pages_manage_posts` + `pages_read_engagement`. Page access tokens are long-lived once exchanged from a short-lived user token.
  - Instagram business posting: two-step flow — `POST /{ig-user-id}/media` to create a container, then `POST /{ig-user-id}/media_publish`. Scope: `instagram_content_publish` + `instagram_basic` + `pages_read_engagement`.
  - TikTok posting: TikTok Content Posting API — separate Developer App approval required, similar OAuth flow.

- **Vault setup for token encryption:** enable `pgsodium` extension on Supabase. Wrap `social.oauth_tokens.access_token` and `refresh_token` columns in `vault.create_secret()` / `vault.decrypted_secrets` view pattern. Edge Functions read decrypted via the view; admins never see raw tokens in dashboard UI.

- **Audit log integration:** every write to `social.drafts` (insert, status update, edit) writes a row to `audit.actions` (table from Session A) via the `audit.log_action()` helper from Session D. Includes who, when, what changed (before/after JSONB). OAuth token writes also audited.

- **Environment variables required:**
  - Netlify (admin dashboard): `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI=https://admin.switchleads.co.uk/api/auth/linkedin/callback`, `OAUTH_STATE_SECRET` (for CSRF cookie signing). Same pattern for `META_*` when added.
  - Supabase Edge Functions: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `ANTHROPIC_API_KEY` (for Claude API calls in `social-draft-generate` + `social-engagement-ingest`), `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_CONTACT_EMAIL`. Same pattern for `META_*`.
  - VAPID keys generated once via `web-push generate-vapid-keys`, stored permanently.

- **Error handling and retry:**
  - `social-publish` failures (4xx): set `status='failed'` + `publish_error`; do NOT retry automatically. Surface in `/social/drafts` for admin to fix.
  - `social-publish` failures (5xx, network): exponential backoff retry up to 3 times within the same cron tick before marking failed.
  - Token expired (401): set `social.oauth_tokens.expires_at = now()` so `vw_channel_status` flips to `expired`; surface immediately in `/social/settings` health badge; do NOT retry the publish (admin must reconnect).
  - Rate limited (429): respect `Retry-After` header, defer the publish to the next cron tick.

- **Push notification implementation:**
  - Library: `web-push` (npm) on the Edge Function side; native Service Worker + `pushManager.subscribe()` on the browser side.
  - Subscription storage: new table `social.push_subscriptions (id, user_id, endpoint, keys_p256dh, keys_auth, created_at)`. Cascade-delete on user removal.
  - Trigger pattern: any Edge Function that needs to push (currently `social-engagement-ingest`) reads matching push_subscriptions, calls `webpush.sendNotification()` per subscription.

**Future-extensibility — what the schema and architecture will support without rebuild:**

- **New social platform (TikTok, YouTube Shorts, X/Twitter, Threads, Bluesky, Mastodon):** add a value to the `channel` enum (e.g. `tiktok`, `twitter`, `youtube_shorts`); add a value to `social.oauth_tokens.provider` (e.g. `tiktok`, `twitter`); build a new `/api/auth/{provider}/{connect,callback}` route pair on admin.switchleads.co.uk; extend `social-publish` Edge Function with a provider-switch case for the new platform's posting API. No schema migration beyond enum extension. No UI changes beyond a new card in `/social/settings`.

- **Switchable brand activation:** create `switchable/social/CLAUDE.md` with brand-specific content pillars and voice (separate from `switchleads/social/CLAUDE.md`). Insert new `social.engagement_targets` rows tagged `brand='switchable'`. Insert new `social.drafts` rows tagged `brand='switchable'`. Create OAuth tokens for `(switchable, linkedin_company)`, `(switchable, meta_facebook)`, etc. via `/social/settings`. The `/social` UI's brand filter handles the rest. No platform code changes required.

- **Multi-account on one channel** (e.g. Charlotte's personal LinkedIn + a co-founder's personal LinkedIn both posting for SwitchLeads): extend the unique key on `social.oauth_tokens` from `(brand, channel)` to `(brand, channel, account_label)` where `account_label` defaults to `'primary'`. Add `account_label` column to `social.drafts`. UI gains an account picker per draft. Backwards compatible — existing rows get `account_label='primary'`.

- **Multi-user admin team:** RLS pattern already supports per-user policies. Switch from "admin role bypasses everything" to "admin role + own_drafts". Add `created_by` column to `social.drafts` (already there as `approved_by`, repurpose or add a separate field). Existing schema unchanged structurally.

- **Cross-posting one content piece to multiple channels:** extend the data model from "one draft = one post" to "one draft = N publishes" by adding a join table `social.draft_publishes (draft_id, brand, channel, scheduled_for, status, external_post_id, published_at)`. Migration is additive but `social.drafts.{channel, status, scheduled_for, external_post_id, published_at}` columns become deprecated in favour of the join-table view. Sketch only — don't implement until a real cross-posting use case emerges.

- **Richer analytics (video views, save count, repost count, link clicks per post):** `social.post_analytics` is wide-table; add columns additively as new metrics are needed (`video_views INT`, `saves INT`, `reposts INT`, etc.). For truly variable-shape metrics across many platforms, consider migrating to a long-table pattern `social.post_metrics (post_id, metric_name, metric_value, captured_at)` — only worth doing once the wide table has 15+ metric columns. Defer until then.

- **Native iOS / Android app:** the PWA push + responsive UI in Session G is the bridge. When daily mobile usage exceeds ~5 sessions/day OR Charlotte explicitly asks, build a native shell using Capacitor or Tauri wrapping the same Next.js routes. Schema and APIs unchanged; new layer on top. Session J or later.

- **Cross-brand reporting (Switchable vs SwitchLeads social performance compared):** Session I (Reporting module) will include a brand-comparison view across `social.vw_post_performance`. No new schema needed; reporting layer reads existing tables filtered + grouped by brand.

- **Provider-facing social** (Phase 4): when SwitchLeads expands to give providers their own portal at app.switchleads.co.uk, providers get a tightly-scoped read-only view of social analytics relevant to their brand presence. RLS already structured for the `provider_id = auth.uid()` pattern from MVP.

The architecture deliberately leaves expansion seams in obvious places and avoids painting into corners. Build session can confidently ship the spec as-is knowing each future addition is a small, well-isolated change.

---

### Session I — Reporting / analytics module (post-MVP, scope TBD)

Cross-brand reporting layer in the admin dashboard, replacing Metabase as the primary analytics surface. Covers both Switchable (B2C learner acquisition) and SwitchLeads (B2B provider acquisition) in one place. Triggered when the in-dashboard analytics growth trigger fires (`platform/CLAUDE.md` — Metabase dashboard count > 5 OR Charlotte requesting in-dashboard charts) or when reporting scope outgrows what Metabase can comfortably serve.

**Surfaces in scope (both brands unless noted):**
- Ad performance — Meta, TikTok, Google Ads. Spend, impressions, CPL, CTR, conversion rate, by campaign and audience. Reads from `ads_switchable.*` and `ads_switchleads.*` (latter not yet built).
- KPIs — the live KPI scorecard from Mira's weekly review, populated from real data. Provider conversations, leads in pipeline, CPL, enrolments, revenue, costs, net profit. Trend lines.
- Cost per enrolment — closed-loop attribution (ad spend → lead → routing → enrolment → billed amount). The reason the unified data layer exists. Per provider, per course, per campaign, per funding route.
- Provider value — lifetime enrolments, revenue contributed, dispute rate, time-to-first-enrolment, conversion rate from leads to enrolments. Powers retention decisions and post-pilot pricing tiering.
- Financial reporting — monthly/quarterly P&L. Revenue (from `crm.billing_events`) minus costs (manually entered or pulled from accounting tool). Margin by stream, runway, gap to £10k/month profit target.
- Organic traffic — both sites. Switchable.careers (learner site) and switchleads.co.uk (provider site). Sessions, conversions, top pages. Pulled from Plausible (or successor) — pull pattern TBD.
- Social performance — extends Session G's `social.*` schema cross-channel. Cross-brand because both brands run organic social independently.
- Email performance — Brevo metrics for both brands. Open rate, click rate, conversion rate, unsubscribes, by sequence and campaign. Pull from Brevo API.
- Funnel analysis — `leads.partials` and `leads.submissions` joined: drop-off by step, by form, by funding route, by source. Switchable funded funnel + Switchable self-funded funnel + SwitchLeads provider funnel.

**Architectural notes for the build session:**
- Likely needs a `reporting` schema with materialised views or pre-aggregated tables to keep dashboard responsive at scale. Avoid querying raw `leads.partials` for live charts.
- Brand filter is a first-class navigation concept, not an afterthought. Every chart that can be brand-filtered should be.
- Reads only — same RLS pattern as Sessions B + D. No service role.
- Charts library: Recharts or Tremor (already on the trigger note in `platform/CLAUDE.md`).
- Some surfaces depend on ingestion that does not exist yet — Meta API into `ads_switchable.meta_daily` (blocker noted in `switchable/ads/` Session 18 handoff), Brevo email metrics, Plausible site metrics, accounting cost data. Each ingestion is a sub-build inside this session or a prerequisite Edge Function.

**Out of scope for this session:** provider-facing reporting (Phase 4 portal); learner-facing reporting (subscription product); recruiter-facing reporting (Phase 3+).

**Full scoping happens when the trigger fires.** This placeholder exists so the surface is named in the build queue and the doc reflects the reality that reporting is its own session, not a footnote inside Sessions B-D.

---

## Dependencies

### Clara (accounts-legal) — non-blocking for build, blocking for Session F
Open ticket created at handoff. Clara provides:
- Retention period for qualified leads
- Retention period for DQ'd leads on the waitlist
- Retention period for partial captures
- Retention differences by funding type (FCFJ vs self-funded)
- Erasure response timeline + identity verification process
- Exception cases (mid-flight billing, vital interests, legal obligation)
- Verification of full PII map (sanity check of system list above)

### Owner-only steps
- Netlify signup + payment method + DNS records (~30 min, Session A)
- Supabase MFA enrolment + email allowlist setup (~30 min, Session A)
- Brevo API key with delete permission (~10 min, Session F)
- Reviewing each feature before merge (~10 min/session)

### External waits
- DNS propagation: ~24h once after Session A
- Clara's retention guidance: parallel to Sessions A-E, must arrive before Session F ships
- Pre-Phase-4 pen-test: months out, separate Backlog ticket [869d0hwxz](https://app.clickup.com/t/869d0hwxz)

---

## Definition of done — MVP

- All 7 features live on `admin.switchleads.co.uk`
- MFA enforced, email allowlist active
- Audit log writing on every dashboard write
- Health bar live, full audit button works
- GDPR erase pipeline tested end-to-end against staging, deployed to production
- Retention cron live (or queued behind Clara's response)
- Charlotte can run a full operational week without opening Supabase
- Provider portal routes (Phase 4) easily addable to the same codebase later
- Schema future-proofed for auto-routing (Phase 2), pluggable billing (Phase 4), in-dashboard analytics (Phase 2-3), marketplace (Phase 4-5)

---

## Changelog for this doc

- 2026-04-25 (evening) — Session G spec expanded to **multi-brand + proper OAuth architecture**, in preparation for a same-day partial early build of the publishing infrastructure. (1) Brand becomes a first-class column on `social.drafts`, `social.engagement_targets`, `social.engagement_log`, `social.oauth_tokens`. (2) `social.oauth_tokens` unique key changed from `(channel)` to `(brand, channel)` — each brand's company page gets its own OAuth row; Charlotte's personal LinkedIn account is one row tagged with the dominant brand. (3) Channel enum expanded to `linkedin_personal | linkedin_company | meta_facebook | meta_instagram | tiktok` with brand context determining account identity. (4) New `/social/settings` admin page for channel connection management with health badges sourced from new `social.vw_channel_status` view. (5) New OAuth callback Next.js routes (`/api/auth/{provider}/connect` + `/api/auth/{provider}/callback`) on `admin.switchleads.co.uk` — proper redirect URLs only, no localhost ever. (6) New Edge Functions: `social-token-refresh` (daily token rotation). (7) `social-publish` rewritten as multi-provider (LinkedIn UGC Posts API + Meta Graph API) keyed on `(brand, channel)` token lookup. (8) New view `social.vw_channel_status` for dashboard health surfacing. (9) Build sequence locked as 12 steps with the explicit constraint that no interim patchwork (no localhost OAuth, no hardcoded cron prompts, no manual scheduling) exists at any point. Estimate up from ~3-4h (single-brand, original) to ~5-6h (multi-brand, proper). Decision driver: owner instruction "no interim patchworks now — fully fledged version" given mid-session 2026-04-25 evening when about to build the SwitchLeads-only publishing stack as an interim. Switchable social management lives at `admin.switchleads.co.uk/social?brand=switchable` once Switchable starts running organic social — same platform, no `admin.switchable` rebuild ever.
- 2026-04-25 (later) — Session D scope expanded again: overview tiles rebuilt for lifecycle visibility (Unrouted / Routed active / Waitlist / Presumed enrolled / Confirmed enrolled / Lost / Disputed / Errors / Active providers + period selector). Owner feedback: "125 total leads is useless — needs to show me what state the business is in." Estimate up from 2-2.5h to ~3h.
- 2026-04-25 — Session D scope expanded: Actions tab (unrouted + past-deadline + presumed-enrolled), `enrolment-auto-flip` daily cron (replaces sheet formula providers rely on), Overview "Unrouted" tile bug fix (was sweeping in DQ leads), `funding_category` schema split (gov/self/loan top-level + `funding_route` becomes specific-scheme; payload schema bump 1.0 → 1.1), favicon. Estimate up from 1.5-2h to 2-2.5h.
- 2026-04-25 — Added Session I (Reporting / analytics module, post-MVP, both brands) as a placeholder. Covers ad performance, KPIs, cost per enrolment, provider value, financial reporting, organic traffic, social, email, funnel analysis across Switchable and SwitchLeads. Full scoping deferred until in-dashboard analytics growth trigger fires. Session H reserved for Meta + Instagram extension to Session G social module.
- 2026-04-25 — Session G spec expanded with five refinements after a working session walking through the autonomous-stage UX end-to-end with the owner. Additions: (1) `rejection_reason_category` enum on `social.drafts` with CHECK constraint requiring it on rejection; Thea reads `vw_rejection_patterns` before next draft cycle to learn from corrections. (2) `social.engagement_targets` table for the curated 15-20 LinkedIn accounts to engage with; `last_reviewed_at` column drives quarterly refresh; `vw_targets_due_review` view surfaces overdue targets. (3) `social.engagement_queue` table populated by the new `social-engagement-ingest` Edge Function, which receives forwarded LinkedIn notification emails (Gmail filter forwards to webhook), parses sender + post URL, drafts contextual comment via Claude API, push-notifies Charlotte's phone. (4) `/social/queue` mobile-first page with one-tap "Comment now" button (clipboard write + universal-link deep-link to LinkedIn post). (5) Quarterly review mechanism: Edge Function flags due-for-review targets every Monday + `/social/targets` badge + recurring ClickUp task as backstop. New Edge Functions: `social-engagement-ingest`, `social-targets-quarterly-flag`, `social-engagement-queue-expire`. New owner one-time setup steps: Gmail filter rule + per-target bell click + VAPID keys generation. PWA push notification stack chosen over native iOS/Android app (deferred to Session J or later).
- 2026-04-24 — Added Session G (Organic social module, post-MVP) with full `social` schema spec, admin UI pages, Edge Functions, and LinkedIn Marketing Developer Platform dependency. Scoped during SwitchLeads social strategy session (Thea agent). Depends on A-F completion; sits after Session F in the build order. See `switchleads/social/CLAUDE.md` and `switchleads/social/docs/linkedin-developer-app-submission.md`.
- 2026-04-22 — Document created. Decisions 1, 2, 3 locked. Sessions A-F sequenced.
