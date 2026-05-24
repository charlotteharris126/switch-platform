# Platform Handoff, Session 58, 2026-05-24

## Current state

Hotfix session. `/admin/experiments` Construction row had been missing 3 of 4 leads since the experiment launched 2026-05-22. Root cause was `netlify-employer-lead-router/index.ts` silently dropping the `experiment_id` / `experiment_variant` hidden inputs at normalise time — the columns were absent from `EmployerSubmissionRow` and from the INSERT. Code fix shipped, function deployed, 3 historical Construction rows backfilled. Construction A/B integrity restored going forward.

## What was done this session

- **Diagnosed `/admin/experiments` gap.** Compared `leads.submissions` vs the live `/data/experiments.json` manifest. Construction had 4 leads on the experiment page since 2026-05-22 but only 1 carried `experiment_id`; GGTV had 2 leads with 1 missing (the missing one was a separate `switchable-waitlist` DQ path, not the Construction-class bug).
- **Confirmed payload integrity.** `raw_payload->'data'->>'experiment_id'` and `experiment_variant` arrive populated on every Construction submission. Hidden inputs in the deployed HTML correct on both variant A and variant B. Bug isolated to the router's normalise step.
- **Code fix.** `EmployerSubmissionRow` gains `experiment_id: string | null` + `experiment_variant: string | null`. `normalise()` reads via `trimOrNull(strOrNull(data.experiment_id))` / variant equivalent. INSERT column list + VALUES updated in lockstep.
- **Deployed.** `supabase functions deploy netlify-employer-lead-router --project-ref igvlngouxcirqhlsrhga` ran clean 2026-05-24.
- **Backfilled 3 rows** (522 = a, 528 = a, 529 = b) via Charlotte-run SQL in the Supabase editor pulling from `raw_payload->'data'->>'experiment_id'` / `experiment_variant`. Construction now reads 2 A / 2 B from the launch onwards.
- **Changelog entry** added under 2026-05-24 in `platform/docs/changelog.md` documenting the fix + backfill + audit gap (audit script checks the hidden inputs exist in HTML but no platform-side test confirms the router actually persists them).
- **Cross-project inbound (Mable, switchable/site Session 72, 2026-05-24):** migration 0163 `editorial` schema for blog CMS applied + seeded (5 categories, 16 tags from YAML mirrors). Posts table empty awaiting Sasha's Phase 2 admin pages. Build script still reads YAML; flip to DB-read is part of Phase 2. Full scope added to Next steps below.

## Next steps

**PUSH from Mable (switchable/site Session 72, 2026-05-24): Phase 2 CMS admin pages for blog (NEW TOP PRIORITY)**

