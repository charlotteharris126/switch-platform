# Platform Handoff, Session 39, 2026-05-11

## Current state

Provider portal hardened end-to-end for EMS cutover: team management on `/provider/account`, public first-time-access guide at `/help/getting-started`, copyable per-lead fastrack + referral URLs on `/admin/leads/[id]`, fastrack-receive now notifies the provider's team on the eager-signal path. New `/admin/data-ops` hub for one-off backfills (024 + 025 both shipped and applied). New "Sheet drift recovery" panel in Data health for on-demand DB → sheet republish. Two latent bugs caught and fixed: `buildFastrackUrl` was emitting an incomplete URL shape (since 2026-05-09), and migration 0109 (`crm.lead_notes`) was missing the `functions_writer` GRANT, which bricked the fastrack DQ flow for lead #375.

## What was done this session

- `/provider/account`: full team-management Card. TeamPanel client component, server-side TeamUserRow loading, `inviteProviderUserAction` Server Action gates on caller `role='provider_admin'`. Re-issue invite per row, plus inline invite form for admins.
- Public help: `/help/getting-started` (phone-first guidance, per-device passkey expectations, concierge "we'll walk you through it" offer). New `/help` layout. Linked from the provider invite email, `/provider/support`, and `/passkey-login` (new footer with first-time-access link + lost-device support).
- Provider portal UX: at-a-glance sidebar click affordance fixed (`key={initialFilter}` on `LeadsTable` so URL changes force remount). Hero strip removed in favour of a small "Past 30 days enrolments" badge top-right. Action-needed pill made compact dark red with clear active/inactive ring state.
- `/admin/data-ops` hub: 024 (Brevo SW_REFERRAL_URL + SW_FASTRACK_URL backfill, 174 audience, 160 mutated) and 025 (client_nonce on funded in-funnel leads). 025 panel auto-hides via `public.count_client_nonce_pending()` RPC (migration 0113). Each panel mirrors with dry-run + confirm-gated apply + before/after spot-checks. 024 ran twice — first pass wrote the `?ref`-only shape, second pass rewrote 160 to the full `?ref&course&m` shape after Charlotte caught the rendering gap.
- `/admin/leads/[id]`: new CopyableUrl widget for per-lead fastrack + referral URLs. Inline "why not available" reason when client_nonce or referral_code missing (pre-0087 funded vs self-funded). Intake fields (`preferred_intake_id`, `acceptable_intake_ids`) surfaced on Course + qualification card.
- `_shared/route-lead.ts buildFastrackUrl()`: rewritten to emit the full `?ref=<n>&course=<slug>&m=<0|1>` shape that the funded thank-you page actually consumes. All 17 Brevo-consuming Edge Functions redeployed twice (once for `BREVO_TIMEOUT_MS` 5→15s + 024 inter-write 100→150ms, once for the URL fix).
- `fastrack-receive`:
  - Step 10 added: notifies every active provider_user when a clean fastrack lands. Skips the auto-DQ paths (`cohort_decline`, `l3_mismatch_self_reported`). End-to-end click-tested.
  - Step 8/9 divergence closed: sheet's `status="Lost"` write is now gated on the DB flip actually succeeding (`rowsAffected > 0`). UPDATE-matched-0-rows is no longer silent.
