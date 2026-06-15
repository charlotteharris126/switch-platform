# Server-side Meta CAPI — scoping + impact assessment, 2026-06-15

Owner sign-off required before build (infrastructure + data-layer change per `.claude/rules/data-infrastructure.md` and the CLAUDE.md infrastructure-change rule).

## Plain-English summary

Today the Meta "Lead" conversion only reaches Meta through a four-hop browser chain (browser pixel → web GTM → Stape server container → Meta). Nobody monitors that chain, it runs on a free Stape tier that auto-disables on low traffic, and when any hop fails we hear nothing. That is why B2B server events silently stopped and we found out by accident.

This plan adds a second, owned path for the Lead event that fires from our own code on every single lead, logs Meta's reply, and emails us the next morning if the counts don't reconcile. The browser pixel + Stape stay exactly as they are (good for match quality); the server send is the guarantee. This is Meta's own recommended "redundant pixel + CAPI, deduplicated by `event_id`" setup.

**Covers both brands: B2C (Switchable, `netlify-lead-router`) and B2B (Switchable for Business, `netlify-employer-lead-router`).**

## Definition of done

1. Every lead that lands in `leads.submissions`, B2C and B2B, triggers a server-side CAPI `Lead` event to the correct pixel.
2. Each send is deduplicated against the browser pixel via the shared `event_id` already generated on the page.
3. Meta's response (`events_received` or error) is logged against the lead.
4. A daily reconciliation job compares leads received vs leads Meta confirmed, per brand, and emails the owner on any gap.
5. Verified live in Events Manager Test Events (deduped Browser+Server) for both brands.

## Why this is the right solution (confirmed)

- Meta documents the redundant browser+server setup deduplicated by `event_id` as best practice, precisely for resilience when one path fails.
- The hard part (a shared `event_id` across browser and server) is already built: `switchable/site/deploy/deploy/js/meta-dedup.js` generates one `event_id` per form load, stores it in `sessionStorage`, writes it to the browser pixel's `{eventID}`, and injects it (plus `fbp`, `fbc`) as hidden form inputs (`meta-dedup.js:107-110`). Both routers already receive these fields in the POST body. They simply don't read them.

## Current state (verified in code)

- **Browser side, ready.** Both thank-you pages fire `fbq('track','Lead', {...}, {eventID})`. The funded page and the business page both use the shared `event_id`.
- **Routers, the gap.** `netlify-lead-router` (B2C) and `netlify-employer-lead-router` (B2B) read `fbclid` but NOT `event_id`, `fbp`, or `fbc` (employer router field map ends at `fbclid`/`gclid`/`referrer`; `event_id`/`fbp`/`fbc` are dropped).
- **DB.** `leads.submissions` stores `email`, `first_name`, `last_name`, `phone`, `postcode`, `fbclid` but has no `event_id`, `fbp`, `fbc` columns. No table logs outbound CAPI sends.
- **Secrets.** No Meta CAPI token or pixel IDs wired server-side today.
- **IP / user agent.** Netlify's form webhook does not pass client IP or user agent. Not a blocker: Meta does not require them, and match quality is strong on hashed email + name + phone + the rebuilt click id (`fbc`).
- **Reconciliation pattern already exists.** `netlify-leads-reconcile` (hourly, alerts owner on drift, `dead_letter` audit rows, `AUDIT_SHARED_SECRET` auth, cron-driven) is the exact model to mirror for the daily CAPI reconciliation.

## Architecture

Keep browser pixel + Stape sGTM unchanged. Add server-side CAPI as a redundant path:

```
Lead form POST ─► router (B2C or B2B) ─► INSERT leads.submissions
                                       └─► callCapiLead()  ─► graph.facebook.com /events
                                                           └─► log response to leads.capi_log
Browser pixel ─► (same event_id) ─► Meta ──┐
Server CAPI   ─► (same event_id) ─► Meta ──┴─► Meta deduplicates by event_id + event_name
Daily cron ─► capi-reconcile-daily ─► compare submissions vs capi_log ─► Brevo alert on gap
```

## Work breakdown

1. **Migration** (`platform/supabase/migrations/`):
   - Add nullable columns to `leads.submissions`: `event_id text`, `fbp text`, `fbc text`. Additive only, no `schema_version` bump required (additive change, per schema-versioning rule).
   - New table `leads.capi_log`: `id`, `submission_id` FK, `brand` (`b2c`/`b2b`), `pixel_id`, `event_name`, `event_id`, `sent_at`, `http_status`, `events_received int`, `fbtrace_id text`, `error_body text`, `raw_response jsonb`. Grant `functions_writer` insert.
2. **Read the fields** in both routers' normalisation: pull `event_id`, `fbp`, `fbc` from the POST body and persist on the insert. (Two small edits, mirrors the existing `fbclid` handling.)
3. **Shared helper** `platform/supabase/functions/_shared/meta-capi.ts`:
   - SHA-256 hash of `em`, `ph`, `fn`, `ln`, `zp`, `country` (normalised, lower-cased, trimmed) per Meta's spec.
   - Rebuild `fbc` from `fbclid` when the cookie value is absent (`fb.1.<event_time_ms>.<fbclid>`), the same logic the Stape tag uses.
   - POST to `https://graph.facebook.com/v<latest>/<pixel_id>/events` with `event_name: 'Lead'`, `event_time`, `event_id`, `action_source: 'website'`, `event_source_url`, hashed `user_data`, and `custom_data` (`value`, `currency`, plus brand-specific params below).
   - Return the parsed response for logging. Fire-and-log via `waitUntil` so a CAPI hiccup never blocks or fails the lead insert.
