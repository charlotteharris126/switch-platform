# Secrets Rotation Tracker — Switchable Ltd Platform

**Purpose:** track every production secret's last-rotated date and next-due date so Sasha's Monday scan can flag anything >10 months old (per `platform/CLAUDE.md` governance scope and `.claude/rules/data-infrastructure.md` §5).

**Default rotation cadence:** annual, unless the secret is platform-managed (auto-injected) or documented otherwise below.

**Warning window:** 2 months before the rotation due date, Sasha surfaces it in the Monday weekly notes.

---

## Active secrets

| Secret | Where it lives | Scope / use | Last rotated | Next due | Notes |
|---|---|---|---|---|---|
| Supabase Postgres superuser password | LastPass: `Supabase — postgres superuser password` | Full DB access, breakglass + migrations | 2026-04-18 | 2027-04-18 | Rotate via Supabase dashboard → Database → Settings |
| Supabase publishable (anon) key | LastPass: `Supabase — publishable key` | Client-side, safe to expose with RLS | 2026-04-18 | Not routinely rotated | Rotated only on suspected leak |
| Supabase secret (service role) key | LastPass: `Supabase — secret key` | Server-side admin — never in iCloud, never in git | 2026-04-18 | 2027-04-18 | Rotate via Supabase dashboard → Settings → API |
| Supabase DB connection URI | LastPass: `Supabase — DB connection string` | Pooled Postgres (port 5432) for long-lived clients | 2026-04-18 | 2027-04-18 | Follows superuser password rotation |
| `readonly_analytics` password | LastPass: `Supabase — readonly_analytics password` | Postgres MCP for agents, Metabase | 2026-04-18 | 2027-04-18 | Rotate via `ALTER ROLE` in a migration |
| `functions_writer` password | LastPass: `Supabase — functions_writer password` | Edge Functions (`SET LOCAL ROLE` pattern) | 2026-04-18 | 2027-04-18 | Rotate via `ALTER ROLE` migration; also update Edge Function secrets that reference it (currently none — auto-injected `SUPABASE_DB_URL` is used) |
| `ads_ingest` password | LastPass: `Supabase — ads_ingest password` | Future Meta/Google/TikTok daily pulls | 2026-04-18 | 2027-04-18 | No active consumer yet |
| `NETLIFY_API_TOKEN` | Supabase Edge Functions → Manage secrets; master in Netlify → User settings → Applications → Personal access tokens | `netlify-forms-audit` + (future) webhook-state checks | 2026-04-18 | 2027-04-18 | Rotate in Netlify first, update Supabase secret second |
| `AUDIT_SHARED_SECRET` | **Supabase Vault** (`vault.secrets`, migration 0019). Read via `public.get_shared_secret('AUDIT_SHARED_SECRET')` from both pg_cron jobs and Edge Functions (`netlify-leads-reconcile`, `netlify-forms-audit`). | Shared secret for cron-triggered Edge Function auth | 2026-04-25 | 2027-04-25 | **Single source of truth: Vault.** Rotate via `SELECT vault.update_secret(id, new_value, 'AUDIT_SHARED_SECRET', ...);` — both cron and Edge Functions pick up the new value automatically on next call. No env to update, no cron command to edit. Migration 0019 closed the previous two-store drift class (Session 9 incident: env had a real value, cron command had literal `<REPLACE_WITH_AUDIT_SHARED_SECRET>` placeholder). |
| `BREVO_API_KEY` | Supabase Edge Functions → Manage secrets; master in Brevo → Settings → SMTP & API → API Keys (name: `switchleads-platform-v1`) | Transactional email sends (owner notification + provider notification + owner sheet-append fallback) | 2026-04-20 | **Due for rotation (plaintext in Session 3 transcript)** | Blast radius: email send only; no data read/write. Rotate by generating a new key in Brevo, replacing the Supabase secret, revoking the old key. |
| `BREVO_SENDER_EMAIL` | Supabase Edge Functions → Manage secrets | Verified From address for Brevo sends; currently `charlotte@switchleads.co.uk` | 2026-04-20 | Not routinely rotated | Update when the canonical sender address changes (e.g. swap to `notifications@switchleads.co.uk` once that mailbox is set up) |
| `SHEETS_APPEND_TOKEN` | Supabase Edge Functions → Manage secrets; duplicated inline in every deployed `platform/apps-scripts/provider-sheet-appender-v2.gs` (and EMS's v1 script) | Verifies `routing-confirm` POSTs to provider Apps Script webhooks | 2026-04-22 | 2027-04-22 | Rotated 2026-04-22 in lockstep across Supabase env + WYK v2 + EMS v1 scripts. Diagnosed via CLI digest comparison (`supabase secrets list`) after the Supabase dashboard hover UI was found to show stale values. Blast radius: sheet write only. New value hashes to SHA-256 `0d30cea30642a599b2958e4b9223381e72c24abc702f69a05ca5906546a83659` (fingerprint only, for future digest-match verification). |
| `ROUTING_CONFIRM_SHARED_SECRET` | Supabase Edge Functions → Manage secrets | HMAC signing key for owner confirm-link tokens; 14-day token TTL | 2026-04-20 | **Due for rotation (plaintext in Session 3 transcript, rotated once mid-session)** | Blast radius: allows minting fake confirm links that would trigger routing for existing leads. Rotation invalidates all outstanding email confirm links (worst case: Charlotte re-receives the next lead's notification). Low volume at pilot scale — re-signing isn't disruptive. |

---

## Platform-managed (not user-rotated)

| Secret | Notes |
|---|---|
| `SUPABASE_DB_URL` (auto-injected env var in Edge Functions) | Supabase rotates this automatically when the superuser password is rotated. No direct action needed. |

---

## Non-secret reference values

Tracked here for completeness — not rotated, but fail-over relevant if they change.

| Value | Where it lives | Purpose |
|---|---|---|
| `NETLIFY_SITE_ID` | Supabase Edge Functions secret + Netlify site config | Identifies the switchable.org.uk site in Netlify API calls. Not a secret, but a hardcoded ID with failure mode if wrong. |
| Supabase project URL (`https://igvlngouxcirqhlsrhga.supabase.co`) | `.env` files, Edge Function code, Netlify webhook target | Endpoint for all function invocations |

---

## Rotation workflow

1. Generate or request the new secret
2. Update the downstream consumer FIRST (Edge Function secret, LastPass entry, .env file on each device) — dual-write if the consumer requires both old and new temporarily
3. Cut over (revoke old secret at the source)
4. Update this file: new `Last rotated` date, new `Next due` date
5. Log in `platform/docs/changelog.md` under a `Secret rotation` entry
6. For scoped Postgres role passwords: rotation happens via `ALTER ROLE ... WITH PASSWORD` in a migration file (never via the Supabase UI) — see `.claude/rules/data-infrastructure.md` §2

---

## Sasha's Monday check

Each Monday, Sasha reads this file and cross-checks `Next due` against today's date:
- Any row with `Next due` in the past → flag as OVERDUE
- Any row with `Next due` ≤ 60 days out → flag as approaching
- Write flags into `platform/weekly-notes.md`

Sasha does not rotate secrets — that is owner-only.

---

## Change log for the tracker itself

| Date | Change |
|---|---|
| 2026-04-19 | Initial file, seeded with all known secrets as of Session 2.5. `AUDIT_SHARED_SECRET` rotated same session. |
| 2026-04-20 | Added `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `SHEETS_APPEND_TOKEN`, `ROUTING_CONFIRM_SHARED_SECRET` for Session 3 owner-confirm routing flow. All four are flagged for rotation next platform session due to plaintext exposure in the Session 3 transcript. |
| 2026-04-22 | Rotated `SHEETS_APPEND_TOKEN` during Session 5.1 incident response. Lockstep change across Supabase env + WYK v2 + EMS v1 scripts. Diagnosed underlying env-vs-script mismatch via CLI digest comparison after the dashboard hover tooltip was found to be unreliable. New rotation due 2027-04-22. `BREVO_API_KEY` and `ROUTING_CONFIRM_SHARED_SECRET` still flagged as overdue from 2026-04-20. |
| 2026-04-25 | **Migration 0019: AUDIT_SHARED_SECRET moved to Supabase Vault as single source of truth.** Triggered by Session 9 incident — cron command had literal `<REPLACE_WITH_AUDIT_SHARED_SECRET>` placeholder string, hourly auto-reconcile had been silently 401'ing for some time, only surfaced when the live webhook also broke. Vault adoption closes the two-store drift class for this secret. `public.get_shared_secret(name)` SECURITY DEFINER helper (allowlist-restricted) provides the read path for both cron jobs and Edge Functions (`netlify-leads-reconcile`, `netlify-forms-audit`). Env entry removed via `supabase secrets unset`. ROUTING_CONFIRM and SHEETS_APPEND_TOKEN deliberately not migrated to Vault (former is single-component so no drift risk; latter retires with Phase 4 Sheets retirement). |
