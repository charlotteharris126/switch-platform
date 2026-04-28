# Platform: Current Handoff: 2026-04-28 (Session 14 closed): admin dashboard reconciliation pass + DQ leak fix shipped, KPI reconciliation still flagged "not right" by owner

**Session type:** Continuation of Session 13 cleanup batch + ad-hoc bug surface from `/admin` dashboard use.

**Session opened:** 2026-04-27 afternoon (continuation of Session 13)
**Session closed:** 2026-04-28 (carrying through midnight)

---

## What we worked on

### 1. Session 13 batch 2: dashboard fixes (shipped)

Owner reported on six items from the Session 13 deploy:

1. Markdown for Thea: lives at `switchleads/social/docs/platform-status-2026-04-27.md`. Path surfaced.
2. Overview rewrite: "Routed" KPI switched from `COUNT(*)` of routed parent rows to `COUNT(DISTINCT lower(trim(email)))` across all live (non-archived) routed rows. "Qualified" tile got the same treatment late in the session after owner spotted it still showed 90 vs Routed's 89. Both now agree. Conversion-rate denominator uses the same dedupe.
3. Leads list enrolment-status badge: `enrolled` deepened from `bg-emerald-100 text-emerald-800` to `bg-emerald-600 text-white` so it's visually distinct from the routed badge.
4. Topbar dropdown: replaced shadcn `DropdownMenu` (Base UI render-prop pattern) with a self-contained `UserMenu` component using vanilla `<button>` + click-outside `useEffect`. Account / Sign out buttons now fire reliably. The render-prop interaction with nested form + Link was the root cause.
5. Providers page: new "Total enrolled" column (confirmed + presumed). Conversion split into "Potential %" (incl. presumed) and "Confirmed %" (enrolled only). Replaces the previous single conversion column.
6. Errors page: major rewrite. Top-of-page DB reconciliation card surfaces routing-log vs unique-people-routed gap and breaks it down (archived test rows + linked re-applications + rapid-fire same-email duplicates). Each unresolved row shows the linked lead's name, email, current state in plain English (pulls from `raw_payload.submission_id` for `reconcile_backfill` rows). Source-group headlines plain English, "What this is / What to do" per source, plus an explanatory card for "Mark resolved".

### 2. Silent-DQ-routing bug (ticket 869d2rxap, shipped)

Owner pinned down the root cause that the Errors page surfaced as Anita Bucpapaj #184. Self-funded form correctly DQ'd her (qualification=professional-body), showed the holding panel; she clicked "keep me on the list" and the contact submission landed in `leads.submissions` with `is_dq=false`, `primary_routed_to=courses-direct`. Marty got her as a qualified lead.

**Form fix (`switchable/site` repo, commit ac03d71):**
- Added `<input type="hidden" name="dq_reason" id="h-dq-reason">` to the `switchable-self-funded` form.
- `showHolding(reason)` now populates it with the DQ reason.
- `restartForm()` clears it.
- Submit handler also clears it whenever `viaDQ === false` (handles back-navigation edge case where a user views the holding panel, backs up, re-answers to qualify, then submits).
- `/tools/form-matrix/` simulator FYC outcome blocks updated to mirror the corrected behaviour. The DQ holding panel is no longer described as "no lead submitted"; the simulator now states explicitly that the "keep me on the list" path captures the lead with `is_dq=true` and skips provider routing.

**Edge Function fix (this repo, commit eb69a06):**
- `_shared/ingest.ts` already read `dq_reason` from the payload and set `is_dq=true`. But the per-form normaliser still populated `provider_ids` from its hardcoded fallback (e.g. `['courses-direct']`).
- Added `applyDqOverride()` to `normaliseAndOverride()` which forces `provider_ids = []` whenever `is_dq=true`. Mirrors `applyOwnerTestOverrides`. Defence-in-depth: the routing branch already short-circuits on `is_dq=true`, but the row in the DB now reflects clean state.
- `netlify-lead-router` and `netlify-leads-reconcile` both redeployed via `supabase functions deploy --no-verify-jwt`.

**Backfill (data-ops/010, commit d87c516, applied via `supabase db query --linked`):**
- Updated leads.submissions id=184 to `is_dq=true, dq_reason='qual', primary_routed_to=null, routed_at=null, provider_ids='{}'`.
- Routing-log row 97 deliberately left in place as audit trail of the historical misroute. Creates a 1-row deliberate drift in the reconciliation card that traces this correction.

**Marty email drafted, PII-clean (per the hard rule that provider notification emails never contain learner PII):**

> Subject: Lead SL-26-04-0184: please disregard
>
> Hi Marty, quick heads-up: lead SL-26-04-0184 in your sheet was a routing error on our side. Please ignore that row, no need to call. A bug in our self-funded form was wrongly classifying some learners as qualified when they should have been held back for our nurture list. We've fixed it today, so this won't happen again. Sorry for the noise. Charlotte

Owner to send from her own inbox tomorrow.

