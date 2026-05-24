# Platform Handoff, Session 58, 2026-05-24

## Current state

High-output session covering five distinct strands: experiment-attribution bug fix, dashboard trust restoration, SEO unblocking, source-attribution + bot filtering on page_views, and the CMS MVP (Mable's S72 push). Three migrations landed (0164 source attribution, 0165 post_ideas), four Edge Function deploys, two repo pushes to switchable/site for the variant-router fixes and sitemap auto-gen, and a full /admin/blog CMS shipped to MVP stage with post CRUD + tag admin + retroactive-apply UI. Charlotte has one data-ops script to run (port the 4 YAML drafts) and one GSC action (submit sitemap + request indexing on top 5 pages). Five CMS pieces remain queued for next session.

## What was done this session

**Strand 1 — Construction experiment attribution restored:**
- Diagnosed `/admin/experiments` Construction row missing 3 of 4 leads since 2026-05-22 launch. Root cause: `netlify-employer-lead-router/index.ts` `normalise()` was silently dropping `experiment_id` / `experiment_variant` hidden inputs (columns absent from `EmployerSubmissionRow` and the INSERT).
- Code fix shipped, function deployed (`supabase functions deploy netlify-employer-lead-router`), 3 historical rows backfilled (522 a, 528 a, 529 b) by Charlotte-run SQL pulling from `raw_payload->'data'`.

**Strand 2 — Dashboard trust restoration (`/admin/experiments`):**
- Charlotte raised that view counts felt "scrambled" — 28x ratio between GGTV and Construction looked unreal.
- Dropped the "Total loads" column from the variant table; surfaced as forensic-only tooltip on Unique sessions. Rate columns already computed against unique_sessions, so no math change — just display cleanup.
- Hit a regression (counselling + SMM read zero post-change because they ran entirely pre-0162 with NULL session_id). Restored the totalLoads fallback with an asterisk + tooltip marking it as raw / pre-clean-tracking.
- Confirmed within-experiment A/B comparisons are clean post-0162; cross-experiment rate comparisons are NOT valid (different audiences, different traffic mixes).

**Strand 3 — Source attribution + bot filtering (migration 0164):**
- Charlotte: "Meta link clicks will be closest, no?" Confirmed the gap between Meta link clicks and our `page_views` row counts (counselling ~700 link clicks vs 4195 loads) is overwhelmingly bot/crawler traffic + pre-0162 refresh inflation.
- Migration 0164 added `user_agent`, `referrer`, `utm_source`, `utm_medium`, `utm_campaign`, `is_bot` columns to `ads_switchable.page_views`. Partial humans-only index. New RPC `get_experiment_view_counts_v3()` returns `total_loads + unique_sessions (humans only) + bot_sessions + null_session_loads`.
- `log-page-view` EF accepts new fields, computes `is_bot` server-side from a comprehensive user-agent regex (search-engine crawlers, SEO scanners, social previewers, uptime monitors, generic HTTP clients).
- `variant-router.ts` (Netlify EF) captures user_agent + referrer + UTM params from request, passes to log-page-view beacon. Adds `?sw_qa=1` URL-param shortcut: any visit with the param sets `sw_is_owner=true` cookie (1-year sticky) so Charlotte can QA from any device without installing the bookmarklet.
- `/admin/experiments` swapped from RPC v2 to v3. Unique sessions cell tooltip surfaces bot_sessions excluded count for forensic transparency.

**Strand 4 — SEO unblocking (Charlotte: "im not ranking at all?"):**
- Critical bug found: `variant-router` was serving variant B's HTML (which carries `<meta robots="noindex,nofollow">`, correct for `/_v/b/` alternate path) at the canonical URL via rewrite. Half the time Googlebot saw the canonical URL as noindex. After ~2 weeks live, `site:switchable.org.uk/business` returned zero results — this was why.
- Fixed: variant-router now detects bot user-agents (same regex as log-page-view) and forces variant A for them. Humans still get random 50/50 first-visit assignment. Same bug affected ALL experiment pages (GGTV, counselling-historic, SMM-historic, construction).
- Sitemap audit: hand-maintained `sitemap.xml` had drifted to 13 URLs while the site had grown to 39 indexable pages. All 4 funded course pages, blog index, 5 categories, 16 tags absent from Google's discovery feed.
- Shipped `scripts/build-sitemap.js` — walks `deploy/` for every `index.html`, filters out `_v/` variants, internal tools, og-preview, pagefind, and any page with `noindex` meta or matching transactional-path regex. Outputs `sitemap.xml` with lastmod + per-section priority + sensible changefreq. Wired into `npm run build`. New course / blog post YAML auto-included on next build — zero hand-editing.

**Strand 5 — CMS MVP (Mable's S72 push):**
- Migration 0165 ships `editorial.post_ideas` (topic queue for `/blog-content-plan` skill).
- `/admin/blog` upgraded from YAML-manifest read to DB read of `editorial.posts`. Drafts pill flagged amber when count > 0.
- `/admin/blog/new` + `/admin/blog/[slug]/edit` — full form: slug + title + dek + excerpt + markdown body with live word + reading-time counter + category dropdown + tags (CSV slug input with unknown-tag warning) + status workflow (draft → scheduled → published → archived) + publish_date + featured + lead-magnet + cover URL + alt + full SEO + OG fields + canonical + target keywords. Reading time auto-computed.
- Drafts have delete; published can only be archived.
- `/admin/blog/tags` — list with usage_count + inline create + inline edit + delete (CASCADE). "Apply to posts" modal opens a checklist of non-archived posts pre-ticked with current taggings; tick/untick + save reconciles in a single transition. This is Charlotte's spec for "create new tag + retroactively apply to older posts".
- `PageHeader` component widened to support `actions` slot (right-aligned button area) and ReactNode `eyebrow` so back-arrow Links render cleanly.
- Architecture: server actions call the authenticated Supabase server client directly (no Edge Function wrapper). Writes are double-gated by `admin.is_admin()` RLS policies from migration 0163.
- Data-ops `047_port_blog_yaml_to_editorial_posts_2026_05_24.js` — idempotent port of the 4 launch YAML drafts into `editorial.posts`. Charlotte runs from `switchable/site/deploy` (where postgres + js-yaml resolve) with DATABASE_URL set.

## Next steps

1. **Charlotte to run the YAML port script.** `cd switchable/site/deploy && DATABASE_URL='<prod>' node ../../../platform/supabase/data-ops/047_port_blog_yaml_to_editorial_posts_2026_05_24.js`. Idempotent — safe to re-run. Unblocks editing the 4 launch drafts via `/admin/blog/[slug]/edit`.
2. **Charlotte to submit sitemap + request indexing in GSC.** Sitemaps → Add new sitemap → `sitemap.xml`. Then URL Inspection → Request Indexing on `/`, `/business/`, `/business/construction/`, `/funded/greater-growth-tees-valley/`, `/find-funded-courses/`. Rate limit ~10/day. Coverage starts appearing in Indexing → Pages within 48 hours.
3. **Build script flip: `scripts/build-blog-posts.js` reads `editorial.posts` not YAML** (CMS Phase 2 #1). Add postgres dep to switchable/site/deploy. New `fetch-blog-posts-from-db.js` step before `build:blog` that fetches posts WHERE status IN ('published', 'scheduled' AND publish_date <= today) plus relations and writes synthetic YAMLs into `data/posts/_db/`. Update `loadPosts()` to merge sources (DB wins on slug collision). Gracefully degrade if DATABASE_URL missing (build continues with YAML only). Netlify env var setup needed — confirm DATABASE_URL is set there. After this lands, move existing YAMLs to `_legacy/` and the live site authoritative source becomes editorial.posts.
4. **`/admin/blog/media` with Supabase Storage upload** (CMS Phase 2 #2). Bucket creation via Supabase dashboard first: `blog-media` with public read, admin-only insert/update RLS. Then upload UI + click-to-copy markdown syntax + alt-text capture + reads from `editorial.media` library.
5. **`/admin/blog/content-plan` pipeline view** (CMS Phase 2 #3). Reads `editorial.post_ideas` (table exists from migration 0165). Pipeline by category: queued / drafted / published / killed. Inline status flip + drag-to-reorder by sort_order.
6. **Netlify deploy hook on publish action** (CMS Phase 2 #4). Server action POSTs to Netlify Build Hook URL when post flips draft → published or status='scheduled' auto-trips. Vault entry needed for the URL.
7. **Draft-ready notification** (CMS Phase 2 #5). Postgres trigger on `editorial.posts` INSERT WHERE status='draft' → `pg_net.http_post` → new `notify-draft-ready` EF → Brevo transactional email to Charlotte. Needs Brevo template ID confirmed.
8. **Verify next Construction lead lands with `experiment_id` + `experiment_variant` populated at INSERT** (not via backfill). Submission 531 was a separate `/business/` non-experiment lead — not the verification we need. Next lead on `/business/construction/` confirms the deploy took.
9. **Decide whether to chase the `switchable-waitlist` experiment-attribution gap.** Submission 523 (GGTV DQ via waitlist) landed with NULL `experiment_id`. Either the waitlist sub-form is missing the hidden input, or the `_shared/ingest.ts` waitlist branch overrides it. Low priority — DQ leads only.
10. **Add a platform-side router test** to close the audit gap (Backlog ticket `869ddxud4` already created). 30 min effort.
11. **Verify SW_MATCH_STATUS drift** dropped to ~0 in the most-recent `brevo_attribute_reconcile_async_check_result` row after c49fe58 (S57 carry). If so, fire Re-sync + republish-provider-sheet for Riverside.
12. **Design the async_apply chunking + checkpoint pattern** so result rows reliably land (S57 carry).
13. **Filter inactive providers out of `brevo-attribute-reconcile`** (S57 carry). 60 errors per Check drift cosmetic noise.
14. **Bulk-clean stale dead_letter rows** (S57 carry): 179 partials (pre-hotfix), 9 brevo_chase (pre-no-op-fix), 11 Riverside sheet_drift, 1 daily brevo_attribute_drift.
15. **PUSH from Mira (Week 2-3) — DQ-to-affiliate landing pages backend** (carry).
16. **PUSH from Mira (Week 5-6) — post-course affiliate burst sequence SMS trigger logic** (carry).
17. **PUSH from Wren — `lead_call_phone TEXT` on `crm.providers`** as the universal SW_PROVIDER_PHONE fallback. Gate on next non-regional business-audience course (carry).
18. **Auto-flip cron + day-12 warning** (carry from S51 / S54 / S55 / S56 / S57). Migration 0097 unapplied. EMS has 50+ leads past 7-day SLA.
19. **Remote Edge Function deletion** (carry from S54).
20. **Per-provider CPL / CPE / P/L scoreboard** (carry from S49).
21. **Infrastructure-manifest update** (carry from S54 + S56). Add `brevo-attribute-reconcile-daily`, `drift-digest-daily`, `sms-fastrack-prompt-cron`. Remove `dead-letter-alert-hourly`.
22. **Cannot-reach-no-chaser** to `/admin/errors` (carry from S55).

## Decisions and open questions

**Decisions:**

- **Experiment-attribution fix scoped to the router only.** Hidden inputs were arriving correctly; bug was server-side at normalise step. Single change in one file.
- **Dashboard "Total loads" demoted to tooltip-only.** It was misleading next to clean unique_sessions and the rate columns. Forensic value retained on hover.
- **Bot filtering happens at log time (server-side) using user_agent regex.** Belt-and-braces: variant-router could compute client-side but the EF is the truth source. Defaults `is_bot=true` when user_agent header missing (humans always send one). False-positive risk acceptable; false-negative risk lower because bots that accept cookies dedupe via session_id anyway.
- **Variant-router serves variant A deterministically to bot user-agents.** Bots see canonical, indexable HTML; humans still get random A/B. No sticky cookie set for bots so future hits stay deterministic. Same regex as log-page-view kept in sync intentionally.
- **Sitemap auto-generated, not hand-maintained.** `npm run build` regenerates every deploy. Drift impossible going forward.
- **CMS architecture: server actions + authenticated Supabase server client + admin RLS gates.** No Edge Function wrapper (unlike `/admin/roadmap`). Editorial writes don't need elevated permissions or cross-schema access — RLS is the right gate.
- **Tag handling v1: comma-separated slug input on the post form** with unknown-tag warning. Full tag management on dedicated `/admin/blog/tags` page.
- **Storage upload deferred to next session.** v1 = cover image as URL field; Charlotte drops files at `deploy/brand/blog/<slug>.jpg`. Bucket + RLS setup happens before the upload UI lands.
- **Within-experiment A/B comparisons are valid; cross-experiment rate comparisons are not.** Different audiences, different traffic mixes. Trust the lift between A and B within each experiment, not the absolute rates between them.

**Open questions:**

- **Where should platform-side router tests live?** No test harness exists in `platform/supabase/functions/`. Deno test in-tree or a separate test directory? Owner picks before next-step #10.
- **Markdown editor for CMS body field: keep textarea v1 or upgrade to Tiptap/Lexical v2?** Mable recommends textarea v1 (which is what shipped). Re-evaluate after first publish.
- **Is DATABASE_URL set on Netlify for switchable-site?** Next-step #3 (build script flip) gates on this. Charlotte to confirm before that session.
- **Brevo template ID for `notify-draft-ready` email** (next-step #7). Either reuse an existing utility template or create new.

## Watch items

- **First new Construction lead post-fix lands with `experiment_id` + `experiment_variant` populated at INSERT.** Proves the employer-lead-router deploy took. Submission 531 was on the generic `/business/` page, not the experiment — still pending verification on `/business/construction/`.
- **Source-attribution columns populate on new page_views rows post-deploy.** First few rows should carry user_agent + referrer + utm_* + is_bot. Confirm via `SELECT * FROM ads_switchable.page_views ORDER BY viewed_at DESC LIMIT 5` after the variant-router Netlify rebuild lands.
- **Bot filtering catches expected categories.** First 24h should show `is_bot=true` rows for Googlebot, Bingbot, link-preview fetchers. If none caught, regex coverage is wrong.
- **Variant-router serves A to bots only.** Once Netlify rebuilds, `curl -A 'Googlebot/2.1' https://switchable.org.uk/business/construction/` should consistently return variant A's HTML (index,follow). If 50/50 still observed, the fix didn't take.
- **GSC sitemap submission status.** Should go from "Pending" → "Success" within 30s of Charlotte submitting. Should report 39 discovered URLs.
- **`/admin/blog` post list reads from DB.** Verify after Netlify rebuild. Empty state visible until Charlotte runs the YAML port script.
- **YAML port script runs cleanly.** 4 ported, 0 skipped (first run). Re-run should show 4 skipped, 0 ported (idempotent).
- **Construction A/B integrity, going forward.** Charlotte's S58 wave of ad spend on `/business/construction/` should show clean per-variant counts within 24h.
- **Carries from S55/S56/S57 still open:** SW_MATCH_STATUS drift after c49fe58, async_apply result rows landing reliably, Riverside sheet drift backfill, 60 inactive-provider errors per Check drift (cosmetic), Greater Growth Tees Valley lead routing path verification, sasha_test row pollution in `leads.partials` (id 15920).

## Next session

- **Folder:** `platform`
- **First task:** Build script flip — wire `scripts/build-blog-posts.js` to read from `editorial.posts` so CMS edits reach the live site. Needs Netlify env var setup (DATABASE_URL) confirmed by Charlotte first. After that lands, ship `/admin/blog/media` (with Supabase Storage bucket setup), `/admin/blog/content-plan`, deploy hook, and draft-ready notification. Full scope in Next steps #3-7.
- **Cross-project:**
  - **Mable (switchable/site):** the variant-router SEO fix + sitemap auto-generator both landed in `switchable/site/deploy`. Pushed to her handoff (Watch items) so she sees the cutover + can verify on her next session. Build script flip is a cross-project surface too — Sasha owns the platform side, Mable owns the build chain integration.
  - **Iris + Solis (switchable/ads + switchable/ads-business):** Construction A/B integrity restored — they can now read `/admin/experiments` Construction row honestly. Source attribution columns on `page_views` going forward mean Iris's MCP queries can attribute paid vs organic vs internal vs bot. Pushed to Solis's S10 handoff Watch items.
  - **Charlotte (owner):** two off-platform actions queued — run the YAML port script (next-step #1), submit sitemap + request indexing in GSC (next-step #2).
