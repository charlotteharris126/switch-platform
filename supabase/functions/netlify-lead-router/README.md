# `netlify-lead-router` — Edge Function

First Supabase Edge Function in the platform. Receives Netlify Forms outgoing webhooks, normalises the payload, and inserts the row into `leads.submissions`. Failed submissions land in `leads.dead_letter` so nothing is ever lost at the capture boundary.

**Scope today:** persistence only. The function does NOT contact the provider (owner-gated routing rule — every lead passes through Charlotte first during pilot). Charlotte's existing Netlify email notification continues to alert her of every submission; the function runs alongside it, adding database persistence.

**Scope next:** a follow-up iteration adds a "rich" owner-notification email (with the suggested provider and a pre-drafted forward body) and a separate `routing-confirm` Edge Function that Charlotte hits to log the forward into `leads.routing_log`. Not this session.

---

## Deployment (one-time setup)

### 1. Set the function secret in Supabase

In the Supabase dashboard: **Edge Functions → Manage secrets**. Add a single secret:

| Key | Value |
|---|---|
| `DATABASE_URL` | `postgresql://functions_writer.igvlngouxcirqhlsrhga:<PASSWORD>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres` |

Where `<PASSWORD>` is URL-encoded from the LastPass entry `Supabase — functions_writer password`.

**Notes:**
- Port **6543** = transaction pooler (short-lived connections, right for Edge Functions).
- Role `functions_writer` (not service_role), per `.claude/rules/data-infrastructure.md` §5 and §6. Permissions: INSERT on `leads.*`, UPDATE on `crm.enrolments` status transitions. Write-only to the workflow's data, no read access to unrelated schemas.
- Role was renamed from `n8n_writer` in migration 0002 on 2026-04-18 (see `platform/docs/changelog.md` Architectural reversal entry).

### 2. Deploy the function

From the workspace root with the Supabase CLI already logged in and linked (Session 1 + 2 kickoff):

```bash
cd platform
supabase functions deploy netlify-lead-router --no-verify-jwt
```

The `--no-verify-jwt` flag is essential: Netlify does not send JWTs, and this function is public-by-design (validated by the `form_name` check and dead-letter fallback).

After deploy, the function lives at:
```
https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-lead-router
```

### 3. Wire Netlify webhooks

In the Netlify dashboard for switchable.org.uk: **Site settings → Forms → Form notifications → Add notification → Outgoing webhook**.

Add one notification **per form name** that needs routing. Current live forms (as of 2026-04-18):

| Form name | Webhook URL |
|---|---|
| `switchable-funded-smm-for-ecommerce-tees-valley` | `https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-lead-router` |
| `switchable-funded-counselling-skills-tees-valley` | same |
| `switchable-self-funded` | same |
| `switchable-waitlist` | same |

Leave Charlotte's existing email notifications in place — they're the owner-notification channel for now.

Future funded course pages follow the `switchable-funded-<course-slug>` pattern; the function auto-handles them (unknown slugs insert as normal, provider defaults to `enterprise-made-simple`). Each new form still needs its notification wired up in Netlify's UI until a Netlify API automation is added.

---

## Testing

### Dummy lead via curl

```bash
curl -X POST "https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-lead-router" \
  -H "content-type: application/json" \
  -d '{
    "form_name": "switchable-funded-smm-for-ecommerce-tees-valley",
    "first_name": "Test",
    "last_name": "Lead",
    "email": "testlead@example.com",
    "phone": "07123 456789",
    "la": "middlesbrough",
    "age_band": "24_plus",
    "employment_status": "unemployed",
    "prior_level_3_or_higher": "no",
    "can_start_on_intake_date": "yes",
    "outcome_interest": "job",
    "why_this_course": "dummy test lead",
    "terms_accepted": "true",
    "marketing_opt_in": "false",
    "page_url": "https://switchable.org.uk/funded/smm-for-ecommerce-tees-valley/",
    "utm_source": "test",
    "utm_medium": "test",
    "utm_campaign": "test"
  }'
```

Expected: `{"status":"ok","submission_id":<N>,"form_name":"switchable-funded-..."}` with HTTP 200.

Verify via the Postgres MCP:
```sql
SELECT id, form_name_derived := split_part(raw_payload->>'form_name', '-', 1),
       first_name, email, course_id, provider_ids, is_dq, submitted_at
FROM leads.submissions
ORDER BY id DESC
LIMIT 5;
```

### Dummy lead via the actual funded page

Open [/funded/smm-for-ecommerce-tees-valley/](https://switchable.org.uk/funded/smm-for-ecommerce-tees-valley/), fill the form with "Test Lead" / `testlead+funded@example.com`, submit. Check:
1. Netlify Forms inbox shows the submission.
2. `leads.submissions` has a new row.
3. Charlotte's email notification arrived (existing Netlify behaviour).

### Dead-letter test

Post malformed JSON or missing `form_name`:
```bash
curl -X POST "https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/netlify-lead-router" \
  -H "content-type: application/json" \
  -d '{"form_name": null, "email": "broken@example.com"}'
```

Expected: `{"status":"dead_letter","error":"..."}` with HTTP 200 (so Netlify doesn't retry forever). Row lands in `leads.dead_letter` for replay.

---

## Logs and monitoring

Supabase dashboard: **Edge Functions → netlify-lead-router → Logs**. Structured logs include request ID, duration, and any `console.error` output from the function.

Dead-letter growth is monitored by Mira's Monday audit (`.claude/rules/data-infrastructure.md` §10). Any row older than 14 days must be replayed or written off.

---

## Changing the provider mapping

Currently hardcoded in `index.ts`:
- `switchable-funded-*` → `enterprise-made-simple`
- `switchable-self-funded` → `courses-direct`
- `switchable-waitlist` → no provider

If a new provider signs and owns new courses, the mapping lives at `normalise()` in `index.ts`. Update the function, redeploy. This is interim — a proper version reads `crm.provider_courses` at request time to decide routing based on `course_id`. That version ships when the Provider Sheet → `crm.providers` cutover is complete (platform Session 5).

Do not use the interim mapping as an argument against a proper routing table — that's the proper long-term fix. The hardcode is acceptable today because there are exactly two providers and the mapping is static.
