# Session 3 — Scope

**Status:** Approved 2026-04-20 by owner. Ready to build.
**Drafted:** 2026-04-20
**Author:** Claude, with owner direction (same session)
**Supersedes:** the single-line Session 3 description in `.claude/rules/business.md` and the Session 3 bullet in `platform/docs/current-handoff.md`. Both will be updated on build.

**Decisions locked in (2026-04-20):**
- Sender domain: `switchleads.co.uk` (DNS records to be added at the registrar — owner task)
- Sender address: `notifications@switchleads.co.uk`, single address for both owner and provider emails
- Confirm-link tokens: HMAC-signed query strings
- v1 only routes to candidate providers from the course YAML; edge cases go through SQL
- Sheet write failure: provider email suppressed, Charlotte gets a "paste manually" alert, row lands in `leads.dead_letter`
- Multi-provider UX: two buttons in the owner email, side by side

---

## Purpose

Remove the manual SQL step from the lead routing flow, and alert providers automatically when a new lead has been assigned to them. End state: a lead lands, Charlotte clicks one link in an email, the lead lands in the provider's sheet with status `open`, and the provider gets a short heads-up email.

The current manual pattern works at three leads. It will not work at thirty.

---

## Current state (as of 2026-04-19)

1. Form submitted on `switchable.org.uk` → Netlify webhook → `netlify-lead-router` Edge Function → row inserted into `leads.submissions`
2. Charlotte receives Netlify's default form notification email (plain, no lead context, no routing decision)
3. Charlotte opens the Supabase SQL Editor, runs a saved snippet to insert a `leads.routing_log` row and update `leads.submissions.primary_routed_to` + `routed_at`
4. Charlotte opens the provider's shared Google Sheet, manually pastes the lead row with status `open`
5. No automated email to the provider. Andy currently finds out because Charlotte messages him

Three pilot leads have been routed this way (Susan, Lesley, Katy — all to EMS).

---

## Target flow (post-Session 3)

1. Form submitted → Netlify webhook → `netlify-lead-router` → row in `leads.submissions` (unchanged)
2. `netlify-lead-router` composes a rich notification email via Brevo and sends it to Charlotte. Email contains: full lead context (all PII fields Charlotte needs to judge the routing), course matched, candidate `provider_ids` from the course YAML, one `[Confirm → {provider}]` link per candidate, one `[DQ this lead]` link
3. Charlotte clicks one link
4. The `routing-confirm` Edge Function:
   a. Inserts a `leads.routing_log` row and updates `leads.submissions.primary_routed_to` + `routed_at`
   b. Appends a row to the matched provider's Google Sheet with status `open` and all the columns Andy uses
   c. Sends a short notification email via Brevo to the provider's `contact_email`, containing no PII, pointing them at their sheet
5. Charlotte's manual SQL step is gone. The provider's sheet is updated automatically. The provider knows within seconds that a new lead has arrived.

---

## Scope boundaries

### In scope

- Brevo account setup, sender domain verification, API key creation, secret added to Supabase Edge Function secrets
- `netlify-lead-router` extended to send owner-notification email with confirm links
- New `routing-confirm` Edge Function (one-click handler for the confirm links)
- Google Sheets service-account integration from the Edge Function to append rows
- `sheet_id` + `sheet_tab` columns on `crm.providers`, plus seed values for EMS and Courses Direct
- Notion Tech Stack entries for Brevo and Google Sheets API
- Secrets rotation tracker entries for the new Brevo API key and the Google service-account JSON
- Infrastructure manifest entries for the new Edge Function, the new secrets, and the outbound Brevo dependency
- Updates to `data-architecture.md`, `business.md`, `current-handoff.md`, `changelog.md` reflecting the new flow

### Out of scope (deliberate)

