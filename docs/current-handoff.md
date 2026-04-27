# Platform — Current Handoff — 2026-04-27 — Session 12 closed (Session G.2 + G.3 shipped — first social post live + 11 queued autonomously)

**Session type:** Continuation of Session 11. After Session G.1 (schema) wrapped and the handoff was written, owner said "g.3" — actually meaning let's keep going. We did G.2 (OAuth flow + settings page) AND G.3 (publish Edge Function + cron + drafts UI) all in one push. End of session: Post 1 of the 12-post batch is LIVE on Charlotte's LinkedIn personal profile, posted autonomously via the cron-driven Edge Function. Posts 2-12 queued with shifted schedule; cron will publish them on date.

**Session opened:** 2026-04-27 morning (continuation of Session 11)
**Session closed:** 2026-04-27 afternoon

---

## What we worked on

### 1. Session G.2 — OAuth + /social/settings (deployed)

- **Migration 0030** — `social.upsert_oauth_token()` SECURITY DEFINER write helper. Atomic: encrypts token via `vault.create_secret()`, upserts metadata row, writes audit row in one transaction. Multi-agent review caught: same-second name collision (fixed via `gen_random_uuid()` suffix), `public` in search_path (removed), caller-supplied `authorised_by` (now uses `auth.uid()` server-side).
- **Two Next.js API routes** added:
  - `/api/auth/linkedin/connect` — generates CSRF state, signs cookie via HMAC, redirects to LinkedIn authorise URL with `openid profile email w_member_social` scopes
  - `/api/auth/linkedin/callback` — verifies CSRF, exchanges code for token, fetches `/v2/userinfo` for member URN, calls `upsert_oauth_token` RPC, redirects to settings page
