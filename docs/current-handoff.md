# Platform — Current Handoff — 2026-04-27 — Session 13 closed (drafts management UI + nav restructure + brand filter + analytics page + analytics-sync Edge Function) + silent-DQ-routing fix coded but UNCOMMITTED

**Cross-session inbound from switchable/ads + switchable/site (2026-04-27 evening):**

Silent-DQ-routing defect handed in via ticket 869d2rxap. Real example: Anita id 184. Self-funded form correctly DQ'd her (qualification=professional-body) and showed the holding panel, but when she clicked "keep me on the list" the contact submission landed with is_dq=false and routed to Courses Direct as qualified. Same bug applies to budget=under-200 / no-invest DQ paths.

**Fix is coded both sides but UNCOMMITTED in working trees:**
- **switchable-site repo:** `find-your-course/index.html` adds a `dq_reason` hidden input that `showHolding(reason)` sets, `restartForm()` and the qualified-submit path both clear it. `tools/form-matrix/index.html` simulator updated. Three-file clean commit ready.
- **THIS platform repo:** `supabase/functions/_shared/ingest.ts` updated to read `dq_reason` from payload (line 163, 335, 406). MIXED with several unrelated working-tree changes from session 13 wrap-up (admin pages, components, weekly-notes, docs/changelog). The silent-DQ commit needs careful staging — `git add supabase/functions/_shared/ingest.ts` only, not `git add -A`.

Once both sides shipped: backfill `leads.submissions` row id 184 to `is_dq=true, dq_reason='qual', primary_routed_to=null`, owner emails Marty so he doesn't chase a DQ'd lead.

---

**Session type:** Continuation of Session 12. After G.2 + G.3 shipped and the handoff was written, owner asked to keep going — restructure the dashboard nav (Tools section), build draft edit/cancel actions (the deferred half of G.3), and add brand filtering + analytics (Session G.4). All shipped and deployed in this run.

**Session opened:** 2026-04-27 afternoon (continuation of Session 12)
**Session closed:** 2026-04-27 evening

---

## What we worked on

### 1. Sidebar nav restructured into Operations + Tools (deployed)

- `NAV_SECTIONS` shape replaces flat `NAV_ITEMS`. Two sections:
  - Top (no header): Overview · Actions · Leads · Providers · Errors
  - Lower **TOOLS** header: Social
- As we add more business-management tools (bulk operations, reports, engagement queue, draft generator, etc.) they go under Tools.
- Active-state logic updated so any `/social/*` sub-route highlights the single Social link.

### 2. Drafts management UI (deployed)
Closes the deferred half of Session G.3.

- `/admin/social/drafts/[id]` detail page — full content view, audit metadata, edit history.
- Edit form: content textarea (3000-char counter, `LinkedIn-Version 202604` cap enforced both client-side and server-side), `scheduled_for` datetime-local picker.
- Server Actions: `editDraft`, `cancelDraft`. Edit history captured to `social.drafts.edit_history` JSONB.
- Editing a `failed` draft auto-resets it to `approved` so the next cron tick retries with the new content. `publish_error` cleared on save.
- Cancel marks the draft `rejected` with `rejection_reason_category='other'` + a sentinel free-text reason.
- Status-conditional rendering: editable for `pending`/`approved`/`failed`; read-only for `published`/`rejected`.

