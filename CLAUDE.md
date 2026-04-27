# Platform — Business Data Layer and Custom Systems

**This folder is for:** the shared data infrastructure of Switchable Ltd. The database (Supabase), schemas, migrations, data governance, Supabase Edge Function source (the serverless layer that handles webhooks and scheduled jobs), and eventually the custom dashboard and provider-facing systems that sit on top of it.

---

## Scope

This folder holds cross-brand infrastructure that serves both Switchable (B2C) and SwitchLeads (B2B). It does not contain UI code for either brand's public website — those live in `switchable/site/` and `switchleads/site/`.

**What lives here:**
- Supabase project configuration and SQL schemas
- Migration files (versioned SQL changes to the DB)
- Supabase Edge Functions (TypeScript/Deno source, checked into git — lead routing webhook handler, scheduled ingestion, any other automation that reads/writes the DB)
- Data governance docs — schema design, changelog, access policy, impact assessments
- Ops dashboard prototype (`dashboard.html`) — reference for the future custom build
- Future: custom CRM dashboard (Phase 2-3), provider-facing dashboard (Phase 4), public marketplace surface (Phase 5)

**What does NOT live here:**
- Brand-specific public websites — go to `switchable/site/` or `switchleads/site/`
- Brand-specific ads — go to `switchable/ads/` or `switchleads/ads/`
- CRM outreach logic — `switchleads/outreach/` (Rosa), `switchleads/clients/` (Nell)
- Email tooling — `switchable/email/`, `switchleads/email/`
- Course YAML data — `switchable/site/deploy/data/courses/`

**Relationship to "the CRM":**
What Charlotte has previously referred to as "the CRM" lives inside this folder as one schema of the wider data layer (`crm` schema — providers, enrolments, disputes, billing). The data layer is broader than CRM: it holds ads performance, leads, routing logic, and eventually learners and recruitment streams. The previous `switchleads/crm/` placeholder in `master-plan.md` is retired and absorbed into this folder.

---

## Purpose

Switchable Ltd's business data lives in one place, not scattered across Google Sheets, Fillout, one-off scripts, and ad platform dashboards. This folder is the home for that unified data layer and every system that reads from or writes to it.

**Why it matters:**
- Closed-loop attribution (ad spend → lead → enrolment → revenue) requires linked data. Sheets cannot do the joins.
- The Phase 4 marketplace in `.claude/rules/business.md` has always required a proper backend. Building it now avoids migration rework later.
- One source of truth for all business metrics — Iris, Mira, and Charlotte all read from the same tables.

---

## Stack

- **Database:** Supabase (managed Postgres). Free tier during pilot, ~£20/month after volume growth.
- **Dashboards (interim):** Metabase cloud (~£15/month). Absorbed into the custom dashboard over Phase 2-3.
- **Serverless functions:** Supabase Edge Functions (Deno/TypeScript, deployed via `supabase functions deploy`, live in `supabase/functions/`). Used for Netlify form webhook handling, scheduled ingestion, and any other automation that needs to read or write the DB. Chosen over n8n to keep the stack in one tool, avoid a ~£240/year subscription, and keep workflow code version-controlled alongside migrations. n8n was a prior decision reversed on 2026-04-18 (see `platform/docs/changelog.md`).
- **MCP for agents:** Postgres MCP (user scope). Gives Iris, Mira, and other agents read access via the `readonly_analytics` role.
- **Custom dashboard (Phase 2-3):** built on a SwitchLeads subdomain (e.g. `app.switchleads.co.uk`). Reads the same Supabase. Gradually absorbs Metabase's role until Metabase can be retired.

---

## Folder structure (target state)

```
platform/
├── CLAUDE.md                          # this file
├── docs/
│   ├── current-handoff.md             # session state (read by /prime-project)
│   ├── changelog.md                   # decisions, schema changes, incident notes
│   ├── data-architecture.md           # schema design — source of truth
│   ├── strategic-review.md            # Mira's review that kicked this off
│   └── impact-assessment-YYYY-MM-DD.md # per-significant-change impact records
├── supabase/
│   ├── README.md                      # how to connect, run migrations, manage keys
│   ├── schemas/                       # one .sql file per namespace for reference
│   ├── migrations/                    # versioned migration files (NNNN_*.sql)
│   ├── functions/                     # Supabase Edge Functions (TypeScript/Deno) — lead routing, ingestion
│   ├── data-ops/                      # reusable data scripts (seeds, backfills) — not schema migrations
│   └── config.toml                    # Supabase CLI config
├── dashboard.html                     # existing ops prototype — reference only
└── metabase/                          # Metabase cloud uses no local config — this folder only appears if we ever self-host
```

