# `netlify-forms-audit` — Edge Function

Second platform Edge Function. Verifies the Netlify-side form configuration matches the allowlist at `https://switchable.org.uk/data/form-allowlist.json`. Any drift (form missing a webhook, webhook URL wrong, unexpected form name not in the allowlist) is written into `leads.dead_letter` with `source = 'netlify_audit'` so Mira's Monday review surfaces it.

This is defence-in-depth against silent lead loss. It complements the build-time allowlist check in `switchable/site/deploy/scripts/audit-site.js` — the build check prevents drift at creation, the audit function catches anything that drifts after deploy (e.g., a webhook accidentally deleted in the Netlify UI).

---

## Setup (one-time)

### 1. Generate a Netlify Personal Access Token

In Netlify: User settings → Applications → Personal access tokens → **New access token**.
- Description: `platform netlify-forms-audit`
- Scope: default is fine (read access to sites and forms)
- Expires: ideally never, or long-lived
- Copy the token immediately — Netlify shows it only once.

### 2. Find the Netlify site ID for switchable.org.uk

In Netlify, open the switchable.org.uk site. **Site configuration → General → Site details**. Copy the **Site ID** (a UUID-like string).

### 3. Generate a shared secret for the x-audit-key header

Any long random string. One option:
```bash
openssl rand -base64 32
```
Copy the output.

### 4. Set function secrets in Supabase

Supabase dashboard → **Edge Functions → Manage secrets → Add**:

| Key | Value |
|---|---|
| `NETLIFY_API_TOKEN` | the token from step 1 |
| `NETLIFY_SITE_ID` | the site ID from step 2 |
| `AUDIT_SHARED_SECRET` | the random string from step 3 |

(`SUPABASE_DB_URL` is auto-injected — no action.)

### 5. Deploy the function

```bash
cd platform
supabase functions deploy netlify-forms-audit --no-verify-jwt
```

`--no-verify-jwt` because we don't want to require a Supabase JWT for cron-triggered calls; the shared-secret header is the auth instead.

### 6. Schedule daily runs

In Supabase dashboard: **Database → Cron Jobs → New cron job**.

- Name: `netlify-forms-audit-daily`
- Schedule: `0 7 * * *` (07:00 UTC every day, just before Charlotte's typical day starts)
- Type: **HTTP Request**
- Method: POST
- URL: `https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-forms-audit`
- HTTP Headers:
  - `x-audit-key`: (the same shared secret from step 3)
  - `Content-Type`: `application/json`
- Body: `{}`

Save. First run fires on the next 07:00 UTC.

---

## Triggering manually

Ad-hoc run (paste the same shared secret as `AUDIT_SHARED_SECRET`):

```bash
curl -sS -X POST "https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-forms-audit" \
  -H "x-audit-key: <YOUR_SHARED_SECRET>" \
  -H "content-type: application/json" \
  -d '{}' | jq
```

Expected response when everything is healthy:
```json
{
  "status": "clean",
  "count": 0,
  "discrepancies": [],
  "ran_at": "2026-04-19T..."
}
```

Expected response when something's drifted (example):
```json
{
  "status": "discrepancies_found",
  "count": 1,
  "discrepancies": [
    {
      "kind": "missing_webhook",
      "form_name": "switchable-funded",
      "details": "Form \"switchable-funded\" on Netlify should have an outgoing webhook to https://.../netlify-lead-router. Actual webhook URLs found: none."
    }
  ],
  "ran_at": "..."
}
```

Each discrepancy also becomes a row in `leads.dead_letter` with `source = 'netlify_audit'` — that's the channel Mira's Monday audit reads.

---

## How to test it detects real drift

Once everything's wired:
1. Manually delete one of the outgoing webhooks in Netlify (e.g., the one for `switchable-funded`)
2. Trigger the audit manually via the curl above
3. Expect `missing_webhook` discrepancy for `switchable-funded` + a new row in `leads.dead_letter`
4. Re-add the webhook in Netlify
5. Re-trigger — expect `"status":"clean"`

---

## Discrepancy types

| `kind` | Meaning |
|---|---|
| `allowlist_fetch_failed` | Couldn't fetch `form-allowlist.json` from switchable.org.uk — probably a site deploy issue, not a Netlify Forms issue |
| `netlify_forms_fetch_failed` | Couldn't query Netlify API — check `NETLIFY_API_TOKEN` and `NETLIFY_SITE_ID` |
| `netlify_notifications_fetch_failed` | Form exists but couldn't fetch its notifications — transient API issue or permissions |
| `missing_netlify_form` | Allowlist names a form that Netlify doesn't know about. Either the form hasn't been submitted yet (Netlify creates form records on first submission), or the HTML form name doesn't match the allowlist |
| `missing_webhook` | Form exists on Netlify but has no outgoing webhook at all |
| `wrong_webhook_url` | Form has outgoing webhooks, but none match the allowlist's expected URL |
| `unexpected_netlify_form` | Netlify has a form that isn't in the allowlist. Either add it to the allowlist or remove from the site HTML |

---

## Permissions

Uses the `functions_writer` Postgres role (same pattern as `netlify-lead-router`): connects via `SUPABASE_DB_URL`, then `SET LOCAL ROLE functions_writer` inside every transaction. Only INSERT permission on `leads.dead_letter` is needed.

---

## Changelog

- 2026-04-19: Function written and deployed as part of platform Session 2 close. Initial scope covers 4 form names from `form-allowlist.json` v1.0.
