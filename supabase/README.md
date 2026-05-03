# Supabase — How It Works Here

Operational notes for working with the Switchable Ltd Supabase project. Read alongside `.claude/rules/data-infrastructure.md` before making any DB change.

---

## Status

Live from 2026-04-18.
- Migration 0001 applied: 4 schemas + 9 tables + 2 views + 3 scoped roles + RLS on every table.
- Two pilot providers seeded into `crm.providers` via `data-ops/001_pilot_providers_init.sql`: `enterprise-made-simple`, `courses-direct`.
- Two Edge Functions deployed and ready:
  - `netlify-lead-router` — persists Netlify form webhooks into `leads.submissions`. Deployed; smoke-tested with submission_id=3 on 2026-04-18. Reads `SUPABASE_DB_URL` + `SET LOCAL ROLE functions_writer`. Needs Netlify outgoing webhooks wired to its URL for the three writing form names (owner action).
  - `netlify-forms-audit` — daily audit that verifies every allowlisted form name on switchable.org.uk has its expected Netlify outgoing webhook wired, writes discrepancies to `leads.dead_letter`. Deployed; needs secrets (`NETLIFY_API_TOKEN`, `NETLIFY_SITE_ID`, `AUDIT_SHARED_SECRET`) set + Supabase Cron daily schedule.
- Allowlist single source of truth at `https://switchable.org.uk/data/form-allowlist.json` (maintained by the switchable/site project). Build-time check in `switchable/site/deploy/scripts/audit-site.js` blocks drift at creation; the daily audit function catches drift after deploy.

## Project details

| Field | Value |
|---|---|
| Project name | `charlotte@switchleads.co.uk's Project` (Supabase default — rename to "Switchable Ltd" in the dashboard when convenient) |
| Project URL | `https://igvlngouxcirqhlsrhga.supabase.co` |
| Region | `eu-west-1` (West EU / Ireland) |
| Postgres version | 15+ (Supabase default as of 2026-04-18) |
| Pricing tier | Free |
| Data API | Enabled (used by the Next.js admin app via `supabase-js`). See "Exposed Schemas" note below. |
| Automatic RLS on public schema | Enabled (belt-and-braces; migration 0001 enables explicitly on every table too) |

### Exposed Schemas (Data API setting)

The Supabase Data API only sees schemas added to **Project Settings → Data API → Exposed schemas**. By default only `public` is exposed. Every non-public schema we want `supabase-js` to query (`leads`, `crm`, `ads_switchable`, etc.) must be added explicitly. After any migration that creates a new top-level schema:

1. Open Supabase dashboard → Project Settings → Data API
2. Add the new schema name to the "Exposed schemas" comma-separated list
3. Save

Without this, calls like `supabase.schema("leads").from("submissions")` return `Invalid schema: leads` even though the role has SELECT permission. This is a manual UI step (no SQL equivalent), so it sits outside the migration file and gets missed easily — flag it in the changelog entry for any schema-creating migration.

Currently exposed: `public`, `leads`, `crm`, `ads_switchable`. Add `ads_switchleads` when the SwitchLeads B2B ad ingest activates (per `platform/docs/data-architecture.md`).

## Credentials (where they live)

Real values never go into iCloud-synced files. LastPass is the source of truth; local `.env` on each device mirrors what's needed at runtime.

| Credential | LastPass entry | Local `.env` variable |
|---|---|---|
| Postgres superuser password | `Supabase — postgres superuser password` | (embedded in `SUPABASE_DB_URL`) |
| Project URL | `Supabase — project URL` | `SUPABASE_URL` |
| Publishable key | `Supabase — publishable key` | `SUPABASE_PUBLISHABLE_KEY` |
| Secret key | `Supabase — secret key` | `SUPABASE_SECRET_KEY` |
| DB connection URI | `Supabase — DB connection string` | `SUPABASE_DB_URL` |
| `readonly_analytics` password | `Supabase — readonly_analytics password` | `SUPABASE_READONLY_ANALYTICS_PASSWORD` |
| `functions_writer` password (role renamed from `n8n_writer` in migration 0002, 2026-04-18) | `Supabase — functions_writer password` (rename the LastPass entry from `n8n_writer password`) | `SUPABASE_FUNCTIONS_WRITER_PASSWORD` |
| `ads_ingest` password | `Supabase — ads_ingest password` | `SUPABASE_ADS_INGEST_PASSWORD` |

Local `.env` path (per device): `~/Switchable/platform/.env` — must be OUTSIDE the iCloud-synced Switch-Claude folder.

---

## Setup (next-session tasks, once Supabase account exists)