- Migration 0114: `GRANT SELECT, INSERT ON crm.lead_notes TO functions_writer` + sequence grant. Root cause for lead #375's drift (RLS policy targeted `functions_writer` but only `authenticated` had the table-level grant; PG evaluates GRANT before RLS).
- Republish provider sheet from DB: new `republish-provider-sheet` Edge Function + UI panel on Data health (`/admin/errors`). Provider picker dropdown, deep-link via `?republish=<provider_id>`. Slim link on `/admin/providers/[id]` pointing to it. Provider page stays focused on provider info; reconciliation tooling lives in one place.
- Data health: state-aware "Open Data ops" banner (only shows when `count_client_nonce_pending > 0`). "Resolved (last 5 days)" table removed — page is a live to-do, not an audit trail.
- Brevo cost-of-load mitigation: `BREVO_TIMEOUT_MS` raised 5s → 15s; 024 backfill inter-write delay 100ms → 150ms (was AT Brevo's 10/s ceiling, starved a concurrent route-lead.ts upsert into lead #370's dead-letter).
- Memory entries locked:
  - `feedback_data_ops_admin_panel_pattern.md`: default new backfills to Edge Function + `/admin/data-ops` panel, not local scripts.
  - `feedback_url_features_click_test_before_shipped.md`: any feature emitting a URL needs an actual browser click on the destination before "shipped".
  - `feedback_rls_policy_needs_table_grant.md`: every `CREATE POLICY ... TO <role>` needs a paired `GRANT` on the same table for that role. Second time this class has bitten (Session 38 was the first).

## Next steps

1. **Owner: mark lead #375 (Lisa Parker) Lost manually** via `/admin/leads/375`. Sheet is already at Lost; admin action brings DB inline and clears the dead-letter row. Migration 0114 means new fastrack DQs won't drift the same way.
2. **Daily proactive sheet ↔ DB drift cron** (the detection counterpart to the recovery tool). Needs a `read_all_status` mode on `provider-sheet-appender-v2.gs` (deployed per provider sheet — EMS, WYK, CD, demo), a new Edge Function `sheet-drift-reconcile-daily`, pg_cron schedule, alerting via dead_letter + summary email.
3. **Provider portal remaining asks (queued from earlier in session, none blocking)**: view-as-provider preview for admin, cohort start date + course name filter options on `/provider/leads`, free-text outcome reasons, lead source breakdown, notification preferences split (vital vs optional).

## Decisions and open questions

**Decisions made:**

- **One-off data fixes belong on `/admin/data-ops`, not local scripts.** Charlotte affirmed after the 024 backfill landed: local Deno scripts hit Brevo-key-not-revealable + IPv6-only direct DB host friction; Edge Functions sidestep both. Pattern: Edge Function (auth via vault `AUDIT_SHARED_SECRET`) + admin page panel (dry-run, confirm-gated apply, spot-checks).
- **DB reconciliation tooling lives in Data health, not on individual provider pages.** Charlotte: "any db reconciliation needs to live in data health not be spread out between providers". Short link from provider page deep-links to Data health.
- **Click-test every URL feature end-to-end before claiming shipped.** The SW_FASTRACK_URL shape bug shipped 2026-05-09 and ran for two days because nobody clicked one of the URLs. Memory entry locks the rule.
- **Sheet writes gated on DB writes.** DB is single source of truth for status. Sheet can't flip Lost without DB flipping first.

**Open questions:** none currently. All in-flight items have owners or are queued.

## Watch items

- Lead #375 still at status=open in DB (sheet says Lost). Resolve via admin lead detail page.
- 024 backfill spot-checks confirmed clean post-rewrite (174 audience / 160 mutated / 0 errors on the second apply). No re-run needed unless `buildReferralUrl` / `buildFastrackUrl` wiring changes again.
- 025 backfill panel will hide automatically once owner runs apply. As of session close it's still pending visibility — run dry-run to confirm count.
- The fastrack-notify Brevo email goes via `switchleads` brand transactional. Confirm Brevo deliverability stays clean on first few fastrack events post-launch.
- Daily drift cron is the planned proactive detection. Until it lands, sheet/DB drift detection is operator-discretion (run the republish tool from Data health when you suspect something).

## Next session

- **Folder:** `platform`
- **First task:** Build the daily sheet ↔ DB drift reconcile cron. Start with adding `read_all_status` mode to `provider-sheet-appender-v2.gs`, owner redeploys on each sheet, then build the `sheet-drift-reconcile-daily` Edge Function + pg_cron schedule + dead_letter surface.
- **Cross-project:** switchable/email handoff pushed (Wren's Brevo backfill ask actioned, 174 audience / 160 mutated / 0 errors, pre-broadcast gate cleared).
