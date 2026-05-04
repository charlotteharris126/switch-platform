# Platform Handoff, Session 28, 2026-05-04

## Current state

Referral programme fully wired end-to-end: DB model, admin dashboard, Brevo sync, and billing trigger all consistent. Voucher now fires on provider-confirmed enrolment only (migration 0067 applied). SW_REFERRAL_CODE and SW_REFERRAL_URL attributes land in Brevo on every lead route and resync. Admin overview page rebuilt with period-aware conversion + CPE tile and real profit/loss. All six Edge Functions deployed.

## What was done this session

- Fixed all three `revalidatePath` calls in `app/admin/referrals/actions.ts`: were `/referrals`, now `/admin/referrals`
- Fixed nav href in `components/admin-shell.tsx`: Referrals link was `/referrals`, now `/admin/referrals`
- Added drift detection JSX to `app/admin/sheet-activity/page.tsx` (driftRows/driftSubs were computed but never rendered; green all-clear or table with cause column now shows)
- Added `referral_code` to `_shared/route-lead.ts` SubmissionRow interface + both SELECT queries + both Brevo upsert attribute objects (SW_REFERRAL_CODE)
- Added `buildReferralUrl` helper + SW_REFERRAL_URL to both upsert paths in route-lead.ts (email team contribution, same session)
- Added `referral_code` to admin-brevo-resync SELECT query
- Wrote and applied migration 0067: restricts referral voucher trigger to `status='enrolled'` only -- `crm.upsert_enrolment_outcome` (IF condition narrowed) and `crm.run_enrolment_auto_flip` (FOREACH referral loop removed entirely). Repaired migration history via `supabase migration repair --status applied 0067`
- Verified 0067 via `pg_proc.prosrc`: both functions confirmed correct
- Deployed all six Edge Functions: netlify-lead-router, routing-confirm, admin-brevo-resync, netlify-forms-audit, netlify-leads-reconcile, netlify-partial-capture
- Admin overview page (`app/app/admin/page.tsx`):
  - Removed "Sent to providers" pace tile (always matched "Leads in" with auto-routing; unrouted surfaced in attention section)
  - Conversion tiles now period-aware: denominator = leads routed this period, numerators = confirmed/presumed this period
  - Replaced "First billable hits" MoneyTile with "Cost per enrolment" (Meta spend / confirmed enrolments, period-aware)
  - Profit/loss now: confirmed lifetime revenue minus period ad spend (real number, not just negative spend)
  - Removed 4 redundant lifetime queries, added 1 period-aware presumed count query
  - Committed and pushed; Netlify build triggered

## Next steps

1. Verify admin.switchleads.co.uk overview page live and correct after Netlify build completes
2. Mable: /refer page build, PP HTML sync, T&Cs page deploy, friend-side referral notice rendering (flagged to Mable handoff)
3. Switchable email: referral CTAs in lifecycle emails (flagged to email project handoff)
4. Apply migration 0067 confirmed: already done -- no action needed
5. Courses Direct sheet setup still pending (Ranjit/HubSpot integration paused awaiting reply) -- check status

## Decisions and open questions

- Voucher trigger: confirmed enrolment only, not presumed. Rationale: voucher should not fire before provider confirms the friend actually started. Presumed rows are billing placeholders; a payout on a disputed presumed row would be incorrect. (Clara's instruction, applied 2026-05-04)
- SW_REFERRAL_URL added by email team in same session; included in all Brevo upsert paths
- Profit/loss tile uses lifetime revenue vs period spend because billing is cumulative (free-3 offset, monthly invoicing). Makes the denominator mixed-period but at least the number is real
- "Leads in" vs "Sent to providers": collapsed to one tile. With auto-routing they always match; the distinction only matters when there's an unrouted backlog, which is already surfaced in the attention section

## Watch items

- Netlify build for overview page changes: triggered on push, verify live in ~3 minutes
- referral_code and referral_url Brevo attributes: created by email team -- verify they appear on next real lead route
- Migration 0067: monitor that no referral flip fires on presumed_enrolled rows going forward
- Courses Direct leads still unrouted (sheet setup pending Ranjit)

## Next session

- **Folder:** platform
- **First task:** Verify overview page live and correct at admin.switchleads.co.uk; then pick up any Mable or email referral work that has landed
- **Cross-project:** Pushed notes to Mable handoff (referral page + legal sync work outstanding) and switchable/email handoff (referral CTAs in lifecycle emails)