# Provider Onboarding Playbook - Sheet + Apps Script + crm.providers

Steps to wire a newly signed pilot provider into the routing pipeline so leads flow from `netlify-lead-router` → owner confirm → `routing-confirm` → provider's Google Sheet → provider notification email, with zero code changes per provider.

Introduced Session 5 (2026-04-21), replacing the provider-specific `provider-sheet-appender.gs` (v1) pattern with a single canonical Apps Script v2 that reads the sheet's own header row.

---

## When to run this

Any of:
- New pilot provider signed the agreement and will start receiving leads
- Existing provider wants a different sheet layout (new headers, reordered columns)
- Apps Script token rotated (re-deploy every sheet)

---

## Prerequisites

- Provider is signed and logged in `accounts-legal/changelog.md`.
- Provider's `crm.providers` row exists and is active. If not, INSERT it first (see existing rows in `platform/supabase/data-ops/001_pilot_providers_init.sql` or `007_session_5_provider_seeds.sql` for the shape).
- Migration 0012 (`cc_emails` column) applied.
- `SHEETS_APPEND_TOKEN` value known (Edge Function secret; ask owner).

---

## Steps

### 1. Agree the sheet headers with the provider

Ask the provider what fields they want visible and in what order. Pick from the supported header set (matches FIELD_MAP in `platform/apps-scripts/provider-sheet-appender-v2.gs`):

**Identity / metadata**
- Lead ID, Submission ID, Submitted at, Course, Course ID, Funding route, Provider, Status

**Learner PII**
- Name (or First name / Last name separately), Email, Phone

**Funded-shape (for funded providers like EMS, WYK)**
- LA (Local authority), Region scheme, Age band, Employment, Prior L3, Start date checked, Outcome interest, Why this course

**Self-funded-shape (for self-funded providers like Courses Direct)**
- Postcode, Region, Reason, Interest, Situation, Qualification seeking, Start when, Budget, Courses selected

**Provider-owned manual columns (any header not in FIELD_MAP is safe - left empty by the script)**
- Notes, Enrolment date, Charge, Contact made, Follow-up, etc.

Header matching is case-insensitive and ignores whitespace / punctuation. "Lead ID", "lead_id", "LEAD-ID" are all the same header to the script.

### 2. Create the Google Sheet

1. New sheet in the owner's Google account (owner keeps ownership; provider becomes an Editor).
2. Row 1 = agreed headers from step 1.
3. Note the sheet ID from the URL: `https://docs.google.com/spreadsheets/d/SHEET_ID_HERE/edit`.

### 3. Deploy Apps Script v2 on the sheet

1. Extensions → Apps Script.
2. Delete the default `Code.gs` placeholder.
3. Paste the contents of `platform/apps-scripts/provider-sheet-appender-v2.gs`.
4. Replace `PASTE_TOKEN_HERE` with the real `SHEETS_APPEND_TOKEN` value.
5. Save (Ctrl+S or Cmd+S).
6. Deploy → New deployment → Web app, **Execute as:** Me (owner Google account), **Who has access:** Anyone.
7. Copy the Web app URL (the `/exec` one).
8. **Verify deployment state.** Deploy → Manage deployments. There should be **exactly one** Active deployment for this sheet, and its URL must match what you copied in step 7. If you see multiple Active deployments, or any Archived ones from earlier attempts, Archive them until only the intended one remains Active. Carry the one URL forward to step 5.

**Common trap (2026-04-22 incident):** clicking `Deploy → New deployment` creates a brand-new URL; clicking `Deploy → Manage deployments → (pencil icon) → New version` updates the existing URL. Some UI flows archive the old deployment and silently create a new one. Archived Apps Script deployments continue to respond to POSTs for some time, serving the code that was live at archive-time - which means `crm.providers.sheet_webhook_url` can silently point at stale code while the Active deployment you see in the editor runs the latest. Step 3.8 catches this. See `platform/docs/changelog.md` 2026-04-22 entry for the incident narrative.

### 4. Share the sheet with the provider

