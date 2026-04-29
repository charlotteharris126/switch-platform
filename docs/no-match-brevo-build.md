# No-match Brevo build — 3-state spec (revised 2026-04-29 evening)

**Status:** Scoped 2026-04-29. Initial spec assumed self-funded would also use matrix.json via a `coursesById` secondary index. **Owner overrode that direction same evening:** self-funded skips matrix entirely; sector pulls from `submission.interest` instead. Funded-only nurture spine. New `SW_DQ_REASON` attribute added. Site work is OUT.

Queued for next platform session. Not blocking tonight's U1 + SF2 launch (those run on the routed-funded path; revising existing matched helper is part of this build).

**Confirmed by owner (final 2026-04-29 direction):**

- 3-state `SW_MATCH_STATUS` (matched / pending / no_match)
- Top-level branch on `funding_category` inside the Brevo upsert helpers
- Self-funded skips matrix.json entirely; `SW_SECTOR` pulls from `submission.interest`
- `SW_COURSE_NAME` / `SW_COURSE_INTAKE_ID` / `SW_COURSE_INTAKE_DATE` / `SW_REGION_NAME` stay blank for self-funded leads
- New `SW_DQ_REASON` attribute, pushed when `is_dq=true`, raw value from `submission.dq_reason`
- N1-N7 nurture spine is funded-only (Brevo automation entry filter: `SW_MATCH_STATUS=matched AND SW_FUNDING_CATEGORY in (gov, loan)`)
- Self-funded routed leads get U-track utility emails but skip the funded-nurture spine
- Sector-led self-funded nurture stream is its own future workstream

---

## Summary

Today's Brevo upsert only fires for matched leads (auto-route or owner-confirm) and assumes every lead resolves through matrix.json. Two real gaps surfaced tonight: (1) the upsert never fires for unmatched leads, and (2) the matrix lookup silently fails for self-funded leads because their `course_id` is a YAML id, not a page slug.

Both gaps close in one build by branching the upsert helpers on `funding_category`.

| State | Trigger | Brevo behaviour today | Brevo behaviour after this build |
|---|---|---|---|
| `matched` | 1 candidate provider, auto-route fires | Upserts with full attributes (shipped 2026-04-29) for funded; broken for self-funded (matrix miss) | Funded: unchanged. Self-funded: skip matrix, push course-blank attrs + `SW_SECTOR` from `submission.interest` |
| `pending` | 2+ candidate providers, awaits owner confirm | Nothing fires | Upsert with provider attributes empty, `SW_MATCH_STATUS=pending`. Owner confirm later flips to `matched` via existing `routeLead` path |
| `no_match` | 0 candidate providers OR `is_dq=true` for any reason | Nothing fires | Upsert with provider attributes empty, `SW_MATCH_STATUS=no_match`, `SW_DQ_REASON` populated when applicable |

Email-side automation entry filters do the nurture differentiation:
- matched + funded (gov/loan) → N1-N7 spine + monthly newsletter
- matched + self-funded → U-track utility only, skip nurture spine, sector-led sequence is future work
- pending → SF13 "picking your provider, hear within 24h", no spine. Flip to matched + gov/loan triggers N1-N7
- no_match → SF8 recirc utility immediately, then monthly newsletter only (no spine)

Platform's job: emit the right state + populated attributes (or blank where not applicable). Brevo's job: filter on it.

---

## Forms in scope (all four flow through `netlify-lead-router`)

Per `switchable/site/deploy/deploy/data/form-allowlist.json`:

- `switchable-funded` — funded course pages (gov / loan funding_category). Matrix lookup applies. DQ branches → `no_match` with `SW_DQ_REASON` populated. 0 candidates → `no_match`. 1 candidate auto-route → `matched`. 2+ candidates → `pending` then `matched`.
- `switchable-self-funded` — self-funded directory. funding_category = `self`. Skip matrix. Pull `SW_SECTOR` from `submission.interest`. Course/region/intake stay blank.
- `switchable-waitlist` — DQ soft-capture from a course-page DQ branch. Always `no_match`. `SW_DQ_REASON` carries the original DQ reason.
- `switchable-waitlist-enrichment` — additional info captured later via `/waitlist/?ref=email`. Same email already in Brevo from initial waitlist; enrichment upsert overwrites with richer data, `SW_MATCH_STATUS` stays `no_match`. Owner-confirmed pattern.

