# Platform Handoff, Session 60, 2026-05-28

## Current state

Continuation session built on top of S59. Three discrete pieces shipped: drift surfaces triaged + Brevo list-ID secret rotated (cuts ~70% of the morning drift email volume); Mira's Build 1 lane hierarchy wired into the existing `/admin/roadmap` MVP (migration 0177, EF + UI extended); admin lead outcome forms now expose the full learner state machine (lead #438 unstuck). All four Phase-1 Mira PUSHes from S58 still open beyond Build 1; Wren's broadcast-gating PUSH still owed.

## What was done this session

**Strand 1 — Drift triage + Brevo list ID rotation:**
- Morning's drift digest carried 160 new dead_letter rows. Three root causes:
  - 106 `edge_function_brevo_chase` rows — Brevo 404 "List ID does not exist" on every email chaser fire. Charlotte had accidentally deleted the SF2 "Provider tried no answer" list and recreated it as ID 11.
  - 24 `netlify_audit` rows — hourly cron flagging `switchable-newsletter` form as not in allowlist. Self-resolved earlier when Mable's `buildNewsletterSignup()` refactor renamed the form to the existing `switchable-blog-subscribers` slot. Audit will go clean on next morning tick.
  - 18 `brevo_transactional_sms` rows — one-off from S59's failed-phone batches. Won't recur.
- Set `BREVO_LIST_ID_PROVIDER_TRIED_NO_ANSWER=11` via `supabase secrets set`. EFs pick up env vars on next invocation; no redeploy. Next email chaser will write to the right list.
- Remaining steady-state drift after fixes: ~10 rows/day (sheet drift + cosmetic carries).

**Strand 2 — Mira's Build 1 lane hierarchy (`/admin/roadmap`):**
- The roadmap MVP page already existed (commit 882d07e, prior session) but pre-dated Mira's 2026-05-25 spec update that introduced the 5 Phase-1 lanes as a top tier above revenue_model. Wired the lane hierarchy through end-to-end.
- Migration 0177: adds `lane` / `lane_sort_order` / `target_milestone` columns to `strategy.roadmap_tasks`. Backfills the existing 101 rows via revenue_model → lane heuristic (e.g. `provider` + `apprenticeship` → `per-enrolment-scale`; `whitelabel` → `provider-os`; `app` + `report` → `deferred-phase-2`; complete-status rows → `complete` lane regardless of model). CHECK constraint locks lane to 7 valid values. **Also fixes a silent-empty RLS-without-GRANT bug** — policy `roadmap_tasks_admin_all` targets `authenticated` but had no matching table GRANT, so the page was rendering zero rows for everyone. Same class as 0114 (lead_notes) and 0175 (sms_log / email_log).
- `admin-roadmap` EF extended: `list` returns the new columns + `ORDER BY lane_sort_order` first; `update` accepts `lane` / `lane_sort_order` / `target_milestone`, derives `lane_sort_order` from the canonical mapping if lane is set without it; `create` requires both and accepts the two new whitelabel split values (`whitelabel-consumer-tools`, `whitelabel-provider-os`).
- `roadmap-client.tsx` UI: two-tier render (lane sections at top with display label + Phase-1 goal text + per-lane completion stats; revenue_model headers as second tier inside each lane). New Lane filter dropdown. Hide-complete defaults ON so the page opens on active work. Per-task lane dropdown lets Charlotte recategorise inline. `target_milestone` rendered as an amber "→ {milestone}" line under the task title.
- Charlotte applied 0177 and confirmed roadmap loads correctly with all 101 tasks across the 5 active lanes + deferred + complete.

**Strand 3 — Lead outcome status set completion:**
- Charlotte flagged lead #438 (Chloe, learner, status `presumed_enrolled`) couldn't be moved to "enrolment meeting booked" via the admin lead detail page. Provider portal correctly locks `presumed_enrolled` as terminal (provider has to email support to unwind).
- Root cause: the admin enrolment-outcome-form's `LEARNER_STATUSES` array only listed open / enrolled / presumed_enrolled / cannot_reach / lost. The four attempt statuses + `enrolment_meeting_booked` were defined in the `EnrolmentStatus` type but missing from the UI dropdown. Same gap on the bulk action bar.
- Added the missing 5 statuses to both surfaces. Admin can now move any learner lead to any state. Provider portal unchanged.