ClickUp ticket `869d2mw3z` ("Build edit/approve/reject/retry actions on /social/drafts") — partially shipped. Edit + cancel done. Approve-from-pending + explicit retry button still pending (next session, when Thea's draft generator starts producing pending drafts).

### 3. Drafts/Analytics/Settings tab strip + Brand filter pill

- New `SocialTabs` component (Drafts | Analytics | Settings) at the top of every `/social/*` page.
- New `BrandFilter` component with pill buttons (All / SwitchLeads / Switchable). URL query param `?brand=switchleads` makes filtered views shareable.
- `/social/drafts` and `/social/analytics` honour the brand filter. `/social/settings` stays brand-agnostic — connection-settings list every (brand, channel) together (owner clarified that's the right shape).
- `normaliseBrand()` helper validates the query param against the enum.

### 4. OAuth scope update (deployed; owner action needed)

- `/api/auth/linkedin/connect` route now requests `openid profile email w_member_social r_member_social` (was missing `r_member_social`).
- `r_member_social` is needed for the analytics-sync function to read like/comment counts.
- **Owner needs to click "Reconnect" on `/social/settings`** for the SwitchLeads/LinkedIn-personal card. The existing token was issued without `r_member_social`; reconnecting refreshes it with the new scope. ~10 seconds.
- Until reconnected, the analytics-sync cron will hit 401/403, set `auth_reconnect_required: true` in its response, and skip writing analytics rows.

### 5. Edge Function `social-analytics-sync` + Migration 0033 (deployed + applied)

- Daily 04:00 UTC cron schedule (`social-analytics-sync-daily`). Idempotent unschedule-then-schedule.
- For every published draft <30 days old: `GET /rest/socialActions/{urn-encoded}/likes?count=0` and `/comments?count=0` in parallel; reads `paging.total` from each. Writes a fresh time-series snapshot to `social.post_analytics`.
- Concurrency-safe via `pg_try_advisory_lock(8472640)` (distinct from `social-publish`'s `8472639`).
- Per-call `AbortSignal.timeout(8000ms)` so one slow LinkedIn call doesn't block the batch.
- 401/403 detected on first post → `auth_reconnect_required` flag set in response + early loop abort. Avoids burning quota when scope is wrong.
- Multi-agent review caught: wrong endpoint shape on first draft (singular `/rest/socialActions/{urn}` returns one action, not aggregates — switched to `/likes` + `/comments` sub-resources reading `paging.total`); missing auth/scope handling; missing per-call timeout. All addressed before deploy.

### 6. `/admin/social/analytics` page (deployed)

- Reads `social.vw_post_performance` (per-post latest snapshot from migration 0029) + most recent `social.post_analytics` row for follower-count snapshot.
- Brand-filtered.
- Stat tiles: Published / Total engagement / Avg per post / Followers (NULL for personal LinkedIn — connections, not followers).
- Per-post table with click-through to `/social/drafts/[id]`.
- Empty state when no published posts (will be the case for non-SwitchLeads brand filters today).

### 7. Status of the 12-post batch

- Post 1: published live to LinkedIn 2026-04-27 (from Session 12).
- Posts 2-12: `approved` in `social.drafts`, scheduled for Tue 28 Apr 9am UK through Wed 20 May 9am UK. Cron `social-publish-15min` will publish them at their scheduled times.

---

## Current state

Social tool now has the full ops surface: per-(brand, channel) connection management, draft list, draft detail with edit/cancel, analytics, brand filter. Publishing cron runs every 15 min. Analytics cron runs daily 04:00 UTC. Owner needs to click Reconnect once to refresh the OAuth scope before analytics will populate.

---

## Next steps

1. **Owner: Reconnect on `/social/settings`.** Refreshes the OAuth token to include `r_member_social`. ~10 seconds. Without this, the analytics cron tomorrow morning returns `auth_reconnect_required: true` instead of pulling metrics.
2. **Verify Post 2 publishes Tuesday 28 Apr ~9am UK.** Check `/social/drafts` — Post 2 should show `published` with a URN.
3. **Verify analytics sync runs Tuesday 04:00 UTC + Post 1 metrics appear.** Check `/social/analytics` — Post 1 should show reactions/comments. If `auth_reconnect_required: true`, the Reconnect step was missed.
4. **Build social-draft-generate Edge Function (Session G.5)** — autonomous Mon + Thu cron that calls Claude API with brand voice + content pillars + past-performance signals to generate the next batch of draft posts. Currently drafts go in via SQL; this closes the loop. Half-day to a day; will need a `pending`-status batch loaded so we can also build the approve/edit-from-pending UI on `/social/drafts`. Also adds `social.engagement_queue` ingest path (forward LinkedIn notification emails to a webhook → Claude drafts a comment angle → push notification to phone).
5. **Build the missing `/social/drafts` actions** (approve-from-pending with reason category, explicit retry button for failed). Smaller scope. Combine with G.5 once pending drafts exist.
6. **EMS Tuesday catch-up call (28 April 13:00).** Nell's pending-items reminder should surface tomorrow morning with three asks: capture call-from numbers, discuss preferred-call-time, sheet-update reminder.

---

## Decisions / open questions

### Decisions made this session
- **Sidebar nav structure:** Operations (top) + Tools (lower section). All future business-management tools land under Tools.
- **`/social/drafts` is the default Social landing.** Sidebar Social link points there.
- **Settings stays brand-agnostic.** Connection cards list every (brand, channel) together. Owner clarified that's the right shape.
- **Brand filter via URL query param.** `?brand=switchleads | ?brand=switchable | (omitted for all)`. Shareable.
- **Edit-resets-failed-to-approved.** When the owner edits a `failed` draft, status flips to `approved` so the next cron tick retries. Cleaner than a separate Retry button for now.
- **Analytics endpoint shape:** `/rest/socialActions/{urn}/likes?count=0` + `/comments?count=0`, read `paging.total`. The singular `/rest/socialActions/{urn}` was wrong (returns one action, not aggregates).
- **Personal-profile follower count is NULL** (LinkedIn personal has connections, not followers; API doesn't expose follower count for personal profiles). Activates later via company-page scope.
- **Personal-profile impressions are NULL** for the same reason. Public API doesn't expose. Sales Navigator / company page would unlock.

### Open questions
- **Will the Tuesday 04:00 UTC analytics sync work cleanly after Reconnect?** First real test of the analytics path.
- **Same-day idempotency on `social.post_analytics`?** Currently the function writes a new row every run. If anyone manually triggers the function on the same day, they get two snapshots. Acceptable for time-series; could dedupe later via partial unique index on `(draft_id, date_trunc('day', captured_at))` if it becomes noisy.
- **When to build `social-draft-generate`?** Owner's batch ends Wed 20 May. Earliest meaningful trigger: ~Mon 18 May for Mira's review of last batch's performance + draft batch 2.

---

## Next session

- **Currently in:** `platform/` — admin dashboard + data layer + Edge Functions
- **Next recommended:** `platform/` — confirm Tuesday morning's autonomous publish + analytics sync land cleanly (~9am Post 2; ~04:00 UTC analytics). Then either build Session G.5 (autonomous drafting) or work on a different build queue item depending on owner priority.
- **Tackle first:** open `/social/drafts` Tuesday morning. Confirm Post 2 = `published` with URN. Then `/social/analytics` after 04:00 UTC for Post 1 metrics. If both clean: Session G publishing path is fully proven end-to-end including analytics.

---

## Cross-project flag from Thea (2026-04-27 evening)

Owner pushed back on the "you'll have to paste LinkedIn analytics in by hand each Monday" workflow scoped in `switchleads/social/docs/platform-status-2026-04-27.md` § What's manual / 2 (Engagement input). Research found the underlying assumption is wrong. Four things to action when next in `platform/`.

### 1. Personal-profile impressions / reach / engagement ARE API-available

Current shipped path (`/rest/socialActions/{urn}/likes` + `/comments` reading `paging.total` with `r_member_social`) returns reaction + comment counts only. Useful, but it leaves us paste-dependent forever for impressions, reach, follower-gained, profile-views.

LinkedIn shipped a public **Member Post Analytics API** in mid-2025 covering all of this for personal profiles:
- Endpoint: `GET /rest/memberCreatorPostAnalytics?q=entity&entity={ugcPostUrn}` (per-post) or `?q=me` (aggregated)
- Metrics: `IMPRESSION`, `MEMBERS_REACHED`, `RESHARE`, `REACTION`, `COMMENT`, `POST_SAVE`, `POST_SEND`, `LINK_CLICKS`, `FOLLOWER_GAINED_FROM_CONTENT`, `PROFILE_VIEW_FROM_CONTENT`
- Required scope: **`r_member_postAnalytics`** (different from `r_member_social`)
- Sits inside the **Community Management API** product (NOT Marketing Developer Platform)
- Authoritative docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics

Direct contradicts the Session 13 `Decisions made this session` line "Personal-profile impressions are NULL... Public API doesn't expose. Sales Navigator / company page would unlock." That decision was based on an outdated read of LinkedIn's API surface — the public API does expose this now, just behind a different scope and product gate.

### 2. Recommended action when next in `platform/`

a. **Verify the Community Management API submission scope list.** The app already in review (per Sasha's snapshot, "in progress on Charlotte's other LinkedIn Developer App") must include `r_member_postAnalytics` in the requested scopes. If it's not on the list, add it before approval lands or we get stuck approved-but-without-the-scope.

b. **When approval lands:** swap `social-analytics-sync-daily` from the `socialActions/{urn}/likes` + `/comments` pair to `memberCreatorPostAnalytics?q=entity` per-post. Existing `social.post_analytics` time-series schema accommodates the new metrics — extend the row shape, no migration of historical likes/comments rows needed (they remain valid time-series data).

c. **Retire the manual `/social/analytics` paste path entirely.** Page becomes read-only display of auto-synced data. The "5 mins/week paste" task in `platform-status-2026-04-27.md` disappears from Charlotte's routine forever.

### 3. Pull Session G.5 (autonomous drafting) and engagement-queue ingest forward

Owner asked how to automate drafting + comment management. Both are scoped (G.5 + the engagement-ingest path described in Thea's CLAUDE.md autonomous stage). Neither needs to wait until ~mid-May.

**G.5 — autonomous drafting (`social-draft-generate` Edge Function):**
- Doesn't depend on the LinkedIn analytics fix above. First batches can run with no performance signal; later batches get smarter as `social.post_analytics` fills.
- Inputs: `.claude/rules/charlotte-voice.md`, content pillars from `switchleads/social/CLAUDE.md`, recent business-activity context (open question — see below), past-performance signal from `social.post_analytics` (when populated), ICP engagement log.
- Outputs: 5-8 rows in `social.drafts` with `status='pending'`. Charlotte approves/edits/rejects in the existing `/social/drafts` UI.
- **Open design question for Sasha to surface to Mira:** how does the cron get "what's happening in the business this week" context? Three options: (a) read structured rows directly (recent leads, sign-ups, enrolments, dispute resolutions), (b) read Mira's `strategy/weekly-review.md` from outside the database, (c) both — DB for facts + a short free-text "this week's vibe" field Mira fills when she writes the weekly review. Owner instinct on (c). Worth a 5-min decision before building.

**Engagement-queue ingest (`social-engagement-ingest` Edge Function + push-notification chain):**
- Path: Charlotte clicks bell on each engagement target's profile (one-time, ~30 sec each, ~20-30 names) → Gmail filter forwards `notifications-noreply@linkedin.com` emails to the Edge Function → function parses post URL + content → calls Claude API to draft a 2-4 sentence comment angle in Charlotte's voice → writes row to `social.engagement_queue` → push notification to phone → Charlotte taps notification → opens LinkedIn post in app + clipboard pre-loaded with the draft → paste, glance, edit, post.
- Doesn't depend on Community Management API approval at all. Doesn't depend on the analytics swap at all. Independent build.
- One-time owner setup when ready: bell-clicks + Gmail filter rule (Sasha provides exact filter string + forwarding webhook URL) + push-notification permission grant on phone.

### 4. `readonly_analytics` role grant on `social` schema

Separate, smaller fix. Currently the `readonly_analytics` Postgres role lacks USAGE on the `social` schema, so Thea/Mira can't query post performance / drafts / engagement-queue via Postgres MCP. Verified empirically this session — `current_user='readonly_analytics'`, `pg_namespace` shows `social` exists, `information_schema.tables` returns empty for `schema='social'`. Same pattern as `leads` and `crm` are granted today.

Migration: `GRANT USAGE ON SCHEMA social TO readonly_analytics;` + `GRANT SELECT ON ALL TABLES IN SCHEMA social TO readonly_analytics;` + `ALTER DEFAULT PRIVILEGES IN SCHEMA social GRANT SELECT ON TABLES TO readonly_analytics;` (default-privileges line so future tables auto-grant).

### Source attribution

Findings verified via WebFetch of Microsoft Learn LinkedIn API docs (the authoritative source — Microsoft hosts LinkedIn's developer documentation), cross-referenced against three independent secondary sources (PPC Land, Phyllo guide, Zernio guide). All four sources agree on endpoint, scope name, metrics, and product gate. The previous "impressions are NULL" decision and the platform-status snapshot's API claim both predate the public API release window and reflect pre-2025 LinkedIn restrictions.
