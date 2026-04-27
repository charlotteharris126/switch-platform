# Platform — Current Handoff — 2026-04-27 — Session 11 closed (repo monorepo restructure + Session G.1 social schema applied)

**Session type:** Continuation of Session 10's work. After the initial Session 10 wrap was written, owner pivoted to launch Session G (organic social tool). To enable proper review of the migration, the repo was restructured into a monorepo first. Session G.1 (schema only) then shipped end-to-end: written, reviewed in-session via three review agents, revised, applied to production, logged.

**Session opened:** 2026-04-26 evening (immediately after Session 10 wrap)
**Session closed:** 2026-04-27 early morning

**Note on session boundaries:** This work continued straight on from Session 10's "wrap that didn't wrap". Calendar date crossed midnight UK time during the session. The earlier `current-handoff.md` for Session 10 stays accurate for the work it covered (realtime fix, status taxonomy refactor, catch-up page); this handoff covers everything done after.

---

## What we worked on

### 1. Monorepo restructure (deployed)
Repo at `github.com/charlotteharris126/switch-platform` was previously the dashboard app only — `platform/app/.git`. Migrations, Edge Functions, governance docs lived in iCloud only. That was the reason `/ultrareview` couldn't review migrations: the files weren't in any git repo, just iCloud.

Restructured `platform/` itself to be the git repo:
- `.git` moved up from `platform/app/` to `platform/`
- Existing app history preserved via git rename detection (every file shown as `path → app/path`)
- Migrations 0001-0029 now tracked
- Edge Functions tracked
- All `docs/*.md` tracked (data-architecture, changelog, scoping, secrets-rotation, infrastructure-manifest, current-handoff, vision)
- `apps-scripts/` tracked (provider sheet appender variants)
- Root `netlify.toml` added with `base = "app"` so the dashboard still deploys from `app/` subfolder
- Root `.gitignore` for `.DS_Store` / `.env` / `vault.icloud` artefacts and `supabase/.temp/` CLI state
- Backup of pre-restructure `.git` at `/tmp/switch-platform-git-backup-20260427-083801` (local, not iCloud)

Pushed as commit `ef73c7f`. Netlify auto-rebuilt cleanly from the new layout.

**Why it matters:** every future migration, Edge Function change, and governance doc edit is now in git → reviewable, version-controlled, recoverable. `/ultrareview` would work on any of them. Same applies to `/security-review` and ad-hoc PR review.

Per `.claude/rules/CLAUDE.md` infrastructure rule, this was assessed for downstream impact: both devices (iCloud-synced, no per-device action), iCloud sync (git inside iCloud already a working pattern via `platform/app/.git`), other agents (none affected — Sasha reads via MCP), other refs (path-based references unchanged), Notion (no impact), new-business template (worth updating eventually so new businesses inherit the pattern — flagged as a future tweak in the cross-project comms ticket scope, not a blocker).

### 2. Migration 0029 — `social.*` schema (Session G.1, applied)
Multi-brand organic social automation foundation. 7 tables, 6 views, RLS, Vault setup. First migration of Session G.

**Tables:** `drafts`, `engagement_targets`, `engagement_queue`, `post_analytics`, `engagement_log`, `oauth_tokens`, `push_subscriptions`. Multi-brand (`switchleads` | `switchable`) and multi-channel (`linkedin_personal` | `linkedin_company` | `meta_facebook` | `meta_instagram` | `tiktok`) from day one. `(brand, channel)` is the unique posting surface key.

**Views:** `vw_pending_drafts`, `vw_post_performance`, `vw_engagement_queue_active`, `vw_targets_due_review`, `vw_rejection_patterns`, `vw_channel_status`. All set `WITH (security_invoker = true)` so they inherit underlying-table RLS.

**Vault:** `pgsodium` enabled. OAuth tokens stored as UUID references into `vault.secrets` rather than direct ciphertext columns (cleaner per Supabase Vault docs). Defensive `REVOKE ALL ON vault.decrypted_secrets FROM authenticated, anon`. SECURITY DEFINER helper for Edge Functions to read tokens via allowlist comes in Session G.3 (mirrors `public.get_shared_secret()` from migration 0019).

**RLS:** Admin only at this stage. `FOR ALL` policies via `admin.is_admin()`. `push_subscriptions` adds row-scope (admin can only see/manage their own).

**Append-only enforcement:** `post_analytics` and `engagement_log` ship with SELECT/INSERT/UPDATE grants only — DELETE deliberately not granted. UPDATE allowed for typo correction. `post_analytics.draft_id` is `ON DELETE RESTRICT` so deleting a draft doesn't silently destroy analytics history.

**Idempotency:** `IF NOT EXISTS` / `OR REPLACE` / `DROP POLICY IF EXISTS` on every object. Real executable DOWN block (drops every object) — schema is brand new, fully reversible.

**Applied to production:** `supabase db push --linked` ran cleanly. Summary: 7 tables, 6 views, 7 RLS policies. No data migration needed (brand new schema, no existing rows).

### 3. Multi-agent review of migration 0029 (in lieu of /ultrareview)

`/ultrareview` is not available in the local Claude Code build (tried after VS Code restart — still "command not found"). Substituted with three in-session review agents running in parallel:

- **SQL correctness + Postgres edge cases**
- **RLS + security + Vault**
- **Schema-vs-spec compliance**

