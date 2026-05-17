# Platform Handoff, Session 48, 2026-05-16

## Current state

Four things shipped today. (1) U1 funded contact block bug closed end-to-end: `SW_PROVIDER_CONTACT_BLOCK` redesigned twice through the session, landed as three plain-text Brevo contact attributes (`SW_PROVIDER_CONTACT_BEFORE`, `SW_PROVIDER_PHONE`, `SW_PROVIDER_CONTACT_AFTER`) that the U1 funded template wraps with HTML. Five Edge Functions redeployed, 356 existing contacts backfilled (zero errors). (2) U1 funded template collapse: pre/post-fastrack split retired — `sendU1Transactional` always sends the single `u1-funded` template. (3) Provider portal SLA: "First contact" copy reads "Within 1 working day" everywhere and the overdue timer respects Mon-Fri working hours. (4) Admin preview sidebar status links now stay inside the preview namespace.

Wren publishes the new `u1-funded` template referencing the three new attributes; Charlotte deletes the orphan `SW_PROVIDER_CONTACT_BLOCK` attribute + orphan `u1-funded-post-fastrack` template from Brevo once verified.

## What was done this session

### U1 funded contact block — final design

- **`renderProviderContactBlock` removed, replaced with `renderProviderContactValues`** in `_shared/route-lead.ts`. Returns `{ before, phone, after }` plain strings (no `escapeHtml` — Brevo handles escape on `{{contact.X}}` substitution).
- **Three new attributes written from `upsertLearnerInBrevo` + `upsertLearnerInBrevoNoMatch`.** Regional match (EMS today): `before` = "George from Enterprise Made Simple will give you a call to talk it through. Spaces fill fast, so save", `phone` = "07955 265 739", `after` = "in your contacts now and pick up when it rings." Fallback (every non-EMS lead, EMS LA outside the configured set, no_match, pending): `before` carries the unified sentence, `phone`/`after` empty (template's empty `<strong></strong>` renders invisibly).
- **Old `SW_PROVIDER_CONTACT_BLOCK` attribute no longer written.** Orphaned on existing contacts; Charlotte deletes from Brevo dashboard once the new template is verified.
- **Old per-send `SW_PROVIDER_CONTACT_BLOCK` param removed** from `sendU1Transactional`.
- **Three new attributes registered in Brevo as Text type** (Charlotte, dashboard step).
- **Five Edge Functions redeployed** by Charlotte: `routing-confirm`, `netlify-lead-router`, `admin-test-email`, `admin-brevo-resync`, `backfill-sw-provider-contact-block`.
- **356 existing contacts backfilled** via `./scripts/run-039-backfill.sh "AUDIT_KEY"`. Zero errors. Script's exit check fixed (jq's `//` operator treats `false` as null-like; switched to `tostring` so `has_more: false` no longer trips the unexpected-response branch).

### U1 funded template collapse

- **`sendU1Transactional` always sends `BREVO_TEMPLATE_U1_FUNDED`.** `isPostFastrack` derivation deleted; `BREVO_TEMPLATE_U1_FUNDED_POST_FASTRACK` env reference removed.
- **Vault key `BREVO_TEMPLATE_U1_FUNDED_POST_FASTRACK` can stay** (harmless when unread). The orphan Brevo template can be deleted from Transactional → Templates whenever.

### Provider portal SLA copy + weekend-aware timer

- **"First contact" copy now reads "Within 1 working day"** in all three surfaces: `provider/agreement-section.tsx` (home agreement card), `provider/welcome/welcome-deck.tsx` (welcome deck SLA slide), `provider/sla-agreement/page.tsx` (standalone SLA page). Help text adds "weekends don't count".
- **New `lib/working-hours.ts` utility.** Exports `workingMsBetween(start, end)` (sums Mon-Fri elapsed ms via 1-hour `.getDay()` iteration) and `isOverdueWorkingHours(iso, workingHours)`.
- **First-attempt overdue timer rewired to working hours.** Three call sites: `provider/page.tsx`, `admin/preview/[provider_id]/home/page.tsx`, `provider/leads/leads-table.tsx`. `isOverdueRow` signature changed to take `openWorkingHours` instead of `openMs`. Callback + stale-attempt timers stay clock hours (not flagged this session).
- **`sla_first_attempt_hours` column reinterpreted as working hours** (semantic-meaning change — recorded here + in `changelog.md`).
- **Dead constants removed** from `leads-table.tsx`.

### Admin preview sidebar

- **`LeadsSidebar` accepts `leadsHrefBase` prop** (default `/provider/leads`). All status StatLinks use the prop.
- **Preview page passes `/admin/preview/<encoded_provider_id>/leads`** so sidebar clicks stay inside the preview impersonation.

## Next steps

