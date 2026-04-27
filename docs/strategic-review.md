# Strategic Review — Data Architecture & Platform Project

**Author:** Mira (Business Strategist)
**Date:** 2026-04-18
**Trigger:** Iris ads-tracking conversation expanded into a business-wide data layer decision.

---

## What this covers

The decision to establish a proper business data layer now (Supabase + Metabase, with a custom dashboard following in Phase 2-3) rather than continuing with Google Sheets, and the creation of `platform/` as the home for that work.

## Scope of the decision

This is not a small change. It touches:

- Where every piece of business data lives (currently fragmented across Fillout, Netlify Forms, Google Sheets, Meta Ads Manager, with no central store)
- How Iris, Mira, and other agents access data (currently they cannot; Iris has been blocked on access for weeks)
- How the funded funnel stores leads (currently planned as a Google Sheet; changes to Supabase)
- How provider data is managed (currently a Google Sheet; moves to Supabase table)
- The Phase 4 roadmap (brings the proper backend database from "Phase 4 future" to "now")
- Workspace governance (new rule file, new project folder, schema-versioning extension)

## Why now, not later

Three reasons make this the right moment:

1. **Two providers are onboarding (EMS, Courses Direct).** Live ads are days away. Iris needs tracking access to optimise campaigns. A Sheet can track performance but cannot attribute spend to enrolment — which is the metric that decides whether the business model works.
2. **The funded funnel is being built right now.** If the routing scenario lands on a Google Sheet, it gets migrated in 6-12 months. If it lands on Supabase, it doesn't. The marginal setup cost is 1-2 extra days.
3. **Phase 4 already commits to Postgres/Supabase.** We are not introducing a new technology — we are moving it forward in time. All analysis in `switchable/site/docs/funded-funnel-architecture.md` has assumed this destination.

Delaying by 3-6 months means building and then migrating: Sheet-based routing, Sheet-based ad tracking, Sheet-based provider data. Each migration is risk and rework.

## Alternatives considered

**Google Sheets + manual discipline.** Works for ads tracking alone. Cannot support closed-loop attribution (ad → lead → enrolment → revenue). Breaks when lead volume crosses ~50/month across multiple providers. No path to Phase 4 marketplace without migration.

**Airtable.** Pretty UI, better than Sheets. Same fundamental limits: not a real database, limited SQL, poor at joins across tables. ~£20/month for team tier. Still requires migration for Phase 4.

**Custom dashboard from day one, no Metabase.** Right end-state (see below) but too expensive to build now. Would delay ad launch by weeks. Metabase serves as the bridge.

**Delay entirely, revisit at Phase 2.** Possible, but every week of Sheet-based tracking is another week without real attribution data. The campaigns launching this week are the first real data source and the most valuable learning opportunity of the pilot. Losing that signal to Sheet-grade tracking is the cost.

## Impact on this week's critical path

Last weekly review set three priorities: Andy/EMS reply, Courses Direct campaign setup, and Switchable site QA.

**Direct impact:** Low in-week. The platform work is multi-day and runs alongside, not in place of, those priorities. It does not block any of them in week one.

**Second-order impact:** The Courses Direct campaign setup will touch ad tracking and potentially lead routing — the data layer should be at least scaffolded before that campaign goes live. Target: data layer stand-up within 7-10 days.

**Risk of not doing this week:** Campaign goes live with Sheet-based tracking, ads start generating data, later we migrate with data loss or reconciliation pain.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Schema design mistakes lock us into bad structure | Additive changes are free; Postgres is forgiving; `.claude/rules/data-infrastructure.md` codifies change discipline; most "mistakes" are rename-level, not structural |
| Supabase goes down, leads lost | n8n webhook retry + dead-letter table; Netlify Forms also stores submissions natively as backup |
| Secrets leak via iCloud-synced files | Secrets management section of governance rule: env vars only, never in repo files |
| Charlotte cannot read raw tables | Metabase dashboards translate data into human-readable views; Charlotte rarely opens Supabase |
| Scope creep into building a full custom app | Governance caps custom build at defined triggers; Metabase carries dashboard load until Phase 2-3 |
| Breaks existing funded funnel build in flight | Funnel architecture doc updated; form payload schema v1.0 unchanged; only destination shifts |

## What this does NOT do

- Does not install Supabase this session. Only folder scaffolding and governance.
- Does not replace any existing running infrastructure. Netlify Forms, Fillout, current n8n flows continue unchanged until the new architecture is stood up.
- Does not expand agent capabilities this session. Iris still waits on live ad data access until the DB exists and the Meta pull is built.
- Does not commit to Metabase as a permanent tool. Explicit sunset path once the custom CRM dashboard absorbs its role in Phase 2-3.

## Recommended next-session priorities (for the platform project)

1. Owner creates Supabase project (free tier, EU-West region)
2. Install Postgres MCP in Claude Code, user scope
3. Execute initial migration — create all four pilot schemas and tables per `platform/docs/data-architecture.md`
4. Build first n8n flow: Netlify Form submission → `leads.submissions` (running in parallel to existing Sheet for 1-2 weeks to verify)
5. Build Meta Ads daily pull → `ads_switchable.meta_daily`
6. Install Metabase (self-hosted or cloud, owner's choice)
7. Build first four dashboards: ads performance, leads pipeline, provider activity, weekly KPI scorecard
8. Iris's Monday check updated to query Supabase via MCP, properly unblocked
9. Migrate provider Sheet → `crm.providers`, update funded funnel n8n to read from the table

**Target:** data layer operational and tracking live campaigns within 7-10 days of the next session starting.

## Mira's call

Do it. The marginal cost is a few days of setup. The cost of not doing it is building the entire pilot's data flow on a Sheet and then rebuilding when the pilot proves the model. This is the one window where "do it right the first time" is cheaper than "ship fast and migrate later."