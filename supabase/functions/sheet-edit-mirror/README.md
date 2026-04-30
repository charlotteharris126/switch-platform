# sheet-edit-mirror

Deployment + activation playbook for the sheet→DB mirror system. Pairs with the [pending-update-confirm](../pending-update-confirm/) Edge Function and [provider-sheet-edit-mirror.gs](../../../apps-scripts/provider-sheet-edit-mirror.gs) Apps Script.

Full design: [platform/docs/sheet-mirror-scoping.md](../../../docs/sheet-mirror-scoping.md).

---

## Deployment phases at a glance

| Phase | What it does | Gates |
|---|---|---|
| **Phase 1 — Channel A** | Status column edits auto-mirror to `crm.enrolments` | None — ships independently |
| **Phase 2 — Channel B** | Updates column edits get AI-interpreted, queued for owner approval | Phase 0 legal/privacy sign-off |

Channel A delivers the consolidated state visibility on its own. Channel B layers on once Clara has confirmed the privacy policy, learner consent text, and Anthropic DPA.

---

## Phase 1 — Ship Channel A

### Step 1: Apply migration 0047

```bash
cd platform
supabase db push
```

Verify in the Supabase SQL editor:
```sql
SELECT count(*) FROM crm.sheet_edits_log;     -- should return 0
SELECT count(*) FROM crm.pending_updates;     -- should return 0
```

### Step 2: Set the Edge Function secret

`SHEETS_APPEND_TOKEN` is already set (used by the appender). The mirror function reuses it. Verify:

```bash
supabase secrets list | grep SHEETS_APPEND_TOKEN
```

### Step 3: Deploy the Edge Functions

```bash
supabase functions deploy sheet-edit-mirror --no-verify-jwt
supabase functions deploy pending-update-confirm --no-verify-jwt
```

The `--no-verify-jwt` flag is mandatory — these functions are called by Apps Script (no Supabase auth context) and from email links.

### Step 4: Smoke-test the Edge Function

```bash
curl -X POST https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/sheet-edit-mirror \
  -H "Authorization: Bearer <SHEETS_APPEND_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "lead_id": "1",
    "provider_id": "test-provider-that-does-not-exist",
    "column": "Status",
    "old_value": "Open",
    "new_value": "Contacted",
    "editor_email": "test@switchable.careers",
    "edited_at": "2026-04-30T14:00:00Z"
  }'
```

Expected: `{"ok":false,"action":"rejected","reason":"no enrolment"}` and a row in `crm.sheet_edits_log` with `action='rejected'`.

### Step 5: Add Status + Updates columns to each provider sheet

For each of the three pilot sheets (EMS, WYK Digital, Courses Direct):

1. Open the sheet.
2. Add `Status` column header at the next free position. Apply data validation: dropdown with values `Open`, `Contacted`, `Enrolled`, `Not enrolled`, `Disputed`. (Data → Data validation → Dropdown → enter the five values).
3. Add `Updates` column header at the next free position. No validation.
4. For existing rows where the lead is unresolved (open / contacted), set Status to `Open` (or whatever matches reality). Don't touch billed leads — they're frozen.

### Step 6: Install the Apps Script trigger on each sheet

For each of the three pilot sheets:

1. Open the sheet → Extensions → Apps Script.
2. Click `+` next to "Files" → Script. Paste the contents of [`platform/apps-scripts/provider-sheet-edit-mirror.gs`](../../../apps-scripts/provider-sheet-edit-mirror.gs). Save.
3. At the top of the new file, replace `PASTE_TOKEN_HERE` with the current `SHEETS_APPEND_TOKEN` value.
4. Replace `PASTE_PROVIDER_ID_HERE` with the provider's slug (`enterprise-made-simple`, `wyk-digital`, `courses-direct`).
5. Click the clock icon (Triggers) in the left sidebar.
6. Click `+ Add Trigger` (bottom right).
7. Configure:
   - Function: `onEdit`
   - Event source: `From spreadsheet`
   - Event type: `On edit`
8. Authorise when prompted (the trigger runs as you, the owner).

### Step 7: End-to-end verification per provider

In each sheet:

1. Pick a lead with an existing `crm.enrolments` row (any routed lead post-2026-04-19).
2. Change the `Status` cell from `Open` to `Contacted`.
3. Within ~5 seconds, verify in Supabase:

```sql
SELECT id, status, status_updated_at
FROM crm.enrolments
WHERE submission_id = <the lead id>
ORDER BY id DESC LIMIT 1;
```

Status should be `contacted`. Then check the audit row:

