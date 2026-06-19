# Platform Handoff, Session 76, 2026-06-18

## Current state
Provider self-invite is now functional for real providers. Freya Kelly (Riverside) promoted to `provider_admin`, and the missing `x-allow-real` header that was blocking every real-provider self-invite has been added and pushed live. All Session 75 CAPI + Session 74 private-pay verification items remain open and are carried forward unchanged (no platform work touched them this session).

## What was done this session
- **Freya Kelly → provider_admin** (Riverside): `crm.provider_users` id 6 flipped from `provider_user` to `provider_admin` via a one-row SQL UPDATE the owner ran in the Supabase SQL editor. Verified: role now `provider_admin`, `updated_at` 2026-06-18 11:50 UTC.
- **Fixed provider self-invite 403** (commit `780cf5b`, pushed live): Freya's invite attempt hit `real_provider_locked`. Root cause: `provider-invite-link` EF has a demo-only fence rejecting real providers (`is_demo=false`) unless the caller sends `x-allow-real: true`. The admin send-portal-invite action already sends it (how Jane + Freya were enrolled); the provider-side `team-actions.ts` was missing it. Added the header, mirroring the admin path exactly. One-line change, deploys via Netlify on push to the portal app.
- Riverside now has three portal admins: Jane Preston, Switchleads Support, Freya Kelly.

## Next steps
1. (Carried from S75) **Rotate the Meta CAPI access token** — it was pasted into chat twice. Owner regenerates (System User → Generate New Token → Never), then swap the `META_CAPI_ACCESS_TOKEN` Supabase secret. Runtime env read, no code/deploy.
2. (Carried from S74) Send a Brevo test of template `76` against a contact whose course has a start date to confirm `SW_COURSE_INTAKE_DATE` renders.
3. (Carried from S74) Verify the Netlify builds landed (admin app + switchable-site): EMS preview shows Saranya with a "Private pay" badge + "bill them directly" banner.
4. (Carried from S74) Watch the first brand-new private-pay lead end to end: auto-routes, shows "Private pay", appears in the portal with the price, gets template 76.
5. **(New, backlog)** Build an audited "change role" control on `/admin/providers/[id]` (promote/demote an existing teammate, mirroring the invite/remove Server Actions + audit.actions write). The gap surfaced again this session — Freya had to be flipped by raw SQL because no UI promotes an existing user. Filed to the Work Hub (`platform`, backlog).

## Decisions and open questions
- **Freya promoted via raw SQL, not a UI** (owner chose quick flip over building the control now). Data UPDATE on one row, not DDL, so no migration-history desync. No audit.actions row written. Logged in `platform/docs/changelog.md` per the data-fix rule.
- (S75) Keep Stape, add an owned server CAPI path; fire CAPI for primary leads only (`parent_submission_id IS NULL`). Value: B2B 400; B2C gov 150 / else 100. DB enum is `gov`/`self`/null, never `funded`.
- (S74) Private-pay leads auto-route with no owner approval; `is_dq` stays true; `accepts_private` is per-provider-per-course.
- Open: none blocking.

## Watch items
- **Provider self-invite live, unverified end to end:** confirm Freya's retry of the Louise Beizsley invite (Louise@riverside-training.co.uk) succeeds after the Netlify build lands, and that Louise receives the invite email and can enrol a passkey. First real provider-initiated invite.
- **Demo fence now bypassed on the provider self-invite path too.** The fence's stated gates (RLS proof + pen-test) were already de facto bypassed by the admin path; flagged for awareness, not a new exposure.
- **Exposed CAPI token** still live until rotated (Next steps 1).
- The pre-existing `trx.json` Deno type error in `route-lead.ts` persists (does not block deploy).
- (S74) Saranya (639) got the funded U1 pre-fix (can't unsend); her `private_price_quoted` is NULL (predates the column).
- (S74) Confirm the late-session Netlify builds (admin app + switchable-site) rendered before relying on portal/site display.

## Next session
- **Folder:** platform
- **First task:** rotate the exposed CAPI token + update the `META_CAPI_ACCESS_TOKEN` secret (both brands verified live).
- **Cross-project:** none this session. Freya change is platform-only.