### 3. Migration 0036: vw_provider_billing_state.total_routed = distinct emails (shipped)

`crm.vw_provider_billing_state.total_routed` was previously `COUNT(*) FROM leads.routing_log GROUP BY provider_id`. After Anita's backfill that orphaned a routing_log row, plus the existing 2 archived test rows + multi-routings of same person (Glennis, Jade), per-provider routed counts summed to 97 vs the overview KPI's 89. View redefined to use `COUNT(DISTINCT lower(trim(email))) FROM leads.submissions WHERE primary_routed_to = ... AND archived_at IS NULL`. Now: EMS 60, CD 15, WYK 15. Sum 90 (Jade overlaps EMS+CD = 1, global = 89). Conversion-rate denominator updated.

### 4. Awaiting-outcome tile fix (shipped)

`/admin` Awaiting Outcome tile was querying `crm.enrolments WHERE status='open'` which only catches the rare case of an explicit "open" row. Most routed leads have NO enrolments row at all (provider hasn't yet given an outcome, "implicitly open"). Tile was showing 1; should show 84 all-time. Fixed by computing as routed-in-period IDs minus IDs with a terminal-status enrolment (enrolled, presumed_enrolled, lost, cannot_reach). Implemented in JS in the page since supabase-js doesn't easily express NOT EXISTS.

---

## Current state

`/admin` overview, providers, leads, errors all reconcile against a single rule: one email = one person. Qualified, Routed, providers per-provider sums (with overlap explained) all use distinct lower-cased trimmed emails. The providers page sums to 90 because Jade Millward overlaps EMS + Courses Direct; global Routed shows 89.

**Owner final remark: "ok its still not right but lets handoff and we'll pick up tomorrow"**

The owner did not say what was still wrong. By end of session the visible numbers were:
- Qualified leads: 89
- Routed: 89
- Per-provider Routed sum: 90 (EMS 60, CD 15, WYK 15)
- Awaiting outcome (all time): 84
- Errors-page reconciliation card: routing-log 97, unique-people 89, gap 8 (2 archived + 4 linked re-applications + 1 rapid-fire dupe + 1 audited-misroute Anita)

Next session must start by asking the owner what specifically is still not adding up, taking a fresh screenshot of the dashboard if helpful. Do not start guessing.

---

## Next steps

1. **Diagnose remaining reconciliation drift the owner flagged.** Open `/admin` with her, capture the specific tiles or columns that don't add up the way she expects. Possibilities to check first: providers per-provider rows display (Total enrolled, Potential %, Confirmed %), whether any tile is still using a stale view value cached by the browser, whether the "Free left" column is showing what she expects per provider.
2. **Owner sends Marty email** for SL-26-04-0184 from her inbox.
3. **Verify topbar dropdown reliability after Netlify deploy completes.** Owner had been seeing the Account / Sign out buttons fail; this session rewrote the component but the visual confirmation under live hosting hasn't happened yet.
4. **Meta analytics + ad spend** (deferred from earlier ticket; too big for this session). Existing ticket: 869d2rbde.
5. **Reconciliation card drift trace cleanup.** The 1-row gap from Anita's audited misroute is intentional now but if the owner wants the card to read "All accounted for" again rather than "Gap: investigate", we'd need to add an "audited misroutes" category to the card breakdown so the math closes.

---

## Decisions / open questions

- **Decision (this session):** routing-log rows from corrected misroutes stay in place as audit history rather than being deleted. The reconciliation card carries the drift as the trace of those corrections. Same precedent as data-ops/005 (Melanie Watson) and data-ops/008 (Ruby + Laura).
- **Decision (this session):** dashboard counts everywhere use distinct lower-cased trimmed emails as the dedupe rule. One email = one person. Per-provider sums can exceed global because overlaps (people sent to multiple providers) are counted in each provider's bucket.
- **Open:** what specifically the owner thinks is still wrong. Resolve before any further dashboard work tomorrow.
- **Open (carried forward):** what counts as a self-funded DQ in the form-matrix simulator vs the live page once we add new courses or providers. Form-matrix simulator rule (zero-drift) means any new DQ path needs both sides updated.
- **Open (carried forward):** Anita's routing_log entry was reported delivery_status='sent' yet she never reached the Courses Direct sheet. Either the sheet append failed silently with no dead_letter trace, or it appended somewhere else. Worth investigating in a future session if any other "no dead_letter, but not in sheet" cases come up.

---

## Next session

- **Currently in:** `platform/` (admin dashboard + Edge Function + DB).
- **Next recommended:** stay in `platform/` for the reconciliation diagnosis Charlotte flagged, then likely move to `switchleads/clients/` (Nell) or `strategy/` (Mira) once reconciliation is signed off. Cross-reference master-plan.md.
- **First task tomorrow:** ask Charlotte what specifically about the reconciliation looks wrong. Open the live dashboard side by side with her sheets and walk through the numbers. Do not guess; she'll point.
