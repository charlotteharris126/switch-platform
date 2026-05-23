# /admin/roadmap MVP Spec

**Author:** Mira | **Pushed to platform:** 2026-05-23 | **For:** Sasha (backend) + Mable (frontend, see switchable/site brief)

Interactive roadmap tracker for Charlotte. Replaces static HTML at `strategy/roadmap.html`. ClickUp ruled out because operational task noise drowns strategic roadmap signal. Lives on platform so Charlotte has one clean tool just for tracking the strategic build.

## Why it exists

Charlotte is building a new business model (audience-first, multi-revenue) layered on the existing Switchable lead-gen funnel. ~60-70 roadmap tasks across 10 revenue models + foundation work, ~18 months of execution. She needs a single place to tick tasks off, write notes per task as she works, see status across all revenue models. Mira reads it each weekly review for continuity.

## Schema

New Supabase table in a new `strategy` schema (or `crm` if cleaner):

```sql
CREATE TABLE strategy.roadmap_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  revenue_model text NOT NULL, -- foundation, provider, apprenticeship, affiliate, ppl, app, newsletter-sponsorship, placements, report, whitelabel
  phase text NOT NULL, -- p1, p2, p3, p4
  agent_tags text[] DEFAULT '{}', -- e.g. {sasha, mable, charlotte}
  status text NOT NULL DEFAULT 'to_do', -- to_do, in_progress, blocked, review, complete
  notes text,
  sort_order integer NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX idx_roadmap_revenue_model ON strategy.roadmap_tasks(revenue_model);
CREATE INDEX idx_roadmap_status ON strategy.roadmap_tasks(status);
CREATE INDEX idx_roadmap_phase ON strategy.roadmap_tasks(phase);

-- RLS: owner-only access
ALTER TABLE strategy.roadmap_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner_full_access" ON strategy.roadmap_tasks
  FOR ALL TO authenticated USING (auth.uid() = '<charlotte's user uuid>');

-- Mira read access via service role (used by readonly_analytics role for MCP)
GRANT SELECT ON strategy.roadmap_tasks TO readonly_analytics;
```

Migration file: `platform/migrations/0<next>_admin_roadmap.sql`. Per workspace data-infrastructure rule: schema_version bump where relevant, change logged in `platform/docs/changelog.md`.

## API endpoints (Edge Functions on platform)

Simple CRUD pattern, all owner-auth-gated:

- `GET /admin/api/roadmap` — list all tasks, optionally filtered by `?revenue_model=` `?phase=` `?status=` `?agent=`
- `PATCH /admin/api/roadmap/:id` — update single task (status, notes, or both); auto-sets `completed_at` when status flips to `complete`; updates `updated_at`
- Optional: `POST /admin/api/roadmap` — add task (Mira-side mostly, Charlotte can use too)

Pattern: mirror existing `/admin/data-ops` endpoints for auth + error shape.

## Frontend (separate brief to Mable in switchable/site)

Mable owns the UI at `/admin/roadmap`. Spec lives in switchable/site brief but key requirements:

- Tasks grouped by revenue model (collapsible sections)
- Status dropdown inline per task (no modal, no page reload)
- Notes textarea expands inline per task
- Auto-save on change (debounced 500ms)
- Optimistic UI (instant feedback, retry on failure)
- Mobile-friendly (Charlotte will check from phone)
- Filter buttons top of page: by revenue model, by phase, by agent
- Strikethrough completed tasks but keep visible (filter "hide complete" toggle)
- "Mira's last sync" timestamp at top so Charlotte knows when state was last reviewed strategically

## Seed data

Mira (me) prepares the seed insert SQL with all ~60-70 tasks from current `strategy/roadmap.html` and `strategy/docs/build-map.md`. Tasks pre-categorised with revenue_model, phase, agent_tags, sort_order, status (already-done items marked `complete` with appropriate timestamps).

I'll write this as `platform/migrations/0<next+1>_admin_roadmap_seed.sql` ready for Sasha to apply after the schema migration.

## Mira integration

Mira reads `strategy.roadmap_tasks` via Postgres MCP (`readonly_analytics` role) at the start of each weekly review:

- Pull all rows where status != 'complete'
- Surface blocked items to Charlotte
- Reference Charlotte's notes per task when prioritising
- Flag tasks with `updated_at` older than 14 days (stale)
- Suggest reprioritisation based on phase progression

No write access for Mira required; Charlotte owns the state changes. Mira reads.

## Build sequence

Order Sasha + Mable can ship in:

1. Sasha: schema migration + RLS + GRANT (30 mins)
2. Sasha: 3 Edge Function endpoints (2-4 hours)
3. Sasha: owner-auth check pattern matched to existing admin pages (1 hour)
4. Mable: admin page UI (4-6 hours) — separate brief in switchable/site, can parallelise with Sasha's backend
5. Mira: seed data SQL prep + handoff to Sasha (2-3 hours)
6. Sasha: apply seed migration (15 mins)
7. End-to-end test + handover to Charlotte (1 hour)

**Total Sasha effort: ~6-9 hours**
**Total Mable effort: ~4-6 hours**

Should ship Week 1-2 of Phase 1 alongside affiliate stack wiring.

## Constraints

- Per workspace data-infrastructure rule: schema changes go through migration files only, never edited via UI
- Schema_version field where relevant
- Log change in `platform/docs/changelog.md` when applied
- Owner-only RLS, no other role gets write access
- Mira gets read-only via readonly_analytics role

## What this unlocks

- Charlotte stops getting lost in agent task noise in ClickUp
- Mira walks into every weekly review already knowing Charlotte's state
- Cross-device sync (phone, laptop, both work)
- Stays separate from operational ClickUp pipeline
- Foundation for adding more strategic tracking tools to /admin/ over time (e.g., revenue dashboard, KPI scorecard, partner relationship CRM)

## Open questions for Sasha

- Where does the schema live? `strategy` schema (new), or extend existing `crm`? Lean toward new `strategy` schema for clean separation; flag if you prefer otherwise.
- Auth pattern: match existing `/admin/*` pages exactly; flag any deviation.
- Are there any existing admin nav patterns we should match for the page header?