- **The provider portal.** Password-protected branded backend for providers was scoped earlier this session and dropped. Andy has Google access; sheet append is enough for now. The proper front-facing platform will replace the sheet entirely when built.
- **Provider-initiated status changes.** Andy updates status in his own sheet manually. There is no sync back from the sheet to `crm.enrolments` in this scope. When the platform front-end is built, `crm.enrolments` becomes the source of truth and the sheet is retired.
- **Sheet formatting / formulas / protection.** Plain rows in existing headers. No styling, no locked cells, no data-validation rules. The sheet is temporary.
- **Auto-routing to multiple providers.** The confirm link picks one provider per lead. Multi-route and rotation logic is Phase 4.
- **Learner-side communication.** No auto-emails to learners in this scope.
- **Replacing the existing plain Netlify notification.** Can be left on or off by Charlotte's preference; the rich Brevo email replaces it functionally.

---

## Schema changes

One small migration. Additive, no data transformation.

### Migration 0009 — add sheet_id + sheet_tab to crm.providers

```sql
ALTER TABLE crm.providers
  ADD COLUMN sheet_id  TEXT,
  ADD COLUMN sheet_tab TEXT;

COMMENT ON COLUMN crm.providers.sheet_id  IS 'Google Sheet spreadsheet ID for the provider''s temporary lead sheet. Retired when platform front-end is live.';
COMMENT ON COLUMN crm.providers.sheet_tab IS 'Tab name inside the spreadsheet. Defaults to the first sheet if null.';
```

Seed values for EMS and Courses Direct set in the same migration as UPDATE statements.

### Why not a new table

`crm.enrolments` already models per-lead-per-provider state with every column Andy's sheet shows (status, notes, enrolment_date, billed_amount). It is the future source of truth. Adding a parallel `crm.provider_lead_view` would create a duplicate source — against the standing tidiness rule. The Google Sheet is the temporary mirror of `crm.enrolments`, not of a new table.

### Column mapping (sheet headers → schema)

| Sheet column | Source |
|---|---|
| Lead ID | `leads.submissions.id` formatted `SL-YY-MM-NNNN` (Katy pattern) |
| Submitted at | `leads.submissions.submitted_at` (UK local) |
| Course | `course_id` resolved to course title via course YAML |
| Name | `first_name` + `last_name` |
| Email | `leads.submissions.email` |
| Phone | `leads.submissions.phone` |
| LA | `leads.submissions.la` |
| Region scheme | `leads.submissions.region_scheme` |
| Age band | `leads.submissions.age_band` |
| Employment | `leads.submissions.employment_status` |
| Prior L3 | `leads.submissions.prior_level_3_or_higher` (Yes/No) |
| Start date checked | `leads.submissions.can_start_on_intake_date` (Yes/No) |
| Provider | `crm.providers.company_name` |
| Status | Literal `open` on insert |
| Enrolment date | Blank on insert. Andy fills in. |
| Charge | Blank on insert. Billing logic computes later. |
| Notes | Blank on insert. Andy fills in. |

---

## External integrations

### Brevo (transactional email)

- Account: new, owned by `hello@switchable.careers`
- Sender domain: `switchleads.co.uk` (needs DKIM + SPF records added to DNS — 5 min via registrar)
- Sender address for owner notifications: `leads@switchleads.co.uk` (suggested; open question 3)
- Sender address for provider notifications: same or a separate `notifications@switchleads.co.uk`
- API key: single transactional key, least-privilege, rotated annually
- Fallback: if the Brevo API errors, the Edge Function writes a row to `leads.dead_letter` with `source='edge_function_brevo_send'` and continues. The lead is still safely in `leads.submissions`.

### Google Apps Script (provider sheet append)

Chosen over Google Sheets API + service account to avoid a Google Cloud project for a transitional surface. Apps Script is right-sized for the lifespan (retires with the platform front-end).