- **`/admin/social/settings` page** — lists three (brand, channel) cards: SwitchLeads/LinkedIn-personal (available), SwitchLeads/LinkedIn-company (Marketing Developer Platform pending), Switchable/LinkedIn-personal (cross-brand future). Connect button per available card. Reads `social.vw_channel_status` for health badges.
- **Owner set 4 env vars on Netlify**: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`, `OAUTH_STATE_SECRET` (generated server-side, secrets-flagged in Netlify UI).
- **Bug found and fixed: proxy.ts admin-prefix rewrite was breaking the OAuth callback URL.** The proxy rewrites `/foo` → `/admin/foo` based on subdomain so user-facing URLs stay clean. But LinkedIn's registered redirect URI is the bare `/api/auth/linkedin/callback` (no `/admin/` prefix), so the rewrite sent the callback to a non-existent route. Added `/api/auth/{linkedin,meta}/{connect,callback}` to `SHARED_AUTH_PATHS` so they bypass the rewrite.
- **Bug found and fixed: Netlify path filter was suppressing real deploys.** The root `netlify.toml` had `ignore = "git diff --quiet HEAD^ HEAD ./app/"` to skip builds when only docs/migrations changed. It accidentally skipped a real `app/`-only deploy too. Removed the filter — every push triggers a build. Re-add once a working test pattern is found.
- **Supabase Data API exposed-schemas list:** owner had to add `social` to the exposed list manually (Supabase Project Settings → Data API). Without it, `supabase.schema("social").rpc(...)` returns `Invalid schema: social`. **Memory rule saved:** `feedback_supabase_expose_new_schema.md` so this doesn't catch us next migration.
- **End of G.2:** owner ran the OAuth dance for `(switchleads, linkedin_personal)`. Token encrypted in Vault, `social.oauth_tokens` row written, channel-health badge green.

### 2. Session G.3 — Publish Edge Function + cron + drafts UI (deployed)

- **Migration 0031** — `social.get_oauth_access_token(brand, channel)` SECURITY DEFINER read helper. Allowlist-restricted, granted to service_role only. Audit row per call. Edge Functions read tokens through this helper, never via direct vault access.
- **Migration 0032** — pg_cron schedule `social-publish-15min` running every 15 minutes. Idempotent (unschedule-then-schedule guard). Reads `AUDIT_SHARED_SECRET` from Vault per the 0019 pattern.
- **Edge Function `social-publish`** deployed to Supabase. Reads approved drafts where `scheduled_for <= now()`, posts to LinkedIn `/rest/posts` with `LINKEDIN_VERSION=202604`, marks rows `published` / `failed` / `deferred`.
- **Concurrency safety:** `pg_try_advisory_lock` at function entry prevents parallel invocations; CAS UPDATE (`WHERE status='approved'`) prevents double-publish even if the lock fails.
- **Error handling:** 401 marks token expired + defers; 5xx/429 defer for next tick; 4xx fail with publish_error; missing `x-restli-id` treated as failure (not silent empty post-id); content > 3000 chars rejected upfront.
- **LinkedIn-Version churn:** spec said `202401`, multi-agent reviewer suggested `202504`, both rejected by LinkedIn as deprecated/non-existent. `202604` confirmed working live. Bump cadence: revisit in ~9 months.
- **`/admin/social/drafts` page** — read-only list grouped by status (Pending / Approved / Published / Failed / Rejected). Sidebar nav points here. Edit / approve / reject / retry actions deferred to next session.
- **Multi-agent review on G.3 work** caught: cron not idempotent, race condition (double-post risk), missing x-restli-id fallback, missing token null-guard, missing content length check. All addressed before deploy.
- **End-to-end verified live:** Post 1 ("Hidden demand opener") inserted as approved with scheduled_for=now(), publish triggered manually via the cron-equivalent SQL call, function published it to LinkedIn, returned `urn:li:share:7454521458158014464`. Draft row updated to `status='published'` with the post URN.

### 3. 11 batch posts loaded with shifted schedule

Owner approved schedule shift: each remaining post takes the slot of the previous-numbered post in the original schedule (Post 1 went out a day early, so Post 2 takes Post 1's Tue 28 Apr 9am slot, Post 3 takes Post 2's Wed 29 Apr 9am slot, etc.). Tue/Wed/Thu cadence preserved. Series ends Wed 20 May (was Thu 21 May).

All 11 inserted as `status='approved'` (already reviewed during drafting). Cron will publish them at their scheduled times. Next post (Post 2) lands tomorrow Tuesday 28 April ~9am UK.

### 4. ClickUp tickets carrying forward

- `869d2cp0m` — Investigate why `/ultrareview` is unavailable (Backlog, `platform`)
- `869d28p6v` — Otter.ai transcript pipeline (Backlog, `platform`)
- `869d281ar` — Provider call-from numbers (Backlog, `platform` + `switchable-email`)
- `869d281bp` — Learner preferred call time (Backlog, `switchable-site` + `platform`)
- `869d2830g` — Standardise cross-project comms across agent folders (Backlog, `strategy`)

### 5. Memory rules saved

- `feedback_supabase_expose_new_schema.md` — recurring failure prevention for new schemas hitting `Invalid schema` errors

---

## Current state

Social tool is fully wired and operational. First post live on LinkedIn. 11 more queued. Cron runs every 15 minutes. Owner has a read-only `/social/drafts` view to monitor the pipeline. The platform side of Session G is functionally complete; only edit/approve/reject/retry actions in the drafts UI remain (next session, smaller scope).

---

## Next steps

1. **Verify Post 2 publishes Tuesday 28 Apr ~9am UK.** Check LinkedIn around 9-9:15am. If it's there: ✅ end-to-end autonomous publishing proven across a fresh cron tick. If it's not: check `/social/drafts` for the failed status and message.
2. **Build edit / approve / reject / retry actions on `/social/drafts`.** Page is read-only currently. Add server actions + buttons. ~1-2 hours, fresh session. Lets owner adjust drafts before they fire, and recover failed posts.
3. **Apply for LinkedIn Marketing Developer Platform.** Now that `/social/settings` is live, the reviewer can verify the integration. Submission doc at `switchleads/social/docs/linkedin-developer-app-submission.md`. 2-8 week wait. Unlocks company-page autonomous publishing.
4. **Submit Switchable's company LinkedIn page (and Switchable brand activation in `/social`)** when Charlotte starts running organic Switchable social — separate later session.
5. **Once `/social/drafts` actions ship, retire the SQL-INSERT pattern** for loading drafts. The next batch comes through the proper review surface.
6. **Monitor cron health** via Sasha's Monday checks — `vw_cron_runs` should show `social-publish-15min` running cleanly.

---

## Decisions / open questions

### Decisions made this session
- **OAuth `authorised_by` read from `auth.uid()` server-side**, not caller-supplied parameter. Defence-in-depth.
- **Vault secret names use UUIDs**, not timestamps. Race-free under same-second re-authorisation.
- **`social.get_oauth_access_token()` granted to service_role only**, not authenticated. Admin UI never reads raw tokens.
- **Edge Function uses `pg_try_advisory_lock` for concurrency safety** rather than per-row `FOR UPDATE` (cleaner for our scale).
- **LinkedIn-Version `202604` confirmed live 2026-04-27.** Bump cadence: ~9 months. Watch for deprecation notices.
- **Schedule shift: each remaining post takes the previous-numbered slot.** Preserves Tue/Wed/Thu cadence; series ends a day earlier than originally drafted.
- **Drafts UI ships read-only first**, edit/approve/reject/retry deferred to next session.

### Open questions
- **Will Post 2 (and beyond) publish cleanly via cron tomorrow morning?** Should — but worth checking 9-9:15am Tuesday.
- **What's the right edit-experience for the drafts page?** Inline edit vs modal vs separate detail page. Punted to next session's design.
- **Marketing Developer Platform timing** — when to submit. Suggest after a few cron-driven publishes prove the integration to LinkedIn reviewers.

---

## Next session

- **Currently in:** `platform/` — admin dashboard + data layer + Edge Functions
- **Next recommended:** `platform/` — verify Post 2 fired correctly tomorrow morning, then build the `/social/drafts` actions (edit / approve / reject / retry). Smaller scope than G.1/G.2/G.3, contained. After that, move on to the Bulk Operations build queue item or the Tuesday EMS catch-up call prep.
- **Tackle first:** open `/social/drafts` and confirm Post 2 status. If `published`: build the action buttons. If `failed` or stuck on `approved` past its scheduled time: diagnose first.
