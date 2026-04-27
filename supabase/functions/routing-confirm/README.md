# routing-confirm

One-click handler for the confirm links embedded in the owner notification email.

## Flow

1. Owner clicks `https://<project>.functions.supabase.co/routing-confirm?t=<signed-token>`
2. Function verifies the HMAC-signed token (`ROUTING_CONFIRM_SHARED_SECRET`, 14-day expiry)
3. Reads the submission and provider from the DB
4. Idempotency: if `leads.submissions.primary_routed_to` is already set, shows a friendly "already confirmed" page and returns (no writes, no emails)
5. If the lead is `is_dq=true`, refuses to route (safety net — DQ leads shouldn't have confirm links in the first place)
6. Otherwise, in one transaction under `functions_writer` role:
   - Inserts `leads.routing_log` row (`route_reason='primary'`, `delivery_method='sheet_webhook'`, `delivery_status='sent'`)
   - Updates `leads.submissions.primary_routed_to` + `routed_at`
7. POSTs the lead row to the provider's Apps Script webhook (`crm.providers.sheet_webhook_url`) with `SHEETS_APPEND_TOKEN` in the body
8. On sheet-append success: sends a PII-free provider notification email via Brevo
9. On sheet-append failure: writes `leads.dead_letter` row, emails the owner with the raw row to paste manually
10. Returns a branded HTML confirmation page

## Secrets expected

- `SUPABASE_DB_URL` — auto-injected
- `ROUTING_CONFIRM_SHARED_SECRET` — HMAC signing key, set via `openssl rand -hex 32`
- `SHEETS_APPEND_TOKEN` — shared with each provider's deployed Apps Script
- `BREVO_API_KEY` — Brevo transactional API key
- `BREVO_SENDER_EMAIL` — verified sender address
- `OWNER_NOTIFICATION_EMAIL` — optional; falls back to `BREVO_SENDER_EMAIL` if unset

## Shared code

- `_shared/routing-token.ts` — HMAC sign/verify for confirm-link tokens
- `_shared/brevo.ts` — Brevo transactional send helper

## Failure modes

| Failure | Response | Side effect |
|---|---|---|
| Missing / invalid / expired token | HTML error page (400) | None |
| Provider not found / inactive | HTML error page (404) | None |
| Submission not found | HTML error page (404) | None |
| Lead is DQ | HTML error page (400) | None; this is a bug signal |
| Already routed to same provider | Friendly "already confirmed" page (200) | None |
| Already routed to different provider | Error page with manual-fix instruction (409) | None |
| DB write fails | HTML error page (500) | None (transaction rolled back) |
| Sheet webhook fails | Confirmation page with "paste manually" copy | routing_log + submissions written; dead_letter logged; owner email sent |
| Provider notification email fails | Confirmation page noting the email failure | routing_log + submissions + sheet all good |

## Deploying

```
supabase functions deploy routing-confirm --no-verify-jwt
```

`--no-verify-jwt` because this function is reached by the owner clicking a link in an email; there is no Supabase JWT. Authentication is the signed token in the query string.

## Verifying after deploy

1. Check the function is listed: `supabase functions list`
2. Owner clicks a confirm link from a test-lead notification email (Block 6)
3. Confirmation page renders, row appears in the EMS sheet, provider notification arrives

## Related

- `platform/docs/session-3-scope.md` — full scope
- `platform/docs/data-architecture.md` — `crm.providers` (sheet_id, sheet_webhook_url), `leads.routing_log`, `leads.dead_letter`
- `platform/apps-scripts/provider-sheet-appender.gs` — counterpart script running on each provider sheet
- `platform/supabase/functions/netlify-lead-router/` — composes the owner notification email with the confirm links this function consumes