Migration 0163 applied 2026-05-24 by Mable. `editorial` schema live (posts, tags, categories, post_tags, media), seeded with 5 categories + 16 tags from the YAML mirrors. Posts table empty awaiting admin. Build script still reads YAML for now — flip is part of this work. ClickUp ticket: `869ddyj3b`. Full scope in `platform/docs/changelog.md` 2026-05-24 entry + Mable's handoff at `switchable/site/docs/current-handoff.md` Session 72. Estimated 6-10 hrs across 2-3 sessions:

  1. CMS admin pages: `/admin/blog` upgrade (badge for drafts-awaiting-proof) + `/admin/blog/new` + `/admin/blog/[slug]/edit` + `/admin/blog/tags` (with retroactive-apply UI per Charlotte spec) + `/admin/blog/media` (Supabase Storage upload) + `/admin/blog/content-plan` (pipeline view).
  2. New migration: `editorial.post_ideas` table for the topic queue (seeded by Mable's `/blog-content-plan` skill).
  3. Build script flip: `scripts/build-blog-posts.js` reads `editorial.posts` not YAML. Scheduled-publish auto-flip in same pass.
  4. Data-ops port 4 draft YAMLs into `editorial.posts`. Delete YAML files after.
  5. Supabase Storage `blog-media` bucket with admin-only RLS upload, public read.
  6. Netlify deploy-hook on publish action.
  7. Draft-ready notification: Postgres trigger on INSERT to `editorial.posts WHERE status='draft'` → pg_net.http_post → `notify-draft-ready` Edge Function → Brevo transactional email to Charlotte.

1. **Watch the first new Construction lead post-fix.** Confirm column population at insert (not via backfill). One row landing with both columns set proves the deploy took.
2. **Decide whether to chase the `switchable-waitlist` experiment-attribution gap.** Submission 523 (GGTV DQ via waitlist) landed with NULL `experiment_id` even though the page was on the live experiment. Either the waitlist sub-form on funded pages is missing the hidden input, or the `_shared/ingest.ts` waitlist branch overrides it. Low priority — DQ leads only — but worth a 15-minute audit before the next waitlist-affecting experiment launches.
3. **Add a platform-side router test** to close the audit gap. `scripts/audit-site.js` confirms the hidden inputs exist in deployed HTML, but nothing tests that the routers READ + PERSIST them. A unit test against `normalise()` for both `netlify-lead-router` and `netlify-employer-lead-router` with a sample payload carrying `experiment_id`/`experiment_variant` would have caught this on day one. Pattern: stub-input → call normalise → assert returned row has the fields populated. ~30 min.
4. **Verify SW_MATCH_STATUS drift dropped to ~0** in the most-recent `brevo_attribute_reconcile_async_check_result` row after c49fe58 deployed (S57 next-step #1). If so, fire Re-sync once to clear remaining drift, then run republish-provider-sheet for Riverside to clear the 11 sheet_drift rows.
5. **Design the async_apply chunking + checkpoint pattern** so result rows reliably land (S57 next-step #5). Current behaviour: apply task gets killed by Edge Runtime wall-time before the result-row INSERT runs.
6. **Filter inactive providers** out of `brevo-attribute-reconcile` (S57 next-step #6). 60 errors per Check drift on Courses Direct + WYK paused providers.
7. **Bulk-clean stale dead_letter rows** on `/admin/errors` (S57 next-step #4): 179 partials (pre-hotfix), 9 brevo_chase (pre-no-op-fix), 11 Riverside sheet_drift (cleared by step 4), 1 daily brevo_attribute_drift.
8. ~~PUSH from Mira (Week 1-2) — `/admin/roadmap` MVP.~~ **DONE.** Migrations 0160 + 0161 applied, `strategy.roadmap_tasks` live with 101 seeded tasks, admin page + actions + client shipped at `platform/app/app/admin/roadmap/`. S57 handoff text said "NOT YET APPLIED" but the work landed in S57 itself. Stale carry. Cleared.
9. **PUSH from Mira (Week 2-3) — DQ-to-affiliate landing pages backend.** Route disqualified leads to affiliate partners via existing form routing. Mable owns landing pages.
10. **PUSH from Mira (Week 5-6) — post-course affiliate burst sequence SMS trigger logic.** Brevo automation handoff. Wren owns content.
11. **PUSH from Wren — `lead_call_phone TEXT` on `crm.providers`** as the universal SW_PROVIDER_PHONE fallback. Gate on next non-regional business-audience course or any Switchable template referencing SW_PROVIDER_PHONE on a non-regional provider.
12. **Auto-flip cron + day-12 warning** (carry from S51 / S54 / S55 / S56 / S57). Migration 0097 unapplied. EMS has 50+ leads past 7-day SLA. Apply prospectively from 1 June 2026.
13. **Remote Edge Function deletion** (carry from S54): `supabase functions delete backfill-referral-fastrack-urls --project-ref igvlngouxcirqhlsrhga`, then `backfill-client-nonce`.
14. **Per-provider CPL / CPE / P/L scoreboard** (carry from S49). Still queued.
15. **Infrastructure-manifest update** (carry from S54 + S56): add `brevo-attribute-reconcile-daily`, `drift-digest-daily`, `sms-fastrack-prompt-cron`. Remove `dead-letter-alert-hourly`.
16. **Cannot-reach-no-chaser** to `/admin/errors` (carry from S55). Belongs as a reconciler card.

## Decisions and open questions

**Decisions:**

- **Experiment-attribution fix scoped to the router only.** Did not change the form HTML, the variant-router Edge Function, or the audit script. The hidden inputs were arriving correctly; the bug was server-side at the normalise step. Single change in a single file.
- **Backfill ran via Charlotte's SQL editor**, not via a `/admin/data-ops` panel. Three rows isn't enough to justify the panel pattern. If more router-side attribution bugs surface (or if we audit `_shared/ingest.ts` and find historical drops), promote to a data-ops job.
- **521's anomaly left alone.** Construction lead 521 has the columns set but `raw_payload->'data'->>'experiment_id'` is null. Out of scope — likely a different ingestion path or an early test. Not affecting current attribution.

**Open questions:**

- **Should `switchable-waitlist` carry `experiment_id` / `experiment_variant`?** Funded-page waitlist submissions are DQ-only and won't influence A/B metrics, but if Mable launches a learner-side experiment on the waitlist itself we'd want attribution. Decide before any future waitlist-affecting experiment.
- **Where do platform-side unit tests live?** No test harness exists in `platform/supabase/functions/`. Closing the audit gap (next-step #3) wants a place to put a `normalise()` test. Owner picks: Deno test in-tree, or a separate test directory pattern.

## Watch items

- **First Construction lead post-deploy.** Confirms `experiment_id` + `experiment_variant` land at INSERT, not via backfill. Variant split should track 50/50 over the next ~20 leads (or flag a variant-router issue if it drifts hard).
- **Carries from S57 still live:** SW_MATCH_STATUS drift after c49fe58 (Charlotte's next Check drift), async_apply result rows landing reliably, Riverside sheet drift backfill via republish-provider-sheet, 60 inactive-provider errors per Check drift cosmetic only, first Greater Growth Tees Valley lead routed picking up Jake/George/Nick via LA + fastrack SMS at +10 min.
- **One sasha_test row** in `leads.partials` (id 15920) from S56 hotfix smoke test. Read-only Sasha can't delete. Owner cleanup when convenient.

## Next session

- **Folder:** `platform`
- **First task:** **Phase 2 CMS admin pages for blog** (NEW, pushed from Mable S72). Schema is live (migration 0163, seeded). Build /admin/blog admin set + `editorial.post_ideas` migration + YAML→DB build-script flip + Netlify deploy hook + draft-ready notification. Full scope in Next steps section above + `platform/docs/changelog.md` 2026-05-24 entry. Estimated 6-10 hrs over 2-3 sessions. ClickUp ticket: `869ddyj3b`.
- **Cross-project:**
  - **Mable (switchable/site):** Phase 2 CMS unblocks her ongoing blog drafting rhythm. Once admin pages + DB-read build are live + the 4 YAML drafts are ported, Charlotte stops touching YAML.
  - **Iris (ads):** Construction A/B integrity restored this session (S58 hotfix). She'll see real per-variant counts on `/admin/experiments` next read. No handoff edit required.
  - **Carried platform-side:** Construction-lead INSERT-time verification (next-step #1), waitlist-form attribution gap audit (#2), router unit-test (#3), and the four S57 carried items (Re-sync drift, async_apply chunking, inactive-provider filter, dead_letter cleanup).
