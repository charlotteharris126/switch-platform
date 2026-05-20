# Platform Handoff, Session 55, 2026-05-20

## Current state

EMS provider notification routing now scopes by LA per user. New per-user column `notification_las` on `crm.provider_users` carries the LA slug array; new-lead emails (`_shared/route-lead.ts`) and callback-note emails (`admin-notify-callback`) both honour it. Demo providers archived and excluded from the admin demo strip. Courses Direct + WYK Digital flipped to `active=false` to actually block routing while staying visible on the admin list.

## What was done this session

- **Migration 0154 — `notification_las TEXT[]` on `crm.provider_users`.** NULL/empty = catch-all, non-empty = scoped. Seed: George Taylor → Stockton + Hartlepool; Jake Balfour → Middlesbrough + Darlington; Nick Rodgers → Redcar. Andy + Daniel left NULL (catch-all).
- **`_shared/route-lead.ts` updates.** `sendProviderNotification` now takes `sql`, fetches area-scoped CCs via new exported helper `fetchAreaScopedProviderUsers`, threads through `buildCcList` (also exported, dedup against TO). Greeting changed from `Hi ${provider.contact_name ?? "there"}` → `Hello,` in both new-enquiry and re-application templates.
- **`admin-notify-callback` rewritten.** Was one email per provider_user (separate TO each). Now one email with matched provider_users in TO (team sees each other), owner + provider.cc_emails in CC. Filters by lead's `la` via `fetchAreaScopedProviderUsers`. Charlotte CC'd on every callback email (was missing).
- **`admin-test-email` signature updated.** Passes `sql` to `sendProviderNotification`.
- **Data-ops 042 — archive demo providers.** `demo-b2c`, `demo-b2b`, `demo-provider-ltd` set `active=false`, `archived_at=now()`. Their 5 provider_users rows suspended. Hard delete blocked by 13 routing_log + 13 enrolments + 13 submissions FK on demo-provider-ltd; archive across all three for consistency + audit preservation.
- **Admin providers page demo-strip filter.** `/admin/providers` "Demo" badge strip now adds `.is("archived_at", null)` to the `is_demo=true` query so archived demos disappear from the strip.
- **Data-ops 043 — pause Courses Direct + WYK Digital.** Both had `pilot_status='paused'` but `active=true`; routing gates on `active` not `pilot_status`, so they could still receive leads. Flipped `active=false`. Not archived (paused is temporary). Stay visible on admin list with "Inactive" badge.
- **Charlotte's per-provider portal accounts.** Self-invited via `/admin/providers/[id]/` UI as `provider_admin` on EMS (`support+ems@switchleads.co.uk`) and Riverside. Two passkeys total. Decision: per-provider accounts over impersonation — at 4 providers the build cost of impersonation (auth-gate branching, RLS fanout, audit, banner) isn't worth it; revisit at 10+ providers.
- **`crm.provider_users` documented.** New section in `platform/docs/data-architecture.md` (had no entry before). Lists authoritative migration history + notification_las semantics + EMS seed values.

## Next steps

1. **Run data-ops 043** in Supabase SQL editor (pause CD + WYK). 2 rows updated. Charlotte hasn't applied yet.
2. **First-fire verification 06:00-06:30 UTC tomorrow (2026-05-21).** Carries from S54: watch the three reconciler crons land (06:00 sheet-drift → 06:15 brevo-attribute → 06:30 drift-digest). If digest email arrives and pills update, the loop is verified end-to-end.
3. **Watch first real EMS lead.** Confirm CC list matches the LA-based rules: Middlesbrough → Jake in CC, not George/Nick; Stockton → George in CC, not Jake/Nick; Redcar → Nick in CC, not Jake/George. Greeting reads `Hello,` not `Hi Andy Fay,`.
4. **Remote Edge Function deletion (carry from S54).** `supabase functions delete backfill-referral-fastrack-urls --project-ref igvlngouxcirqhlsrhga`, then same for `backfill-client-nonce`. Repo source already gone.
5. **Auto-flip cron + day-12 warning email (carry from S51, reopened S54).** Migration 0097 still unapplied. 37 EMS stale leads waiting. Pre-conditions: Brevo warning template, provider heads-up emails, Mira's activity-gate framework, optional `auto_flip_enabled` per-provider flag.
6. **Per-provider CPL / CPE / P/L scoreboard (carry from S49).** Still queued.
7. **Brevo orphan deletion** once Wren confirms `u1-funded` template verified live (carry from S48-49).
8. **Infrastructure-manifest update (carry from S54).** Add `brevo-attribute-reconcile-daily` + `drift-digest-daily` cron rows; remove `dead-letter-alert-hourly` row. Update last-verified timestamps.
9. **Defer: portal UI for self-edit of `notification_las`.** At 4 providers + DB-only edits the manual SQL path is fine. Build when the second provider asks for area routing, or when Charlotte needs George/Jake/Nick to swap LAs without a ticket.

