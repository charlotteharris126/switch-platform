# Platform Handoff, Session 60, 2026-05-28

## ⚡ PUSH FROM Solis 2026-05-29: B2B Stape server container provisioning (urgent, lead-impact)

Site-layer audit confirms the B2B Stape server container `GTM-P4KGSWSB` has no custom subdomain provisioned, no CAPI tags configured, and is receiving no production traffic. £493 of B2B ad spend flagged as low-data-quality affected. Full diagnosis in `switchable/ads-business/docs/b2b-pixel-pipeline-audit-2026-05-29.md`.

**Sasha's read of scope (2026-05-29):** zero platform-side state change. No schema, no migration, no Edge Function, no `_shared/route-lead.ts` touch. Stape is dashboard infrastructure outside the Postgres governance perimeter set by `.claude/rules/data-infrastructure.md`. No impact assessment doc required. Logged in `platform/docs/changelog.md` (2026-05-29 entry) for the historical record only.

**Status as of 2026-05-29 end of session:**

- **Spec shipped:** `platform/docs/b2b-stape-server-container-playbook-2026-05-29.md` — precise click-through playbook covering DNS CNAME, Stape custom domain activation, the two CAPI tags (Lead + ViewContent) with full field-by-field mapping per the canonical doc, post-fix verification SQL Solis can run from Postgres MCP, and the forward-looking Stape free-tier ceiling watch.
- **Changelog entry:** `platform/docs/changelog.md` (2026-05-29 header).

**Sitting with Charlotte (dashboard work, NOT executable from code):**

- **S-1.** Execute Part A of the playbook (DNS CNAME for `b2b-capi.switchable.org.uk` → Stape target + activate custom domain in Stape). DNS propagation 5-30 minutes. Verify with `dig b2b-capi.switchable.org.uk CNAME +short` before moving to S-2.
- **S-2.** Execute Part B of the playbook (two CAPI tags inside `GTM-P4KGSWSB` per the field tables in `switchable/site/docs/tracking-emq-capi.md` § "B2B-specific overrides"). Pixel ID = B2B Meta pixel ID (confirm in Events Manager which ID is which before saving). All canonical-doc gotchas apply.
- **S-3.** Coordinate Step 8 (test cycle, Part C of the playbook) with Mable + Solis once S-1, S-2, M-1, M-2 are all done. Submit a B2B test lead, verify in Meta Events Manager → B2B pixel → Test Events that a single Lead event arrives with Browser AND Server badges, deduped via `event_id`. Cross-check the Stape dashboard request count rising.
- **S-4 (forward-looking, no immediate action).** Monitor Stape free-tier 10,000-request/month ceiling on `GTM-P4KGSWSB`. Current 5% utilisation. Projected 30% post-fix at current spend, 90%+ at 3x ad spend. Flag to Charlotte at 70% sustained for the paid-tier upgrade (~£20-30/month for 100k events).

**Coordination point:** S-1 must complete BEFORE Mable's M-2 publishes — the web container's `[B2B] Stape Forwarder` tag needs the custom subdomain live to have somewhere to post events. Recommended order: S-1 → Mable M-1 (inventory in parallel with DNS propagation) → S-2 (in parallel with M-1) → Mable M-2 → Step 8 verification.

## ⚡ UPDATE 2026-05-30: Both pipelines live (B2B fix + B2C cutover)

Charlotte executed the dashboard work on 2026-05-30. Sasha's spec was approximately correct but the actual execution surfaced two silent failures that weren't in the original audit:

1. **Invalid Meta CAPI access token** on the B2B pixel. The token in the Stape tag had been wrong since initial setup; Meta rejected every CAPI request with OAuthException 190. Discovered via Claude sending a direct CAPI probe to `https://graph.facebook.com/v18.0/<pixel_id>/events` and reading Meta's response. **Rotated** via Meta Events Manager → B2B pixel → Settings → Generate access token. New token verified working via a second direct probe before pasting into the Stape tag.
2. **B2C External ID field typo** (`{Event Data — external_id}}` — missing one opening brace). Variable never resolved; external_id has been absent from user_data on B2C CAPI events. **Fixed** in the same publish as the B2C cutover.

**Platform-side state of this work (Sasha): still zero schema change, zero migration, zero Edge Function change.** Stape + GTM dashboard infrastructure only. Token rotation is a credential change but not under Postgres governance (token lives in Stape tag config, not Supabase secrets).

**Verification proof captured:**
- Direct curl probes against both Meta pixels returned `events_received: 1` (token + pixel ID + payload format all valid)
- Browser network panel captured the actual `generate_lead` request reaching `b2b.switchable.org.uk` with 200 OK and first-party cookies set on switchable.org.uk
- B2C `b2c.switchable.org.uk` returned proper Stape sGTM responses (HTTP 400 + trace-id for malformed probe = container reachable and serving)

**Followup discovery — `lead-gate.js` vs `ingest.ts` OWNER_TEST_DOMAINS drift.** Server-side had `charlie-harris.com`, browser-side didn't. Mirrored on 2026-05-30. Scope a build-time audit rule that compares the two lists for future-proofing (one-line server-side change emits the list as a build artefact, audit-site.js asserts equality). Backlog for next platform session.

