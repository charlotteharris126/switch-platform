# Platform Handoff, Session 27, 2026-05-04

## Current state

Platform-side work in the cleanest state since pilot start. A/B testing infrastructure live end-to-end (migration 0061 + `/admin/experiments` page reading manifest + DB-driven counts + per-variant enrolment lift). Iris dashboard architecture rebuilt per Iris's Session 24 correction: everything nested under `/admin/analytics` with brand selector + view tabs, all "Iris" branding stripped from user-facing UI. Channel B sheet-edit-mirror activated and tested end-to-end with v2 prompt aligned to canonical statuses. Brevo attribute sync wired into both sheet-edit-mirror and pending-update-confirm so SW_ENROL_STATUS catches up automatically and U4 enrolment-celebration automation fires hands-off. Cost-per-enrolment column + tile added to /admin/analytics/ads. Migrations 0065 + 0066 applied (closed-loop view + RLS gap fix on leads.referrals). Comprehensive platform sweep completed: 0 unresolved dead letters, 0 RLS gaps, 0 orphaned/stuck/leaked rows, all 7 active crons succeeding.

## What was done this session

### A/B testing infrastructure (Mable + Sasha co-shipped)
- Migration 0061 written + applied: two new nullable TEXT columns on `leads.submissions` (`experiment_id`, `experiment_variant`) + partial composite index `leads_submissions_experiment_idx`. Foundation for site-controlled A/B testing across Switchable funded / self-funded / loan-funded landing pages. `_shared/ingest.ts` mapping shipped with Sasha's parallel commit (collision detection: Sasha renumbered iris_writer-grant migration from original 0061 to 0063 to avoid the clash).
- `/admin/experiments` page shipped (commits `0e5459b` + `f07dfcc`): groups leads by experiment_id + variant, surfaces submission count, qualified count (DQ-excluded), DQ rate, lead lift (B vs A), confidence flag (≥30 qualified per side); reads live experiments manifest from `https://switchable.org.uk/data/experiments.json` (cached 60s) so currently-running tests appear regardless of lead volume; per-variant enrolment counts via `crm.enrolments` JOIN + new "Enrolment lift" stat alongside lead lift; "Live" / "Ended" pill per section.
- First real test live (`counselling-tees-hero-variant-2026-05`) on counselling-skills-tees-valley with funded-urgency challenger. Awaiting paid traffic.

