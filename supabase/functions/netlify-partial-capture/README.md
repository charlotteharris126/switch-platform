# `netlify-partial-capture` — Edge Function

Captures progressive step data from the Switchable multi-step forms so we can analyse funnel drop-off. Called **directly from the browser** (not via Netlify Forms webhook), upserts into `leads.partials` keyed by `session_id`.

**Non-PII only.** This function stores preference/intent answers (reason, interest, budget, etc.) and attribution. It never touches first_name / last_name / email / phone — those land on `leads.submissions` via `netlify-lead-router` on final submit.

## How it fits together

```
Browser (/js/partial-tracker.js)
   │
   │ fetch POST { session_id, form_name, step_reached, answers, utm_*, ... }
   ▼
netlify-partial-capture (this function)
   │ UPSERT into leads.partials ON CONFLICT (session_id) DO UPDATE
   │ GREATEST(step_reached), answers = existing || incoming
   │ upsert_count += 1 (rate-limit cap at 50 per session)
   ▼
leads.partials (is_complete = false until final submit)

... later, learner submits the form ...

Netlify Forms → outgoing webhook → netlify-lead-router
   │ INSERT leads.submissions (including session_id from hidden field)
   │ UPDATE leads.partials SET is_complete = true WHERE session_id = $1
   ▼
leads.partials (is_complete = true) + leads.submissions (session_id populated)

Metabase queries public.vw_funnel_dropoff (JOIN partials → submissions on session_id)
```

## Deployment

### 1. Apply migrations first

```
0004_add_leads_partials.sql
0005_add_submissions_session_id.sql
```

These create the table, view, pg_cron purge, and the `session_id` column on `leads.submissions`. The Edge Function will fail if the table doesn't exist.

### 2. Function secrets

No additional secrets required — inherits `SUPABASE_DB_URL` auto-injected by Supabase, same as `netlify-lead-router`. Drops to `functions_writer` via `SET LOCAL ROLE`.

### 3. Deploy

```bash
cd platform
supabase functions deploy netlify-partial-capture --no-verify-jwt
```

`--no-verify-jwt` is essential — this function is called from the browser without auth. Security relies on:
- `ALLOWED_FORMS` hard-coded allowlist (`switchable-self-funded`, `switchable-funded`)
- `session_id` UUID format validation
- `upsert_count` per-session cap (50)
- `answers` PII key blocklist (belt-and-braces)
- CORS `*` (the endpoint is meant to be public)

Function URL after deploy:
```
https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-partial-capture
```

## Payload shape

```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "form_name": "switchable-self-funded",
  "step_reached": 3,
  "answers": {
    "reason": "career-change",
    "interest": "it",
    "situation": "employed-ft"
  },
  "page_url": "https://switchable.org.uk/find-your-course/",
  "course_id": null,
  "funding_category": "self",
  "funding_route": "self",
  "utm_source": "meta",
  "utm_medium": "paid",
  "utm_campaign": "120215xxx",
  "utm_content": "120216xxx",
  "fbclid": "IwAR...",
  "gclid": null,
  "referrer": "https://www.facebook.com/",
  "user_agent": "Mozilla/5.0 ...",
  "device_type": "mobile"
}
```

All fields except `session_id`, `form_name`, and `step_reached` are optional. The function merges on conflict — sending a partial payload later only fills in what's new; existing values are preserved.

## Responses

| HTTP | Body | Meaning |
|---|---|---|
| 200 | `{"status":"ok","session_id":"...","step_reached":N}` | Row upserted |
| 400 | `{"error":"invalid_session_id"}` | Session ID not a UUID |
| 400 | `{"error":"disallowed_form_name"}` | `form_name` not in allowlist |
| 400 | `{"error":"invalid_step_reached"}` | Step number out of range |
| 400 | `{"error":"body_not_object"}` | Malformed JSON |
| 429 | `{"error":"rate_limited"}` | Session crossed `MAX_UPSERTS_PER_SESSION` |
| 500 | `{"error":"internal","detail":"..."}` | DB write failed; row persisted to `leads.dead_letter` |

## Testing

### End-to-end via curl

```bash
SID=$(uuidgen | tr 'A-Z' 'a-z')

curl -X POST "https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-partial-capture" \
  -H "content-type: application/json" \
  -d "{
    \"session_id\": \"$SID\",
    \"form_name\": \"switchable-self-funded\",
    \"step_reached\": 1,
    \"answers\": {\"reason\": \"career-change\"},
    \"page_url\": \"https://switchable.org.uk/find-your-course/\",
    \"device_type\": \"desktop\"
  }"

# Expected: {"status":"ok","session_id":"...","step_reached":1}

# Progress to step 3, add more answers
curl -X POST "https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-partial-capture" \
  -H "content-type: application/json" \
  -d "{
    \"session_id\": \"$SID\",
    \"form_name\": \"switchable-self-funded\",
    \"step_reached\": 3,
    \"answers\": {\"interest\": \"it\", \"situation\": \"employed-ft\"}
  }"

# Verify via MCP:
#   SELECT session_id, step_reached, answers, upsert_count
#     FROM leads.partials WHERE session_id = '<SID>';
#   Expected: step_reached=3, answers = {reason, interest, situation}, upsert_count=2
```

### Rate limit

Send the same payload 51 times in a loop — the 51st should return 429.

### Dead letter

Break the DB (rotate the `functions_writer` password, don't update the function) and send a request. The request returns 500; a row lands in `leads.dead_letter` with `source='edge_function_partial_capture'`.

## Logs and monitoring

Supabase dashboard: **Edge Functions → netlify-partial-capture → Logs**. Sasha's Monday audit watches `leads.dead_letter` for `source='edge_function_partial_capture'`.

## Retention

Incomplete sessions (is_complete = false) older than 90 days are purged daily at 03:00 UTC by the `purge-stale-partials` pg_cron job set up in migration 0004. Complete partials are retained indefinitely (they join to `leads.submissions` which has its own lifecycle).

## Relationship to other functions

- **`netlify-lead-router`** — Updated in the same session. On a successful INSERT into `leads.submissions`, it also runs `UPDATE leads.partials SET is_complete = true WHERE session_id = $1`. That's how partials reconcile to conversions.
- **`netlify-forms-audit`** — Unchanged. It audits Netlify Form names vs `form-allowlist.json`. `netlify-partial-capture` is not a Netlify form so it's not in its scope.