1. **Wait for Wren's u1-funded template publish.** She's on the hook for republishing the single `u1-funded` template referencing `{{contact.SW_PROVIDER_CONTACT_BEFORE}} <strong>{{contact.SW_PROVIDER_PHONE}}</strong> {{contact.SW_PROVIDER_CONTACT_AFTER}}`. She'll confirm when live.
2. **Verify on the next real EMS funded lead.** Submit at `/funded/counselling-skills-tees-valley/`, owner-confirm. U1 should render the named rep + phone in bold, no literal tags, no duplicated "they'll be in touch..." sentence. Eyeball logs to confirm the three attributes pushed correctly.
3. **Verify the non-EMS fallback.** Submit a WYK Camden funded lead, owner-confirm. U1 should render the unified fallback paragraph with `<strong></strong>` invisible.
4. **Delete the orphans from Brevo** once verified: `SW_PROVIDER_CONTACT_BLOCK` attribute (Contacts → Settings → Contact Attributes) + `u1-funded-post-fastrack` template (Transactional → Templates). Both harmless leftovers; no rush.

> **Charlotte directive, 2026-05-16 (post-fix-session) — admin overview rebuild + slowness diagnostic + provider portal fresh-leads filter.** Three pieces of platform-view work. Slowness is the biggest day-to-day pain; tackle that first if it's a cheap diagnose-and-fix, otherwise sequence as A → B → C.
>
> **A. Slowness diagnostic (highest priority, daily friction).** Returning to the platform tab has a lag before clicks are acknowledged. Suspected culprits: (1) the 18-query fan-out on `/admin/page.tsx` re-running on every navigation or tab refocus, (2) Next.js server component revalidation hitting Supabase on focus, (3) no client-side cache between routes so every admin nav hits the DB. The `withTimeout` wrapper in `/admin/page.tsx:59` already acknowledges the fan-out is a known issue ("Architectural-grade fix is to split queries into critical vs optional bundles and partial-render; queued for a future session"). Time to do that split. Likely cheap to investigate, biggest daily-pain item. Could be fixable without touching B.
>
> **B. Overview redesign per Charlotte's spec.** Replace what's on `/admin` with:
>
> - **Duration picker** at top: `2d` / `7d` / `14d` / `30d` / `lifetime` / `custom` (custom date range picker). Existing `PeriodPills` is the starting point but needs the new buckets + custom.
> - **Top-line tiles for the selected date range:**
>   - Total leads (`leads.submissions` count by date range)
>   - Confirmed enrolments (`crm.enrolments` where `status='enrolled'`, by `enrolled_at`)
>   - Cost per lead (ad spend / total leads)
>   - Cost per confirmed enrolment (ad spend / confirmed enrolments)
>   - Confirmed income (per pilot pricing — see open question)
>   - Ad spend (from `ads_*` schemas)
>   - Profit / loss, confirmed (see open question on formula)
> - **Separate small tile:** "Presumed enrolments this period" — just a number. Charlotte expects this to trend to near-nil as auto-flip lands; kept visible for auto-flip cohort tracking.
> - **Provider scorecard table** — per-provider breakdown of all the above metrics for the date range. Four providers today (EMS, Courses Direct, WYK Digital, Riverside).
> - **Summary cards at the bottom:** data health notices (the `vw_admin_health` content) + actions notices (current `actionsCount` from layout). These move from layout/sidebar onto the overview body.
> - **Drop the "ad signals" section** — Charlotte's unclear what it's for on the overview. Move it to its own page (e.g. `/admin/analytics` or `/admin/ads-signals`) or kill if nothing reads it.
>
> **Open question on B — P/L formula:** Charlotte flagged the current profit/loss as inaccurate. Definitional pin-down before rebuild: P/L = confirmed income − ad spend only? Or also net off tooling costs (Brevo, Supabase, GoCardless fees) and provider commissions where applicable? Pricing is per `business.md`: funded enrolment £150 (first 3 free per provider), self/loan 15% of fee (min £75, max £150), apprenticeship enrolment / employer signed £400 flat. First three of each per provider are free. Confirm formula with Charlotte before building.
>
> **C. Provider portal `/provider/leads` — new "Fresh leads" filter.** Sits next to the existing "Overdue" filter on `leads-sidebar.tsx`. Fresh leads displayed FIRST (becomes the default landing tab). Within fresh, order fastrack-completers to the top.
>
> **Open question on C — "fresh" definition:** `created < 24h`? `no contact attempt logged yet`? Both? And confirm fastrack-first ordering = `fastracked_at DESC NULLS LAST`. Pin down with Charlotte before building.

