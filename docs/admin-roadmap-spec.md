# /admin/roadmap MVP Spec

**Author:** Mira | **Pushed to platform:** 2026-05-23 | **Last updated:** 2026-05-25 (5-lane top-level hierarchy added per Phase 1 sharpening) | **For:** Sasha (backend) + Mable (frontend, see switchable/site brief)

Interactive roadmap tracker for Charlotte. Replaces static HTML at `strategy/roadmap.html`. ClickUp ruled out because operational task noise drowns strategic roadmap signal. Lives on platform so Charlotte has one clean tool just for tracking the strategic build.

**Hierarchy update 2026-05-25:** spec now requires explicit two-tier structure — 5 top-level Phase 1 LANES, each containing granular tasks. Charlotte needs to see the big picture at a glance and drill into specifics. Matches the structure in `strategy/docs/build-map.md` "Phase 1 — top-level view" section.

## Why it exists

Charlotte is building a new business model (audience-first, multi-revenue) layered on the existing Switchable lead-gen funnel. ~60-70 roadmap tasks across 10 revenue models + foundation work, ~18 months of execution. She needs a single place to tick tasks off, write notes per task as she works, see status across all revenue models. Mira reads it each weekly review for continuity.

## Schema (revised 2026-05-25 with `lane` top-tier)

New Supabase table in a new `strategy` schema. **Two-tier grouping:** `lane` is the top-level strategic grouping (5 Phase 1 lanes + deferred + complete-phase-2); `revenue_model` is the second-tier finer slicing; individual tasks are the granular tier.

```sql
CREATE TABLE strategy.roadmap_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  lane text NOT NULL, -- per-enrolment-scale, provider-os, affiliate-stack, audience-build, operational-backbone, deferred-phase-2, complete
  revenue_model text NOT NULL, -- foundation, provider, apprenticeship, affiliate, ppl, app, newsletter-sponsorship, placements, report, whitelabel-consumer-tools, whitelabel-provider-os
  phase text NOT NULL, -- p1, p2, p3, p4
  agent_tags text[] DEFAULT '{}', -- e.g. {sasha, mable, charlotte}
  status text NOT NULL DEFAULT 'to_do', -- to_do, in_progress, blocked, review, complete
  notes text,
  lane_sort_order integer NOT NULL, -- sort lanes in UI: 1=per-enrolment-scale, 2=provider-os, 3=affiliate-stack, 4=audience-build, 5=operational-backbone, 99=deferred
  sort_order integer NOT NULL, -- sort tasks within lane
  target_milestone text, -- optional Phase 1 goal that task contributes to, e.g. "£5-7k/mo combined by month 9"
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX idx_roadmap_lane ON strategy.roadmap_tasks(lane);
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

### The 5 Phase 1 lanes (top-tier grouping)

| `lane` value | Display name | Phase 1 goal by month 9 | `lane_sort_order` |
|---|---|---|---|
| `per-enrolment-scale` | Per-enrolment + apprenticeship scale | £5-7k/mo combined | 1 |
| `provider-os` | Whitelabel Provider OS | £1.5-3k MRR (5-10 customers) | 2 |
| `affiliate-stack` | Affiliate + PPL stack | £700-1.4k/mo | 3 |
| `audience-build` | Audience build (minimum-viable) | 3-5.5k newsletter subs | 4 |
| `operational-backbone` | Operational backbone (this tracker + supporting infra) | Live by end of week 2 | 5 |
| `deferred-phase-2` | Deferred to Phase 2 (month 6+) | Activated after £6k profit holds | 99 |
| `complete` | Already shipped | — | 100 |

The two new `revenue_model` values (`whitelabel-provider-os`, splitting from the existing `whitelabel` which becomes `whitelabel-consumer-tools` for the FE-college route) reflect the two-product whitelabel strategy locked 2026-05-24.

Migration file: `platform/migrations/0<next>_admin_roadmap.sql`. Per workspace data-infrastructure rule: schema_version bump where relevant, change logged in `platform/docs/changelog.md`.

## API endpoints (Edge Functions on platform)

Simple CRUD pattern, all owner-auth-gated:

- `GET /admin/api/roadmap` — list all tasks, optionally filtered by `?revenue_model=` `?phase=` `?status=` `?agent=`
- `PATCH /admin/api/roadmap/:id` — update single task (status, notes, or both); auto-sets `completed_at` when status flips to `complete`; updates `updated_at`
- Optional: `POST /admin/api/roadmap` — add task (Mira-side mostly, Charlotte can use too)

Pattern: mirror existing `/admin/data-ops` endpoints for auth + error shape.

## Frontend (Sasha-only — Mable dropped 2026-05-25)

**Mable dropped from this build 2026-05-25.** Internal-only tool, Charlotte is the only user, plain HTML rendered directly from an Edge Function is sufficient. Mable's bandwidth preserved for Provider OS V1 frontend + light programmatic course-page extensions.

Sasha serves the page directly from an Edge Function returning HTML + minimal JS. Functional requirements (no polish):

- Single page, server-rendered HTML
- **5 Phase 1 lanes as top-level sections** with lane name, Phase 1 goal, task counts (X done / Y in progress / Z to do)
- Tasks grouped by `revenue_model` within each lane
- Status select dropdown per task (form submit on change, page reloads with updated state)
- Notes textarea per task with explicit "Save" button (no debounced auto-save — keeps Edge Function simple)
- Filter via URL params: `?lane=` `?phase=` `?status=`
- Strikethrough completed tasks but keep visible
- "Mira's last sync" timestamp at top
- Mobile-friendly via responsive CSS (basic flex/grid, no framework needed)
- Owner-auth-gated like other admin pages

**Build effort revised:** Sasha 4-5 hours total (schema + Edge Function + HTML render). No Mable involvement. Ships Week 1.

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

## Build sequence (Sasha-only, revised 2026-05-25)

1. Sasha: schema migration + RLS + GRANT (30 mins)
2. Sasha: Edge Function for GET/PATCH (1-2 hours)
3. Sasha: HTML render in Edge Function — lane sections + task list + status forms + notes forms (2-3 hours)
4. Mira: seed data SQL prep + handoff to Sasha (2-3 hours)
5. Sasha: apply seed migration (15 mins)
6. End-to-end test + handover to Charlotte (30 mins)

**Total Sasha effort: ~4-6 hours**
**Mable effort: 0**

Should ship Week 1 of Phase 1 alongside affiliate stack wiring.

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
