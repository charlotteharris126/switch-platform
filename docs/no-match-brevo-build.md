# No-match Brevo build — 3-state spec

**Status:** Scoped 2026-04-29, queued for next platform session. Not blocking tonight's U1 + SF2 launch (those run on the routed-lead path, already shipped).

**Confirmed by owner:** 3-state `SW_MATCH_STATUS` (matched / pending / no_match), self-funded option (b), enrichment overwrite, no in-Brevo nurture differentiation in v1 (handled by automation entry filters, not by platform).

**Trigger to start:** owner clears tonight's email launch (U1 + SF2 live with routed leads), then opens platform.

---

## Summary

Today's Brevo upsert only fires for matched leads (auto-route or owner-confirm). Three real states exist; each needs the upsert with the right `SW_MATCH_STATUS`:

| State | Trigger | Brevo behaviour today | Brevo behaviour after this build |
|---|---|---|---|
| `matched` | 1 candidate provider, auto-route fires | Upserts with full attributes (shipped 2026-04-29) | Unchanged |
| `pending` | 2+ candidate providers, awaits owner confirm | Nothing fires | Upsert with provider attributes empty, `SW_MATCH_STATUS=pending`. Owner confirm later flips to `matched` via existing `routeLead` path |
| `no_match` | 0 candidate providers OR `is_dq=true` for any reason | Nothing fires | Upsert with provider attributes empty, `SW_MATCH_STATUS=no_match` |

Email-side automation entry filters do the nurture differentiation:
- Matched → N1-N7 spine + monthly newsletter
- Pending → SF13 "picking your provider, hear within 24h", no spine. Flip to matched triggers N1-N7
- No-match → SF8 recirc utility email immediately, then monthly newsletter only (no spine)

Platform's job: emit the right state. Brevo's job: filter on it.

---

## Forms in scope (all four flow through `netlify-lead-router`)

Per `switchable/site/deploy/deploy/data/form-allowlist.json`:

- `switchable-funded` — funded course pages. DQ branches (age, prior qual, postcode mismatch, employment status) → `no_match`. 0 candidates after eligibility pass → `no_match`. 1 candidate auto-route → `matched` (existing). 2+ candidates owner-confirm → `pending` then `matched`.
- `switchable-self-funded` — self-funded directory. `course_id` shape is the course YAML id (e.g. `smm-for-ecommerce`), NOT a regional page slug. Currently breaks matrix lookup — see "Site change" below.
- `switchable-waitlist` — DQ soft-capture from a course-page DQ branch. Always `no_match`.
- `switchable-waitlist-enrichment` — additional info captured later via `/waitlist/?ref=email`. Same email already in Brevo from initial waitlist submission; the enrichment upsert overwrites with richer data, `SW_MATCH_STATUS` stays `no_match`. Owner-confirmed pattern.

---

## Site change — matrix.json secondary index by course-only slug

`switchable/site/deploy/scripts/build-funded-pages.js` already emits `courseId` (course-only slug) on every route entry as of 2026-04-29 (Session 17).

This build adds: a top-level `coursesById` map keyed by `courseId`, with the union of fields shared across all routes for that course (course title, both interest tags). Region and intake are NOT in the map because they don't apply to course-only lookups.

```jsonc
{
  "routes": [...],
  "coursesById": {
    "smm-for-ecommerce": {
      "courseTitle": "Social Media for E-Commerce",
      "cfInterest": "marketing",
      "ffInterest": "digital-tech"
    }
  }
}
```

