# Platform Handoff, Session 80, 2026-06-25

## Current state
Sheet teardown is overdue (was due 25 Jun). Gaply CAPI match quality fix shipped this session -- `_shared/meta-capi.ts` now sends IP, user agent, and fbp for all three EFs that use it. All three redeployed.

## What was done this session
- **`_shared/meta-capi.ts`:** added `ip` and `userAgent` to `CapiLeadInput` interface; both included in CAPI `user_data` as `client_ip_address` and `client_user_agent`. Fixes Meta's "improve match quality" diagnostic on the Gaply B2B pixel.
- **`labs-event/index.ts`:** extracts client IP from `x-forwarded-for` / `cf-connecting-ip` headers; passes `ip`, `userAgent`, `fbp` (from attribution), and `fbc` (from attribution) to `sendCapiLead`.
- **Redeployed:** `labs-event`, `netlify-lead-router`, `netlify-employer-lead-router` (all import the shared module, all must redeploy on shared change).

## Next steps
1. **Sheet teardown (overdue):** permanently `cron.unschedule('sheet-drift-reconcile-daily')` (jobid 20), strip sheet-append side effect from `fastrack-receive`, retire sheet reconcile panel in `/admin/errors`.
2. **Verify B2C CAPI fix** on next organic DQ lead: `is_dq=true` row in `leads.submissions` with NO new Lead row in `leads.capi_log`.
3. **Check lead #601:** enrolled (EMS-set 19 Jun) but `billed_amount` is null. Charlotte emailing EMS.
4. **Revoke leaked GitHub PAT** (flagged by Sasha, still not actioned).

## Decisions and open questions
- `ip` and `userAgent` are sent raw (never hashed) per Meta CAPI spec -- same as `fbp`/`fbc`. This is correct.
- Fix also benefits B2C and S4B EFs at no extra cost since they share the module.
- Open: does the funded adset need a learning-phase reset after ~10 false conversions? (Carried from S79, Iris question.)

## Watch items
- Sheet teardown is overdue -- do it first next platform session
- Monitor `leads.capi_log` for Gaply Purchase rows post-fix: expect `client_ip_address` + `client_user_agent` in `raw_response`
- Lead #601 billed_amount null -- possible un-billed enrolment

## Next session
- **Folder:** `platform/`
- **First task:** Sheet teardown -- unschedule cron job 20, strip fastrack sheet-append, retire reconcile panel. Overdue.
- **Cross-project:** Labs handoff (S7) updated this session with the CAPI match quality fix details.