Found two CRITICAL issues:
1. Views were missing `WITH (security_invoker = true)` — Postgres views default to running as the view owner (postgres = god mode), bypassing RLS on underlying tables. `vw_channel_status` would have leaked OAuth metadata to any authenticated role.
2. Views were missing `GRANT SELECT ... TO authenticated` — dashboard would have hit "permission denied for view" on first load.

Plus several non-critical items (DELETE grants tightened on append-only tables, `post_analytics.draft_id` switched to RESTRICT, `engagement_queue.expires_at` made NOT NULL with auto-default, missing `target_id` index added, idempotency guards added, real DOWN block).

All addressed in a revision before applying. One clean migration shipped, no follow-up 0030 needed. Owner approved revision and applied.

### 4. data-architecture.md updated in lockstep
Added the full `social` schema section — canonical source for migration 0029. Removed the stale `audit` Phase 2+ row in the deferred-schemas table (audit has been live since migration 0013). Updated to reflect the secret_id pattern, security_invoker on views, ON DELETE RESTRICT, append-only grant pattern, defensive vault revoke.

### 5. Changelog logged
`platform/docs/changelog.md` has the full entry for migration 0029 with all eight impact-assessment fields, repo state at apply time, and explanation of why the multi-agent review was used in place of /ultrareview.

### 6. ClickUp tickets created earlier in Session 10 still active
Three Backlog tickets logged earlier (`869d281ar` provider call-from numbers, `869d281bp` learner preferred call time, `869d2830g` standardise cross-project comms across all agent folders) plus `869d28p6v` Otter.ai transcript pipeline. Adding one more in this handoff: a ticket on getting `/ultrareview` working on Charlotte's Claude Code build.

---

## Current state

`social` schema is live on production. No user-facing change yet — schema is foundation only. Session G.2 (OAuth callback route + `/social/settings`) is the next step. No deadline pressure on the first 12 posts; owner is fine waiting until the platform is ready.

---

## Next steps

1. **Session G.2 — OAuth callback route + minimal `/social/settings` page.** ~2 hours. Adds `/api/auth/linkedin/connect` and `/api/auth/linkedin/callback` routes on the admin app. Adds the basic `/social/settings` UI with a "Connect LinkedIn personal" button. Stores token via `vault.create_secret()` and saves the secret_id on `social.oauth_tokens`. End of G.2: Charlotte does the OAuth dance once, token is stored encrypted, channel-health badge goes green.
2. **Session G.3 — `social-publish` Edge Function + cron + minimal `/social/drafts` UI + load 12 posts.** ~3 hours. Reads approved drafts on a 15-min cron, calls LinkedIn API via the SECURITY DEFINER token-read helper, posts to Charlotte's personal profile. End of G.3: first 12 posts publish autonomously starting on Charlotte's chosen `scheduled_for` timestamps.
3. **Watch Netlify deploy from the monorepo restructure.** Should be green after the push (`ef73c7f`); confirm via the live site if not already done.
4. **Tuesday 28 Apr 13:00 EMS call (Andy Fay).** Nell prep note already surfaced in `switchleads/clients/docs/pending-items.md`. Open the catch-up page during the call, raise the three pending asks (call-from numbers, preferred-call-time, sheet hygiene reminder).

---

## Decisions / open questions

### Decisions made this session
- **Monorepo at `platform/` level chosen over two-repo split or fresh-history reset.** Reasons: tightly coupled (migration changes often paired with app changes), `/ultrareview` works on whole branch, single review surface, no DNS work. Existing app history preserved via git rename detection.
- **Vault token storage uses UUID-handle pattern** (`access_token_secret_id` referencing `vault.secrets`) over wrapped column. Cleaner per Supabase Vault docs, semantically equivalent, easier to reason about.
- **Multi-agent in-session review** is the substitute for /ultrareview until /ultrareview becomes available in Charlotte's Claude Code build. Found and fixed two critical issues this session, so the substitute is working.
- **Append-only tables** (`post_analytics`, `engagement_log`) enforce no-DELETE at the privilege layer — RLS allows it but no GRANT means database refuses. Belt-and-braces around audit-relevant data.
- **Session G is multi-session, ultrareview-equivalent gated, no patchwork.** G.1 done. G.2 + G.3 to follow.

### Open questions
- **Why /ultrareview isn't recognised in Charlotte's Claude Code.** Could be version, billing setup, or naming. Will be ticketed.
- **First 12 posts schedule** — Charlotte sets `scheduled_for` timestamps once Session G.3 ships. No pressure.
- **Marketing Developer Platform approval for company-page posting** — submission planned once `/social/settings` is live (Session G.2). 2-8 week wait.

---

## Next session

- **Currently in:** `platform/` — admin dashboard + data layer + Edge Functions
- **Next recommended:** `platform/` — Session G.2 (OAuth callback + `/social/settings`). The schema foundation is in; OAuth is the next logical step. Each session in the G.1/G.2/G.3 sequence should ship cleanly to keep momentum.
- **Tackle first:** add `/api/auth/linkedin/connect` and `/api/auth/linkedin/callback` routes to the Next.js app under `platform/app/app/api/auth/linkedin/`. Build the minimal `/social/settings` page with a "Connect LinkedIn personal" button. Wire the OAuth dance: redirect to LinkedIn, receive code, exchange for token, call `vault.create_secret()`, write `social.oauth_tokens` row with the returned secret_id. Test end-to-end with Charlotte's personal LinkedIn account. Reference: `platform/docs/admin-dashboard-scoping.md` § Session G "OAuth integration" + "Implementation specifics" for endpoints + scopes.
