# Platform Handoff, Session 45, 2026-05-13

## ⚡ PUSH FROM switchable/email 2026-05-15: B2B_PROVIDER_NAME + B2B_PROVIDER_TRUST_LINE for U1-employer parity with funded path

U1-employer template has been rewritten to mirror the funded U1 pattern: hardcoded Riverside trust prose replaced with `{{contact.B2B_PROVIDER_NAME}}` + `{{contact.B2B_PROVIDER_TRUST_LINE}}`. Sasha-side gap: the upsert added on 2026-05-14 doesn't push either of these attributes yet, so the template will render two blanks on live send until you ship the parallel work below.

**What's needed (three changes):**

1. **Migration** — add `b2b_trust_line TEXT` (nullable) to `crm.providers`. New B2B-specific column rather than reusing `trust_line` because the audience register diverges (employer/HRD vs learner). Per `feedback_no_patchwork.md`, proper architecture now beats a re-template at v2.

2. **Edge Function** — extend the employer upsert in `netlify-employer-lead-router/index.ts` (the one you added 2026-05-14) to also push:
   - `B2B_PROVIDER_NAME` ← `crm.providers.name` for the matched provider
   - `B2B_PROVIDER_TRUST_LINE` ← `crm.providers.b2b_trust_line` for the matched provider
   
   For v1 the matched provider is hardcoded "riverside-training" per existing routing; lookup is one SELECT against `crm.providers` keyed by `provider_id`.

3. **Riverside data backfill** — populate Riverside's `b2b_trust_line` with the canonical prose I had hardcoded:

   > They've been delivering apprenticeships for over 30 years, are rated Good by Ofsted, have a 98.4% pass rate and run programmes nationwide for employers including the NHS, BMW, MINI, Five Guys and Wiley.

   `UPDATE crm.providers SET b2b_trust_line = '...' WHERE provider_id = 'riverside-training';` Same data-ops pattern as 030.

**Brevo workspace (Charlotte UI step, blocks nothing on your side):** Add `B2B_PROVIDER_NAME` and `B2B_PROVIDER_TRUST_LINE` as TEXT contact attributes at workspace level.

**Cross-project coordination:** Mable is updating the `new-apprenticeship-provider` skill + apprenticeship-provider YAML to mirror this field (push in `switchable/site/docs/current-handoff.md`). When her skill writes new providers to crm.providers, the column from step 1 needs to exist or her insert fails. Sequence: your migration first, then her skill update can use the column.

**Why this matters now (not a future ticket):** U1-employer is currently live with template ID set in Supabase Vault as of 2026-05-14. Every employer submission today renders blank `{{contact.B2B_PROVIDER_NAME}}` + `{{contact.B2B_PROVIDER_TRUST_LINE}}` until your upsert change deploys. Visible regression in real employer inboxes. Priority for next platform session.

---

## Current state

Provider portal welcome deck shipped to production (audience-aware learner / employer carousel at `/provider/welcome`, admin preview at `/preview/<provider_id>/welcome`). Employer router patched to persist `source_form='s4b-employer-lead-v1'` (Solis Session 3 carry-forward resolved). Data-ops 030 staged but not yet applied; five test leads routed to Riverside still sit live in DB pending the run. Wed paid traffic readiness from prior handoff unchanged: Edge Functions clean, dead-letter signal active, drift reconciler self-healing.

## What was done this session

