# Platform Handoff, Session 74, 2026-06-15

## Current state
Private-pay (self-funded) leads are now fully first-class end to end: they auto-route like any warm lead, show as "Private pay" (not DQ) in admin and the provider portal, carry the price the learner accepted, and get their own welcome email. All migrations applied and functions deployed; platform + switchable-site repos pushed.

## What was done this session
- **Auto-route private-pay:** removed the owner-confirm gate in `netlify-lead-router` so `pay_route='private'` leads auto-route to an `auto_route_enabled` provider like funded single-candidate leads.
- **Provider gets the "bill the learner" context:** `_shared/route-lead.ts` adds a PRIVATE PAY note to the sheet `notes`, a `pay_route` field on the sheet payload, and a PII-free callout in the provider notification email.
- **Admin display:** private-pay leads show an amber "Private pay" badge (not red DQ) on the leads list + detail, and routed ones get full enrolment/U1 tracking. `is_dq` column left unchanged (billing/analytics rely on it = "not a funded place").
- **Migration 0210:** widened the `provider_read_submissions` RLS to admit private-pay leads (`is_dq IS NOT TRUE OR pay_route='private'`) so the provider portal can see them. Was the reason EMS couldn't see Saranya.
- **Single source of truth for portal visibility:** new `app/lib/provider-lead-visibility.ts` (`applyProviderLeadVisibility`); real portal (list + home) and admin preview (list + home) both route through it. Fixes the drift where the preview reimplemented the filter and missed the private-pay widening.
- **Portal display:** "Private pay" badge + "Self-funding learner — bill them directly" banner + "Price-qualified: they were shown and accepted {price}" on the lead detail; "Private pay" sub-label in the list.
- **Migration 0211 + site capture:** new `leads.submissions.private_price_quoted` column; the funded form captures the course `private_option.price_display` (e.g. "under £1,690") via a hidden field set by `dqPrivatePay`; `_shared/ingest.ts` maps + inserts it.
- **Per-provider sign-off (switchable-site):** `accepts_private: true` on the page-YAML provider entry gates the private offer + routing per provider per course; set for EMS on Build an Online Shop + Intro to Management. `/new-course-page` skill updated to capture it.
- **u1_private welcome email:** `sendU1Transactional` now a 3-way branch (funded/self/private). Migration 0212 allows `email_type='u1_private'`. Brevo template `76` built + wired (`BREVO_TEMPLATE_U1_PRIVATE=76`). Fixes private payers previously getting the funded ("confirm you qualify") welcome.
- **Saranya (639)** routed to EMS via the owner-confirm email (predated the auto-route fix).
- **Counselling page:** confirmed already waitlist-only (empty `intakes[]` since 22 May); the blank welcome date was an old test contact, not a live issue. No change made.
- **Deploys:** migrations 0210/0211/0212 applied; `_shared/route-lead.ts` bundlers (14) redeployed across three rounds; `netlify-lead-router` + `netlify-leads-reconcile` for ingest; secret set; platform + switchable-site pushed.

## Next steps
1. Send a Brevo test of template `76` against a contact whose course has a start date (e.g. a Build an Online Shop / Tees Valley lead) to confirm `SW_COURSE_INTAKE_DATE` renders (counselling has no date, so it shows blank there).
2. Verify the Netlify builds landed (admin app + switchable-site): EMS preview should show Saranya with a "Private pay" badge + "bill them directly" banner; list sub-label reads "Private pay".
3. Watch the first brand-new private-pay lead end to end: auto-routes, shows "Private pay", appears in the portal with the price, gets template 76.
4. (Optional, flagged not built) graceful "which starts X" fallback in the welcome templates when a course has no intake date — twin wording or a fallback attribute, since Brevo conditionals are unreliable.

## Decisions and open questions
- **Private-pay leads auto-route with no owner approval** (owner decision: a learner who chooses to pay is warmer, not colder).
- **`is_dq` not flipped** — it stays `true` (= "didn't get a funded place") so billing/analytics still exclude funded counts; only routing + display changed.
- **`accepts_private` gate is per-provider-per-course** in the page YAML; new providers default off until onboarding records sign-off + price.
- **Price shown is the learner-facing `price_display`** ("under £1,690"), not the ex-VAT fee; switchable in the YAML if preferred.
- **Counselling stays waitlist** rather than fully taken down (keeps collecting interest for the next cohort).
- Open: none blocking.

## Watch items
- Netlify builds for the admin app (platform) + switchable-site were pushed late in the session — confirm they rendered before relying on the portal/site display.
- Saranya (639) received the funded U1 once (pre-fix, can't unsend) and her `private_price_quoted` is NULL (predates the column). Future private payers are correct.
- The pre-existing `trx.json` Deno type error in `route-lead.ts` persists (does not block deploy) — untouched.
- Untracked `docs/capi-server-side-scoping-2026-06-15.md` is not from this session; left in place.

## Next session
- **Folder:** platform
- **First task:** verify the first real private-pay lead end to end (auto-route, Private pay display, portal price, template 76), or send the template-76 Brevo test against a dated-course contact.
- **Cross-project:** switchable/site (per-provider `accepts_private` + `private_price_quoted` capture in the funnel) and switchable/email (`u1_private` template 76 live, source at `html-exports/u1-private.html`) — both pushed to their handoffs this session.