1. Owner creates Supabase project. Name: "Switchable Ltd". Region: `eu-west-1` (West EU / Ireland — closest to UK until Supabase adds a London region). Postgres 15+.
2. Record credentials in per-device local `.env` files:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY` (public, safe to share among local tooling)
   - `SUPABASE_SERVICE_ROLE_KEY` (never in iCloud, never in Git)
   - `SUPABASE_READONLY_ANALYTICS_PASSWORD` (scoped role credential)
   - `SUPABASE_N8N_WRITER_PASSWORD`
   - `SUPABASE_ADS_INGEST_PASSWORD`
3. Copy `.env.example` to local `.env`, fill in values. Never commit `.env`.
4. Install Postgres MCP at user scope for Claude Code (command lives in this README once a vetted MCP is selected — verify install count + source before installing per `.claude/rules/skills.md`).

---

## Per-device credential discipline

Supabase credentials live per-device, not in iCloud sync.

- Each device has its own local `.env` file at a path outside iCloud.
- The `.env.example` in this repo shows the shape but contains no real values.
- When working on a new device, owner copies credentials from password manager, never from a synced file.

---

## Migration workflow

1. Update `platform/docs/data-architecture.md` to reflect the intended change.
2. Create a new migration file in `platform/supabase/migrations/` following the naming convention `NNNN_short_description.sql`.
3. Test locally: `supabase db reset` against a local Docker instance (or Supabase staging project).
4. Review the migration — owner sign-off required for non-trivial changes.
5. Apply to production: `supabase db push` OR run via Supabase SQL editor with the service role key.
6. Log in `platform/docs/changelog.md`.
7. Verify all downstream consumers (n8n workflows, Metabase dashboards, agent queries) still work.

**Never edit production schema via the Supabase UI.** Always a migration file.

---

## Roles

| Role | Purpose | Used by |
|---|---|---|
| `readonly_analytics` | Read all tables, read all views, no writes | Metabase, Postgres MCP for agents |
| `n8n_writer` | Write to `leads.*`, update `crm.enrolments` status, read all | n8n scenarios |
| `ads_ingest` | Write to `ads_*` only, no reads outside `ads_*` | Meta/Google/TikTok daily pull scripts |
| `owner` (service role) | Everything | Migrations, incident recovery, owner-initiated fixes |

Passwords rotated annually and on any suspected leak.

---

## Backups

- Supabase auto-backups daily, 7-day retention on free tier (30-day on Pro).
- Manual on-demand backup before any irreversible change (DROP COLUMN, DROP TABLE, mass UPDATE).
- Monthly manual export of `crm.providers` and `leads.submissions` to local storage (belt and braces).
- Quarterly test-restore to a scratch project — owner verifies, logs outcome in `docs/changelog.md`.

---

## Restore

Restore from Supabase backup:
1. Supabase dashboard → Database → Backups
2. Select backup point, trigger restore to a new project OR replace current (dangerous, owner decision).
3. Verify row counts against expected.

Restore is a last resort. Fix forward wherever possible.

---

## Agent access

Agents access via Postgres MCP using `readonly_analytics` role credentials.

- Agents can read all tables and views.
- Agents cannot write. State changes go through n8n workflows triggered by owner-approved agent recommendations.
- New views requested by agents: Mira designs, migration ships, agent queries.

---

## Local development

Docker-based local Supabase for testing migrations:

```bash
supabase init              # one-time setup per device
supabase start             # starts local Supabase on Docker
supabase db reset          # applies all migrations from scratch
supabase db diff           # compares local vs remote schema
supabase db push           # pushes local migrations to remote
```

Never `supabase db push` without first running `supabase db diff` and reviewing the output.

---

## Emergency playbook

If a migration breaks production:
1. Do NOT immediately run another migration to fix — assess the damage first.
2. If data is at risk: take a manual backup immediately.
3. If application-breaking: consider `supabase db reset` to the last known-good backup.
4. Log everything in `docs/changelog.md` under an INCIDENT entry.
5. Owner does the postmortem, not Claude.

---

## MCP install command

Installed at user scope with the `readonly_analytics` role (not service role). One-time per device. Substitute `<PASSWORD>` with the URL-encoded value of the LastPass entry `Supabase — readonly_analytics password`:

```
claude mcp add postgres --scope user \
  -- npx -y @modelcontextprotocol/server-postgres \
  "postgresql://readonly_analytics.igvlngouxcirqhlsrhga:<PASSWORD>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"
```

After install, restart Claude Code to pick up the MCP. The server exposes the Postgres schema to agents as read-only SQL (every query is wrapped in a read-only transaction, so writes are blocked even if a role had permission).

**Connection string notes — read before changing this:**
- The `@modelcontextprotocol/server-postgres` package takes the DB URL as a **positional CLI argument**, not an environment variable. An earlier version of this doc used `--env POSTGRES_URL=` which silently registers but then fails at query time with "Please provide a database URL as a command-line argument."
- The direct hostname `db.<project_ref>.supabase.co` is **IPv6-only** on new Supabase projects. Most developer machines (including Charlotte's Macs) have no public IPv6 route, so direct connections fail with `getaddrinfo ENOTFOUND`. Use the Session Pooler (port 5432) for long-lived clients like the MCP, and the Transaction Pooler (port 6543) for ephemeral/short queries like n8n nodes.
- The pooler username format is `<role>.<project_ref>`. The `.<project_ref>` suffix is Supavisor's tenant routing — it is not a Postgres username prefix. The password remains the role's password.
- Pooler region is `eu-west-1` (matches the project region). Using `eu-west-2` returns `XX000 Tenant or user not found` even if everything else is correct.

## Per-device setup checklist

When working on a new device (iMac, replacement laptop, etc.):

1. `mkdir -p ~/Switchable/platform`
2. `cp "<path-to-switch-claude>/platform/supabase/.env.example" ~/Switchable/platform/.env`
3. Open `.env` and fill each value from LastPass folder `Supabase — Switchable Ltd`
4. Run the MCP install command above, substituting the password
5. Restart Claude Code
6. Verify: `SELECT * FROM leads.submissions LIMIT 1` returns zero rows, no error

Bigger-picture plan: the Business-wide secrets and portability strategy ticket will retire this manual process and move credentials into a hosted secrets manager, so new-device setup drops from ~15 min to ~3 min.