---

## ~~Site change — matrix.json secondary index by course-only slug~~ DROPPED

Originally specified, owner overrode 2026-04-29 evening. Self-funded does not need matrix at all. Site session has nothing to do for this build.

The `courseId` field already added to each route entry in matrix.json (Session 17, commit c229baf) stays — still serves the funded path for `SW_COURSE_SLUG`. No revert needed.

---

## Edge Function changes

### 1. New attribute: `SW_DQ_REASON`

Already configured in Brevo as the 15th attribute. Pushed whenever `is_dq=true`, raw value from `submission.dq_reason`. Empty string otherwise. Same atomic upsert call.

Common values currently in `submission.dq_reason` (raw, automation handles branching):
- `owner_test_submission`
- DQ-panel reasons (codes from the funded course-page eligibility checks): age, postcode, employment, prior qualification, etc. — exact taxonomy lives in `_shared/ingest.ts` / form-copy.yml

### 2. Refactor `upsertLearnerInBrevo` to branch on `funding_category`

```ts
export async function upsertLearnerInBrevo(
  sql: Sql,
  provider: ProviderRow,
  submission: SubmissionRow,
): Promise<void> {
  // ... existing setup (env vars, marketing_opt_in check) ...

  const fundingCategory = submission.funding_category ?? "";

  // Branch: funded path uses matrix; self-funded reads submission directly.
  let courseTitle = "";
  let courseSlug = "";
  let intakeId = "";
  let intakeDate = "";
  let regionName = "";
  let sector = "";

  if (fundingCategory === "self") {
    sector = submission.interest ?? "";
    // course/region/intake stay blank
  } else {
    // gov / loan / unknown → funded matrix path
    const matrix = await getMatrixContext(submission.course_id, submission.preferred_intake_id);
    courseTitle = matrix.courseTitle ?? submission.course_id ?? "";
    courseSlug = matrix.courseId ?? "";
    intakeId = matrix.intakeId ?? "";
    intakeDate = matrix.intakeDate ?? "";
    regionName = matrix.regionName ?? "";
    sector = (matrix.ffInterest ?? matrix.cfInterest) ?? "";
  }

  const dqReason = submission.is_dq ? (submission.dq_reason ?? "") : "";

  const attributes: BrevoAttributes = {
    FIRSTNAME: submission.first_name ?? "",
    LASTNAME: submission.last_name ?? "",
    SW_COURSE_NAME: courseTitle,
    SW_COURSE_SLUG: courseSlug,
    SW_COURSE_INTAKE_ID: intakeId,
    SW_COURSE_INTAKE_DATE: intakeDate,
    SW_REGION_NAME: regionName,
    SW_SECTOR: sector,
    SW_PROVIDER_NAME: provider.company_name,
    SW_PROVIDER_TRUST_LINE: provider.trust_line ?? "",
    SW_FUNDING_CATEGORY: fundingCategory,
    SW_FUNDING_ROUTE: submission.funding_route ?? "",
    SW_EMPLOYMENT_STATUS: submission.employment_status ?? "",
    SW_OUTCOME_INTEREST: submission.outcome_interest ?? "",
    SW_DQ_REASON: dqReason,
    SW_CONSENT_MARKETING: submission.marketing_opt_in,
    SW_MATCH_STATUS: "matched",
  };

  // ... existing single upsert call with both lists ...
}
```

### 3. New helper `upsertLearnerInBrevoNoMatch`

```ts
export async function upsertLearnerInBrevoNoMatch(
  sql: Sql,
  submission: SubmissionRow,
  matchStatus: "no_match" | "pending",
): Promise<void> {
```

Same funding_category branching as the matched helper. Provider attributes (`SW_PROVIDER_NAME`, `SW_PROVIDER_TRUST_LINE`) stay empty. List membership: utility always; marketing if `marketing_opt_in=true`. Single atomic upsert call.

### 4. `netlify-lead-router/index.ts` wiring