**Backlog for Sasha — GTM + Stape MCP servers (nice-to-have).** Today's debugging required Charlotte to be the eyes on every dashboard surface (GTM tag configs, Stape Domain panel, request volume, etc.). Scoping a service-account-credentialled MCP for Google Tag Manager API + Stape API would let Solis/Iris/Sasha read live tag and container state directly. Per the infrastructure-change rule, requires impact assessment + secrets management before standing up. Not urgent given the fix is in, but a future debugging session would benefit substantially.

**S-4 (free-tier ceiling watch) still active.** Now that B2B events actually flow, utilisation will climb meaningfully. Currently at 9% (mostly pre-fix noise from the kxkzcqdu requests that were discarded). Real usage from 2026-05-30 onward. Flag at 70% sustained for paid-tier upgrade (~£20-30/month for 100k events).

## ⚡ PUSH FROM Mira 2026-05-28: AI tool builds + bespoke conversion-optimised funnels for the learner-side 10-SKU portfolio

Mira strategy Session 19 consolidated the learner-side product stack into a 10-SKU portfolio. Two AI-tool builds and a bespoke-funnel architecture decision sit with Sasha on top of the Phase 1 Builds 2-4 already in-flight.

**Build 5: Eligibility Checker free tool + Pro tier (£8/mo subscription).** AI tool that asks 5-10 questions about the learner's profile (age, employment status, residency, prior quals, sector interest, funding history) and outputs personalised matches to UK funded routes (Skills Bootcamps, FCFJ, Advanced Learner Loans, apprenticeships). Free tier drives Lane 1 funded course traffic directly. Pro tier adds: personalised funded-course recommendations beyond the free output, saved profile + change-notification ("a new Skills Bootcamp matching your profile opened in your area"), eligibility-coach AI chat. Build via Claude/Cursor, 2-3 weeks. Hosted on the existing Switchable infrastructure (NOT on the new Provider OS platform). FIRE-scored as highest-priority tool because the underlying problem (UC + No Level 3 + non-UK quals confusion about what's free) scored 11-12/12 across the buyer-problem matrix.

**Build 6: AI Career Pathfinder freemium + Pro tier (£8-12/mo subscription).** Profile-to-career-matching tool. Free tier matches existing skills to UK funded courses (audience: career changers). Pro tier adds longer pathways + career history mapping + sector-transition coaching via AI chat. Build via Claude/Cursor, 3-4 weeks. Ships months 3-5.

**Build 7: Bespoke conversion-optimised funnel pattern for SLO landing pages.** Mira's recalibrated conversion assumptions explicitly require bespoke-funnel architecture rather than generic Stripe checkout. Two SLO candidates ship across months 1-4 (UC + Funded Study Decision Tool £15, Skills Translator £20), plus two more in months 2-3 (Quals Recogniser £15-20, Bootcamp Application Coach £25). Each needs: custom landing page with personalisation (e.g. acknowledges the visitor's referring niche page or community), Stripe payment integration, instant delivery (PDF download OR access link to gated content), abandoned-cart recovery (3-email sequence triggered on landing-without-purchase), urgency mechanics (notify-me waitlist conversion when pre-sell signal proves PMF), post-purchase upsell to Pro-tier AI tool subscription. Conversion target: 5-12% warm-audience visit-to-paid (vs the 3-5% industry-standard on generic platforms). Pattern needs to be re-usable across the 4 SLOs without re-building per product.

**Build 8: Pre-sell-before-build infrastructure (mandatory gating event for every SLO and AI tool).** Before any product gets built, a one-page pre-sell landing ships and gets posted to 3-5 niche communities for a 7-day intent measurement window. Pre-sell pages need: simple email capture for "notify me when ready" signups, optional £5 pre-order with Stripe (the strongest commitment signal), simple tracking of intent volume per community. Re-usable component template, not per-product custom build. Decides which product to ship first across simultaneous pre-sells (e.g. UC Tool vs Skills Translator SLO pre-sells running in parallel weeks 1-2).

**Build 9 (carries from S18 push): blog cadence agentification.** Already in-flight per S18 Build 4. No change to scope.

**Recalibrated conversion assumptions Sasha needs to design against:** SLO warm conversion target 5-12% (vs 3-5% industry-standard); affiliate per-visitor monetisation target 0.5-3% (vs 0.1-0.5% generic); freemium-to-paid AI tool target 2-12% on free-tier-to-paid (not 1-2% visitor-level). Charlotte explicitly pushed for "think bigger, be bigger" on assumptions; portfolio approach concentrates probability that 2-3 of 8 products hit PMF at the upper end.

Sequencing for these new builds: pre-sell infrastructure (Build 8) ships first as it gates everything else. Bespoke SLO funnel pattern (Build 7) ships in parallel with SLO #1 product build (whichever wins pre-sell). Eligibility Checker (Build 5) and Career Pathfinder (Build 6) sequence after SLO #1 ships and pre-sell discipline is operating. Build 9 unchanged from S18.

Full picture: `strategy/docs/current-handoff.md` Session 19.

---

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
