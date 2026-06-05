# /admin/work — Work Hub Spec

**Author:** Mira | **Date:** 2026-06-05 | **For:** Sasha (backend + schema) + frontend (Next.js admin app, `platform/app`)

The single place Charlotte manages everything she has to do. Replaces ClickUp for task management and absorbs the existing `/admin/roadmap` as its top altitude. One tool, where she already works every day, with in-platform notifications so nothing has to be remembered.

Supersedes `admin-roadmap-spec.md`: the roadmap becomes the "Build" altitude inside this hub, not a separate page.

## Why it exists

Charlotte is drowning in task chaos: 100+ tasks in ClickUp (most stale), tasks added in places she never sees (handoff docs, cross-project pushes, agent tickets), no single place to add a job she thinks of, and nothing that reminds her work exists. The disease is capture and resurfacing, not volume. The fix: one front door in, one focused list out, and the system does the remembering.

## Core model: two altitudes, one system

- **Run (work *in* the business):** small and medium operational tasks. The day-to-day. This is the primary kanban board.
- **Build (work *on* the business):** the roadmap rocks (the existing `strategy.roadmap_tasks`, 5 Phase 1 lanes). Bigger initiatives.
- **Link:** a Run task can belong to a Build rock (`roadmap_task_id`). A big job never appears as one scary card; it lives as a rock, and only its next concrete Run step shows on the board.

## The board (kanban, drag-and-drop)

Primary view is the Run board. Columns, left to right, drag a card to change status:

1. **Inbox** — the one front door. Every new task lands here untriaged. Mira sorts (tag, size, link to rock, move to a column).
2. **This Week** — Charlotte's focus list. Capped soft at ~5-7. This is the only column she has to live in.
3. **In Progress** — actively being worked. Cards that sit here too long get a "stalled / half-done" flag (the most-dropped category).
4. **Review** — waiting on Charlotte's eyes (approve / decide / check). Never allowed to just pile; surfaced in notifications and cleared by Mira.
5. **Done** — auto-archives after N days.

Plus **Blocked** as a state (flag on the card, not a column, so the board stays clean) and a **Quick wins** filter (size = tiny) to batch sub-15-min jobs into one pass.

UX requirements: drag between columns (updates status), reorder within a column (`sort_order`), card shows title + size badge + area tag + parent rock + due/next, click to expand for notes. Clean and minimal over feature-rich. Fast. Mobile-friendly (she checks on phone).

## Fields

```
strategy.tasks
  id uuid pk
  title text not null
  notes text
  status text not null default 'inbox'   -- inbox, this_week, in_progress, review, done
  blocked boolean default false
  blocked_reason text
  size text default 'small'              -- tiny, small, big
  area_tag text                          -- the business-area tags (switchable-site, platform, etc.)
  roadmap_task_id uuid null references strategy.roadmap_tasks(id)  -- link to a Build rock
  added_by text not null                 -- charlotte, mira, rosa, nell, sasha, <project>, etc.
  due_date date null
  sort_order integer not null            -- ordering within a column for drag
  created_at timestamptz default now()
  updated_at timestamptz default now()
  completed_at timestamptz null
  seen_by_owner boolean default false    -- drives the "added for you since you last looked" feed
```

RLS: owner-only write/read (`admin.is_admin()`), `readonly_analytics` SELECT on a direct-identifier-free view for Mira's reads. Per `.claude/rules/data-infrastructure.md`.

## Capture (one front door, nothing silent)

Every task ends up here, never in a doc:

- **Charlotte:** "Add task" in the UI (defaults to Inbox), or tells Mira "add: X" in a session.
- **Mira + agents:** via an Edge Function `task-upsert` (owner-auth or service-role gated; agents call it, I call it). Per data-infra: writes go through a dedicated EF, not a raw role.
- **Project folders / handoffs:** the `/handoff` push step and cross-project pushes call `task-upsert` to create an owner task here, instead of writing a line into a handoff doc Charlotte never opens.
- **`added_by` is stamped on every task**, and anything added by someone other than Charlotte raises the "added for you" feed item, so nothing lands silently.

## Notifications (in-platform, because she's here daily)

A badge + a small feed/inbox panel in the admin nav. Triggers:
- New task added for her since last look (`added_by != charlotte AND seen_by_owner = false`).
- Due today / overdue.
- In Progress sitting > N days (half-done nudge).
- Review column count > 0.

v1 = in-app badge + feed. Email/Brevo digest optional later.

## Migration from ClickUp

1. Mira triages the ~100 ClickUp Task-pipeline tasks down to the real survivors (~20-25), categorising each: keep (Run task), promote (Build rock), or drop (done/obsolete/stale).
2. Mira prepares the seed insert SQL for `strategy.tasks` (and any new rocks into `roadmap_tasks`), with status/size/area_tag/added_by set.
3. Sasha applies after the schema migration.
4. ClickUp Task pipeline + Backlog retire. **Out of scope for now:** the Prospect Pipeline + Client Pipeline (lead CRM, Rosa/Nell) stay on ClickUp this round; revisit moving them into `crm` later.

## Impact assessment (per infra-change rule)

- **Agents' filing path changes** from ClickUp MCP to the `task-upsert` EF. Update Rosa's and Nell's auto-create steps, the ticketing-discipline rule in workspace `CLAUDE.md`, and `/handoff` skill steps 4-5.
- **Docs + skills cutover (owner note 2026-06-05), do at Phase 4 when the board is live:**
  - Every project folder's `CLAUDE.md` — replace "tasks live in ClickUp" guidance with "tasks live in `/admin/work`; capture via the UI or `task-upsert`".
  - `/prime-project` skill — Step 4 currently reads the ClickUp Review/Updated queue; repoint to the Work Hub (Review column + the "added for you" feed) filtered to the active project's `area_tag`.
  - `/handoff` skill — steps 4 (ClickUp update) and 5 (cross-project push into other handoffs) become `task-upsert` calls into `/admin/work` with the right `area_tag` + `added_by`.
  - Workspace `CLAUDE.md` ticketing-discipline rule — rewrite for the Work Hub (tag rule maps to `area_tag`; context rule stays).
- **ClickUp MCP** can be removed from the stack (both devices) after migration; coexist during transition. Update Notion Tech Stack when dropped.
- **Roadmap** (`/admin/roadmap`) folds into this hub as the Build altitude; don't run two task surfaces.
- **Both devices:** no per-device action (web app). **iCloud:** none (platform is not iCloud-synced).
- **Notifications** are new admin-app infra.
- Schema, RLS, EF write path all follow `.claude/rules/data-infrastructure.md` (migration files only, owner-only RLS, scoped read for Mira).

## Build effort + sequencing

Bigger than the roadmap MVP because the kanban needs real frontend (drag-and-drop in the Next.js admin app, e.g. dnd-kit), not plain EF-rendered HTML. Rough: schema + EF (Sasha, ~half day), kanban UI + notifications (frontend, ~2-3 days), migration seed (Mira, ~half day). Competes with Sasha's queue (CMS, Provider OS, Labs tracking, billing, security backlog). Sits in the operational-backbone lane; recommend high priority because daily task friction is slowing every other lane.

## Open questions for Sasha

- One unified `tasks` table linked to `roadmap_tasks` (this spec), or merge both into one table with an `altitude` column? Lean to two linked tables to preserve the existing roadmap.
- dnd library preference for the kanban in the existing Next.js stack.
- Notification delivery: poll on page load (simplest) vs realtime (Supabase realtime). Lean poll for v1.