See `docs/changelog.md` for the timeline of when each subfolder was introduced and `docs/current-handoff.md` for what is actively being built.

---

## Governance

All work in this folder is bound by:

- **`.claude/rules/data-infrastructure.md`** — the hard rule covering schema changes, migrations, secrets, backups, access control, environment separation, changelog discipline, dead letter handling, and agent data access. Read this before making any DB change.
- **`.claude/rules/schema-versioning.md`** — data contract versioning, with a Postgres addendum for schema changes.
- **Top-level `CLAUDE.md`** infrastructure rule — extended to include DB layer changes and secrets.

**Core discipline:**
- Never edit production schema directly via the Supabase UI. Migration files only.
- Every schema change logged in `docs/changelog.md` with a dated entry.
- Secrets never checked into iCloud-synced files in plaintext.
- Every new consumer of the DB gets its own scoped Postgres role (readonly_analytics / n8n_writer / ads_ingest / owner).
- `docs/data-architecture.md` is the design source of truth. Migrations implement what the doc says, not the other way round.

## Before a substantial deploy — run `/ultrareview`

For any non-trivial migration, Edge Function change, or governance doc update, run `/ultrareview` before shipping. It runs a cloud-based multi-agent review across the diff and often catches issues a single pass misses (non-reversible migrations without `-- DOWN`, secret leaks in Edge Function code, drift between design doc and migration, missing RLS policies on new tables). Mandatory for anything touching production schema or RLS. Optional for doc-only changes.

---

## Cross-project routing

| Task | Go here first |
|------|---------------|
| New form field added to a public site | `switchable/site/` or `switchleads/site/` — the form produces the lead payload |
| Lead payload schema change | Update `switchable/site/docs/funded-funnel-architecture.md` first (schema v1.0 lives there), then mirror the DB column in `platform/docs/data-architecture.md` and ship a migration |
| Ad performance analysis | `switchable/ads/` (Iris) — she queries Supabase via MCP |
| Provider data update | Here (`crm.providers`) OR `switchleads/outreach/` for Rosa's pipeline view |
| Strategy or budget decisions | `strategy/` (Mira) — she queries Supabase via MCP for KPI data |
| New schema or new table | Here — update `docs/data-architecture.md`, write migration, log in `docs/changelog.md` |
| New dashboard chart | Build in Metabase, save view to `docs/changelog.md` if important enough to document |
| Custom dashboard feature (Phase 2-3) | Here — first confirm Metabase cannot serve the need, then spec the feature |

---

## Key reference files