After `insertSubmission` returns, branch on routing outcome:

- 0 candidates OR `is_dq=true` → `await upsertLearnerInBrevoNoMatch(sql, submission, "no_match")`
- 1 candidate, auto-route fires → existing `routeLead("auto_route")` path (no change to call site; updated helper now branches inside)
- 2+ candidates → `await upsertLearnerInBrevoNoMatch(sql, submission, "pending")` THEN send the existing owner-confirm email

All branches stay best-effort: failure logs `leads.dead_letter`, doesn't unwind the submission insert.

### 5. Edge case: re-submission upgrades

If a learner first submits no-match, then later resubmits and matches, the existing `routeLead` upsert fires `SW_MATCH_STATUS=matched` and overwrites — including clearing any prior `SW_DQ_REASON`. No special handling needed.

---

## Test plan

Synthetic submissions covering each state, fresh non-owner email per submission so Brevo doesn't deduplicate against earlier tests:

| Test | Form | funding_category | Expected `SW_MATCH_STATUS` | Expected attributes |
|---|---|---|---|---|
| 1 | switchable-funded | gov | `matched` | Full set: course/region/intake/sector populated, provider populated, `SW_DQ_REASON` empty |
| 2 | switchable-funded | gov | `no_match` (postcode mismatch DQ) | Course/region/sector populated, provider attrs empty, `SW_DQ_REASON` = the DQ panel reason |
| 3 | switchable-funded | gov | `no_match` (age below min) | Same as test 2 with appropriate `SW_DQ_REASON` |
| 4 | switchable-self-funded | self | `matched` (or `no_match` if no self-funded matching exists) | `SW_SECTOR` from `submission.interest` (e.g. "marketing"), course/region/intake all blank, provider populated if matched |
| 5 | switchable-self-funded | self | `no_match` | `SW_SECTOR` populated, course/region/intake blank, provider blank, `SW_DQ_REASON` if applicable |
| 6 | switchable-waitlist | (whatever original) | `no_match` | Whatever the form captures, `SW_DQ_REASON` carrying the original reason |
| 7 | switchable-waitlist-enrichment | (whatever original) | `no_match`, attributes overwrite richer | Same email as test 6, refreshed data |
| 8 | switchable-funded | gov | `pending` (2+ candidate providers) | Course/region/intake/sector populated, provider attrs empty |
| 9 | follow test 8: owner clicks confirm | gov | `matched` (overwrite) | Full set with provider populated |

Each test verified by reading the Brevo contact + checking list memberships + checking automation entry behaviour (email side).

---

## Out of scope for this build

- `SW_AGE_BAND` push (deferred to v2 — form age-question redesign)
- Brevo email metrics ingestion into Supabase (Phase 2-3 trigger)
- Per-state nurture content variation in N1-N7 (v2 — owner said v1 uses same spine, conditional content blocks v2)
- **Sector-led self-funded nurture sequence** — its own future workstream. Self-funded routed leads enter U-track utility only at v1; the dedicated sector-led nurture is queued for after the funded N1-N7 is bedded in.
- Any provider-side or routing-side change (this build is Brevo-only)

---

## Estimated work

- `_shared/route-lead.ts`: refactor `upsertLearnerInBrevo` to branch on funding_category + add `SW_DQ_REASON` + new `upsertLearnerInBrevoNoMatch` helper: ~45 min
- `netlify-lead-router/index.ts` branching for the 3 states: ~30 min
- Synthetic test pass (9 tests): ~30 min
- Doc updates (changelog, infrastructure-manifest, current-handoff, switchable/email handoff): ~15 min

Total: ~2 hours, single platform session. **No site work.**

---

## References

- Brevo enrichment fix that shipped today's matched-funded path: `platform/docs/changelog.md` 2026-04-29 entries
- Lead payload schema: `switchable/site/docs/funded-funnel-architecture.md`
- Form allowlist: `switchable/site/deploy/deploy/data/form-allowlist.json`
- Existing matched-path helper: `platform/supabase/functions/_shared/route-lead.ts` `upsertLearnerInBrevo`
- Email project's automation IDs (U1, SF2, SF8, SF13, N1-N7): `switchable/email/`