1. Share → add provider's email as Editor.
2. Add any CC-listed co-recipients (e.g. Ranjit at Courses Direct) as Editors.
3. Do NOT use "Anyone with the link" - that breaches the PII rule in `memory/feedback_pii_sharing.md`.

### 5. Seed `crm.providers` with sheet_id + webhook_url + cc_emails

In Supabase SQL editor, as owner:

```sql
UPDATE crm.providers
   SET sheet_id          = '<sheet id from step 2>',
       sheet_webhook_url = '<web app URL from step 3>',
       cc_emails         = ARRAY['<cc1@example.com>', '<cc2@example.com>'], -- or '{}' if none
       updated_at        = now()
 WHERE provider_id = '<slug>';
```

### 6. End-to-end test

1. Submit a lead via the provider's course page using an owner-allowlisted email (`*@switchable.org.uk` etc. - see `OWNER_TEST_EMAILS` and `OWNER_TEST_DOMAINS` in `platform/supabase/functions/_shared/ingest.ts`).
2. The lead lands as `is_dq=true, dq_reason='owner_test_submission'` and does NOT fire owner notification.
3. To test the full path, submit with a real-looking email (NOT an owner-allowlisted one). Owner notification email fires with confirm buttons for each candidate provider.
4. Click the confirm button for the provider being onboarded.
5. Verify:
   - Confirmation page shows "Lead sent to <Company Name>."
   - `leads.routing_log` has a new row.
   - Sheet has a new row in whatever columns the headers specified.
   - Provider received a "new enquiry - check your sheet" email (CCs working).
6. Archive the test row in the DB (`is_dq=true, archived_at=now()`) and delete from the sheet.

### 7. Log in the changelog

Add a `platform/docs/changelog.md` entry: provider slug, sheet id (reference), date, who tested, any deviations from the playbook.

---

## Token rotation (periodic)

If `SHEETS_APPEND_TOKEN` rotates:

1. Generate new value: `openssl rand -hex 32`.
2. Update Supabase Edge Functions → Manage secrets → `SHEETS_APPEND_TOKEN` to the new value.
3. For EVERY deployed sheet: Apps Script editor → update `TOKEN` at the top → save (Ctrl+S) → Deploy → Manage deployments → edit the existing web app deployment → Version dropdown → New version → Deploy.
4. **Verify deployment state after each redeploy.** Deploy → Manage deployments must still show exactly ONE Active deployment per sheet, and its URL must match `crm.providers.sheet_webhook_url` for that provider. If a new deployment was accidentally created instead of a new version of the existing one, archive the old one AND `UPDATE crm.providers SET sheet_webhook_url = '<new URL>'` in lockstep. See step 3.8 + the 2026-04-22 incident entry in `platform/docs/changelog.md`.
5. End-to-end test at least one sheet to confirm the new token works both sides.
6. Log rotation in `platform/docs/secrets-rotation.md`.

Do NOT rotate partially. Supabase-only = every sheet breaks. Sheet-only = Edge Function starts rejecting.

---

## Retiring a sheet

When the Phase 4 provider dashboard ships and a provider cuts over:

1. Stop deliveries to the sheet by nulling `sheet_webhook_url` on the provider row. `routing-confirm` falls back to the paste-manually email path until the new dashboard takes over (or until the new delivery method is wired).
2. Take a CSV export of the sheet for archive (`File → Download → CSV`).
3. Share the sheet Read-only with the provider going forward (historical record).
4. Delete the Apps Script deployment (Apps Script editor → Deploy → Manage deployments → Archive).
5. Log retirement in `platform/docs/changelog.md`.

---

## References

- Canonical script: `platform/apps-scripts/provider-sheet-appender-v2.gs`
- v1 historical reference (no live deployments since 2026-04-29 EMS migration): `platform/apps-scripts/provider-sheet-appender.gs`
- Routing flow architecture: `platform/docs/data-architecture.md` (§ `leads.submissions` writers + `crm.providers` sheet integration)
- Session 5 design rationale: `platform/docs/changelog.md` 2026-04-21 (evening) entry
- Hard rules on PII sharing: `memory/feedback_pii_sharing.md`, `memory/feedback_provider_email_no_pii.md`