## Decisions and open questions

**Decisions:**

- **Per-user LA scoping via `notification_las` on `crm.provider_users`, not a separate table.** Why: everyone Charlotte mentioned (Andy, Daniel, George, Jake, Nick) is already a `provider_users` row. A separate `provider_area_notifications` table would duplicate the recipient list. Single column, optional, NULL = pre-existing catch-all behaviour.
- **`fetchAreaScopedProviderUsers` exported from `_shared/route-lead.ts`, not a new shared module.** Used by both `sendProviderNotification` and `admin-notify-callback`. Single source of truth for the area-filter query — same SQL in both paths, no drift risk.
- **Callback notification model: matched provider_users in TO (multi-recipient), owner + cc_emails in CC.** Why: team visibility (they see each other on the thread) + matches the new-lead email pattern.
- **Archive (not delete) demo providers.** Why: demo-provider-ltd has 13 routing_log + 13 enrolments + 13 submissions rows; FK ON DELETE RESTRICT would block hard delete, cascade would destroy audit chain. Archive across all three for consistency.
- **Per-provider admin accounts over impersonation.** Why: impersonation needs auth-gate branching + RLS fanout on every provider-scoped table + audit start/stop + view-as banner; pays off at 10+ providers, not 4. iCloud Keychain holds passkeys; one per provider is manageable.
- **Pause CD + WYK via `active=false`, not `archived_at`.** Why: `pilot_status='paused'` is metadata only — routing in `_shared/route-lead.ts` gates on `active`/`archived_at`. Need `active=false` to truly block routing. Not archiving because paused is temporary; archive means gone.
- **Andy stays `invited` status (no nudge to enrol).** Why: Charlotte 2026-05-20 — he doesn't call leads. New-lead emails still reach him via `provider.contact_email`. Callback emails skip him (`status='active'` filter). Acceptable per owner.

**Open questions:**

- **Charlotte's portal alias on EMS landed as `support+ems@switchleads.co.uk`, not `hello+ems@switchleads.co.uk` as proposed.** Same effect (catch-all to her inbox). Just note for consistency if she onboards onto more providers — pick one prefix and stick with it.
- **Should Andy be CC'd on callback notes anyway** (even though `invited`)? Today he's filtered out by the `status='active'` clause. If Charlotte wants him kept on the chain for visibility, the filter widens to `status IN ('active','invited')` — one-line change.

## Watch items

- **First real EMS lead** — verify CC list matches the new LA scoping rules. Until that lands, the wiring is unverified in production.
- **Migration 0154 deployed?** Charlotte confirmed "all done" — DB query confirms seed values present, schema column live. Edge Functions deployed per her confirmation; not independently verified from this session.
- **Data-ops 043 not yet applied.** CD + WYK still `active=true` until Charlotte runs the SQL.
- **Carries from S54 still open** — first-fire verification 06:00-06:30 UTC 2026-05-21; remote Edge Function deletion; infrastructure-manifest cron rows.
- **Carries from S52 still open** — crm.email_log rows 504-506 (employer chaser webhook events), first natural Riverside attempt transition by Freya without manual SQL, leads.dead_letter sources `channel_b_sheet_writeback` (S50) + `edge_function_brevo_chase_employer` (S52) should stay empty.
- **Carries from S51 still open** — auto-flip cron + day-12 warning (migration 0097 unapplied), `u_fastrack_qualified` row in `crm.email_log`, invite-claim audit via `public.log_system_action_v1`, `TEST_MODE = false` re-verification before any B2B test submission.

## Next session

- **Folder:** `platform`
- **First task:** Confirm overnight 06:00-06:30 UTC cron loop fired cleanly (sheet-drift → brevo-attribute → drift-digest), then verify the next real EMS lead's email CC list matches the LA-scoped routing. If clean, proceed with the auto-flip cron + day-12 warning email reopened scope (migration 0097, biggest unblocker on Charlotte's billing path).
- **Cross-project:** None.
