# Platform Handoff, Session 65, 2026-06-04

## Current state
Provider portal now surfaces lead re-applications (badge, list bubble, detail-page history) and the fastrack duplicate-notification bug is fixed at the function. Earlier this session: the Switchable Labs platform layer (admin funnel page + PII-minimisation standard). The Codex security backlog is still untouched and remains the main outstanding platform work. Clara has pushed a billing-reconciliation + `/admin/billing` brief (ticket 869djrtgk) — the DB holds no billed/paid state, so monthly invoicing is reconstructed by hand.

## What was done this session
- **Fastrack duplicate notification fixed.** Diagnosed via the data: two `fastrack_submissions` rows shared the identical client-set `submitted_at` → one submission processed twice (Netlify webhook re-delivery and/or the page's fetch-then-native-fallback double-send; not provable which without logs). Migration **0186**: deduped existing pairs (552/557/564) + unique index on `(parent_submission_id, submitted_at)`. `fastrack-receive` EF: `ON CONFLICT DO NOTHING` + idempotent early-return; **plus Codex-authored hardening (deployed, owner-approved):** advisory lock + "prior clean fastrack for this parent" check so only the first clean fastrack (cohort confirmed, L3 not re-flagged) notifies, even if a later delivery carries a different timestamp; recipients deduped by email.
- **Fastrack provider email is now one CC'd email** (to first recipient + cc the rest), not an individual send per person — owner (an EMS portal account holder via `support+ems`) now sees the team on it.
- **Provider portal now surfaces re-applications** (when a learner re-submits, collapsed into the parent lead). Badge on the list + detail page, lead bubbles up the list by most-recent-activity, dated history panel on the detail view ("This learner has enquired more than once"). Mirrored in the admin preview-as-provider view. `/admin/leads` gained a real "Re-submissions: Hidden/Shown" filter (was URL-only). Vicki Smith (id 567, re-applied 4 Jun) was the trigger.
- **Switchable Labs platform layer** (earlier today): `/admin/labs` funnel page (RPCs, migration 0183); PII minimisation (0184/0185) — reporting role reads a direct-identifier-free view, raw signup emails off the API; §6a standard added to `.claude/rules/data-infrastructure.md`.
- Portal "open lead" link confirmed correct (proxy rewrites `/leads/N` → `/provider/leads/N`); not a bug.

## Next steps
1. **Billing reconciliation + `/admin/billing`** (Clara push, ticket 869djrtgk, brief at `platform/docs/billing-section-brief-2026-06-04.md`). Phase 0 backfill of the two historical invoices, Phase A data layer (enrolment billed/paid columns vs `crm.billing_events` authority, `invoice_reference`, `billing_period`, direct-identifier-free per-lead view per §6a), Phase B billing admin section. Additive migrations + view + route.
2. **Security backlog (Codex order, untouched):** provider login OTP binding (#1) → Netlify ingestion auth (#5) → lock `editorial.fire_netlify_blog_build` (#6) → 5 missing `verify_jwt=false` config blocks (#8) → app-code batch (#3/#7/#9/#10/#11/#13).
3. **`leads.submissions` PII follow-up (ticket 869dja09z):** apply §6a to leads — revoke `readonly_analytics` raw SELECT, identifier-free view, repoint agent queries. Impact-assess consumers first.
4. **Labs platform items, deferred to ad-budget gate (ticket 869dja78d):** event dedupe (client `event_id` + unique index), recursive payload size cap, optional event token.
5. **SMS delivery tracking via pull (low):** cron EF on `GET /v3/transactionalSMS/statistics/events`. Redeploy corrected `brevo-sms-event-webhook` as dormant push-fallback.
6. **Carries:** auto-flip cron + day-12 warning (migration 0097 unapplied); CMS Phase 2 build-script flip; demand-aggregation view (Mira); Provider OS V1 scoping (Mira); Wren broadcast-gating; `sql.json` deno-check cleanup (route-lead.ts:1782) + lint.

## Decisions and open questions
**Decisions:**
- Fastrack provider notification fixed server-side (idempotent + first-clean-only), which stops the duplicate regardless of whether the source is Netlify retry or the page double-sending. Source-agnostic by design — exact trigger not pinned.
- Re-application surfacing reads child submissions per parent; no schema change. The list sorts by max(routed_at, latest re-application).
**Open questions:**
- Exact double-send trigger (Netlify webhook retry vs the page's fetch→native-fallback path) — unproven without Netlify logs. Not chased because the server fix is source-agnostic.
- Carries: `crm.billing_events` empty (now owned by the billing brief); chaser 24h resend window (owner decides if same-day repeat chase ever needed).

## Watch items
- **Next EMS fastrack should produce exactly ONE provider email** (verify the fix lands in the wild).
- **Frontend fastrack double-send not yet guarded** — the page's submit script can fall back to a native form submit if the background fetch is slow, sending the same submission twice. Server fix catches it, but the page itself isn't guarded. Pushed to Mable (switchable/site) as a follow-up. Codex said it added a page guard but it's NOT in the workspace files — treat as not done.
- Admin app rebuild — confirm `/admin/labs`, the re-application badges, and the `/admin/leads` re-submissions filter render after deploy.
- `labs.events` holds two bot-flagged test rows (ids 1, 2), filtered everywhere.
- Brevo sender reputation (S63 spam complaint); `crm.billing_events` still empty.

## Next session
- **Folder:** platform
- **First task:** Billing reconciliation/`/admin/billing` (Clara push, ticket 869djrtgk) OR start the security backlog at provider login OTP binding (#1) — owner picks which is more urgent.
- **Cross-project:** Frontend fastrack double-send guard pushed to `switchable/site` (Mable). Billing brief is shared with accounts-legal (Clara, ticket 869djrtgk). `leads.submissions` PII follow-up (869dja09z) and deferred Labs items (869dja78d) live here.