### Channel B activation + v2 prompt fix
- Charlotte set up `ANTHROPIC_API_KEY`, `PENDING_UPDATE_SECRET`, `CHANNEL_B_ENABLED=true` in Supabase secrets.
- First test sheet edit caught the AI prompt was using pre-migration-0028 status taxonomy (suggested `contacted` which isn't a valid status). Rewrote `sheet-edit-mirror/index.ts` system prompt to constrain AI to canonical 5 (`open / enrolled / presumed_enrolled / cannot_reach / lost`); contact-only notes return null; bumped `PROMPT_VERSION` to v2. Re-tested: same note now correctly returns `implied_status=null`, action `note_only`.

### Brevo attribute sync gap closed (per switchable/email cross-project push)
- `sheet-edit-mirror.handleStatusEdit` and `pending-update-confirm` (Approve/Override path) both UPDATEd `crm.enrolments.status` without firing the Brevo sync, so SW_ENROL_STATUS stayed stale and the U4 "An attribute is updated" automation never fired for sheet-driven or AI-approved status changes.
- Both functions now call `crm.sync_leads_to_brevo` (canonical RPC, migration 0044) inside try/catch. Same pattern as admin Server Actions / one-click chaser / 14-day auto-flip cron. Function-call approach chosen over a DB trigger for now (simpler, matches existing pattern; revisit when third+ write path emerges).

### Iris architecture rebuild (per Session 24 ads cross-project push)
- Rejected standalone `/admin/iris-flags` + `/admin/ads` + `/admin/ads/[ad_id]` shape. Restructured everything under `/admin/analytics`:
  - `/admin/ads` → `/admin/analytics/ads`
  - `/admin/ads/[ad_id]` → `/admin/analytics/ads/[ad_id]`
  - `/admin/iris-flags` → `/admin/analytics/signals`
  - Shared section/actions/button moved to `/admin/analytics/signals/_components/` (Next.js private folder).
- New `/admin/analytics/layout.tsx` with `AnalyticsNav` client component: brand selector (Switchable | SwitchLeads dormant) + view tabs (Overview / Ads / Signals / Experiments). Persists current view across brand switches.
- All "Iris" UI labels stripped: `IrisFlagsSection` → `AdSignalsSection`, "Iris flags" page title → "Ad signals", card heading → "Ad signals", etc.
- Sidebar nav: removed standalone "Ads" + "Iris flags" links. Single "Analytics" entry hosts everything.
- Old route directories deleted (no redirects; admin app, low traffic).

### Cost-per-enrolment column on /admin/analytics/ads
- Added Enrolled count + Cost-per-enrolment cells to per-ad performance table (now 13 columns).
- Headline tile row: 6 tiles (added Enrolled). New prominent Cost-per-enrolment tile underneath, highlighted, with "no enrolments yet in this window" empty-state copy.
- Inline computation (no dependency on migration 0065 view).
- Verified attribution: 17 of 18 lifetime enrolments have `utm_content` + `utm_medium=paid` set. The 1 unattributed has `utm_content='{{ad.id}}'` literal (Meta dynamic-param substitution failed for one historical ad). Last 30 days: £946 spend → 16 attributable enrolments → ~£59 average CPE.

### `/admin/analytics:418` Blended CPL fix (Session 26 carry-over)
- Applied `freshLeads = subs.filter(s => s.parent_submission_id === null).length` and used for the Blended CPL calc only at line 418. `totalLeads` and `totalQualified` left alone (events-vs-people distinction at line 366 is intentional).

### Migrations 0065 + 0066 applied
- 0065 (`ads_switchable.v_ad_to_enrolment` view, closed-loop attribution): applied via SQL editor. Returns zero per ad until enrolments accumulate from real revenue. Page consumers compute inline today; switching to view is a follow-up cleanup.
- 0066 (RLS gap on leads.referrals): audit pass found `functions_writer` had no INSERT policy (Edge Function processReferral was about to fail on first production ?ref= submission) and `readonly_analytics` had no SELECT policy. Two new policies applied; verified via pg_policies (4 rows now).

### CLI migration tracker resync
- Charlotte ran `supabase migration repair --status applied 0048 0050 0051 0052 0053 0054 0055 0056 0057 0058 0059 0060 0061 0063 0064 0065 0066`. CLI in lockstep with production.

### Comprehensive platform sweep
- Spawned Explore subagent for code-level audit (TODO/FIXME, dead code, type holes, hardcoded values, missing error handling, half-built features).
- Ran DB-side audits via Postgres MCP (cron health, dead letter status, RLS gaps, rogue statuses, orphaned rows, owner-test leaks, stuck-unrouted leads, enrolled-unbilled).
- Findings shipped:
  - **Critical: Admin error boundary.** New `app/admin/error.tsx`. Catches uncaught server-side errors in any /admin/* route. Friendly explanation, error.digest reference, retry + go-to-overview buttons, dev-only stack trace.
  - **Critical: Owner-email + dashboard URL helpers.** New `_shared/owner-email.ts` (`getOwnerEmail`, `adminLeadUrl`, `getAdminDashboardUrl`). Replaced ~10 inline duplications + 3 hardcoded `https://admin.switchleads.co.uk` URLs across 5 Edge Functions.
  - **Major: Server action result shape convention.** New `lib/actions.ts` defines `ActionResult<T>` as canonical shape with docstring on when to use it vs custom shapes.
  - **Major: Dashboard query timeout.** New `withTimeout` helper wraps the 18-query Promise.all on /admin overview in 20s race against labelled timeout error. Hard timeout converts hang into clear error caught by error.tsx.
  - **Minor cleanups:** "Coming soon" placeholder removed from /admin/account; magic 600ms debounce constant in realtime-refresh.tsx named with reasoning; OWNER_NOTIFICATION_EMAIL inline constants in sheet-edit-mirror + crm-webhook-receiver replaced by helper.

### `/admin/sheet-activity` drift detection (partial — query only, rendering not landed)
- Built drift-detection query: surfaces enrolments where the latest sheet Status edit's outcome doesn't match current DB status (failed-and-stuck, or mirrored-then-diverged). Limitation explicit: only catches drift originating from sheet edits that fired onEdit; Apps-Script-style silent edits aren't visible.
- Section renderer not yet added to the page. Query wired but JSX missing. Quick follow-up.

### Audit log cross-checks (no fix needed)
- Investigated perceived sheet/DB enrolment drift Charlotte spotted (count mismatch 18 vs 15). Cross-checked her per-row list against DB: every email matched, drift was a counting error not a real divergence. EMS = 11 enrolled + 3 presumed; WYK = 4 enrolled.
- Charlotte deleted the Apps Script that had been auto-flipping sheet statuses + manually reverted the affected sheet rows. DB unchanged (script had only edited sheets, not DB).

### Cross-project pushes
- `switchable/site/`: pixel/CAPI fix work item closed (Mable shipped commits `4437855` + `e8953f3`).
- `switchable/ads/`: Iris architecture rebuild done; "Iris" branding stripped from UI per her brief.
- `switchable/email/`: Brevo attribute sync gap closed; U4 chain hands-off end-to-end.

## Next steps

1. **Verify tomorrow's 09:00 + 09:30 BST cron runs** (08:00 + 08:30 UTC). Both `meta-ads-ingest-daily` and `iris-daily-flags` should fire cleanly. Check `net._http_response` after 08:31 UTC for two 200s. If meta-ads-ingest 502s with "API access blocked", Meta verification gate has refired (see step 4).
2. **Land the `/admin/sheet-activity` drift section JSX.** Query is wired in the page; renderer not yet added. ~10 min: drop a section between PageHeader and tiles that maps over `driftRows` and shows in a small table. Empty state shows green dot + "All sheets in sync ✓".
3. **Watch P2.3 over next 7 days** as post-Mable-fix submissions accumulate. Drift should normalise from -71%/+33% bidirectional to single-digit %. Recalibrate Iris thresholds after 7 days of clean data. If drift stays large, Stape CAPI dedup config is the next layer to investigate.
4. **Meta Business Verification + App Review** (owner action, ClickUp [869d4xtng](https://app.clickup.com/t/869d4xtng)). Multi-day external wait. Once cleared, re-deploy stage 1d patch (preserved in git history at commit `ea683b0` — was the rollback) so meta-ads-ingest populates the 5 metadata columns; that unparks Iris's P2.1 daily health check.
5. **Iris stage 6 (recommendations + Brevo digest)** ([869d511wu](https://app.clickup.com/t/869d511wu)). Independent of Meta verification. Spec at `switchable/ads/docs/ads-dashboard-scope.md` Stage 6. Lives inside the Ads view per the new architecture (not a standalone /admin/recommendations).
6. **Riverside apprenticeship pilot call outcome** (Tue 5 May 14:00, per master plan critical path). If they sign, apprenticeships data model + routing becomes next platform priority over stage 1d backfill.
7. **Watch first `/admin/experiments` data appear** as paid traffic hits the live counselling-tees test. Need ≥30 qualified per side for lead lift to read; enrolment lift is 2-6 week lagging signal.

## Decisions and open questions

**Decisions made this session:**
- **Brevo sync via function call, not DB trigger.** Function-call approach matches existing Server Action pattern and keeps wiring visible in the write code. DB trigger considered but parked: extra complexity (pg_net inside trigger) without clear immediate benefit. Revisit when a third or fourth net-new write path emerges.
- **AI prompt v2 in sheet-edit-mirror.** Constrained to canonical 5 statuses. Contact-only notes default to null. Disputes are no longer a status; AI suggests null and surfaces for owner attention.
- **Iris architecture nested under /admin/analytics.** Brand selector + view tabs at top via shared layout. "Iris" branding stripped from all user-facing UI; DB table iris_flags stays as internal name.
- **Cost-per-enrolment computed inline on /admin/analytics/ads, not from v_ad_to_enrolment view.** Inline computation works regardless of view application status; view stays as a clean source for future Iris P3.1 closed-loop CPA flag automation.
- **Stage 1d not re-attempted this session.** Adding Meta endpoint surface area to a low-trust app re-trips the verification gate (proven in Session 26). Wait for Business Verification.
- **ActionResult convention added but no mass refactor.** Defines shape for new actions; existing rich return types stay (bulk operations carry intentional per-item data). Refactor only when an existing shape is actively confusing.
- **Dashboard timeout via Promise.race not architectural split.** 20s timeout converts hang into a clear error now that error.tsx catches it. Architectural fix (split critical vs optional queries, partial-render) queued for future session.
- **Migration 0061 lands two columns on `leads.submissions` rather than a separate `experiments` table.** Per-lead attribution is read-heavy + low cardinality; JOIN to a second table on every analytics read would cost more than two extra columns. Aligned with existing utm_*, fbclid, gclid attribution columns on the lead row.
- **`/admin/experiments` reads manifest at runtime, not mirrored into DB.** Manifest is small (a few hundred bytes) and updated only on site deploy; fetch+cache at the dashboard layer is simpler than a sync job. Revisit only if dashboard ever needs historical experiments query.
- **Enrolment lift surfaced alongside lead lift, not instead of.** Lead lift is leading indicator (fast, noisy at low volume); enrolment lift is lagging business-truth indicator (slow, accurate). Both visible so owner can read leading early and trust lagging later.

**Open questions:**
- Does the Mable form fix actually close the P2.3 drift, or is Stape CAPI dedup also misconfigured? Watch over next 7 days.
- Should the experiments manifest history be persisted? Currently dashboard sees CURRENTLY-running OR has-leads-in-DB. Dead-drop tests with zero leads would disappear. Probably fine for now.
- Per-variant CPL numbers would close the loop with /admin/analytics/ads (which has cost data). Out of scope today; needs joining `meta_daily` ad spend to lead variant. Future enhancement.
- After Meta verification clears, should the rolled-back stage 1d patch ship as-is or with feature-flagged endpoint additions for safer rollback? Decide when the time comes.

## Watch items

- **Tomorrow's 09:00 + 09:30 BST cron pair.** Both should fire cleanly. If either 502s with OAuthException, Meta verification gate has refired. Escalate to ClickUp 869d4xtng.
- **Live P2.3 drift signal in iris_flags.** One row from Session 26 morning (red, account-wide). Should NOT have a new P2.3 fire today (7-day suppression). Should see smaller signal next week if Mable's fix worked.
- **Meta App un-Development-Moded but no Business Verification.** Recurring "API access blocked" gate possible until Business Verification clears.
- **Stage 1d columns on meta_daily** still NULL across all rows. P2.1 daily health check stays parked until backfill.
- **leads.referrals table empty.** First production ?ref= submission will exercise the newly-policy'd insert path. Worth eyeballing logs after first one lands.
- **`/admin/sheet-activity` drift section query** wired but rendering JSX missing. Section won't show until JSX added.
- **A/B experiment `counselling-tees-hero-variant-2026-05`** running on `/funded/counselling-skills-tees-valley/`. First leads with `experiment_id` populated will appear on `/admin/experiments`. Need ≥30 qualified per side for lift.
- **Riverside call Tue 5 May 14:00.**

## Next session

- **Folder:** `platform/`
- **First task:** Verify both crons fired cleanly (check `net._http_response` after 08:31 UTC for two 200s from meta-ads-ingest + iris-daily-flags). If clean, land the `/admin/sheet-activity` drift section JSX (10 min) — query already wired, just needs the rendered table block.
- **Cross-project:** Three pushes landed in switchable/email (Brevo sync done), switchable/ads (Iris architecture rebuild + UI labels stripped), switchable/site (pixel/CAPI form fix work item closed). All confirmed in step 5 of this `/handoff`.