5. **Consider folding callback + stale-attempt timers into working-hours too** for consistency. Charlotte only flagged first-attempt; the other two still use clock hours. Easy follow-up if a provider complains about weekend stale-attempt badges.
6. **Watch invited portal users walk through** (carry from Session 47). Andy, Jake, George, Nick (EMS) and Jane, Freya (Riverside) still at `status='invited'`.
7. **First real B2C ad-driven lead, confirm full chain** (carry from Session 47).
8. **Optional env vars** in Supabase Vault when ready (carry): `BREVO_SENDER_EMAIL_LEADS = hello@switchleads.co.uk`, `OWNER_CC_ALL_EMAILS = hello@switchable.careers`.
9. **Launch WYK + Courses Direct portals** when ready (carry from Session 47).
10. **Preview B2B mode for Riverside.** `LeadsSidebar` accepts `leadType` + `employerStats` props but the admin preview page doesn't pass either, so a Riverside preview shows the learner sidebar. Separate-from-today bug. Fix when Solis touches Riverside again.
11. **Lead-assignment "in session" lock (Phase 2)** (carry).
12. **Tighten data-ops audit-log template** (carry from Session 44).
13. **WYK + CD sheet-vs-DB reconcile** (carry, backlog 869d994nb).
14. **`/provider/leads` N+1 + cursor siblings** (carry, backlog 869d994qf).
15. **`RealtimeRefresh lead_notes` subscription scope** (carry, backlog 869d994t5).
16. **RLS `(SELECT fn())` wrap on `crm.disputes` + `leads.fastrack_submissions`** (carry).
17. **Solis carry-forward** — schema naming `ads_business` vs `ads_switchable_business`. `crm.employer_signings` design before first Riverside Employer Signed event.
18. **CLI migration registry cleanup** (carry from Session 47). 0141 through 0145 in local but not remote per `supabase migration list --linked`. Repair at a calm moment.

## Decisions and open questions

**Decisions:**

- **`SW_PROVIDER_CONTACT_BLOCK` split into three plain-text attributes (`BEFORE`/`PHONE`/`AFTER`).** Why: Brevo's text-type contact attributes always escape-render; `| raw` throws a syntax error and there's no template-side workaround. Wren's call to keep variables plain text and put `<strong>` markup in static template content.
- **U1 funded template collapsed to one.** Wren's call: the regular U1 copy gracefully covers fastracked learners, and the post-fastrack "thanks for sending the extra details" beat duplicated the site thank-you page's ack. `sendU1Transactional` no longer branches on fastrack state.
- **First-attempt SLA reinterpreted as working hours (Mon-Fri).** `crm.providers.sla_first_attempt_hours` value of 24 now means "24 Mon-Fri clock hours". Display reads "1 working day" so the semantics are visible inline. No schema change; reinterpretation happens at the timer call site in code.
- **Callback + stale-attempt timers stay clock-hours** for now (not flagged by Charlotte).
- **Backfill DID run this time** (356 contacts, zero errors). Was skipped earlier in the session when the chained-worker pattern hit Supabase compute limits. Loop-based bash wrapper proved reliable — fresh compute budget per chunk.
- **Migration 0145 header untouched** through all the redesigns (data-infrastructure rule: never edit applied migrations). All change context recorded in `changelog.md` + `data-architecture.md`.

**Open questions:** none this session.

## Watch items

- **Wren's u1-funded template publish.** Once live, verify on the next real EMS funded lead + a WYK non-EMS lead.
- **First Friday-late or Saturday-routed lead post-deploy.** Confirm the overdue badge does NOT fire over the weekend.
- **CLI migration registry drift** (carry from Session 47). 0141 through 0145 in local but not remote. Production correct.
- **Audit row lands on every new SLA acceptance** (carry from Session 46-47).
- **`SLA: X/N accepted` badge** on `/admin/providers/<id>` (carry from Session 46-47).
- **TEST_MODE = false** in Supabase Vault. Re-verify before any session that might trigger a real B2B submission.
- **First real cohort_decline fastrack** (carry from Session 44).
- **First fire of `dead-letter-alert-hourly` cron** (carry from Session 44).
- **First real B2B Riverside submission** (carry from Session 46-47).

## Next session

- **Folder:** `platform`
- **First task:** Verify Wren's new u1-funded template renders correctly on the first real EMS Tees Valley funded lead + a WYK Camden non-EMS lead. Confirm the three attributes resolved correctly, the `<strong>` bold rendered the phone (no literal tags), and the fallback paragraph reads cleanly with no visible empty strong. Once verified live: delete the orphan `SW_PROVIDER_CONTACT_BLOCK` attribute + orphan `u1-funded-post-fastrack` template from Brevo. Optional follow-up: extend the working-hours timer to callback + stale-attempt for consistency.
- **Cross-project:** switchable/email — Wren publishing the new u1-funded template. Once she confirms live, the issue closes.