The `_shared/route-lead.ts` helper extends to read this map when the submission's `course_id` matches a `coursesById` key (self-funded lookup) instead of a `routes[].slug` key (funded lookup). For self-funded:
- `SW_COURSE_NAME` → course title from `coursesById`
- `SW_COURSE_SLUG` → the `courseId` itself
- `SW_SECTOR` → `cfInterest` (self-funded uses course-finder taxonomy)
- `SW_REGION_NAME`, `SW_COURSE_INTAKE_ID`, `SW_COURSE_INTAKE_DATE` → empty (don't apply)

Build script update + matrix.json regeneration ships in the site repo. No simulator impact (it doesn't read `coursesById`).

---

## Edge Function changes

### 1. New helper in `_shared/route-lead.ts`

```ts
export async function upsertLearnerInBrevoNoMatch(
  sql: Sql,
  submission: SubmissionRow,
  matchStatus: "no_match" | "pending",
): Promise<void>
```

Composes attributes from submission + matrix (no provider). Same Brevo upsert semantics. Provider attributes (`SW_PROVIDER_NAME`, `SW_PROVIDER_TRUST_LINE`) stay empty. List membership: utility always; marketing if `marketing_opt_in=true`. Single atomic upsert call.

### 2. `getMatrixContext` extension

Helper checks `coursesById` map when route lookup by slug fails. Returns the same `MatrixContext` shape with region/intake null for self-funded paths.

### 3. `netlify-lead-router/index.ts` wiring

After `insertSubmission` returns, branch on routing outcome:
- 0 candidates OR `is_dq=true` → `await upsertLearnerInBrevoNoMatch(sql, submission, "no_match")`
- 1 candidate, auto-route fires → existing `routeLead("auto_route")` path (no change)
- 2+ candidates → `await upsertLearnerInBrevoNoMatch(sql, submission, "pending")` THEN send the existing owner-confirm email

All branches stay best-effort: failure logs `leads.dead_letter`, doesn't unwind the submission insert.

### 4. Edge case: re-submission upgrades

If a learner first submits no-match, then later resubmits and matches, the existing `routeLead` upsert fires `SW_MATCH_STATUS=matched` and overwrites. No special handling needed.

---

## Test plan

Synthetic submissions covering each state, fresh non-owner email per submission so Brevo doesn't deduplicate against earlier tests:

| Test | Form | Course | Postcode | Expected `SW_MATCH_STATUS` | Expected attributes |
|---|---|---|---|---|---|
| 1 | switchable-funded | smm-for-ecommerce-tees-valley | TS1 (in region, all eligibility pass) | `matched` | Full 13 |
| 2 | switchable-funded | smm-for-ecommerce-tees-valley | SW1 (out of region) | `no_match` | Course/region/sector populated, provider attrs empty |
| 3 | switchable-funded | counselling-skills-tees-valley | TS1, but age < min_age (DQ) | `no_match` | Course/region/sector populated |
| 4 | switchable-self-funded | smm-for-ecommerce | n/a | `no_match` (assuming no self-funded matching exists yet) | Course title + sector populated, region/intake empty |
| 5 | switchable-waitlist | follows test 2's DQ panel | n/a | `no_match` | Sparser; whatever the form captures |
| 6 | switchable-waitlist-enrichment | refs test 5 | extra fields | `no_match`, attributes overwrite richer | Same email, refreshed data |
| 7 | switchable-funded | a course with 2+ candidate providers | match | `pending` | Course/region/sector populated, provider attrs empty |
| 8 | follow test 7: owner clicks confirm | n/a | n/a | `matched` (overwrite) | Full 13 with provider |

Each test verified by reading the Brevo contact + checking list memberships + checking automation entry behaviour (email side).

---

## Out of scope for this build

- `SW_AGE_BAND` push (deferred to v2 — form age-question redesign)
- Brevo email metrics ingestion into Supabase (Phase 2-3 trigger)
- Per-state nurture content variation in N1-N7 (v2 — owner said v1 uses same spine, conditional content blocks v2)
- Any provider-side or routing-side change (this build is Brevo-only)

---

## Estimated work

- Site script update + matrix shape regen + push: ~20 min
- `_shared/route-lead.ts` helper + `getMatrixContext` extension: ~30 min
- `netlify-lead-router/index.ts` branching + tests: ~30 min
- Synthetic test pass (8 tests): ~30 min
- Doc updates (changelog, infrastructure-manifest, current-handoff): ~10 min

Total: ~2 hours, single platform session.

---

## References

- Brevo enrichment fix that shipped today's matched-lead path: `platform/docs/changelog.md` 2026-04-29 entries
- Lead payload schema: `switchable/site/docs/funded-funnel-architecture.md`
- Form allowlist: `switchable/site/deploy/deploy/data/form-allowlist.json`
- Existing matched-path helper: `platform/supabase/functions/_shared/route-lead.ts` `upsertLearnerInBrevo`
- Email project's automation IDs (U1, SF2, SF8, SF13, N1-N7): `switchable/email/`
