# Platform Handoff, Session 67, 2026-06-05

## ⚡ PUSH FROM Mable (switchable/site) 2026-06-08: persist + route `earnings_band` (new funded income gate)

New funded course page built this session: **Introduction to Management** (NCFE Level 2 Certificate in Principles of Team Leading), Sunderland, provider EMS. Course id `team-leading`, slug `introduction-to-management-sunderland`. **Not live yet** (push held, blocked on EMS confirming the funding scheme name). It introduces a new `earnings` qualifier step (DQs anyone earning £30k+, captures the declared band), per Charlotte's "filter out 30k+ earners, capture and send to EMS" spec.

**What the site now emits on funded leads (live in the build, ships when the page goes live):**
- New payload field **`earnings_band`** on the funded form. Values: `under_30k` (passes) / `over_30k` (DQ'd at the gate, so a clean submitted lead is always `under_30k`; `over_30k` only appears on a DQ-injected `switchable-waitlist` row via `injectQualifierAnswers`). Carried as a main-form hidden field + injected into the DQ waitlist form.
- New **`dq_reason`** value **`over_income_threshold`** on the income DQ waitlist submission.
- Mirrored in the form-matrix simulator + `routing.js` classifier (`classifyFundedStep('earnings', …)`, FUNDED_STEP_DQ `over_30k`).

**Current behaviour without you:** Netlify captures `earnings_band` on every submission, and `netlify-lead-router` receives it, but with no column it's silently dropped (unknown field ignored — nothing breaks, but the band isn't persisted or routed to EMS).

**Asks (priority order):**
1. **Column:** add `leads.submissions.earnings_band TEXT NULL`. Additive (free per data-infra §2). Migration + `data-architecture.md` mirror + changelog row.
2. **EF mapping:** map incoming `earnings_band` → the column in `netlify-lead-router`'s insert. (Producer schema doc `switchable/site/docs/funded-funnel-architecture.md` updated my side — additive field, no version bump.)
3. **EMS sheet:** add `earnings_band` to the EMS provider sheet (header + canonical v2 Apps Script FIELD_MAP entry, then redeploy) so the declared band reaches EMS as eligibility evidence — that's the "send" half of capture-and-send.
4. **`dq_reason` constraint:** confirm whatever column `dq_reason` lands in accepts `over_income_threshold`. If there's a CHECK enum, widen it (migration); if free text, nothing to do.
5. **Optional:** if useful for nurture, surface `earnings_band` as a Brevo attribute via `_shared/route-lead.ts` (not required; flag a backfill if you do, per the Brevo-wiring rule).

**Impact (§8):** reads of `leads.submissions` — the `readonly_analytics` view should pick up the new column (quasi-identifier, fine to expose; not PII). No existing consumer reads `earnings_band` yet. Producer = the funded form (one page so far, low volume). Rollback = drop column. Sign-off: owner.

## Current state
Built the Work Hub (`/admin/work`) end to end this session: a kanban task board that replaces ClickUp, with the roadmap folded in as a "Build" tab. It's feature-complete and live but **near-empty** — the ClickUp task migration (the only big piece left) is deferred to a focused Mira session. Also fixed Freya/Riverside's not-signed bug and removed Metabase from the docs. The Codex security backlog and Clara's billing brief remain the other untouched platform work.

## What was done this session
- **Work Hub built + deployed** (`platform/docs/admin-work-hub-spec.md`):
  - Schema: `strategy.tasks` (0188) + `tags`/`priority` (0189) + `agents` status (0190). RLS mirrors `roadmap_tasks` (owner `admin.is_admin()`, `readonly_analytics` read for Mira, `functions_writer` for capture). `area_tag` + `tags` are free text (no CHECK-enum drift); `status`/`priority` are CHECK enums kept in lockstep with both EFs + the board.
  - EFs: `task-upsert` (agent/handoff capture front door, `TASK_UPSERT_SECRET`-gated) + `work-tasks` (owner board ops, x-audit-key/`AUDIT_SHARED_SECRET`, mirrors `admin-roadmap`).
  - UI `/admin/work`: dnd-kit kanban (Inbox · Agents · This Week · In Progress · Review · Done), drag between + reorder within columns (sort_order persisted), editable card detail (title/category/priority/tags/notes/due/blocked/delete), filter views (All/New/Overdue/Due today/Due soon/Stalled/Review/Blocked/Quick wins/Big projects/No category) with **multi-select** + Category/Priority/Tag dropdowns, notifications bell (badge + grouped feed, deep-links to filtered board), roadmap as a Build tab (removed standalone Roadmap nav). Opening an agent-added card marks it seen.
  - `/prime-project` skill Step 4 now also reads the Work Hub for the active project's `area_tag` (queued-by-others, agent-delegated, count). Skill syncs via iCloud.
- **Fixed not-signed bug (Freya/Riverside, 0187):** widened `crm.enrolments.lost_reason` CHECK to allow the employer reasons. Live + verified.
- **Removed Metabase** from all live docs (we use the in-house admin app); migration files left (immutable).

## Next steps
1. **ClickUp → Work Hub migration (Mira, the big one):** triage the ~156 ClickUp tasks (Task pipeline ~100 + Backlog 56) to the real survivors, map to `strategy.tasks` (category/priority/status), import clean. Then retire ClickUp tasks + wire agents (Rosa/Nell) + `/handoff` steps 4-5 to call `task-upsert`, and update project folders' CLAUDE.md + ticketing rule. Cutover list in the spec. **Do import + triage together in the Mira session — do NOT bulk-dump 156 raw cards.**
2. **Billing reconciliation + `/admin/billing`** (Clara push, ticket 869djrtgk, brief `platform/docs/billing-section-brief-2026-06-04.md`).
3. **Security backlog (Codex order, untouched):** provider login OTP binding (#1) → ingestion auth (#5) → lock `editorial.fire_netlify_blog_build` (#6) → `verify_jwt` config blocks (#8) → app-code batch.
4. **`leads.submissions` PII follow-up (ticket 869dja09z):** apply §6a; impact-assess consumers first.
5. **Carries:** SMS delivery pull; auto-flip cron (0097 unapplied); Provider OS V1 scoping; `sql.json` deno-check cleanup.

## Decisions and open questions
**Decisions:**
- Work Hub = two linked tables (`tasks` + `roadmap_tasks`), dnd-kit, poll-not-realtime notifications (per spec). Mira reads `tasks` directly (no stripped view) — it has no identifier columns and triage needs full content.
- Tags are orthogonal labels only; "needs approval" = Review column, "can't proceed" = Blocked flag, not tags (removed awaiting-approval/waiting).
- Migration done in the Mira session (triage + import together), not a 1am bulk dump.
**Open questions:**
- Final mapping of ClickUp tags → `area_tag` categories (Mira decides at triage).

## Watch items
- **Click-test the board** after rebuild: drag reorder within a column + move between, the card detail modal, the filters, the notifications bell. (dnd-kit reorder was built + tsc-clean but not click-tested from here.)
- Work Hub holds 1 seed task until the migration runs.
- `TASK_UPSERT_SECRET` is set in Supabase; agents/handoff need it wired at Phase 4 cutover.
- Freya: confirm she can now mark not-signed with a reason.

## Next session
- **Folder:** platform (or `strategy` if Mira is running the migration triage)
- **First task:** ClickUp → Work Hub migration with Mira (triage + import), OR billing reconciliation (869djrtgk) if not doing the migration.
- **Cross-project:** Migration is Mira's (pushed to `strategy/docs/current-handoff.md`). Prime-project + ticketing-rule + agent filing changes land at Phase 4 cutover.
