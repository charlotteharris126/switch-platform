# Platform Handoff, Session 27, 2026-05-04

## Current state

A/B experiment infrastructure now end-to-end: platform side has migration 0061 applied to `leads.submissions` (`experiment_id` + `experiment_variant` nullable text columns + partial composite index), `_shared/ingest.ts` maps the new payload fields, and `/admin/experiments` surfaces both currently-running tests (read from the live site manifest) and per-variant lead + enrolment data. First real test (`counselling-tees-hero-variant-2026-05`) live since 2026-05-04 — counselling-skills-tees-valley with a funded-urgency challenger; awaiting paid traffic. Iris stages 3+4 architecture rebuild (UI nesting under /admin/analytics) still pending from Session 26 carry-over.

## What was done this session

- **Migration 0061 written + applied to production.** Two new nullable TEXT columns on `leads.submissions` (`experiment_id`, `experiment_variant`) plus a partial composite index `leads_submissions_experiment_idx` on (experiment_id, experiment_variant) WHERE experiment_id IS NOT NULL. Foundation for site-controlled A/B testing on Switchable funded / self-funded / loan-funded landing pages. Additive only; no existing column or row touched. Verified live via `information_schema.columns` lookup. Commit `4dc5088` (migration file). Note: `_shared/ingest.ts` mapping for these fields was bundled into Sasha's Session 26 commit `9c59e9f` (parallel-session collision detected → Sasha renumbered iris-role grant from 0061 to 0063 to avoid the clash; ingest changes shipped with that deploy).
- **`/admin/experiments` page shipped (commit `0e5459b`).** Reads `leads.submissions` for every row carrying `experiment_id`, groups by experiment + variant in JS, renders one section per experiment with submission count, qualified count (DQ-excluded), DQ rate, lift (B vs A) on qualified deltas, and a confidence flag (≥30 qualified per side before reading the lift). Re-applications excluded. Empty state explains the opt-in mechanism. New "Experiments" entry in `admin-shell` Tools nav between Analytics and Social.
- **`/admin/experiments` extended (commit `f07dfcc`).** Two extensions per owner request:
  1. Currently-running tests appear regardless of lead volume. Page now fetches the live experiments manifest from `https://switchable.org.uk/data/experiments.json` (cached 60s) and merges with DB-driven counts. Running tests with zero leads render with empty A/B rows so the test is visibly "in flight" the moment a deploy lands. "Live" / "Ended" pill on each section header. Page URL shown for the live ones.
  2. Per-variant enrolment counts via `crm.enrolments` JOIN on `submission_id IN (... experiment lead ids)`. Status grouping: `enrolled` + `presumed_enrolled` = billable, `open` + `cannot_reach` = in flight, `lost` = lost. New columns: Enrolled, In flight, Lead → enrol % per variant. New "Enrolment lift (B vs A)" stat alongside the existing "Lead lift". Footnote on each section reminds owner enrolment data takes 2-6 weeks to stabilise.
- **Changelog entries added.** Migration 0061 entry + `/admin/experiments` page-live entry, both at the top of `platform/docs/changelog.md`. Commits `4dc5088` (migration entry as part of file) and `ee2cac3` (page-live entry).

## Next steps

