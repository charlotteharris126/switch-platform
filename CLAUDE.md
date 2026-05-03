# Platform, Business Data Layer and Custom Systems

## Purpose

The shared data infrastructure of Switchable Ltd. The database (Supabase), schemas, migrations, data governance, Supabase Edge Function source (the serverless layer that handles webhooks and scheduled jobs), and eventually the custom dashboard and provider-facing systems that sit on top of it.

Open this folder for: schema design and migrations, Edge Function work, data governance, dashboard build (Phase 2-3), provider-facing systems (Phase 4), anything that reads from or writes to the unified data layer.

Do not open this folder for: brand-specific public websites (`switchable/site/` or `switchleads/site/`), brand-specific ads (`switchable/ads/` or `switchleads/ads/`), CRM outreach logic (`switchleads/outreach/` or `switchleads/clients/`), email tooling (`switchable/email/`, `switchleads/email/`), course YAML data (`switchable/site/deploy/data/courses/`).

What Charlotte previously called "the CRM" lives inside this folder as one schema of the wider data layer (`crm` schema, providers, enrolments, disputes, billing). The data layer is broader than CRM: it holds ads performance, leads, routing logic, and eventually learners and recruitment streams.

## Folder structure

- `agent.md`, Sasha's persona, schedule, inputs, outputs (loaded when Sasha runs)
- `docs/current-handoff.md`, session state (read by `/prime-project`)
- `docs/changelog.md`, decisions, schema changes, incident notes
- `docs/data-architecture.md`, schema design, source of truth
- `docs/strategic-review.md`, Mira's review that kicked this off
- `docs/impact-assessment-YYYY-MM-DD.md`, per-significant-change impact records
- `docs/secrets-rotation.md`, rotation log Sasha cross-checks Monday
- `docs/infrastructure-manifest.md`, critical-row verification list Sasha runs at session start
- `docs/admin-dashboard-scoping.md`, scoping doc for in-dashboard analytics and Phase 4 provider build
- `docs/provider-onboarding-playbook.md`, repeatable provider setup steps
- `weekly-notes.md`, Sasha's Monday output (replaced each week)
- `supabase/README.md`, how to connect, run migrations, manage keys
- `supabase/schemas/`, one .sql file per namespace for reference
- `supabase/migrations/`, versioned migration files (NNNN_*.sql)
- `supabase/functions/`, Supabase Edge Functions (TypeScript/Deno), lead routing, ingestion
- `supabase/data-ops/`, reusable data scripts (seeds, backfills), not schema migrations
- `supabase/config.toml`, Supabase CLI config
- `dashboard.html`, existing ops prototype, reference only
- `metabase/`, only appears if we ever self-host (Metabase cloud uses no local config)

## Conventions

### Stack

- **Database:** Supabase (managed Postgres). Free tier during pilot, ~£20/month after volume growth.
- **Dashboards (interim):** Metabase cloud (~£15/month). Absorbed into the custom dashboard over Phase 2-3.
- **Serverless functions:** Supabase Edge Functions (Deno/TypeScript, deployed via `supabase functions deploy`, live in `supabase/functions/`). Used for Netlify form webhook handling, scheduled ingestion, and any other automation that needs to read or write the DB. Chosen over n8n to keep the stack in one tool, avoid a ~£240/year subscription, and keep workflow code version-controlled alongside migrations.
- **MCP for agents:** Postgres MCP (user scope). Gives Iris, Mira, Sasha, and other agents read access via the `readonly_analytics` Postgres role.
- **Custom dashboard (Phase 2-3):** built on a SwitchLeads subdomain (e.g. `app.switchleads.co.uk`). Reads the same Supabase. Gradually absorbs Metabase's role until Metabase can be retired.

### Governance

All work in this folder is bound by:

- `.claude/rules/data-infrastructure.md`, the hard rule covering schema changes, migrations, secrets, backups, access control, environment separation, changelog discipline, dead letter handling, and agent data access. Read this before making any DB change.
- `.claude/rules/schema-versioning.md`, data contract versioning, with a Postgres addendum for schema changes.
- Top-level `CLAUDE.md` infrastructure rule, extended to include DB layer changes and secrets.

### Core discipline

- Never edit production schema directly via the Supabase UI. Migration files only.
- Every schema change logged in `docs/changelog.md` with a dated entry.
- Secrets never checked into iCloud-synced files in plaintext.
- Every new consumer of the DB gets its own scoped Postgres role (`readonly_analytics` / `n8n_writer` / `ads_ingest` / owner).
- `docs/data-architecture.md` is the design source of truth. Migrations implement what the doc says, not the other way round.

### Before a substantial deploy, run `/ultrareview`

For any non-trivial migration, Edge Function change, or governance doc update, run `/ultrareview` before shipping. It runs a cloud-based multi-agent review across the diff and often catches issues a single pass misses (non-reversible migrations without `-- DOWN`, secret leaks in Edge Function code, drift between design doc and migration, missing RLS policies on new tables). Mandatory for anything touching production schema or RLS. Optional for doc-only changes.

### Key reference files

- Schema design: `platform/docs/data-architecture.md`
- Strategic review (Mira's decision record): `platform/docs/strategic-review.md`
- Data governance rule: `.claude/rules/data-infrastructure.md`
- Schema versioning rule: `.claude/rules/schema-versioning.md`
- Funded funnel architecture (upstream producer of `leads.submissions`): `switchable/site/docs/funded-funnel-architecture.md`
- Lead payload schema v1.0: inside the funded funnel architecture doc
- Business model and audiences: `.claude/rules/business.md`
- Ops dashboard prototype: `platform/dashboard.html`

## Cross-project routing

| Task completed here | What to do next |
|---|---|
| New form field added to a public site | Go to `switchable/site/` or `switchleads/site/` first, the form produces the lead payload |
| Lead payload schema change | Update `switchable/site/docs/funded-funnel-architecture.md` first (schema v1.0 lives there), then mirror the DB column in `platform/docs/data-architecture.md` and ship a migration |
| Ad performance analysis | `switchable/ads/` (Iris), she queries Supabase via MCP |
| Provider data update | Here (`crm.providers`) OR `switchleads/outreach/` for Rosa's pipeline view |
| Strategy or budget decisions | `strategy/` (Mira), she queries Supabase via MCP for KPI data |
| New schema or new table | Here, update `docs/data-architecture.md`, write migration, log in `docs/changelog.md` |
| New dashboard chart | Build in Metabase, save view to `docs/changelog.md` if important enough to document |
| Custom dashboard feature (Phase 2-3) | Here, first confirm Metabase cannot serve the need, then spec the feature |
| Legal page changed in Notion that affects platform-served surfaces | Flag to the relevant site agent's `docs/current-handoff.md` (Paige or Mable) |
