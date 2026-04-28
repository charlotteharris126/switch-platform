# Architecture Decision: Call records into the admin dashboard

**Date:** 2026-04-28
**Decided by:** Charlotte
**Captured by:** Claude (Nell session, ahead of EMS catch-up call at 13:00)
**Status:** Decided. Build deferred to next platform session window with capacity (after Mettle / GoCardless setup completes; that remains present critical path).

---

## Decision

All call-prep + post-call records — for both prospect calls (Rosa) and signed-provider catch-ups (Nell) — move from the local HTML tool at `switchleads/outreach/call-prep/` into the admin dashboard at `admin.switchleads.co.uk`, attached to the provider record.

One source of truth (`crm.calls` table, working name), two UI views per provider:

- **Catch-up section (Nell):** scheduled catch-ups, prep, transcript, decisions, post-call action items, billing-trigger flags
- **Prospect call section (Rosa):** pre-signing call records, prep, transcript, decisions

## Why

Provider records (`crm.providers`) carry routing config, enrolment data, and (Phase 4) the provider-facing portal. Adding call history to the same record means the relationship trail travels with the company through prospect → signed → active → churn, with no fragmentation. A prospect that signs does not lose its pre-sign call history; it simply transitions to having both sections populated.

Also kills the cross-device-sync friction of the local `file://`-based tool, and removes the need to deploy that tool to its own Netlify subdomain (a backlog item that is now obsolete).

This work re-fires the "Recurring manual DB edits by owner" growth trigger from `platform/CLAUDE.md`. That trigger originally fired 2026-04-22 → admin dashboard delivered (Sessions A-G shipped through 2026-04-27, deployed at admin.switchleads.co.uk). Re-fires here for the call-records workflow that the dashboard doesn't yet cover.

## What this replaces

**Local HTML tool at `switchleads/outreach/call-prep/`:** stays in place for Rosa's prospect calls until the platform version reaches feature parity. After that, retire cleanly per `feedback_stay_tidy.md`. Backlog items in `switchleads/outreach/call-prep/backlog.md` are flagged as obsolete or superseded at the top of that file as of 2026-04-28.

**Nell's current state:** no tooling. Prep in chat, manual NELL LOG updates, post-call routing handled in-session by Claude. The platform version is the first proper Nell tooling.

## Phasing question (open, to confirm at build session)

- **Catch-up side first** (Charlotte's instinct): Nell has zero tooling, 3 active providers, first formal catch-up ran 28 Apr. Direct quality-of-life win, immediate pull.
- **Prospect-call side first:** Rosa has a working tool to copy from, less urgent, more battle-tested workflow.
- **Both in parallel:** only if Sasha has bandwidth and underlying schema is shared anyway.

## Governance

Per `.claude/rules/data-infrastructure.md`:

- New `crm.calls` table ships via a migration file in `platform/supabase/migrations/`
- RLS on by default. Policies: Charlotte read/write; agents read via `readonly_analytics`; Phase 4 provider-facing access scoped to that provider's own rows when the provider portal lights up
- Design first in `platform/docs/data-architecture.md`, then implement
- Changelog entry in `platform/docs/changelog.md` at ship time
- `/ultrareview` before any non-trivial migration ships, per `platform/CLAUDE.md`

Per `.claude/rules/schema-versioning.md`:

- `crm.calls` carries a `schema_version` column
- The Postgres addendum applies — additive changes are free, breaking changes need a new migration

Per the top-level `CLAUDE.md` infrastructure rule:

- Affects three agents: Rosa, Nell, Sasha. All three CLAUDE.md files update at ship time, not before
- New-business template inherits the pattern when it grows a "platform" stub. Flag for future template update; not urgent

## Memory rules to honour at build time

- `feedback_pre_call_reminders.md` — reminder emails are courtesy only, no agenda preview. Any auto-generated reminder content from the workflow respects this
- `feedback_provider_email_no_pii.md` — any provider-facing notification surfaces stay PII-clean
- `feedback_stay_tidy.md` — retire the local tool cleanly when feature parity is reached
- Voice file pairs (`.claude/rules/charlotte-voice.md`, Pairs 1-8 and growing) — any auto-generated email content from the workflow follows the voice rules

## References

- ClickUp Backlog ticket (canonical record): "Move call prep + post-call records into admin dashboard under provider records"
- Existing local tool: `switchleads/outreach/call-prep/`
- Backlog pivot note: `switchleads/outreach/call-prep/backlog.md` (architectural pivot section at top of file)
- Admin dashboard scoping (single source of truth for the admin layer): `platform/docs/admin-dashboard-scoping.md`
- Existing post-call automation pattern: `switchleads/outreach/CLAUDE.md` "Post-call update workflow"
- Data governance: `.claude/rules/data-infrastructure.md`
- Schema versioning: `.claude/rules/schema-versioning.md`