1. **Iris stages 3+4 architecture rebuild (`869d511uk`, high priority, Session 26 carry-over).** Owner rejected the standalone /admin/iris-flags + /admin/ads architecture. Nest under /admin/analytics with brand selector (Switchable | SwitchLeads) + Ads as one analytics view. Strip "Iris" from ALL user-facing UI labels (page titles, card headings, button labels, sidebar nav). DB table stays `iris_flags` internally. Plus deploy verification: owner couldn't see Session 26 evening dashboard on /admin overview, confirm push went through. Full detail in `switchable/ads/` Session 24 cross-project push at top of the previous handoff.
2. **`/admin/analytics:418` Blended CPL surgical fix (Session 26 carry-over).** Add `const freshLeads = subs.filter(s => s.parent_submission_id === null).length`, use `freshLeads` in the CPL calc only at line 418. Leave totalLeads/totalQualified alone (events-vs-people distinction is intentional).
3. **Channel B activation (owner action, Session 26 carry-over).** Generate Anthropic API key + PENDING_UPDATE_SECRET, paste into Supabase secrets, flip `CHANNEL_B_ENABLED=true`. Test by editing a provider sheet Updates column.
4. **Apply migration 0065 (Iris stage 5 view, Session 26 carry-over).** Single transaction, no password placeholder. Once applied, /admin/ads cost-per-enrolment tile + drill-down revenue start populating when enrolments accumulate.
5. **Meta Business Verification (owner action, Session 26 carry-over).** Meta Business Manager → Security Centre. 1-3 business days. Unblocks re-deploy of stage 1d patch (preserved in git history pre-rollback).
6. **Meta App Review for `ads_management` + `ads_read` Advanced Access (Session 26 carry-over).** After Business Verification. 5-10 business days. ClickUp `869d4xtng`.
7. **Watch P2.3 over next 7 days (Session 26 carry-over).** Post-fix submissions should normalise drift from -71/+33% to single-digit %. If not, Stape CAPI dedup config is the next layer. Mable's form-side fix (commit `4437855` + follow-up `e8953f3`) shipped + verified working on lead id 262.
8. **Riverside apprenticeship pilot call (Session 26 carry-over).** Tue 5 May 14:00 per master plan critical path. If yes, apprenticeships data model + routing becomes next priority.
9. **`/admin/experiments` cleanup once first test ends.** When the counselling test winner is locked and the page YAML's `experiment:` block is removed, that experiment moves to "Ended" pill. No code action needed; it stays in the historical record automatically.

## Decisions and open questions

**Decisions made this session:**
- **Migration 0061 lands two columns on `leads.submissions` rather than a separate `experiments` table.** Reasoning: per-lead attribution is read-heavy + low cardinality (one experiment_id per submission, one variant per submission); a JOIN to a second table on every analytics read would cost more than two extra columns. Aligned with the existing pattern of attribution columns on the lead row (utm_*, fbclid, gclid).
- **`/admin/experiments` reads experiments.json at runtime rather than mirroring it into the DB.** Reasoning: the manifest is small (a few hundred bytes), updated only on site deploy, fetch+cache at the dashboard layer is simpler than a sync job. If the dashboard ever needs to query "what experiments ran in 2026-Q2?" we'd revisit and persist the manifest history.
- **Enrolment lift surfaced alongside lead lift, not instead of.** Lead lift is the leading indicator (fast, noisy at low volume); enrolment lift is the lagging business-truth indicator (slow, accurate). Surfacing both in the same row lets the owner read the leading early and trust the lagging later. Footnote spells this out.

**Open questions:**
- **Should the experiments manifest history be persisted?** Currently the dashboard only sees experiments that are CURRENTLY running OR have leads in the DB. If an experiment ends with zero leads (dead drop), it disappears. Probably fine for now; revisit if it becomes a gap.
- **Per-variant CPL numbers** would close the loop with `/admin/ads` (which has cost data). Out of scope today; needs joining `meta_daily` ad spend to lead variant — possible future enhancement.

## Watch items

- A/B experiment `counselling-tees-hero-variant-2026-05` running on `/funded/counselling-skills-tees-valley/`. First leads with `experiment_id` populated will appear on `/admin/experiments`. Need ≥30 qualified per side for lift to be readable.
- Iris P2.3 drift watch (Session 26 carry-over): 7-day window from 2026-05-03. Confirm Meta/CAPI dedup normalises post-fix.
- Migration 0065 unapplied (Session 26 carry-over). Owner action.
- Riverside call Tue 5 May 14:00 (Session 26 carry-over).

## Next session

- **Folder:** platform/
- **First task:** Owner decides which Session 26 carry-over to tackle first. Top of the list is the Iris stages 3+4 architecture rebuild (`869d511uk`) since it has owner-rejected work that needs replacing AND a deploy-visibility issue to resolve.
- **Cross-project:** Counterpart `switchable/site/` Session 50 handoff covers the site-side A/B work whose lead/variant data this dashboard reads. No new tasks pushed to other projects this session — `/admin/experiments` is read-only against existing DB columns + a public site URL.