- **Welcome deck.** New `/provider/welcome` route at `platform/app/app/provider/welcome/`. Server page (`page.tsx`) auth-gates via `requireProviderUser()` and reads `crm.providers.funding_types` to pick the learner deck (EMS / CD / WYK) or the employer deck (Riverside). Client carousel (`welcome-deck.tsx`) handles dot progress, prev/next buttons, keyboard arrows, touch swipe, skip-top-right; last slide CTA into `/provider`. Inline mini-replicas of `home-view.tsx` palette as visuals (action grid, leads list with status pills, lead detail split-pane, stepper, 60-day clock, free-three / free-one widget) so the deck stays in sync with the real UI without screenshots to maintain.
- **Admin preview at `/preview/<provider_id>/welcome`** mirrors the existing home / leads / account preview routes. `preview-header.tsx` Active union widened to include `welcome`, new tab added. Reads `funding_types` server-side, hands the deck `audience='employer'` or `'learner'` to match the target provider.
- **Two commits to the platform app pushed via Netlify** (`656225a` welcome deck, plus prior `185e713` Session 44 handoff doc that had been sitting unpushed). Build live.
- **`netlify-employer-lead-router` `source_form` fix.** Added `source_form: string` to `EmployerSubmissionRow` interface and threaded through `normalise()` (hardcoded `'s4b-employer-lead-v1'` since the handler's early-exit at line 130 already rejects any other form name) + the INSERT column list. Function redeployed via `supabase functions deploy`.
- **Data-ops 030 written** at `supabase/data-ops/030_mark_riverside_test_leads_2026_05_13.sql`. Flips submissions 423-427 to `is_dq=true, dq_reason='owner_test_submission'`, deletes downstream `crm.enrolments` rows 542-546, audit row per submission via `audit.log_system_action`. Same shape as 027.
- **Changelog updated** with both the source_form fix and data-ops 030.
- **Committed and pushed** `0420b62 Wire source_form on employer router + data-ops 030 for Riverside test leads`.

## Next steps

1. **Charlotte runs data-ops 030** in the Supabase SQL editor. Dry-run preview at top, single BEGIN/COMMIT, verification SELECT at the end. Five submissions flip + five enrolment rows delete.
2. **Charlotte cleans Jane's Riverside sheet** of the five test rows (20:25 to 21:23 yesterday: Switchable Ltd TEST / Switchable Ltd / kieranwrites entries). Sheet → DB direction is not auto-mirrored.
3. **Verify `source_form` writes on next real B2B submission.** First Wed paid-traffic lead should land with `source_form='s4b-employer-lead-v1'`. Spot-check via `SELECT id, source_form FROM leads.submissions WHERE lead_type='employer_apprenticeship' ORDER BY id DESC LIMIT 5`.
4. **Welcome deck click-through.** Open `admin.switchleads.co.uk/preview/<provider_id>/welcome` for one learner provider (EMS / CD / WYK) and Riverside; review slide order, copy, and whether the mini-visuals carry meaning at a glance. Free-three / £400 slide is operational-with-numbers; pull it if it should stay purely operational. No first-login redirect yet; pure URL access.
5. **Wed paid traffic launch (Solis-owned, platform watch).** Edge Function logs end-to-end on the first real Riverside submission. Per-leg logger surfaces any failure by name.
6. **Wren: 3 Brevo templates.** `BREVO_TEMPLATE_U1_EMPLOYER`, `BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING`, `BREVO_TEMPLATE_PROVIDER_PRESUMED_FLIPPED`. First one degrades Wed UX until set.
7. **Tighten data-ops audit-log template (carry forward).** Future data-ops scripts capture `before_value` via a SELECT into a variable; write audit row only when the UPDATE actually mutated something. Carries from Session 44.
8. **WYK + Courses Direct sheet-vs-DB reconcile (carry forward).** Backlog ticket 869d994nb. Drift reconciler now noise-free; verify near-zero each Monday for two weeks then close.
9. **Provider portal `/provider/leads` N+1 + cursor siblings (carry forward).** Backlog 869d994qf.
10. **`RealtimeRefresh` `lead_notes` subscription scope (carry forward).** Backlog 869d994t5.
11. **RLS `(SELECT fn())` wrap on `crm.disputes` + `leads.fastrack_submissions` (carry forward).** Backlog 869d994un. Trigger: either table crosses ~1000 rows.
12. **Owner invites for Andy / Jane / Marty (carry forward).** Republish EMS + WYK sheets from DB before sending invites (mostly done in spirit via reconcile work).
13. **Solis carry-forward.** Schema naming decision `ads_business` vs `ads_switchable_business` before B2B Meta ad ingest. `crm.employer_signings` design before first Riverside Employer Signed event fires.
14. **(2026-05-14 PUSH FROM Solis Session 3): data-ops 030 already applied + leftover cleanup gap for enrolments 540/541.** Solis confirmed DB state: subs 423-427 carry `is_dq=true, dq_reason='owner_test_submission'`, enrolment rows 542-546 deleted (gap in sequence between 541 and 547). Data-ops 030 ran cleanly. BUT — enrolments 540 (sub 421) and 541 (sub 422) still exist as open Riverside enrolments, same owner-test pattern (Charlotte's own email caught by server-side OWNER_TEST_EMAILS at insert) but predate data-ops 030's 423-427 scope. Please write data-ops 031 to delete these two using the same audit-log + DELETE pattern as 030, OR generalise into a re-usable "test-flagged submission with lingering open enrolment" cleanup script for any future drift between is_dq classification timing and enrolment creation. Quick-glance verification query: `SELECT id, submission_id, provider_id, status FROM crm.enrolments WHERE submission_id IN (421, 422) AND provider_id = 'riverside-training';` — should be empty post-cleanup.

## Decisions and open questions

**Decisions made:**

- **`source_form` is populated on B2B submissions.** Resolves Solis Session 3 push. Convention: every router that owns a form name hardcodes that name into the INSERT, since the handler already rejects mismatches at the gate. B2C funded router should mirror the pattern if Solis's wider scan finds NULL there too.
- **Welcome deck lives at `/provider/welcome` (auth-gated)**, not `/help/welcome` (public). Reason: audience detection needs the signed-in provider's `funding_types`; the deck is for first-login orientation, not pre-sign-in shareability. The existing public `/help/getting-started` page already covers shareable first-time-access mechanics.
- **No first-login redirect or `welcome_seen_at` column in v1.** Pure URL access; pilot providers get the link from invite emails. Build the redirect later if it proves needed.
- **Every Riverside-routed lead to date is a test lead.** Real Riverside traffic begins after Wed paid-traffic flip is confirmed in Meta Events Manager. The router's `OWNER_TEST_EMAILS` gate continues to catch tests going forward; `kieranwrites@gmail.com` slipped through because it isn't a `hello+` test variant, and the `hello+capittest123` / `hello+123capi123` / `hello+kierantest` variants weren't on the pattern list.

**Open questions:**

- Does the B2C funded router (`netlify-lead-router` via `_shared/route-lead.ts`) also write `source_form`? Solis's Session 3 query observed that most B2C submissions have `source_form = NULL`; only `fastrack-l3-mismatch` populates it. Worth confirming whether the B2C router should populate too (matches the new B2B convention) or whether `source_form` is intentionally narrow-scope and the verification query was wrong. Read `_shared/route-lead.ts` before next router-touching session.
- Should the welcome deck's billing slide stay in? Operational copy with numbers (£150 / 15% / £400 ex VAT) reads factual, not salesy, but it is the only commercial moment in an otherwise operational guide. Charlotte decides on click-through.

## Watch items

- **First Wed paid-traffic Riverside submission.** Confirm `source_form='s4b-employer-lead-v1'` writes, full Edge Function chain runs clean (DB insert + sheet append + U1 + U2 where wired), no dead-letter row.
- **Data-ops 030 + sheet cleanup pending.** Dashboard shows 5 inflated routed-to-Riverside counts until both run; admin preview of Riverside's portal will show stale test leads in the leads list.
- **First real cohort_decline fastrack.** Carries from Session 44; untested in production under 0139.
- **First fire of `dead-letter-alert-hourly` cron** (carry from Session 44). Empty hour = no email, that's the expected steady state.
- **`BREVO_TEMPLATE_U1_EMPLOYER` env unset.** Function warns-and-skips; no breakage, just no employer ack email until set.
- **TEST_MODE confirmed `false`** in Supabase Vault before Wed paid traffic peaks.

## Next session

- **Folder:** `platform`
- **First task:** Verify Charlotte ran data-ops 030 + cleaned Riverside sheet (run the verification SELECT block at bottom of 030), then spot-check `source_form` on the most recent five B2B submissions to confirm the Edge Function fix is writing through.
- **Cross-project:** Solis's Session 3 push on `source_form` resolved here; Solis's handoff Next steps + Watch items updated as part of this /handoff. Welcome deck is platform-internal; no other folder owes follow-up beyond Nell knowing the provider invite email body can now link `/provider/welcome` post-sign-in (pushed to Nell's handoff).
