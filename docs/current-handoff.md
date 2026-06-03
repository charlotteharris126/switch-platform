# Platform Handoff, Session 63, 2026-06-02

## Current state
Chaser operational emergency closed. The duplicate chaser-email bug (6 learners got 2-4 identical emails within seconds over 14 days, 1 spam complaint) is fixed and verified live on both channels, and the `chaser_self` silent gap is fixed and armed. Codex reviewed the work and signed it off. The Codex security backlog (provider login binding, ingestion auth, etc.) is untouched this session and remains the main outstanding work.

## What was done this session
- **Audited email/SMS chasers** against production (read-only Postgres MCP). Found two live defects: duplicate chaser emails (race) and `chaser_self` never firing. SMS confirmed clean (0 rapid duplicates in 30 days; closest two texts to one person 4d 10h apart).
- **Fixed the duplicate-email race.** `_shared/brevo.ts` `sendTransactional`: dedup check + queued-row insert now run in one transaction under `pg_advisory_xact_lock(submission_id, email_type)`; added `resendWindowMinutes` windowed dedup. `admin-brevo-chase` + `admin-brevo-chase-employer` pass a 24h window (`CHASER_RESEND_WINDOW_MINUTES`, env-tunable). Deployed both; verified a real funded chase (sub 535) landed as exactly one clean `sent` row.
- **Hardened `sendSms` identically** (defensive parity). Redeployed `sms-chaser-attempt-1`, `sms-fastrack-prompt-cron`, `fastrack-receive`, `admin-test-sms`.
- **Fixed `chaser_self`.** Missing chaser template now fails loudly to `dead_letter` instead of silent skip. Set `BREVO_TEMPLATE_CHASER_SELF=12`, redeployed `admin-brevo-chase`. Live test parked (no self campaigns running).
- **Built `brevo-sms-event-webhook`** (SMS delivery tracking, push). Corrected to Brevo's real SMS payload schema (`msg_status`, integer `messageId`). Hit a wall: this Brevo account has no SMS-webhook config in the dashboard, so activation must be a pull instead (see Next steps). Function left dormant.
- **Investigated owner's "are we sending SMS multiple times?" fear.** Confirmed NO: the 3 Brevo log lines (Accepted/Sent/Delivered) for one number are one message's lifecycle, not 3 sends. `sms_log` shows exactly one row (id 159, sub 538) for it.
- Logged everything in `docs/changelog.md` (two entries). Ticket 869dhrzz1.

## Next steps
1. **Security backlog (main work, Codex order):** provider login OTP binding (#1) → Netlify ingestion auth (#5) → lock down `editorial.fire_netlify_blog_build` (#6, migration) → 5 missing `verify_jwt=false` config blocks (#8) → app-code batch in one branch/deploy (#3 redirect sanitize, #7/#11 getUser helper, #9 Vault secret, #10 bulk-audit RETURNING, #13 drop SVG upload type). Accepted-noise notes only: #2 admin allowlist dual source, #12 public analytics endpoints.
2. **SMS delivery tracking via pull (low priority, unrelated to duplicates):** build a cron EF that calls `GET /v3/transactionalSMS/statistics/events` and updates `crm.sms_log.status` by `messageId`. Redeploy the corrected `brevo-sms-event-webhook` (first deploy was the pre-correction cut) to keep it as a dormant push-fallback. No migration (`sms_log_status_check` already allows delivered/undelivered).
3. **Carries from S62 (untouched this session):** `crm.billing_events` empty despite confirmed pulls (Nell/Mira shared item); auto-flip cron + day-12 warning (migration 0097 unapplied, EMS 50+ leads past SLA); CMS Phase 2 build-script flip; demand-aggregation view (Mira PUSH); Provider OS V1 scoping (Mira PUSH); Wren broadcast-gating PUSH; reconcile panel-apply proper fix.
4. **Low: cleanup** the shared `sql.json` type-check error (`route-lead.ts:1782`, `brevo-event-webhook`, `brevo-sms-event-webhook`); lint (56 problems); README Next version mismatch.
5. **PUSH from Labs (2026-06-02): move Switchable Labs conversion tracking into Supabase.** The two Labs tools (`/amistuck`, `/gaply`) currently post partial (`*-unlock-intent`, fires on the £17 click) + complete (`*-signup`, email) events to **Netlify Forms**, free tier ~100 submissions/month → silently drops data once exceeded, which an ad test will blow past, losing the conversion data the smoke test exists to measure. Route these events into the data layer instead (durable, no cap, joins ad-spend → run → conversion). **Go-live gate before any Labs ad spend.** Context: `labs/docs/current-handoff.md`; metrics in `strategy/docs/switchable-labs-success-model.md`.

## Decisions and open questions
**Decisions:**
- Race fixed with a per-(submission, type) advisory lock + windowed dedup, not a unique index (a partial unique index can't express a time window). Mirrors the SMS sibling's cooldown model.
- 24h resend window chosen to match SMS and because of the spam complaint. Env-tunable, no code change to adjust.
- SMS delivery tracking pivots from push (webhook) to pull (statistics API) because the Brevo account exposes no SMS-webhook config.

**Open questions:**
- **Owner decides: does Charlotte ever need a same-day repeat chase to the same lead?** The 24h window now blocks it (logged as skipped_duplicate). Data says her cadence is days apart, so 24h is fine. If yes, lower `CHASER_RESEND_WINDOW_MINUTES` (e.g. 60). Bring decision next session; no work needed if keeping 24h.
- `crm.billing_events`: what writes to it and why nothing has (carry, owner/Mira/Nell).

## Watch items
- **Brevo sender reputation** over the next ~week, after the 1 spam complaint + historical duplicate spray. Fix stops new duplicates; reputation recovers slowly. Watch for any new `complained` rows.
- **`chaser_self` armed but never run live** (no self campaigns). First self chase should be verified to confirm a clean `chaser_self` row lands and no dead-letter.
- **`brevo-sms-event-webhook` is the pre-correction version on the server** and is dormant; do not rely on it until redeployed and a pull/push route is actually wired.
- Carries: `crm.billing_events` still empty; drift digest ~87; `edge_function_partial_capture` connection-pool errors (free-tier ceiling watch).

## Next session
- **Folder:** platform
- **First task:** Start the security backlog at provider login OTP binding (#1), or the DB-side quick wins (#6 migration + #8 config blocks) if a shorter session. Both push cleanly via `supabase db push`.
- **Cross-project:** None new. `crm.billing_events` gap remains a shared Nell/Mira ↔ platform item; generated no new push this session.
