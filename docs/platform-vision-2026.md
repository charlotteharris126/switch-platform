# Platform Vision — what could make this really special

**Status:** Strategic doc, written 2026-04-25 in answer to Charlotte's prompt: *"how can we make this backend platform really special. i want to run the whole business from here."*
**Purpose:** Collect every feature idea worth considering, categorised. Not a build queue — that's `admin-dashboard-scoping.md`. This is the longer view to inform what gets pulled into Sessions G, H, I onwards.

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
- **Session G:** organic social module (LinkedIn + later Meta) — Thea's content workflow
- **Session H:** Meta + Instagram extension to Session G
- **Session I:** cross-brand reporting module (placeholder added 2026-04-25)
- **Phase 4:** provider portal at `app.switchleads.co.uk` — same codebase, RLS-scoped per provider

The roadmap below is *additive* to those.

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

## What I'd recommend prioritising next (after current Session D wraps)

**Status 2026-04-25: all 19 features below approved by owner.** Sequencing locked, build queue per below.

### Build queue (in order)

| # | Item | Tier | Estimate | Why this position |
|---|------|------|----------|--------------------|
| 1 | **Auto-routing v1 (A)** | 1 | 1-2h | Already designed, immediately removes the Charlotte-as-router bottleneck. Easy first win. |
| 2 | **Lead deduplication (D)** | 1 | 2-3h | The Alistair-Divers double-row pattern keeps recurring. Cleans data before more downstream features build on top. |
| ~~3~~ | ~~AI catch-up summaries (K)~~ | ~~3~~ | ~~half day~~ | **Deferred 2026-04-26.** Owner reasoning: if the dashboard surfaces data clearly, she can read it herself; can ask Claude in-session for prose. Re-fire trigger: dashboard becomes too noisy to read at a glance, OR owner asks for it. Implication: prioritise clear presentation over AI summarisation. |
| 3 | **In-dashboard provider catch-up (B)** | 1 | half day | Tuesday's call gets a dedicated review page. Faster bulk-outcome marking. |
| 4 | **Bulk operations (C)** | 1 | half day | Multi-select on the leads list. Archive / mark / route in batches. |
| 5 | **AI follow-up email drafts (L)** | 3 | half day | Click "draft follow-up to Heena," get a draft in Charlotte's voice. Removes blank-page friction. |
| 6 | **Anomaly detection — Sasha extension (E)** | 1 | 1 day | Daily pattern-watch on top of Sasha's existing Monday checks. Catches problems hours after they start. |
| 7 | **Closed-loop attribution wiring (F)** | 2 | 1-2 days | Big payoff for Mira / reporting. Wires UTMs through routing → enrolment → revenue. Foundation for Session I. |
| 8 | **Cohort analysis (I)** | 2 | 1 day | Funnel decay over time. Drives ad spend decisions. Session I work. |
| 9 | **Multi-hand-off audit (V)** | 6 | half day | Re-routing chain visible. Plumbing — slot in alongside other write surfaces work. |
| 10 | **Course YAML → DB sync (U)** | 6 | half day | Nightly sync, drift alerting. Removes "is the YAML in sync with the DB?" question. |
| 11 | **Lead-to-content automation (M)** | 3 | 1 day | Milestones (50th lead, first enrolment) auto-draft Thea's posts. Closes the Switchable→SwitchLeads loop. |
| 12 | **AI lead triage (J)** | 3 | 1 day | When multi-provider courses get real performance data, AI reads lead profile + history and recommends a routing. Phase 2 territory — needs enrolment data first. |
| 13 | **Billing module (G)** | 2 | 2-3 days | Track pilot enrolment counts, free-tier exhaustion, generate invoices via GoCardless. Once 5+ providers are live this becomes daily admin. |
| 14 | **Provider onboarding wizard (H)** | 2 | 2-3 days | 90 min manual onboarding → 5 min wizard. Built before next big provider sign-up wave. |
| 15 | **Provider portal MVP read-only (N)** | 4 | ~2 weeks | The Phase 4 unlock. Sheets retire, `SHEETS_APPEND_TOKEN` retires, per-provider Apps Script retires. Foundation for items 16-17. |
| 16 | **Provider self-serve outcome marking (O)** | 4 | 1 week | Built on top of #15. Tuesday calls die. |
| 17 | **Provider invoicing portal (P)** | 4 | 1 week | Built on top of #13 + #15. Provider self-serves invoices, pays via GoCardless. Manual chase dies. |
| 18 | **Learner status check page (Q)** | 5 | 2-3 days | Tracking URL on the thank-you page. Phase 2 territory. |
| 19 | **Learner outcome feedback survey (R)** | 5 | 2-3 days | Closes the loop on lead quality. Drives provider scoring + ad targeting. |
| 20 | **A/B variant tracking (T)** | 6 | 1 day | When you start running A/B tests on Switchable, this makes outcomes provable. Slot in when first A/B planned. |
| 21 | **Migration UI in dashboard (W)** | 6 | 1 day | Self-serve schema state visibility. Quality-of-life. |

### Why this order

- **#1-6 ship over the next ~2 weeks.** Each builds on Session D foundations. Each removes friction or adds visibility you can feel daily.
- **#7-8 ship in Session I window** — both are reporting / attribution wiring that justify the unified data layer.
- **#9-11 are mid-tier** — useful, not urgent. Slot in alongside larger work.
- **#13-14 ship before next provider wave** — pre-empt scaling pain.
- **#15-17 are Phase 4** — provider portal arc, ~4-5 weeks total, sequenced together.
- **#18-21 are Phase 2 / opportunistic** — learner experience + foundations. Slot in as relevance arises.

### What "approved" means

The shapes are agreed. Each item's full scoping (database changes, UI design, edge cases) happens at the start of its session. This list is the *direction*, not the spec.

---

## How this doc evolves

- Built this 2026-04-25 in response to Charlotte's prompt at session close.
- Update when a tier-X item ships → move to "shipped" section in `admin-dashboard-scoping.md`.
- Add new ideas as they land. No new tier needed for ad-hoc additions — slot into the most natural existing tier.
- This is *deliberately* over-broad. Most of these won't ship in 2026. The doc exists so when the time comes for any of them, the thinking has already been done.
