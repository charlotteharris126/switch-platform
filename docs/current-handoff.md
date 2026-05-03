# Platform Handoff, Session 26, 2026-05-03

## Current state

The full Iris dashboard architecture is built end-to-end. Stage 1 (data layer) shipped this morning. Stages 2 (daily flag-compute Edge Function), 3 (Action Centre surface on /admin overview + full /admin/iris-flags page), 4a (/admin/ads tiles + per-ad performance table), 4b (/admin/ads/[ad_id] drill-down with funnel tiles + cost tiles + spend bars + per-provider breakdown + flag history + recent leads list), and 5 (closed-loop attribution view) all shipped this afternoon. The morning's stage 1d patch was rolled back after triggering Meta's "API access blocked" gate; the columns it would have populated stay NULL until Business Verification clears. Channel B sheet-edit-mirror activation runbook handed to owner; awaiting secrets setup. Mable's form-side pixel/CAPI dedup fix shipped same day, closing the P2.3 drift root cause.

## What was done this session

### Iris stage 3 — flag surface
- New `/admin/iris-flags` page: 30-day audit history + per-automation summary tiles (active/resolved/suppressed) + full table with severity badges + state pills + metric/threshold formatting per automation type.
- New `IrisFlagsSection` reusable component, surfaced on `/admin` overview as compact top-of-page card (max visibility per the Action-Centre-not-landing concern). Same component used on `/admin/ads`.
- Server actions: `markFlagResolved` (stamps `read_by_owner_at = now()`) and `markAllFlagsResolved` (bulk clear with confirm pattern).
- Sidebar nav: "Iris flags" added to Tools section.

### Iris stage 4a — `/admin/ads` page
- Period pills (24h / 7d / 30d / lifetime), brand tabs (Switchable | SwitchLeads dormant), funding-segment filter (all / funded / self-funded / loan-funded / other).
- Five headline tiles: Spend, Leads (Meta), Qualified (DB), Routed, True CPL. All counts use `parent_submission_id IS NULL` for True CPL consistency.
- Embedded Iris signals card.
- Per-ad performance table: 11 columns. Sorted qualified-desc then CPL-asc. Signal dots link to /iris-flags. Ad-name cells link through to drill-down.
- Sidebar nav: "Ads" added to Tools section.

### Iris stage 4b — `/admin/ads/[ad_id]` drill-down
- Lead funnel tiles: Spend, Meta leads, DB total, Qualified, Routed, Enrolled. Each with % of prior step.
- Cost tiles: True CPL (highlighted), cost-per-enrolment, revenue, CTR.
- Server-rendered SVG bars chart for daily spend (no client deps; date labels every 5th bar; tooltip on hover).
- Per-provider breakdown table (qualified/routed/enrolled per provider, links through to /providers/[id]).
- Iris flag history for this ad (active + resolved + suppressed).
- Recent leads list (last 50, with state badge, routing target, enrolment status link-through).

### Iris stage 5 — closed-loop attribution
- Migration 0065 written: new view `ads_switchable.v_ad_to_enrolment` extending `v_ad_to_routed` with `leads_enrolled` (status IN enrolled, presumed_enrolled), `revenue` (SUM `crm.enrolments.billed_amount`), `cost_per_enrolment`. Returns zero per ad until enrolments populate from real revenue.
- Schema correction: scope doc said `invoice_amount_pence` but production column is `billed_amount` (NUMERIC, £).

### Stage 1d patch + rollback
- Built and shipped patched `meta-ads-ingest` adding two new endpoint calls (`/act_X/ads` for status + creative metadata, `/act_X/adsets` for daily_budget) to populate the five metadata columns on `meta_daily`.
- Within an hour Meta refired the "API access blocked" verification gate. The newly-published app's low-trust state means added endpoints trip a fresh permission check.
- Rolled back: function returned to morning's working code path (single `/insights` call). Verified via test SQL: 200 with 9 rows upserted.
- Stage 1d code preserved in git history for re-apply once Business Verification clears.

### P2.3 drift signal — investigated and resolved
- Pulled the actual lead rows for 2026-05-01/02 (10 rows, the count Iris flagged on).
- Found: `event_id`, `_fbp`, `_fbc` all NULL on every paid lead for the last 14 days (109 rows, zero exceptions). Only `fbclid` (URL param) was captured.
- Root cause: form's hidden inputs weren't capturing the Meta dedup/identifier fields. CAPI events arrived at Meta with no shared event_id (over-count days from no dedup) and no browser identifier (under-count days from low-confidence drops). Drift bidirectional, range -71% to +33%.
- Brief written and passed to Mable via owner. Mable shipped fix same day (switchable-site commit 4437855): new `deploy/js/meta-dedup.js` auto-creates and populates the three hidden inputs on every form on every page, both thank-you pages share the same stashed event_id for the pixel call.

### Channel B activation runbook
- Verified `sheet-edit-mirror/index.ts` is gated cleanly on `CHANNEL_B_ENABLED` env var, with `ANTHROPIC_API_KEY` and `PENDING_UPDATE_SECRET` checked at use time.
- Activation steps handed to owner: generate Anthropic API key (with monthly spend cap), generate PENDING_UPDATE_SECRET via openssl, paste both into Supabase secrets, set `CHANNEL_B_ENABLED=true`. Test by editing a provider sheet's `Updates` column.