## PUSH from Mira (2026-05-25 strategy Session 18) — Phase 1 platform brief, four builds (carry from S58)

Phase 1 plan sharpened across 5 lanes. **Build 1 — `/admin/roadmap` MVP — shipped this session.** Builds 2-4 still owed. Full context: `strategy/docs/build-map.md` Phase 1 top-level view + `strategy/docs/product-and-revenue-map.md` cash trajectory + `strategy/docs/provider-os-scoping-2026-05-24.md` + `strategy/docs/demand-aggregation-playbook.md`.

**Build 2: Provider OS V1 architecture scoping (Sasha, 2-3 weeks design upfront).** Option B locked: build fresh on a new Supabase project, not refactor existing. Scope deliverable: new-platform schema design + multi-tenancy RLS pattern + tenant settings architecture + GoCardless billing model.

**Build 3: Demand-aggregation aggregation view (Sasha, Phase 1 weeks 3-6).** Pulled forward from month 8-9. View design at `strategy/docs/demand-aggregation-playbook.md`. Aggregates audience by location × course interest × demographic × consent.

**Build 4: Blog cadence agentification (Sasha, Phase 1 weeks 4-6).** Edge Function on pg_cron (Mon/Wed/Fri AM) picks topic from `editorial.post_ideas`, calls Anthropic, inserts `status='draft'`, Brevo notifies Charlotte.

Sequencing: Build 3 → 2 (scoping in parallel) → 4.

## PUSH from Wren (broadcast-gating, 2026-05-25): re-applicant nurture wiring (carry from S58)

`SW_FASTRACK_COMPLETED` per-course + new `SW_PENDING_RESTART` flag + new `SW_COURSE_OPEN` flag. Three related changes in `_shared/route-lead.ts` plus a small course-state source-of-truth wiring, all needed before the EMS new-course broadcast (117 marketing-consented non-enrolled leads) can ship. Detail unchanged from S59 handoff.

## Next steps