```sql
SELECT action, applied_status, received_at
FROM crm.sheet_edits_log
WHERE provider_id = '<provider slug>'
ORDER BY id DESC LIMIT 1;
```

Action should be `mirrored`. Repeat for at least one other transition (`Contacted → Enrolled`).

Test the anomaly path: try setting Status to a value not in the dropdown (disable validation temporarily). Expect an anomaly email and `action='queued'`.

### Step 8: Update `infrastructure-manifest.md`

Add rows for `sheet-edit-mirror` and `pending-update-confirm` Edge Functions. See [the manifest](../../../docs/infrastructure-manifest.md) for format.

**Phase 1 ships when steps 1–8 are complete and verified.** Channel A runs in production from this point.

---

## Phase 2 — Activate Channel B

**Cannot start until Phase 0 (legal/privacy) is complete.** See [sheet-mirror-scoping.md § Phase 0](../../../docs/sheet-mirror-scoping.md) for the legal prerequisites.

### Step 1: Set Channel B secrets

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set PENDING_UPDATE_SECRET=$(openssl rand -hex 32)
```

`PENDING_UPDATE_SECRET` is the HMAC key for the email button tokens. It must NOT be in iCloud-synced files. Generate fresh, paste once into Supabase, never store elsewhere.

### Step 2: Verify Anthropic API access

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model": "claude-haiku-4-5-20251001", "max_tokens": 50, "messages": [{"role": "user", "content": "ping"}]}'
```

Expected: 200 OK with a message body. If 401, the API key is wrong. If 404, the model ID is wrong (check current Haiku model ID in the Anthropic console).

### Step 3: Flip the activation flag

```bash
supabase secrets set CHANNEL_B_ENABLED=true
```

Re-deploy to pick up the env change:

```bash
supabase functions deploy sheet-edit-mirror --no-verify-jwt
```

### Step 4: End-to-end Channel B test per provider

In each sheet:

1. Pick a lead with an existing `crm.enrolments` row.
2. Type a test note in the `Updates` cell: e.g. `Spoke to learner this morning, very keen, paperwork going out today.`
3. Within ~10 seconds, expect an email to `hello@switchable.careers` with subject like `[Status suggestion] <name> — enrolled (high)`.
4. Click `Approve`. Expect a success page and `crm.enrolments.status` updated.
5. Verify audit:

```sql
SELECT action, ai_implied_status, ai_confidence, applied_status
FROM crm.sheet_edits_log
WHERE provider_id = '<provider slug>'
ORDER BY id DESC LIMIT 5;
```

Should see `ai_suggested` (followed by `ai_approved` after the click). Test reject and override paths in the same way.

### Step 5: Set up daily auto-expire sweep

Pending updates expire after 7 days. Add a cron sweep to clean up expired rows:

```sql
-- Run daily at 04:00 UTC; same pg_cron pattern as purge-stale-partials.
SELECT cron.schedule(
  'pending-updates-expire-sweep',
  '0 4 * * *',
  $$
    UPDATE crm.pending_updates
    SET status = 'expired',
        resolved_at = now(),
        resolved_by = 'auto_expire'
    WHERE status = 'pending'
      AND resolver_token_expires_at < now();
  $$
);
```

### Step 6: Update infrastructure manifest + secrets rotation

Add rows for `ANTHROPIC_API_KEY` and `PENDING_UPDATE_SECRET` to [`platform/docs/secrets-rotation.md`](../../../docs/secrets-rotation.md). Annual rotation default.

---

## Rollback

If anything goes wrong:

- **Disable Channel B:** `supabase secrets set CHANNEL_B_ENABLED=false` and re-deploy. AI calls stop immediately. Existing pending suggestions remain in the DB and can still be approved/rejected.
- **Disable both channels:** Delete the Apps Script `onEdit` trigger on each sheet (Triggers → trash icon). Sheet edits stop firing the function. The function and tables stay in place; no data lost.
- **Full rollback:** `supabase migration revert 0047` (uses the `-- DOWN` block in the migration file). Drops `crm.sheet_edits_log` and `crm.pending_updates`. Apps Script triggers must be deleted separately.

---

## Operational notes

- **Verify each function deploy with `verify_jwt=false`.** Missing this flag silently 401s every webhook (memory: feedback_supabase_function_deploy_flags).
- **Announce diagnostic writes before they happen** during testing (memory: feedback_announce_diagnostic_writes). Test rows in `crm.sheet_edits_log` are fine — they have an `action='rejected'` and don't touch enrolments.
- **End-to-end verification matters more than component checks** (memory: feedback_end_to_end_setup). Don't sign off Phase 1 until you've watched a sheet edit land as a `mirrored` row in the audit log AND the enrolment row has the new status.
