# Platform — Current Handoff — 2026-04-26 — Session 10 closed (realtime fix + status taxonomy refactor + catch-up page + Session G launch decision)

**Session type:** Multi-feature build session. Shipped a live-bug fix (realtime auto-refresh), a foundational data taxonomy refactor (enrolment statuses), the per-provider catch-up page (build queue item #3), and locked the launch plan for Session G (organic social tool). All three deploys live on production.

**Session opened:** 2026-04-26 morning
**Session closed:** 2026-04-26 evening

**Note on numbering:** today's changelog and migration entries reference "Session 9" inline (carryover from the conversation summary at the start of this session). Real numbering is Session 10 — Session 9 closed 2026-04-25. Date stamps in the changelog (2026-04-26) make the actual sequence unambiguous, no need to retro-fix the labels.

---

## What we worked on

### 1. Realtime auto-refresh reliability fix (deployed)
Live bug: a real lead landed and the dashboard didn't auto-update; only a manual refresh showed it. Diagnosed three holes in `realtime-refresh.tsx`:
- Auth token expiry not propagated to the realtime channel (channel kept the socket open but stopped delivering RLS-gated events after the JWT expired)
- Backgrounded tabs had their websocket suspended by the browser, with no recovery
- No reconnect on `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED`

Fix layered all three: forward `TOKEN_REFRESHED` events to `realtime.setAuth()`, queue a `router.refresh()` on `visibilitychange` + `focus` (the safety net), reconnect with 2s backoff on channel error. File: `platform/app/components/realtime-refresh.tsx`.

### 2. Enrolment status taxonomy refactor — migration 0028 (deployed)
Owner reframed the status model. Old set lumped operationally distinct outcomes ("we couldn't reach them" vs "we reached them, they declined"). New set:

`open / enrolled / presumed_enrolled / cannot_reach / lost`

Plus:
- `lost_reason` required when status='lost': `not_interested / wrong_course / funding_issue / other`
- `disputed_at` + `disputed_reason` as flags on presumed_enrolled rows (not a status)
- `contacted` folded into `open` (never surfaced anyway)
- `not_enrolled` migrated to `lost`
- old `disputed` rows migrated to `presumed_enrolled` + flag

Migration is a single coordinated change: data UPDATE + new CHECK constraint + new columns + replaced `crm.upsert_enrolment_outcome()` (6-arg signature) + replaced `crm.run_enrolment_auto_flip()` (drops 'contacted' from early-state filter).

Code updates in lockstep: outcome form (5 status buttons + conditional reason radio + dispute checkbox), Server Action, lead detail page (passes new fields), admin overview tiles (Lost replaces Not Enrolled, new Cannot reach tile, Disputed counts via flag), actions page (drops 'contacted', surfaces dispute badge inline).

Production migration applied cleanly: 0 open, 2 enrolled, 3 presumed, 0 cannot_reach, 0 lost, 0 disputed flags. No legacy rows needed translation.

Logged in `platform/docs/changelog.md` with full impact assessment per `.claude/rules/data-infrastructure.md` §8.

### 3. Provider catch-up page (deployed)
Build queue item #3. New route at `/admin/providers/[id]/catch-up`, with tab navigation (Overview / Catch-up) on the provider detail page. Sections:
- This week stat tiles (Routed / Enrolled / Presumed / Cannot reach / Lost)
- Three summary cards (All-time conversion %, Free enrolments left, All-time totals)
- Talking points (auto-generated nudges for the call — stale opens, long opens, disputes, billing milestones, sheet hygiene)
- Common lost reasons (horizontal bar from new `lost_reason` data)
- By course breakdown (conversion + outcome split per course_id, all-time)
- Active disputes (only if any)
- Re-applications (last 30 days, only if any)
- Recent activity (last 30 days, every routed lead + current status)

Reframed during scoping: original spec was a checklist for marking outcomes lead-by-lead; owner clarified the call doesn't go lead-by-lead, it's a strategic conversation about quality / trends / lost reasons / sheet hygiene. Page rebuilt around that.

Files: `tabs.tsx` (shared tab component), `catch-up/page.tsx` (the page), edits to provider detail page for tab integration.

### 4. AI catch-up summaries deferred (build queue #3 → DEFERRED)
Owner reasoning saved to memory and queue doc: "if the data is strong and clear i can see for myself". Re-fire trigger documented. Build queue renumbered (now 21 items, was 22). Memory rule `feedback_clarity_over_ai_summarisation.md`.

### 5. Session G (social tool) launch plan locked
Owner pivoted at end of session to launch the organic social tool (`/social` module) per the Session G spec in `platform/docs/admin-dashboard-scoping.md`. Verified actual state vs the doc's claim of a partial early build:

- Spec claims: schema migration, OAuth callback route, `social-publish-linkedin` Edge Function, `social.oauth_tokens` table built 2026-04-25
- Reality on disk + git: NONE of it exists. Clean slate.

Owner's decision: build it properly across multiple sessions, no patchwork, ultrareview gated. No rush on the first 12 posts (they can wait until the platform is ready — owner is fine starting publish whenever).

Phased plan agreed for next sessions:
- **G.1** — schema migration only (6 tables + RLS + Vault for OAuth token encryption). Ultrareview before applying. ~2 hours.
- **G.2** — OAuth callback route + minimal `/social/settings` page + LinkedIn OAuth dance. ~2 hours.
- **G.3** — `social-publish` Edge Function + cron + minimal `/social/drafts` UI + load 12 posts. End-to-end test. ~3 hours.

### 6. Three ClickUp Backlog tickets logged
- `869d281ar` — Add provider call-from numbers to learner warm-up email (`platform`, `switchable-email`)
- `869d281bp` — Capture preferred call time on funded course form, surface to provider (`switchable-site`, `platform`)
- `869d2830g` — Standardise cross-project communication mechanisms across all agent folders (`strategy`)

### 7. Nell prep note for Tuesday EMS call
Added to `switchleads/clients/docs/pending-items.md` with `surface_by: 2026-04-27`. Three asks for the Tuesday call:
1. Capture provider call-from numbers
2. Discuss preferred-call-time form addition
3. Reminder on lead-by-lead sheet updates (not only after 3rd no-answer)

### 8. Memory rules saved this session
- `feedback_clarity_over_ai_summarisation.md` — invest in legible dashboards over AI summary layers; owner reads raw data and asks Claude in-session if she wants prose

### 9. Otter.ai mentioned as future enabler
Owner uses Otter.ai for call transcripts. Logged as a future direction for richer post-call data extraction (auto-mark outcomes from transcripts, pull lost reasons in provider's actual words). Not built — layers on top of the structured data we now have. Worth a future ticket once dashboard surfaces are stable.

---

## Current state

Platform admin dashboard is feature-complete for pilot operations: full lifecycle (open → enrolled / presumed_enrolled / cannot_reach / lost) with a rebuilt outcome form, per-provider catch-up page for Tuesday calls, realtime auto-refresh that actually works. Session G (organic social module) is fully scoped and ready to start as a multi-session build.

---

## Next steps

1. **Verify production deploys are healthy.** Hard-refresh `admin.switchleads.co.uk` and confirm: new "Cannot reach" + "Lost" tiles on overview; outcome form on a routed lead has 5 buttons + conditional reason radio; Catch-up tab on any provider page renders without error; auto-refresh fires on tab focus.
2. **Tuesday 28 Apr 13:00 EMS call (Andy Fay)** — Nell prep note already surfaced in `switchleads/clients/docs/pending-items.md`. Walk into the call with the catch-up page open, raise the three pending asks (call-from numbers, preferred-call-time, sheet hygiene reminder), and capture answers.
3. **Session G.1: schema migration for `social.*` namespace.** Author migration 0029 covering all 6 tables, indexes, views, RLS, and Vault setup per `platform/docs/admin-dashboard-scoping.md` § Session G. Ultrareview before applying. ~2 hours.
4. **After G.1 ships:** start G.2 (OAuth callback route + minimal `/social/settings`).
5. **Bulk operations on leads list (build queue #4).** Half-day. Defer until after Session G.1 ships.
6. **Otter.ai transcript-to-DB pipeline** — log as a Backlog ticket once dashboard surfaces have stabilised.

---

## Decisions / open questions

### Decisions made this session
- **Deferred AI catch-up summaries.** Default to clearer dashboard data over AI summary layers.
- **Status taxonomy reshape locked.** `open / enrolled / presumed_enrolled / cannot_reach / lost` + dispute as flag. Operationally separates "couldn't contact" (operational fix) from "contact made, declined" (sales fix).
- **Cannot reach is its own status, not a flavour of Lost.** Justified by different remediation paths (numbers/timing/automation vs qualification/course-fit/funding).
- **Disputed is a flag on presumed_enrolled, not a status.** Resolves to either enrolled or lost.
- **Lost requires a reason** (radio: not_interested / wrong_course / funding_issue / other). Enforced in DB and UI.
- **Catch-up page is strategic snapshot, not lead-by-lead checklist.** Reframed mid-session after owner clarified how the call actually runs.
- **Session G build is multi-session, ultrareview gated, no patchwork.** No deadline pressure on the first 12 posts.
- **By-course breakdown included in catch-up page** (D from the polish pass).
- **Catch-up link from lead detail page NOT included** (B from the polish pass — owner doesn't see the need).
- **Speed-of-contact metric NOT included** (C — owner: "we'll never get that" because providers don't mark contact promptly).

### Open questions
- **Marketing Developer Platform approval for company-page posting** — submission planned once `/social/settings` is live (Session G.2). 2-8 week wait. Plan accordingly for company-page autonomous publishing.
- **First 12 posts in `switchleads/social/docs/drafts-2026-04-27.md`** — schedule once Session G.3 ships. No rush; owner is fine waiting.
- **Otter.ai pipeline scoping** — when to ticket, what shape it takes. Leaving until after Session G.

---

## Next session

- **Currently in:** `platform/` — admin dashboard + data layer + Edge Functions
- **Next recommended:** `platform/` — Session G.1 (social schema migration). The taxonomy refactor and catch-up page are done; the natural next move is launching the social tool build, which is multi-session and time-sensitive (Marketing Developer Platform 2-8 week clock starts once Session G.2 ships).
- **Tackle first:** Author migration 0029 (`social.*` schema) per `platform/docs/admin-dashboard-scoping.md` § Session G. Update `platform/docs/data-architecture.md` first (source-of-truth lead). Then ultrareview, then apply.