1. **CMS Phase 2 carries** (#1-5 from S59 handoff). Build script flip (read `editorial.posts` not YAML), `/admin/blog/media`, `/admin/blog/content-plan`, Netlify deploy hook on publish, draft-ready notification. Build script flip gates CMS becoming live-on-site.
2. **Build 3 — Demand-aggregation view** (Mira PUSH, Phase 1 weeks 3-6). View at `strategy/docs/demand-aggregation-playbook.md`. Wren handoff coordination via switchable/email handoff push.
3. **Build 2 — Provider OS V1 architecture scoping** (Mira PUSH, 2-3 weeks design). Fresh Supabase project.
4. **Build 4 — Blog cadence agentification** (Mira PUSH, Phase 1 weeks 4-6). pg_cron Anthropic drafter.
5. **Wren broadcast-gating PUSH — `SW_FASTRACK_COMPLETED` per-course + `SW_PENDING_RESTART` + `SW_COURSE_OPEN`** (carry). Blocks EMS 117-lead broadcast.
6. **Bulk-clean stale dead_letter rows.** 139 `edge_function_brevo_chase` rows are now obsolete (list ID was wrong, now corrected). Truncate or selectively replay. Same for the older carries from S57 (179 partials pre-hotfix, 9 brevo_chase pre-no-op-fix, 11 Riverside sheet_drift, 1 daily brevo_attribute_drift). Either bulk-mark as replayed_at or just leave — they no longer drive the morning email since the fix.
7. **Investigate recurring `sheet_drift_detected` for EMS subs 20, 82, 148, 198, 362.** Same submissions drift every morning on the `status` column. Either fix the reconciliation or accept the noise floor.
8. **Manually fix or accept typo'd phones on subs 188 + 377** (carry from S59). Stronger normaliser doesn't catch genuine typos.
9. **Auto-flip cron + day-12 warning** (carry from S51-S58). Migration 0097 unapplied. EMS has 50+ leads past 7-day SLA.
10. **Verify next Construction lead lands with `experiment_id` + `experiment_variant` at INSERT** (carry).
11. **Decide whether to chase the `switchable-waitlist` experiment-attribution gap** (carry).
12. **Platform-side router test** (Backlog `869ddxud4`, carry). 30 min.
13. **Verify SW_MATCH_STATUS drift dropped to ~0** in the most-recent `brevo_attribute_reconcile_async_check_result` row after c49fe58 (carry).
14. **Design the async_apply chunking + checkpoint pattern** (carry).
15. **Filter inactive providers out of `brevo-attribute-reconcile`** (carry).
16. **PUSH from Mira (Week 2-3): DQ-to-affiliate landing pages backend** (carry).
17. **PUSH from Mira (Week 5-6): post-course affiliate burst sequence SMS trigger logic** (carry).
18. **PUSH from Wren: `lead_call_phone TEXT` on `crm.providers`** as universal SW_PROVIDER_PHONE fallback (carry).
19. **Remote Edge Function deletion** (carry from S54).
20. **Per-provider CPL / CPE / P/L scoreboard** (carry from S49).
21. **Infrastructure-manifest update** (carry from S54-S57). Add `brevo-attribute-reconcile-daily`, `drift-digest-daily`, `sms-fastrack-prompt-cron`. Remove `dead-letter-alert-hourly`.
22. **Cannot-reach-no-chaser to `/admin/errors`** (carry).
23. **Optional UI polish: failed-chaser indicator** (carry). Subs 188 + 377 currently show "—" in SMS column because they only have `failed` rows.

## Decisions and open questions

**Decisions made this session:**
- **Roadmap lane backfill is heuristic.** Mira can rebalance later if she wants the existing 101 tasks redistributed. Reassignment is one-click via the per-task lane dropdown — no SQL needed.
- **Hide-complete defaults ON in /admin/roadmap.** Opens on active work, not the 24 already-shipped items.
- **Email-chaser dedup not changed.** Despite tonight's brevo_chase failures during the broken-list-ID window, no email_log rows were written (failure happens at list-add before sendTransactional), so there's no closed-loop dedup problem to mitigate. The 139 dead_letter rows are just observability artefacts.
- **Newsletter form name kept as `switchable-blog-subscribers`** (matched existing allowlist entry). No new entry needed. Mable already resolved before this session.

**Open questions:**
- **Bulk-clean strategy for the stale dead_letter rows.** Truncate-all is fastest but loses history; per-source mark-replayed preserves audit. Charlotte's call — pencilled as #6.
- **Sheet drift root cause** for EMS subs 20, 82, 148, 198, 362. Likely the `status` column in EMS sheet has been hand-edited to values the reconciler considers non-canonical. Defer until either Charlotte changes her sheet workflow or the volume becomes painful.
- **Carries from S58 still open:** markdown editor for CMS body, DATABASE_URL on Netlify confirmation, Brevo template ID for `notify-draft-ready`.

## Watch items

- **Brevo list ID 11 active.** Next email chaser fire (auto-fire from attempt_1_no_answer OR a bulk send) should land cleanly with no Brevo 404. If 404s keep coming, the secret didn't propagate or the list ID is wrong.
- **Morning drift email shrinks.** Expected ~10 rows/day from now on instead of 160. Check tomorrow's email at 06:30 UTC to confirm.
- **`/admin/roadmap` loads with all 5 lanes populated** after Netlify rebuild. Lead #438's status flip works in `/admin/leads/438`.
- **Carries from S55-S59 still open:** Construction `experiment_id` populating at INSERT for next lead, SW_MATCH_STATUS drift, async_apply result rows, Riverside sheet drift backfill, GGTV lead routing path verification, sasha_test partial pollution.

## Next session

- **Folder:** `platform`
- **First task:** CMS Phase 2 #1 — build script flip so `editorial.posts` becomes the live blog source. Gates the whole CMS becoming visible on switchable.org.uk. Confirm DATABASE_URL is set on Netlify env first.
- **Cross-project:**
  - **Mable (switchable/site):** the newsletter form audit warning is sorted on her side already — `switchable-newsletter` renamed to `switchable-blog-subscribers`. No outbound push needed.
  - **Wren (switchable/email):** her broadcast-gating PUSH (S58, #10 above) still owed by platform. EMS 117-lead broadcast remains blocked.
  - **Charlotte (owner):** S58 off-platform actions still pending — YAML port script + GSC sitemap submission + indexing requests. Both gate CMS Phase 2 visibility.
