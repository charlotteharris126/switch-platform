# Infrastructure Impact Assessment — 2026-04-18

**Change:** Create `platform/` as active project; bring business data layer (Supabase + Metabase) forward from Phase 4; add governance rules and update all affected references.

**Assessed against:** Top-level `CLAUDE.md` infrastructure rule (7 questions).

**Scope of change this session:** File-only — rules, docs, folder scaffolding, references. No tooling installed, no accounts created, no credentials handled.

**Scope of change next session(s):** Supabase account, Postgres MCP install, n8n credential changes, Metabase install, first migrations. Those trigger their own impact assessments at the time of install.

---

## 1. Does this affect both devices? What needs doing on each?

**This session:** No device-specific action. All changes are iCloud-synced files (rules, docs, folder structure). Both devices receive the changes automatically via sync.

**Next session (install phase):** Yes, both devices need:
- Postgres MCP installed at user scope (once per device)
- Local `.env` file with Supabase credentials (per-device, not synced)
- n8n access reviewed per device if n8n runs locally (it runs in n8n cloud, so no per-device install needed there)
- Metabase access: if self-hosted, runs on owner's chosen device or a cloud VM; if Metabase cloud, just web access

**Action for next session:** Document the per-device setup step in `platform/supabase/README.md` and flag it explicitly when the first install happens.

## 2. Does this affect iCloud sync? Will it sync correctly or need per-device action?

**This session:** All produced files are in iCloud-synced paths and will sync correctly. No binaries, no SQLite databases, no `.env` files in iCloud paths.

**Next session (install phase):**
- Migration files in `platform/supabase/migrations/` — safe to sync, they are plain SQL text
- n8n workflow JSON exports in `platform/n8n/workflows/` — safe to sync, they are plain JSON
- Local `.env` files — MUST NOT be in iCloud paths. `platform/supabase/README.md` explicitly mandates per-device local storage outside iCloud
- Metabase self-hosted config (if chosen) — runs on one device or cloud, not synced

**Risk:** accidental commit/sync of `.env` with real credentials. Mitigation: `.env.example` in repo, real `.env` goes outside iCloud, documented in `platform/supabase/README.md`.

## 3. Does this affect any other project folder or agent?

Yes, multiple:

| Folder / agent | Impact | Action taken |
|---|---|---|
| `switchable/site/` (funded funnel) | Routing target changes from Sheet to Supabase tables | `funded-funnel-architecture.md` updated |
| `switchleads/crm/` (planned) | Absorbed into `platform/` | `master-plan.md` row replaced |
| `switchable/ads/` (Iris) | Access path changes from "still blocked" to "Postgres MCP on Supabase" | `switchable/ads/CLAUDE.md` updated this session |
| `strategy/` (Mira) | Gains ability to query Supabase for KPI data | No CLAUDE.md change needed this session; documented in `platform/CLAUDE.md` |
| `switchleads/outreach/` (Rosa) | Provider data moves from Sheet to `crm.providers` (dual-write transition) | No immediate change; Rosa will read Supabase once dual-write period ends |
| `switchleads/clients/` (Nell) | Client data now lives in `crm.providers` + `crm.enrolments` | No immediate change; Nell will query via Postgres MCP once standing up |
| Every other agent with read access | Will gain Postgres MCP access over time under `readonly_analytics` role | Per-agent CLAUDE.md updates deferred until MCP is installed and roles are live |

## 4. Does this break any existing reference, permission, or path?

**References checked:**
- `master-plan.md` "Ops dashboard" section updated to reflect platform/ as active
- `master-plan.md` `switchleads/crm` row replaced with `platform/` row
- `business.md` "Lead matching" section updated (Sheet → Supabase)
- `funded-funnel-architecture.md` diagram + routing layer + Phase 4 section updated
- `.claude/rules/schema-versioning.md` updated with Postgres addendum and new schema reference
- Top-level `CLAUDE.md` infrastructure rule extended

**ClickUp ticket `869cvpnjr` (switchleads/crm kickoff):** still exists in ClickUp, now orphaned because the project is absorbed. Action for next Mira session: close this ticket with a note pointing to `platform/`.

**No other broken references identified.**

## 5. Does this change what gets written to Notion or what Notion owns?

Not this session. Nothing changed in Notion yet.

**Next session (install phase):** Notion Tech Stack page needs updating:
- Add: Supabase (role: database), Metabase (role: dashboards), Postgres MCP (role: agent access)
- Note: n8n role expanded (now writes to Supabase, not just Sheet)

Notion Business Overview does not need updating — data architecture is operational, not structural.

**Action for next session:** during the install phase, update Notion Tech Stack page as part of Priority 1 wrap.

## 6. Does this affect the new-business template — should it be updated to match?

**Yes, partially.** The `/new-business` skill sets up the workspace for a new business. It does not currently include a data architecture / platform folder. Question: should every new business start with a `platform/` scaffold and a `data-infrastructure.md` rule?

**Recommendation:** Yes, but in a minimal form.

- New businesses rarely need a full Supabase project on day one
- But the conceptual separation (platform/ as home for business data, rules binding any future DB work) is good discipline from day one
- The `/new-business` skill should be extended to:
  - Create a `platform/` folder with a placeholder CLAUDE.md explaining its intended role
  - Include a stripped-down `data-infrastructure.md` rule (or a reference to the Switchable one as a template)
  - NOT create Supabase — that is a later decision per-business

**Action:** flagged as a follow-up task for a future session. Do not block this session on new-business template updates. Add to the new-business template TODO list.

## 7. Database-specific consumer impact

Per the extended infrastructure rule (DB changes require consumer mapping).

**No database exists yet** — nothing to impact this session. Next session creates the database and the first consumers simultaneously, so impact at that moment is bounded and known:

- `n8n_writer` consumer: the funded funnel routing workflow (new, built from scratch against Supabase)
- `ads_ingest` consumer: Meta Ads daily pull (new)
- `readonly_analytics` consumer: Metabase, Postgres MCP for agents (new)

No existing consumers to break. Migration cutover plan for provider data (Sheet → `crm.providers`) includes a dual-write period of 1-2 weeks.

---

## Overall assessment

**Risk level this session:** Low. File-only changes, governance drafted before tooling installed, all references updated in-session.

**Risk level next session (install):** Medium. Requires per-device setup, credential handling, first real migrations. Mitigated by:
- Governance rule already in place before any tooling lands
- Dual-write transition for provider data
- Dead letter table catches any Supabase outage
- Supabase auto-backups from day one
- Staging option available via Supabase Branching or local Docker

**Signed off:** Owner (session 2026-04-18) to proceed to next session when ready.

**Review required before next session starts:**
- Metabase self-host vs cloud decision
- Confirmation that no other work in flight blocks the provider Sheet cutover