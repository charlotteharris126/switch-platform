# Auto-routing Design (v1)

**Status:** Proposed 2026-04-25 (platform Session 9). Awaiting owner sign-off before build.
**Scope:** Replace the email-confirm step on the routing path for the 80% common case. Email-confirm stays as the fallback for edge cases.
**Build estimate:** ~1.5–2 hours, one platform session.

---

## Today's flow (recap, plain English)

1. Learner submits the form on switchable.careers.
2. Netlify forwards the submission to the `netlify-lead-router` Edge Function.
3. Function writes the row to `leads.submissions` and emails Charlotte with one "Confirm to [Provider]" button per candidate provider.
4. Charlotte clicks → `routing-confirm` runs: appends to provider's Google Sheet, emails the provider, writes the routing_log row, sets `primary_routed_to`, writes audit row.

The friction point: step 3 + 4. Charlotte has confirmed every single lead so far. The email step is verifying nothing she isn't already happy with.

## Proposed v1 flow

When a lead lands, decide automatically:

- **If exactly one candidate provider AND that provider has `auto_route_enabled = true`** → route immediately, no Charlotte click. Send Charlotte an FYI email ("Routed lead 142 to EMS") rather than a confirm-button email. Audit row tagged `auto_routed`.
- **Otherwise** → fall back to today's email-confirm flow.

That's it. No scoring, no round-robin, no AI. Just "single candidate + provider opted in" → automatic.

## Why this v1

- **80% rule (Charlotte 2026-04-25):** most live courses today have one candidate provider. Counselling and SMM → EMS only. LIFT → WYK Digital only. Find-your-course → Courses Direct only. So the single-candidate path covers nearly all live volume.
- **Multi-provider stays manual:** Phase 2 will add provider scoring (`vw_provider_performance` already in schema from Session C). For now, ambiguous routing keeps Charlotte in the loop.
- **Per-provider opt-in:** the `crm.providers.auto_route_enabled` flag already exists. Default is `false`. Charlotte toggles ON per provider via the provider edit form (already shipped Session D) once she trusts each one for auto-routing.

## The multi-provider edge case (worked through)

When does a lead have multiple candidates? Two routes today:
1. **`provider_ids`** array on the form payload comes in with >1 entry. Today this only happens for self-funded leads where `find-your-course` defaults to `[courses-direct]` but could carry more if course YAMLs evolve.
2. **Course YAML** lists multiple `provider_ids`. Already designed for; not used in any live YAML.

Decision: in v1, multi-candidate routing **always** falls back to email-confirm. Reasons:
- No good signal for picking yet (no enrolment data per provider per course).
- Keeps Charlotte's oversight where stakes are highest.
- Phase 2 adds the auto-routing scoring algorithm noted in `platform/CLAUDE.md` growth triggers ("3+ providers per course routinely matched on the same routing criteria → build auto-routing algorithm").

So the 20% case stays where it is until enrolment data justifies a smarter pick.

## What to build

### 1. Refactor: extract shared routing logic
Today `routing-confirm` does INSERT routing_log + UPDATE submissions + sheet append + provider notification + audit, all inline. Move that into `_shared/route-lead.ts` so both `routing-confirm` (token-triggered) and `netlify-lead-router` (auto-route triggered) call the same function.

### 2. Decision logic in `netlify-lead-router`
After the lead is inserted into `leads.submissions`, check:
- `is_dq` is false
- `provider_ids.length === 1`
- That provider exists, is `active`, and has `auto_route_enabled = true`

If all true → call the shared route-lead helper. If any false → email-confirm path (today's behaviour).

### 3. Owner FYI email
A new email template: "Routed lead 142 to EMS." No confirm buttons. Just visibility. Charlotte can disable this flag-by-flag once she trusts the system fully (a `notify_on_auto_route` provider setting could be added later if she wants).

### 4. Audit
Every auto-route writes a `system`-surface audit row via `audit.log_system_action()`:
- `action = 'auto_route_lead'`
- `target_table = 'leads.submissions'`
- `target_id = lead id`
- `context = { sole_candidate: provider_id, decision_path: 'sole_candidate_auto_route_enabled' }`

## What v2 might add (later, when warranted)

- **Provider scoring:** when a course routinely matches 3+ providers on the same criteria, build a scoring algorithm based on `vw_provider_performance` (already in schema). Per the existing growth trigger in `platform/CLAUDE.md`.
- **Capacity caps:** providers can set monthly lead caps. Once the cap is hit, route falls back to next best.
- **A/B routing experiments:** for new providers, randomly route a slice of leads to compare conversion vs. incumbents.
- **Earned-trust progression:** auto-track each provider's enrolment rate; when it crosses a threshold, suggest enabling `auto_route_enabled` automatically.

## Risks

- **A bad lead reaches a provider without Charlotte's eyes on it.** Mitigation: only auto-route when `is_dq = false`, and Charlotte must explicitly opt each provider in. The DQ classifier in `_shared/ingest.ts` already handles owner test emails, dummy domains, region/postcode/age fails.
- **Provider sheet append fails.** Today's behaviour: dead_letter row + "paste manually" email to owner. Same in v1 — auto-routing reuses the existing failure path.
- **Provider notification fails.** Same — Brevo error logged, owner sees it via dead_letter. Lead is still routed in DB; just the email didn't land.
- **Auto-route happens for a lead that should have been DQ'd.** Mitigation: auto-route runs AFTER ingest classification. Any DQ flag from the ingest layer (or owner-test override) blocks auto-route.

## Decision matrix for auto-route

| `provider_ids` count | `auto_route_enabled` on provider | Lead is DQ | Decision |
|---|---|---|---|
| 1 | true | false | **auto-route** |
| 1 | false | false | email-confirm |
| 1 | true | true | DQ path (no routing) |
| ≥2 | any | false | email-confirm |
| 0 | n/a | false | dead_letter (no candidate) |

## Provider toggle state at design time

**Owner decision 2026-04-25:** `auto_route_enabled = true` for all 3 pilot providers (EMS, WYK Digital, Courses Direct). Set via SQL same day. No behavioural change until the Edge Function logic ships — these toggles are just config waiting for the build.

Heads-up about WYK Digital: the LIFT Digital Marketing Futures campaign has ended (cohort closed Fri 24 Apr 2026 evening when Heena's interview deadline closed). The course YAML is in `cohort_closed` state, so any switchable.org.uk visitor to the LIFT page sees the waitlist panel rather than the apply form. **Effect on auto-routing:** zero leads will currently route to WYK because the funnel can't produce them — the cohort_closed pattern blocks at the form layer, before lead-router even sees a submission. The toggle is on so when WYK runs another cohort (with a fresh `application_deadline`), auto-routing kicks in immediately without a config touch.