### Cross-project pushes
- `switchable/site/docs/current-handoff.md`: original brief for the form fix (now marked done) + Mable's commit reference.
- `switchable/ads/docs/current-handoff.md`: Iris stage 2 live, P2.3 root cause + fix, recalibration heads-up.

## Next steps

1. **Channel B activation** (owner action). Generate Anthropic API key + PENDING_UPDATE_SECRET, paste into Supabase secrets, flip CHANNEL_B_ENABLED=true. Then test by editing a provider sheet Updates column.
2. **Apply migration 0065** (Iris stage 5 view). Single transaction, no password placeholder. Once applied, /admin/ads cost-per-enrolment tile + drill-down revenue numbers will start showing data when enrolments accumulate.
3. **Meta Business Verification** (owner action, Meta Business Manager → Security Centre). 1-3 business days for Meta to process. Unblocks re-deploy of stage 1d patch (preserved in git history pre-rollback).
4. **Meta App Review** for `ads_management` + `ads_read` Advanced Access. After Business Verification. 5-10 business days. ClickUp [869d4xtng](https://app.clickup.com/t/869d4xtng).
5. **Watch P2.3 over next 7 days** as post-fix submissions accumulate. Drift should normalise from -71/+33 to single-digit %. If it doesn't, fix wasn't sufficient and Stape CAPI dedup config needs investigation.
6. **Riverside apprenticeship pilot call** (Tue 5 May 14:00, per master plan critical path). If they say yes, apprenticeships data model + routing becomes the next platform priority over stage 1d backfill.

## Decisions and open questions

**Decisions made this session:**
- **Rolled back stage 1d patch.** Adding `/act_X/ads` and `/act_X/adsets` calls to a low-trust Meta app refired the verification gate within an hour. Lesson: don't expand a low-trust Meta app's API surface; saved as feedback memory.
- **Iris flags surface lives on /admin overview, not /admin/actions.** Owner had said /admin/actions wasn't landing; putting flags there alone would inherit that problem. /admin overview is the daily-glance surface where flags get max visibility. Same component dropped into /admin/ads as well.
- **Per-ad drill-down at `/admin/ads/[ad_id]` route, not side drawer.** Routes are deep-linkable, no client state, matches existing dashboard pattern. Side drawer would have needed client component + sheet primitive.
- **Spend trend chart as inline server-rendered SVG**, no chart library added. Sufficient at pilot scale (≤30 days = ≤30 bars). Revisit if multi-axis chart becomes a frequent need.
- **Cost-per-enrolment tile shipped on /admin/ads/[ad_id] showing "—" until enrolments accumulate.** Better than hiding the tile entirely; surfaces what the metric WILL show once Phase 4 is real.
- **Migration 0065 ships even though crm.enrolments is empty.** No-op-but-correct. When enrolments land, no further deploy needed.

**Open questions:**
- Will Mable's pixel/CAPI fix fully close the drift, or is there a Stape CAPI dedup config also wrong? Watch over next 7 days.
- When Business Verification + App Review clear, the rolled-back stage 1d patch needs re-applying. Check git history for the exact diff (rollback commit `ea683b0`).

## Watch items

- **Channel B activation pending owner secrets.** Until ANTHROPIC_API_KEY + PENDING_UPDATE_SECRET set + CHANNEL_B_ENABLED=true flipped, sheet-edit-mirror returns "Channel B disabled" on Updates-column edits. No silent failure — function explicitly says it's gated.
- **Migration 0065 pending application.** v_ad_to_enrolment view doesn't exist in production yet; cost-per-enrolment column on /admin/ads/[ad_id] will show "—" until applied (and even after, until crm.enrolments has rows).
- **Stage 1d columns NULL across all rows** (delivery_state, daily_budget, status, headline, primary_text). Re-deploy the rolled-back patch when Meta verification clears.
- **First scheduled iris-daily-flags cron at 09:30 BST tomorrow** (08:30 UTC 2026-05-04). Verify it ran cleanly. Expected: in-flight P2.3 flag from today suppressed by 7-day rule; new P2.3 should be smaller after Mable's fix; P1.2/P2.2 quiet.
- **Meta App un-Development-Moded but no Business Verification yet.** Recurring "API access blocked" gate keeps firing — twice this session (morning + when stage 1d patch added new endpoints). Each gate fire requires Charlotte to log into developers.facebook.com and clear a verification screen. Will keep happening until Business Verification clears.
- **CLI migration tracking now includes 0056-0065.** Next `db push` will need `migration repair --status applied 0048 0050 0051 0052 0053 0054 0055 0056 0057 0058 0059 0060 0061 0063 0064 0065` (excluding 0049 HubSpot, no 0062 in production). Run before next CLI push.

## Next session

- **Folder:** `platform/`
- **First task:** Check Channel B activation status. If owner has set up secrets, do a manual sheet-edit test to confirm the AI suggestion email lands. If not yet, defer Channel B and verify the morning's iris-daily-flags cron ran cleanly (check `net._http_response` after 08:31 UTC for a 200 from iris-daily-flags). Then if Business Verification has cleared, re-deploy the rolled-back stage 1d patch (commit `ea683b0`).
- **Cross-project:** Mable's form fix and the resulting P2.3 normalisation both flagged in `switchable/ads/`; confirm Iris isn't surprised by the changing flag pattern over the next week.