- Canonical script: `platform/apps-scripts/provider-sheet-appender.gs`
- Deployed in each provider's sheet via Extensions → Apps Script → Deploy as Web app (Execute as: owner; Who has access: Anyone)
- Each deployment gives a unique Web app URL, stored in `crm.providers.sheet_webhook_url`
- Authentication: shared token (`SHEETS_APPEND_TOKEN`) verified inside the script. Token rides in the JSON body (Apps Script web apps strip custom headers)
- Token stored as Supabase Edge Function secret. Same token across all provider scripts; rotated annually (or on leak). Rotation = update TOKEN constant in every deployed script AND the Supabase secret in lockstep
- Fallback: if the POST fails or returns non-`ok`, the Edge Function writes to `leads.dead_letter` with `source='edge_function_sheet_append'`. Charlotte gets a "routing confirmed but sheet append failed, paste manually" email via Brevo. The row is still safely in `leads.submissions` and the routing is logged.

---

## Secrets needed

| Secret | Purpose | Lives in | Rotation |
|---|---|---|---|
| `BREVO_API_KEY` | Send transactional email | Edge Function secrets | Annual |
| `BREVO_SENDER_EMAIL` | From address for outbound emails | Edge Function secrets (non-secret but centralised) | On change |
| `SHEETS_APPEND_TOKEN` | Verifies Edge Function POSTs to provider Apps Script webhooks | Edge Function secrets + inline in each deployed Apps Script | Annual, rotate on leak |
| `ROUTING_CONFIRM_SHARED_SECRET` | Signs the confirm-link tokens so only Charlotte-originating clicks are accepted | Edge Function secrets | Annual, rotate on leak |

All four added to `platform/docs/secrets-rotation.md` on build.

---

## Impact assessment (per .claude/rules/data-infrastructure.md §8)

1. **What changes:** One new Edge Function (`routing-confirm`), one modified Edge Function (`netlify-lead-router`), one additive migration, two new Edge Function secrets, one additive column pair on `crm.providers`. New external dependencies: Brevo, Google Sheets API. No existing rows transformed.
2. **What reads the affected tables:** `crm.providers` is read by the routing logic in `netlify-lead-router` via `provider_ids`. Adding two nullable columns breaks nothing. Metabase (not yet live), Sasha's reads, agents via `readonly_analytics` — all unaffected.
3. **What writes the affected tables:** Only the Edge Functions and the owner (manual UPDATE in SQL editor). Migration 0009 adds the new columns; no producer change needed beyond the new Edge Function behaviour.
4. **`schema_version` bump:** None. The lead payload from the form is unchanged. The internal schema gains optional columns; external contracts are identical.
5. **Data migration:** None. Existing rows in `crm.providers` get NULL for the new columns. UPDATE statements seed values for the two active providers in the same migration.
6. **New scoped role or RLS policy:** None. Existing `n8n_writer` role already has INSERT/UPDATE on `leads.routing_log` and SELECT on `crm.providers`. It does NOT have UPDATE on `crm.providers`, which is correct — the seed UPDATEs run under the `owner` role during migration, not at runtime.
7. **Rollback:** Revert by dropping the two columns (migration DOWN) and un-deploying `routing-confirm`. Revert `netlify-lead-router` to previous git SHA. No data loss; leads still land in `leads.submissions`.
8. **Sign-off:** Owner signs off on this scope doc before build. Mira signs off on the architectural shape (cross-brand: SwitchLeads site unaffected, Switchable site unaffected, platform gains one function). No other consumer signs needed.

---

## Build order

Each block is small and verifiable before moving on.