4. **Wire the helper** into both routers post-INSERT, passing the brand, pixel id, and value mapping.
5. **Reconciliation EF** `capi-reconcile-daily` mirroring `netlify-leads-reconcile`: counts yesterday's `leads.submissions` vs successful `leads.capi_log` rows per brand; on any gap (or any non-2xx sends), email the owner via Brevo. Cron entry + `public.vw_cron_jobs`.
6. **Secrets** (Supabase): `META_CAPI_ACCESS_TOKEN` (must be a non-expiring **System User** token, see open questions), `META_PIXEL_ID_B2C`, `META_PIXEL_ID_B2B` (`1386293849929367`).
7. **Changelog** entry in `platform/docs/changelog.md` per data-infrastructure rule.

## Per-brand field mapping

| Field | B2C (`netlify-lead-router`) | B2B (`netlify-employer-lead-router`) |
|---|---|---|
| Pixel | `META_PIXEL_ID_B2C` (confirm id) | `1386293849929367` |
| `event_name` | `Lead` | `Lead` |
| `event_id` | shared from `meta-dedup.js` | shared from `meta-dedup.js` |
| `value` / `currency` | by route: funded 150 / self 100 (confirm) GBP | 400 GBP (matches existing Stape tag) |
| `content_category` | funding segment | `lead_route` (`employer_lead`) |
| user_data | em, ph, fn, ln, zp, country (hashed) + fbc/fbp | em, ph, fn, ln (hashed) + fbc/fbp |

Browser and server use the **same** `event_name` (`Lead`) and `event_id`, the two conditions Meta requires for deduplication.

## Impact assessment (CLAUDE.md infrastructure rule)

1. **Both devices?** No device-specific action. Code + migration deploy via existing routes.
2. **iCloud sync?** Repo files sync normally. No per-device step.
3. **Other projects/agents?** Touches Iris (B2C ads) and Solis (B2B ads) reporting quality, both benefit. No agent config change. `switchable/site/docs/tracking-emq-capi.md` gains a note that CAPI now also fires server-side from the routers.
4. **Breaks existing refs/permissions/paths?** No. Pixel + Stape path untouched. New columns are additive and nullable. New EF + table only.
5. **Notion ownership?** Tech Stack page: note server-side CAPI now runs from Supabase EFs (in addition to Stape). Minor.
6. **New-business template?** No change needed; this is Switchable-specific plumbing.
7. **Database (data-infrastructure rule):**
   - Consumers affected: none read these columns today; additive only. n8n / admin / agents unaffected.
   - `schema_version`: no bump (additive).
   - Migration file: yes, one new migration (columns + `capi_log` table + grants).
   - Sign-off: owner (this doc).
   - Logged in `platform/docs/changelog.md` on completion.

## Verification (standing, not one-off)

- **Test Events** (Events Manager, each pixel): submit one lead per brand, confirm a single deduped Lead showing both Browser and Server.
- **Diagnostics tab**: confirm no "server events not received" / token / dedup flags after 24-48h.
- **Overview Browser vs Server split**: both should show server events flowing.
- **Reconciliation dry-run**: run `capi-reconcile-daily` in dry mode, confirm zero drift.
- Ongoing: the daily email is the permanent monitor.

## Open questions (need answers before/at build)

1. **B2C pixel ID** — confirm the numeric id (from Events Manager or `tracking-emq-capi.md`); not hard-coded anywhere I can read.
2. **Access token type** — the token must be a **System User token set to never expire**. If the current Stape token is a normal user token (~60-day expiry), that is likely today's B2B break and we should generate a system-user token now and use it for both Stape and the EF.
3. **B2C Lead value** — confirm `value` per funding route (funded 150 / self 100?) so B2C ROAS computes, or send no value if you'd rather not.
4. **Today's B2B break** — independent of this build: Events Manager → B2B pixel → Diagnostics will name the current cause (likely the token). Worth doing now; the server-side path will make it moot going forward.

## Effort

A focused build of roughly one to two sessions: migration + two small router edits + one shared helper + one reconciliation EF (mirroring an existing one) + secrets + live test. Not weeks. No change to the existing pixel/Stape setup, so no regression risk to current tracking.

## Rollout order

1. Confirm open questions 1-3, generate system-user token (Q2).
2. Migration (columns + `capi_log`).
3. Router edits to persist `event_id`/`fbp`/`fbc`.
4. `_shared/meta-capi.ts` + wire into B2B router first (the brand that's broken), live Test Events check.
5. Wire into B2C router, live Test Events check.
6. `capi-reconcile-daily` EF + cron + Brevo alert.
7. Update `tracking-emq-capi.md` + Notion Tech Stack + `changelog.md`.