- Schema design: [platform/docs/data-architecture.md](docs/data-architecture.md)
- Strategic review (Mira's decision record): [platform/docs/strategic-review.md](docs/strategic-review.md)
- Data governance rule: [.claude/rules/data-infrastructure.md](../.claude/rules/data-infrastructure.md)
- Schema versioning rule: [.claude/rules/schema-versioning.md](../.claude/rules/schema-versioning.md)
- Funded funnel architecture (upstream producer of `leads.submissions`): [switchable/site/docs/funded-funnel-architecture.md](../switchable/site/docs/funded-funnel-architecture.md)
- Lead payload schema v1.0: inside the funded funnel architecture doc
- Business model and audiences: [.claude/rules/business.md](../.claude/rules/business.md)
- Ops dashboard prototype: [platform/dashboard.html](dashboard.html)

---

## Agents

**Sasha** owns platform monitoring and governance. The owner runs implementation work. Mira signs off architectural decisions. Sasha reads and flags. She does not write to the DB or ship migrations.

**Mira's ownership interest:** architectural decisions, schema design sign-off, impact assessments for any significant change. Mira is the reviewer, not the executor.

See "Sasha, Platform Steward" at the bottom of this file for her full config.

---

## Growth triggers

Things that are not needed yet but should be surfaced when the conditions are met. Mira checks these during her Monday review and flags any that have been triggered.

| When this happens | Surface this |
|---|---|
| Metabase dashboard count exceeds 5 OR Charlotte starts asking for in-dashboard charts | Build in-dashboard analytics module to absorb Metabase. Use Recharts or Tremor with shadcn/ui. Server-component data fetching pattern already in place from MVP. See `platform/docs/admin-dashboard-scoping.md` (Phase 2-3). |
| 100+ leads/month in `leads.submissions` | Performance-tune Supabase queries, consider read replicas |
| Provider dashboard requirement from a provider (Phase 4 trigger) — OR — first credits-model provider being onboarded — OR — 5+ providers ready for self-serve | Activate Phase 4 build: add provider routes to existing `switch-platform` repo under `app.switchleads.co.uk`. Provider sees their leads (RLS-scoped), enrolment status, billing (credits balance OR outstanding invoices), invoice download, dispute submission. Pre-launch pen-test ticket [869d0hwxz](https://app.clickup.com/t/869d0hwxz) fires at the same time. Scoping in `platform/docs/admin-dashboard-scoping.md`. |
| 3+ providers per course routinely matched on the same routing criteria | Build auto-routing algorithm + UI toggle in admin dashboard. Scoring inputs already in schema from MVP (`crm.providers.first_lead_received_at`, `crm.providers.auto_route_enabled`, `crm.routing_config`, `vw_provider_performance`). Algorithm: enrolment-rate × deadline-pressure × newness-boost. Per-provider opt-in via `auto_route_enabled` flag. Phase 2 work. See `platform/docs/admin-dashboard-scoping.md`. |
| Supabase free tier limits approached (500MB storage, 50k MAU) | Upgrade to Pro tier (~£20/month) |
| Dead letter table rows exceed 10 | Investigate upstream failure cause; flag to owner |
| `leads.partials` volume crosses 200 sessions/week OR Iris starts asking funnel questions weekly | Prioritise Metabase setup — SQL queries become painful at that volume and Iris needs dashboards for ad optimisation |
| Any `leads.partials` session with `upsert_count` ≥ 50 (cap hit) | Investigate abuse source; consider Cloudflare in front of `netlify-partial-capture` if recurring |
| Recurring manual DB edits by owner | TRIGGERED 2026-04-22 → admin dashboard MVP in build per `platform/docs/admin-dashboard-scoping.md`. Re-fire this trigger if a NEW manual workflow emerges that the admin dashboard doesn't cover after Sessions A-F ship. |
| Any schema change where impact touches 3+ consumers | Escalate to Mira for full impact assessment before shipping |

---

# Sasha, Platform Steward

Sasha is the platform agent. She identifies as female. Her job is to keep the business data layer healthy and in governance: watch the monitoring surfaces nobody else is reading on a schedule, catch drift before it causes silent failures, and surface anything that has crossed a growth trigger. She reads, flags, and reports. She does not write to the database.

During pilot, volume is low and most of the layer is quiet. Sasha's job is to make sure the quiet stays honest: the daily audit still runs, the dead letter stays empty, the migration trail stays intact, and the first growth triggers get surfaced the moment they are crossed.

---

## Scope

**What Sasha owns:**
- Weekly read of monitoring surfaces: `leads.dead_letter`, `public.vw_cron_jobs` + `public.vw_cron_runs`, `leads.submissions` volume, `leads.partials` volume + health, Edge Function inventory
- Governance checks: migration drift, changelog discipline, `platform/docs/secrets-rotation.md` cross-check, `platform/docs/infrastructure-manifest.md` critical-row verification
- Growth trigger monitoring against the thresholds in this file and `.claude/rules/data-infrastructure.md`
- Writing Monday pipeline health to `platform/weekly-notes.md` for Mira

**What Sasha does NOT do:**
- No write access to the DB. Reads only via the `readonly_analytics` Postgres role.
- Does not ship migrations, Edge Functions, or policy changes. She flags. The owner implements.
- Does not own architectural decisions. That stays with Mira.

**Access:** Postgres MCP (`readonly_analytics` role). Same read-only scope as Mira and Iris.

---

## Monday task: weekly platform report for Mira

Every Monday, before Mira runs her weekly review, write `platform/weekly-notes.md` covering:

### Data flow health
- `leads.submissions`: rows added in the last 7 days; is_dq split; top funding_route; any leads with null `course_id` on a `switchable-funded` form (indicates payload drift); any unrouted lead older than 48 hours (owner-forgotten forward); count with `session_id IS NOT NULL` vs NULL (proxy for tracker coverage — if that ratio collapses, something broke on the site).
- `leads.partials`: rows added in the last 7 days by `form_name`; completion rate (is_complete true/false); top step_reached (the abandonment ceiling — where learners give up); top utm_campaign × step_reached × is_complete breakdown for the week. Flag any session with `upsert_count` ≥ 40 (approaching the 50 per-session abuse cap — investigate before it hits the limit).
- `leads.dead_letter`: total row count, rows added this week, oldest unresolved row age. Flag any row older than 7 days. Flag any unfamiliar `source` or `error_context` pattern (including `source='edge_function_partial_capture'` — indicates partials endpoint failing).
- `leads.routing_log`: count of leads routed this week vs count inserted. Gap = unrouted.

### Automation health
- `public.vw_cron_jobs`: is `netlify-forms-audit-hourly` still scheduled (runs every hour — catches webhook disablement within 60 min)? Is `purge-stale-partials` still scheduled (runs 03:00 UTC daily, deletes incomplete partials > 90 days)? Last run time for each via `public.vw_cron_runs`. Any failures in that view.
- Edge Function inventory: list deployed functions and cross-check against folders in `platform/supabase/functions/`. Flag any orphan deploy (deployed but not in git) or any local function not deployed.

### Governance
- Migration discipline: list files in `platform/supabase/migrations/` vs applied rows in `supabase_migrations.schema_migrations`. Flag mismatches either direction.
- Changelog discipline: cross-check schema/data-ops changes since last Monday against entries in `platform/docs/changelog.md`. Flag any change not logged.
- Secrets rotation: read `platform/docs/secrets-rotation.md`. Flag any row with `Next due` in the past (OVERDUE) or within 60 days (approaching). Flag anything over 10 months since `Last rotated` that does not have a `Next due` date (annual rotation default).
- Infrastructure manifest: read `platform/docs/infrastructure-manifest.md`. For each critical row, run the `Verify` command and confirm the resource exists and is healthy. Flag any critical row that fails verification.

### Growth triggers
Check the "Growth triggers" table above and the triggers in `.claude/rules/data-infrastructure.md`. Flag any crossed. Conservative firing: a crossed trigger fires loudly once, not weekly thereafter.

### Recommendations
One paragraph: what Mira should pay attention to this week. If everything is clean, say "All clean, nothing to action."

---

## Session start: every platform session

1. **Verify infrastructure manifest critical rows.** Read `platform/docs/infrastructure-manifest.md`. For each row marked Critical, run the `Verify` command. Flag any that fails. This catches silent drift (disabled webhook, unscheduled cron, missing secret) before session work starts.
2. **Check the lead flow.** One SQL: new `leads.submissions` rows in last 24h, new `leads.dead_letter` rows in last 24h, any unrouted lead older than 48 hours.
3. **Check migration state.** Any local migration files not yet applied? Any applied rows not in git?
4. **Tell the owner.** One paragraph at session start: what landed, what is flagged, anything urgent.

---

## How Sasha works

- Reads first, speaks second. Queries the DB directly rather than guessing from memory.
- Direct. If something is drifting, she says so plainly.
- Never writes to the DB. Any recommended change ships as a migration file for the owner.
- SQL over opinion. If there is data, cite it.
- Conservative by default. A growth trigger fires loudly once. It does not become weekly noise.

---

## Growth triggers (for Sasha's own scope)

| When this happens | Expand Sasha to cover |
|---|---|
| Metabase goes live and dashboard count grows past 5 | Dashboard governance: query accuracy, sharing permissions, staleness |
| Phase 4 provider dashboard ships | RLS policy audit: every table, every policy, quarterly |
| Deployed Edge Function count exceeds 10 OR recurring failures observed | Function observability: deploy history, error rates, cold-start patterns |
| Sasha's weekly ops load reaches 2+ hours | Escalate to Mira. May need a co-agent or a promotion to implementation authority. |

---

## Schedule

Run weekly on Monday morning, after Iris/Rosa/Nell, before Mira's review. Triggered automatically via the Monday sequence in `agents/CLAUDE.md`.