1. **Brevo setup** (~20 min): create account, verify `switchleads.co.uk` domain (DNS records), create API key, send a test email from the Brevo UI, add API key to Edge Function secrets.
2. **Google Cloud + Sheets setup** (~20 min): create service account, download JSON, add to Edge Function secrets, share both provider sheets (EMS + Courses Direct) with the service account email.
3. **Migration 0009** (~10 min): draft, test locally, apply to production via SQL editor, verify `SELECT sheet_id, sheet_tab FROM crm.providers` returns seeded values.
4. **`routing-confirm` Edge Function** (~2 hr): new function, signed-token verification, inserts routing_log, updates submission, calls Sheets API, calls Brevo API for provider notification, returns a branded HTML "confirmed" page. Deploy.
5. **Extend `netlify-lead-router`** (~1 hr): on row insert, compose rich owner notification email via Brevo with signed confirm links per candidate provider. Deploy.
6. **End-to-end test** (~30 min): submit a test lead (owner-test-domain auto-DQ path gives us a safe loop), walk through the full flow, verify sheet append + provider email deliverability.
7. **Docs + changelog + manifest + secrets tracker + business.md + Notion Tech Stack** (~30 min).
8. **Handoff** (~10 min): close session cleanly.

Total: around 4.5 hours. Best tackled in one session.

---

## Docs and files updated on build

- `platform/docs/data-architecture.md` — new columns on `crm.providers`, note the temporary-sheet integration
- `platform/docs/changelog.md` — full entry following §9 format
- `platform/docs/infrastructure-manifest.md` — `routing-confirm` Edge Function, Brevo dependency, Sheets dependency, three new secrets
- `platform/docs/secrets-rotation.md` — four new secret rows
- `platform/docs/current-handoff.md` — Session 3 marked complete, Session 4 (Meta Ads pull) reinstated as next
- `platform/supabase/migrations/0009_add_provider_sheet_refs.sql` — new migration
- `platform/supabase/functions/routing-confirm/` — new function
- `platform/supabase/functions/netlify-lead-router/` — modified
- `.claude/rules/business.md` — Session 3 description expanded to include sheet append + provider email
- `master-plan.md` — Brevo moved from "setup pending" to "live"
- Notion Tech Stack — Brevo entry, Google Sheets API entry
- Notion Business Operations — no change (business model unchanged)

---

## Open questions

1. **Sender domain.** `switchleads.co.uk` vs an alternative. Confirming now lets DNS verification start in parallel with build. Recommend `switchleads.co.uk` since provider-facing email should come from the provider-facing brand.
2. **Sender addresses.** `leads@switchleads.co.uk` for Charlotte-facing emails. One address or separate for provider notifications? Recommend one address for now (`notifications@switchleads.co.uk`); split if volume or spam reputation demands it later.
3. **Confirm-link token format.** Signed JWT or HMAC-signed query string. HMAC is lighter and sufficient; recommend HMAC unless owner wants audit-ready JWT structure.
4. **Charlotte override.** Should the owner notification email include a "Route to a provider not in the candidate list" option, or require Charlotte to go to the SQL editor for edge cases? Recommend: v1 limits to candidates from the course YAML; edge cases go through SQL. Keeps the function simple.
5. **Sheet write failure behaviour.** If Sheets API append fails but routing_log succeeds, how is Charlotte alerted? Recommend: the provider email is NOT sent, Charlotte receives a "routing confirmed but sheet append failed — paste manually" email, the row is in `leads.dead_letter` for retry.
6. **Multi-provider candidate UX.** If a course has two candidate providers, does the owner notification email show two confirm buttons side by side, or one "compare and choose" page behind a single link? Recommend: two buttons. Simpler, fewer moving parts.

---

## Sign-off (completed 2026-04-20)

- [x] Scope as written is correct
- [x] Brevo confirmed as email provider
- [x] Sender domain `switchleads.co.uk`, address `notifications@switchleads.co.uk`
- [x] Open questions 1–6 answered (see header)
- [x] Build can run in one session or split at any block boundary; owner to decide at session start
- [x] This doc is the Session 3 source of truth; `business.md` and `current-handoff.md` update on build

**Owner action before build:** add DKIM + SPF records for `switchleads.co.uk` at the registrar (~5 min, Brevo provides the exact values after account creation). Build cannot complete Block 1 until these records have verified.
