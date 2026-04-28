# Platform Vision: what could make this really special

**Status:** Strategic doc, written 2026-04-25 in answer to Charlotte's prompt: *"how can we make this backend platform really special. i want to run the whole business from here."* Refreshed 2026-04-28 (Session 14) to reflect what shipped and to lock in the principles that have crystallised in flight.
**Purpose:** Collect every feature idea worth considering, categorised. Not a build queue (that's `admin-dashboard-scoping.md`). This is the longer view to inform what gets pulled into Sessions G, H, I onwards.

---

## The pitch in one paragraph

Today the dashboard is a window into the data. The vision is for it to *be the cockpit* — every operational lever, every strategic insight, every cross-business reporting surface lives in one place. Charlotte opens admin.switchleads.co.uk in the morning and the platform tells her: what changed, what to do, what's working, what's at risk. By the time the marketplace ships in Phase 4-5, the same platform also runs the provider portal, the learner subscription, and the recruitment lead-gen pipeline. One backend, every business stream.

---

## What the tiers mean (glossary)

The features below are sorted into six tiers. Tier doesn't mean "priority" exactly — it means *what kind of value the feature unlocks and how soon it's likely worth building*. Each tier has a different shape of justification.

**Tier 1 — high-impact, near-term.** Things that remove daily-life friction or close obvious gaps in the current operating loop. Each one is a small build (hours to a couple of days) with immediate visible payoff. If this platform is going to feel like a *tool you use*, tier 1 is what makes that real. Build these first when the current Session D dashboard work wraps.

**Tier 2 — strategic depth.** Bigger pieces that unlock data or workflows the business *doesn't have yet at all*. Building these takes longer (days to a couple of weeks each) but they create genuinely new business capabilities — closed-loop attribution, automated billing, scaled provider onboarding. These are what move the business from "pilot working" to "operationally robust."

**Tier 3 — AI-native.** Features that use Claude (or similar LLM) to turn the database into something conversational and proactive. Each one is small to build (a single Edge Function calling the API) but transforms the *feel* of the platform — instead of clicking through tables, you ask questions and get summaries. Most appropriate to start once tier 1 and tier 2 have generated enough structured data for AI to be useful on top.

**Tier 4 — provider experience (Phase 4 prep).** Features that move us from "Charlotte runs everything for providers" to "providers self-serve." This is the unlock for scaling beyond ~10 providers without Charlotte being the bottleneck. Build order matters here: read-only portal first (replaces sheets), then write surfaces (outcomes, billing). Per the master plan, Phase 4 is when SwitchLeads stops being a service and starts being a marketplace platform.

**Tier 5 — learner experience.** Features that improve the experience for the *learner* (the person who fills in the Switchable form). Currently the learner submits and goes silent until a provider contacts them. These features fill that silence and gather feedback that improves everything else (provider scoring, ad targeting, conversion). Phase 2 territory in the business roadmap.

**Tier 6 — data foundation.** Less visible, high leverage. Plumbing that makes everything else possible — A/B variant tracking, schema-config sync, multi-hand-off audit trails. These don't have a clear "wow" moment but each one prevents a class of future bug or missed-opportunity. Slot in alongside other work, not as standalone sessions.

---

## Already in scope (named, not yet built)

- **Session E:** live health bar + on-demand audit button (uses `vw_admin_health` already shipped)
- **Session F:** GDPR erase pipeline (blocks on Clara retention input)
- **Session G:** organic social module (LinkedIn + later Meta), Thea's content workflow. **G.1, G.2, G.3, G.4 shipped 2026-04-26 / 2026-04-27.** First autonomous publish proven (Post 2 fired 2026-04-28 09:00 BST, 4-second lag, status `published`). G.5 (`social-draft-generate` autonomous Mon + Thu cron) is the remaining piece.
- **Session H:** Meta + Instagram extension to Session G
- **Session I:** cross-brand reporting module (placeholder added 2026-04-25)
- **Phase 4:** provider portal at `app.switchleads.co.uk`, same codebase, RLS-scoped per provider

The roadmap below is *additive* to those.

---

## Shipped since 2026-04-25 (not in original queue)

These weren't in the build queue at the bottom of this doc. They surfaced in flight as bug fixes, owner asks, or natural follow-ons from items that did ship. Logged here so the queue stays honest.

| Date | Item | Why it happened |
|------|------|-----------------|
| 2026-04-26 | **Realtime auto-refresh fix** (Session 10) | Live bug: a real lead landed without auto-update. `realtime-refresh.tsx` now forwards `TOKEN_REFRESHED`, refreshes on `visibilitychange`/`focus`, reconnects with backoff. |
| 2026-04-26 | **Status taxonomy refactor** (migration 0028) | `open / enrolled / presumed_enrolled / cannot_reach / lost` + `lost_reason` enum + `disputed_at` flag. Operationally separates "couldn't contact" from "contact made, declined". |
| 2026-04-26 | **Per-provider catch-up page** (`/admin/providers/[id]/catch-up`) | Item B from this doc, pulled forward. Tuesday's call gets a dedicated review screen. |
| 2026-04-27 | **Sessions G.1 to G.4** (multi-brand social automation) | 4 schema migrations, 2 Edge Functions, OAuth flow, drafts UI, analytics page. Post 1 published autonomously 2026-04-27. |
| 2026-04-27 | **DQ leak fix** (ticket 869d2rxap) | Self-funded form was sending DQ'd learners to providers as if qualified. Form payload now carries `dq_reason` hidden input, Edge Function honours it, simulator updated, Anita backfilled. |
| 2026-04-27 | **Admin dashboard correctness pass** (Session 13 batch 2) | Overview KPI to distinct emails, leads enrolled badge deepened, providers Total Enrolled + dual conversion, errors page DB reconciliation card, topbar dropdown rewritten as vanilla `UserMenu`. |
| 2026-04-27 | **Migration 0036** | `vw_provider_billing_state.total_routed` redefined as distinct emails per provider. Reconciles with overview KPI. |
| 2026-04-27 | **Awaiting outcome tile fix** | Was querying `enrolments WHERE status='open'` (1 row); now counts routed-no-terminal-outcome (84). |
| 2026-04-28 | **DB tidy data-ops 011** | Deleted 2 archived test routing-log rows + Anita's orphan; resolved 9 dead_letter rows. Reconciliation closes cleanly: 94 routing-log = 89 unique people + 5 same-email duplicates. |
| 2026-04-28 | **Overview business-health redesign** | Pace / Money / Provider scoreboard / Needs attention. Period selector (2d/7d/30d/lifetime). Confirmed vs potential split everywhere. Top-level conversion rate. Free-3 deal explicit. |
| 2026-04-28 | **Lifecycle pills on `/admin/leads`** | All / Qualified / Routed / Awaiting / Enrolled / Lost / DQ / Archived. Each is a self-contained filter. |
| 2026-04-28 | **`/admin/errors` reframe as Data health** | Reconciliation card always visible at top with plain-English explanation. Errors section below with clear empty-state. |
| 2026-04-28 | **Manual ad-spend paste form** (`/admin/ads`) | Interim fallback while Meta API ingestion is blocked on FB device-trust. Same table, distinguishable rows (`ad_account_id='manual_paste'`). |
| 2026-04-28 | **`/admin/analytics` page** | 7 sections: lead source quality, demographics, funnel drop-off, course demand vs supply, DQ patterns, geographic, time patterns. Period-aware. People-grain vs event-grain dedupe rule applied per section. Notable strip at top with deterministic flags. |

---

## Core principles (locked 2026-04-28)

These crystallised over Sessions 13-14 as we untangled drift. Treat them as constraints when scoping any new feature; if a feature would violate one, fix the principle first or change it deliberately.

- **One email = one person.** All people-counting metrics dedupe by `lower(trim(email))`. People-grain metrics (demographics, DQ patterns, geographic, top-level KPIs) use this. Event-grain metrics (sources, funnel, time, raw routing log) keep one row per event because each event has its own UTM, step, or timestamp that would be lost on dedupe.

- **Reconciliation belongs on `/admin/errors` (Data health), not on the overview.** Overview answers "is the business winning?". Errors page answers "does the data add up, and is anything broken?". A user looking at the overview should never have to mentally reconcile two numbers; that's done for them on the errors page.

- **Tidy DB before features.** Manual data hygiene precedes any new build that surfaces or aggregates data. Otherwise drift compounds and every new view inherits the noise. Pattern: spot the anomaly, write a `data-ops/NNN_*.sql` script, owner sign-off, apply, log in changelog.

- **Provider emails never carry learner PII.** Hard rule (`feedback_provider_email_no_pii.md`). Provider notification emails carry lead ID + "check your sheet" only. Sheet is the access-gated channel; email is not.

- **Routing log is append-only audit history.** Once a routing event lands, the row stays. Corrections happen via UPDATE on submissions, not DELETE on routing_log. Exception: archived test rows or fully-corrected misroutes can be cleaned out via dedicated `data-ops/` scripts with owner sign-off (precedent: data-ops 011).

- **Period-aware vs lifetime.** Pace + ad spend respect the period selector. Conversion + revenue + provider state are lifetime. Period-aware conversion is misleading because of enrolment lag (lead routed week 1 might not enrol until week 4); always show conversion as a lifetime KPI.

- **Confirmed vs potential.** Revenue and conversion math shows both: confirmed-only (lock-in, no dispute risk) and potential (incl. presumed enrolments per pilot rule in `business.md`). Single-number views are misleading; pair them.

- **Free-3 per provider always factored into revenue.** Pilot deal: first 3 enrolments per provider are free. Every revenue figure already excludes these. Footnote in the UI keeps the calc transparent so the owner doesn't have to remember the rule.

- **Plain English over jargon on the dashboard.** "Lead recovered from Netlify" not `reconcile_backfill`. "Database matches" not "All accounted for". "Held on DQ panel" not "Step 91". Internal column names stay; user-facing labels translate.

- **Defence in depth on the data ingestion path.** When the form sends a flag (e.g. `dq_reason`), the Edge Function enforces the consequence (`is_dq=true`, `provider_ids=[]`) regardless of what other fields the payload also carries. The form may forget; the Edge Function shouldn't trust it.

- **Manual fallback before automation.** When an automated path is blocked (e.g. Meta API on FB device-trust today), ship the manual paste form first. Same table, distinguishable rows, automation slots in later. Means the dashboard always has data to show, even on day one of a new metric.

---

## Tier 1 — high-impact, near-term

### A. Auto-routing v1
Replace email-confirm for the 80% case (single-candidate provider, opted in). Detailed design in `auto-routing-design.md`.

### B. In-dashboard provider catch-up
Replace the manual Tuesday call with a structured workflow. Charlotte clicks one button → bulk-loads the EMS leads from the last 7 days into a focused review screen → outcomes get marked rapidly. Today's enrolment outcome form is the building block; this is a faster review surface on top of it.

### C. Bulk operations
Multi-select on the leads list. Archive, route, mark-outcome in batches. Cuts catch-up call admin from minutes to seconds when reviewing a campaign's worth of leads.

### D. Lead deduplication
Same email submits twice → today gets two `leads.submissions` rows. Should consolidate (or at least flag with a `parent_submission_id` link) so dashboard counts and provider sheets aren't misleading.

### E. Anomaly detection (Sasha agent extension)
Background process: "EMS lead volume dropped 40% week-over-week" → alert. "WYK Digital first-contact time slipped from 4h to 18h" → alert. KPI patterns, not just thresholds. Sasha already does Monday checks; this extends her to daily/realtime.

---

## Tier 2 — strategic depth

### F. Closed-loop attribution
Every lead lands with UTM context. Every enrolment lands with billable amount (Session D auto-flip + outcome form give us this). Add Meta Conversions API event log per lead, attribution windows, lifetime-value-per-source. Reporting (Session I) joins ad spend → enrolment → revenue end-to-end. *This is the closed-loop attribution that justifies the entire unified data layer over Sheets.*

### G. Revenue / billing module
Track pilot enrolment counts per provider, when free pilot ends, generate invoices via GoCardless integration. Currently 100% manual. At 5+ providers this becomes a daily cost.

### H. Provider onboarding wizard
Today: Charlotte signs them up via Notion → manual sheet creation → manual Apps Script paste → manual DB row insert. Replace with: in-dashboard "Add provider" wizard that creates the DB row, provisions the sheet (Apps Script via Google API), wires the webhook, sets `cc_emails`, generates the agreement page, fires the welcome email. End-to-end in 5 minutes instead of 90.

### I. Cohort analysis
"Of the 20 leads who submitted on May 5, how many enrolled?" Time-cohort views to see lead → enrolment funnel decay. Drives ad spend decisions and provider quality scoring. Reporting module candidate (Session I).

---

## Tier 3 — AI-native features

### J. AI lead triage
For multi-provider leads, AI suggests best routing based on past performance + provider strengths + course type. Charlotte approves or overrides. Replaces the (currently never-built) scoring algorithm with a more flexible reasoning layer.

### K. AI catch-up summaries — DEFERRED (nice-to-have)
**Status 2026-04-26:** Owner deferred. Reason: if the dashboard surfaces the data clearly enough, owner can read it directly; she can also ask Claude in-session if she wants prose. Don't build until/unless the dashboard view becomes too noisy to read at a glance, or owner asks for it. Implication: invest harder in clear data presentation (tiles, breakdowns, provider detail page) instead of AI summarisation on top.

Original spec (kept for future reference): instead of clicking through every routing_log + enrolment, ask *"summarise EMS performance over the last 7 days."* Returns: leads sent, response rate, enrolments expected, anomalies. One paragraph. Same shape as Mira's Monday review but on-demand for any provider, course, or campaign.

### L. AI provider follow-up drafts
"Heena hasn't updated 3 leads in 12 days — draft a check-in email." LLM produces a draft in Charlotte's voice (uses `.claude/rules/charlotte-voice.md`), Charlotte sends. Removes blank-page friction.

### M. Lead-to-content automation
A signed lead's anonymised story (with explicit consent at form time) becomes Thea's social content draft. Closes the loop between Switchable funnel and SwitchLeads brand-building. *"Just sent our 50th counselling lead. Here's what one of them told us."* Auto-drafted on milestone events.

---

## Tier 4 — provider experience (Phase 4 prep)

### N. Provider portal MVP
Already in long-term scope. A leaner v1 first: read-only "your leads" page replacing Google Sheets entirely. Same data, same sortable table, but inside admin.switchleads.co.uk infrastructure with RLS. Removes the Apps Script dependency, removes `SHEETS_APPEND_TOKEN`, removes the per-provider sheet-setup overhead. ~2 weeks.

### O. Provider self-serve outcome marking
Provider logs in, sees their leads, marks outcomes themselves. Replaces the Tuesday call entirely. Charlotte sees it land in real time.

### P. Provider invoicing portal
Provider sees their billable enrolments, downloads invoice, pays via GoCardless. Replaces the manual chase.

---

## Tier 5 — learner experience

### Q. Learner status check page
Learner submits → gets a tracking URL where they can see *"we've matched you with EMS, expect contact within 24 hours."* Builds trust at the most anxious moment. Reduces re-submissions. Reduces "where's my course?" emails.

### R. Learner outcome feedback loop
After enrolment, learner gets a short survey: *"Did the provider call you? Was the course good?"* Closes the loop on lead quality. Drives provider scoring (Tier 3 J).

### S. Learner premium subscription (Phase 2)
£10/month. Already in business roadmap. Backend foundation: `learners` schema, subscription state machine, Stripe integration. Builds on top of the current data layer rather than next to it.

---

## Tier 6 — data foundation (less visible, high leverage)

### T. Form A/B variant tracking
When a hero section A/B tests on a funded course page, the DB should record which variant the lead saw. Today no field for this. Add `variant_id` to the lead payload + a `cms.variants` table tracking what's running. Conversion rate per variant becomes computable.

### U. Course YAML → DB sync
Today course config lives in YAMLs in switchable/site. The DB has `crm.provider_courses` but it's manually populated. Nightly sync hashes every course YAML, writes/updates `crm.provider_courses`, alerts on drift. Closes the gap between content config and CRM.

### V. Multi-hand-off audit
A lead routed to EMS, EMS doesn't take, re-route to WYK. Today this is messy (`primary_routed_to` overwrites). Build "re-route" workflow + audit chain so the full path is visible.

### W. Schema migration playbook in dashboard
Current state: every schema change is a `supabase db push` from CLI. Power user only. A v2 idea: a "Migrations" page in the admin dashboard showing applied/pending, last run, drift status. Self-service for Charlotte to monitor schema state without CLI.

---

## Build queue, refreshed 2026-04-28

Sequencing rebuilt to reflect what shipped, what's now blocking, and what's freshly worth pulling forward.

### Shipped

| Original # | Item | Status |
|---|---|---|
| 1 | Auto-routing v1 (A) | Shipped via Edge Function single-candidate auto-route path + `crm.providers.auto_route_enabled` flag. |
| 2 | Lead deduplication (D) | Shipped (migration 0026, `parent_submission_id` linkage on rapid re-submissions). |
| 3 | In-dashboard provider catch-up (B) | Shipped Session 10 (`/admin/providers/[id]/catch-up`). |

Plus the in-flight additions from the "Shipped since 2026-04-25" table above.

### Up next (priority order, refreshed today)

| # | Item | Tier | Estimate | Why this position |
|---|---|---|---|---|
| 1 | **Meta ad spend ingestion** (NEW; was implicit in F) | 2 | half day to 1 day | Highest-leverage outstanding platform task. Unlocks closed-loop attribution, cost-per-lead, profit/loss math, and the Phase 1 KPI scorecard Mira's been waiting on. Currently blocked on FB device-trust check; manual paste form (`/admin/ads`) is the interim. Build the Edge Function + cron the moment FB unblocks; rest of the platform is wired and waiting. |
| 2 | **Bulk operations (C)** | 1 | half day | Multi-select on the leads list. Archive / mark / route in batches. Friction every day for catch-up calls. |
| 3 | **Anomaly detection (E)** | 1 | 1 day | Daily pattern-watch on top of Sasha's existing Monday checks. Now that the analytics page exists, the rules to watch are concrete and writeable. |
| 4 | **AI follow-up email drafts (L)** | 3 | half day | Click "draft follow-up to Heena", get a draft in Charlotte's voice. Removes blank-page friction. Pairs with the Tuesday catch-up. |
| 5 | **Closed-loop attribution finishing (F)** | 2 | half day | Most of the wiring exists (UTMs persisted on submissions, ad spend ingestion landing). Final layer: per-source CPL on the analytics page, per-source enrolment lifetime value, "best ad" view. Unlocks Mira's £10k revenue model. |
| 6 | **Cohort analysis (I)** | 2 | 1 day | Funnel decay over time. "Of the 20 leads who submitted on May 5, how many enrolled by week 4?" Drives ad spend decisions. Slots naturally next to the analytics page. |
| 7 | **Weekly report email** (NEW) | 1 | half day | Edge Function that emails Charlotte every Monday at 06:00 UK with the analytics highlights + Notable callouts + week-over-week deltas. Removes the "click through 5 pages" tax. Builds on existing analytics + Brevo wiring. |
| 8 | **Multi-hand-off audit (V)** | 6 | half day | Re-routing chain visible (lead routed to EMS, EMS doesn't take, re-routed to WYK). Currently `primary_routed_to` overwrites. Plumbing for a future where re-routing is real. |
| 9 | **Course YAML → DB sync (U)** | 6 | half day | Nightly sync + drift alerting between switchable/site YAMLs and `crm.provider_courses`. Closes the gap between content config and CRM. |
| 10 | **Lead-to-content automation (M)** | 3 | 1 day | Milestones (50th lead, first enrolment) auto-draft Thea's posts. Closes the Switchable to SwitchLeads loop. |
| 11 | **AI lead triage (J)** | 3 | 1 day | When multi-provider courses get real performance data, AI reads lead profile + history and recommends a routing. Phase 2 territory; needs enrolment data first. |
| 12 | **Billing module (G)** | 2 | 2-3 days | Track pilot enrolment counts, free-tier exhaustion, generate invoices via GoCardless. Fires the moment first billable enrolment confirms (Susan, ~10 May). |
| 13 | **Provider onboarding wizard (H)** | 2 | 2-3 days | 90-min manual onboarding to 5-min wizard. Pre-empts next provider sign-up wave. |
| 14 | **Provider portal MVP read-only (N)** | 4 | ~2 weeks | The Phase 4 unlock. Sheets retire, `SHEETS_APPEND_TOKEN` retires, per-provider Apps Script retires. Foundation for #15-16. |
| 15 | **Provider self-serve outcome marking (O)** | 4 | 1 week | Built on top of #14. Tuesday calls die. |
| 16 | **Provider invoicing portal (P)** | 4 | 1 week | Built on top of #12 + #14. Provider self-serves invoices, pays via GoCardless. Manual chase dies. |
| 17 | **Learner status check page (Q)** | 5 | 2-3 days | Tracking URL on the thank-you page. Phase 2 territory. |
| 18 | **Learner outcome feedback survey (R)** | 5 | 2-3 days | Closes the loop on lead quality. Drives provider scoring + ad targeting. |
| 19 | **A/B variant tracking (T)** | 6 | 1 day | When you start running A/B tests on Switchable, this makes outcomes provable. Slot in when first A/B planned. |
| 20 | **Migration UI in dashboard (W)** | 6 | 1 day | Self-serve schema state visibility. Quality-of-life. |
| 21 | **Session G.5: autonomous draft generation** | 3 | 1 day | `social-draft-generate` Edge Function, Mon + Thu cron, Thea writes / owner approves / system schedules. Closes the manual-content-load tax for the social automation. Last piece of Session G. |

### Why this order changed

- **#1 (Meta ad spend) jumped to top.** Wasn't on the original list at all because closed-loop attribution was framed as item 7. In practice, ad spend is the single missing input for half the dashboard's value (CPL, profit/loss, source-level conversion). Owner-flagged on 2026-04-28.
- **AI catch-up summaries (K) stayed deferred.** Owner reasoning held: clear presentation beats AI summarisation. The analytics page + Notable strip is the alternative path, and it ships data faster than prose ever would.
- **Weekly report email is new.** Builds on the analytics page. Trivial to write, removes the "I have to click through to find anything" tax for Mira's Monday review and Charlotte's morning glance.
- **Session G.5 dropped to #21.** Not blocked, but lower leverage than the things above. Posts 2-12 are already queued and publishing autonomously per the cron; G.5 only matters once Thea wants to fully retire the manual-load step.

### What "in this queue" means

Direction, not spec. Each item's full scoping (DB changes, UI design, edge cases) happens at the start of its session. The principles section above is the constraint set every scoping must respect.

---

## How this doc evolves

- Built this 2026-04-25 in response to Charlotte's prompt at session close.
- Update when a tier-X item ships → move to "shipped" section in `admin-dashboard-scoping.md`.
- Add new ideas as they land. No new tier needed for ad-hoc additions — slot into the most natural existing tier.
- This is *deliberately* over-broad. Most of these won't ship in 2026. The doc exists so when the time comes for any of them, the thinking has already been done.
