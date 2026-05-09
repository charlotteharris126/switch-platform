# Platform Handoff, Session 37, 2026-05-09

## Current state

Provider portal MVP P2 + P3 shipped end-to-end on production. Demo provider (`demo-provider-ltd`, `is_demo=true`) seeded with 12 fake leads spanning all 9 statuses; passkey enrolment, sign-in, leads list, lead detail, outcome marking all live and owner-tested. Five migrations applied (0101 through 0105), one new Edge Function deployed, 14 commits to main. Real-provider cutover (EMS first, mid-next-week target) gated on three Clara-approved conditions: audit-log wrapper, RLS proof, `/ultrareview`. Repo + origin clean on `main@974ffc6`.

## What was done this session

Migrations:

- **0101** filter `is_demo` providers out of `crm.sync_leads_to_brevo` (single filter point covers every trigger + the daily reconcile cron + direct callers; demo data never reaches Brevo)
- **0102** `crm.provider_passkeys` table + invite-token state columns on `crm.provider_users` + `status='invited'` value + `enrolled_at` timestamp
- **0103** `crm.provider_users.auth_user_id` made nullable so the Supabase auth user is created at register-verify (not invite-time), closing the OTP-hijack edge case where a dormant auth identity could be hit with `signInWithOtp` before passkey registration
- **0104** extend `public.get_shared_secret()` allowlist to include `PROVIDER_INVITE_SECRET` (vault becomes single source of truth alongside `AUDIT_SHARED_SECRET`)
- **0105** GRANT `service_role` on `crm` + `leads` + `audit` schemas with `ALTER DEFAULT PRIVILEGES` so future tables auto-grant. Closes the project-wide gap that surfaced when the new passkey API routes (which use service-role to read pre-session) returned silent empties

Edge Functions:

- **`provider-invite-link`** new — admin-authed via `x-audit-key` (vault-read), generates 15-min HMAC enrolment-only token, single-use enforced via sha256 hash on the row, sends Brevo invite email; demo-only fence (`is_demo=true` required) until Clara's three gating conditions clear; defensive trailing-slash strip on `PORTAL_BASE_URL`; `Number()` coercion on BIGINT `provider_user_id` before signing (postgres-js footgun)

Next.js portal (`app.switchleads.co.uk`):

- **`/passkey-login`** + **`/passkey-enrol/[token]`** pages with `@simplewebauthn/browser` ceremonies and humanised error messages
- **4 API routes** (`register-options`, `register-verify`, `login-options`, `login-verify`) — verify ceremonies via `@simplewebauthn/server`, mint Supabase sessions via `admin.generateLink('magiclink')` + server-side `verifyOtp` (Supabase Auth doesn't natively support WebAuthn — confirmed via docs)
- **`/provider`** home rebuilt with four counter tiles (Open / In progress / Enrolled this month / Awaiting outcome > 7 days), CTA into the leads list
- **`/provider/leads`** RLS-scoped list (name / course / routed-when / status badge); click row → detail
- **`/provider/leads/[id]`** lead detail with full routed payload (contact, learner, course, free-text answers); outcome marking buttons calling Server Action that writes `crm.enrolments` via RLS, with `revalidatePath` on success
- **`ProviderShell`** top nav (Home / Leads / Sign out with `useFormStatus` pending state)
- **`proxy.ts`** updated: `/passkey-login`, `/passkey-enrol`, `/api/passkey/*` added to `SHARED_AUTH_PATHS` so they bypass the auth gate and hostname rewrite

Admin polish:

- New "Portal access" card on `/admin/providers/[id]` with Send portal invite form (pre-filled, demo badge, validates `portal_enabled=true`)
- Demo data fence on `/admin/page.tsx`, `/admin/leads/page.tsx`, `/admin/providers/page.tsx`, `/admin/profit/page.tsx` via new `lib/demo.ts` helper (cached 30s)
- Demo provider violet pill links above the providers table for direct access to demo detail page

Auth model relock:

- Pivot from magic-link to passkey-only after Charlotte raised UK GDPR Article 32 concerns (auth tokens at rest in email inboxes)
- Clara approved the new model in `accounts-legal/changelog.md`: PPA v2 covers it, no addendum gate, sub-processor disclosure unchanged
- Three conditions before real-provider cutover, captured in `accounts-legal/docs/current-handoff.md` item 2

Demo data:

- `data-ops/019_seed_demo_provider_2026_05_09.sql` ran cleanly — 1 provider + 12 fake leads + 12 routing_log + 12 enrolments. Brevo never received any of it (filter held; verified zero pg_net dispatches from the 12 enrolment INSERTs)

Bug fixes worth naming (each surfaced as a different symptom but rooted in a real architectural gap):

- **BIGINT-as-string coercion** — postgres-js returns BIGINT columns as JS strings; my Edge Function was embedding `"1"` into the JSON token, Next.js verify did `typeof === "number"` and rejected as malformed. Fixed both sides defensively.
- **`service_role` schema GRANTs** — service_role had `BYPASSRLS` but no schema/table privileges on `crm`/`leads`. supabase-js calls returned `data: null` with no error, surfaced as 404 user_not_found. Fixed via 0105.
- **Vault drift class** — `PROVIDER_INVITE_SECRET` was in two stores (Supabase Edge Function secrets + Netlify env), they disagreed, every invite click failed signature verify. Same fix pattern as 0019 did for `AUDIT_SHARED_SECRET`.
- **Next.js 16 middleware → proxy convention** — added `middleware.ts` not knowing Next 16 had renamed it. Build failed; renamed routes to non-conflicting paths (`/passkey-login`, `/passkey-enrol`) so the existing `proxy.ts` works.

## Next steps

1. **Wire `audit.log_provider_action` via public-schema wrapper** (~30 min, gates EMS cutover). Audit schema isn't exposed in Data API; either expose it + add `service_role` grant, or add a `public.log_provider_action_v1(...)` thin wrapper that delegates. Server Action `markOutcomeAction` has TODO comment in place. Required before real-provider cutover for Article 30 ROPA evidence.

2. **RLS proof** (~1h, Clara condition). Build a fixture with the demo provider + one real provider. Authenticate via supabase-js as the demo passkey-enrolled user. Attempt `SELECT` on `leads.submissions`, `crm.enrolments`, `leads.routing_log`, `crm.disputes` rows belonging to the real provider. Assert zero rows returned in every case. Confirm `crm.provider_user_provider_id()` returns NULL for an unflagged (`portal_enabled=false`) provider. Output a runbook in `platform/docs/rls-proof-2026-05-XX.md`.

3. **Run `/ultrareview`** on migrations 0091-0105 + portal route code (Clara condition, mandatory before real-provider cutover). Cloud-based multi-agent review across the diff per `.claude/rules/data-infrastructure.md` item 8.

4. **Disable email OTP at Supabase project level** (Supabase dashboard → Authentication → Providers → Email → disable). Stops `signInWithOtp` working against any provider auth user, even though we never call it ourselves. Defence-in-depth.

5. **Cleanup duplicate secret stores** (Charlotte action, ~5 min): delete `PROVIDER_INVITE_SECRET` from Supabase Edge Function secrets dashboard, delete `PROVIDER_INVITE_SECRET` + `AUDIT_SHARED_SECRET` from Netlify env (vault-RPC bypasses both now). Harmless if left, but tidy.

6. **P4 admin polish** (~1-2h): last-login column on `/admin/providers`, "providers without recent login" tile on `/admin` home, provider-side activity panel on `/admin/leads/[id]`, Brevo "new lead routed" template updated to deep-link `/provider/leads/[id]` instead of "check your sheet". Templates dormant until Brevo IDs set.

7. **EMS cutover sequence** (target mid-next-week, gated on 1+2+3 clearing). Day 0 invite, days 0-14 parallel sheet + portal, day 14 emails switch to portal-only, day 21 sheet append disabled. Clara's optional PPA clarification paragraph folds into addendum stack ticket [869d61kft](https://app.clickup.com/t/869d61kft) when it next goes out.

8. **SwitchLeads provider-facing Brevo template drafts** (when auto-flip cron re-arms): `BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING` (day-12), day-14 confirmation, day-19 dispute reminder. Charlotte voice (`charlotte-voice.md`), no PII (count + portal link only). Owner approves before live.

9. **Re-arm auto-flip + day-12 warning crons** when prerequisites clear: Wren's day-12 template + Mira's activity-gate framework + provider heads-up emails (Nell). Clara's PPA review now cleared. One SQL block re-schedules both.

10. **Verify Mable's fastrack frontend redirect** for cohort_decline + l3_mismatch (Mable shipped commit `bd7093c` 2026-05-09 evening). Watch `leads.dead_letter` 24-48h for any `edge_function_brevo_upsert` rows with payload `switchable-waitlist-enrichment` carrying `parent_ref` + `source_form='fastrack-cohort-decline'` or `'fastrack-l3-mismatch'`. Clean = working.

11. **Pre-fill enrichment form via backend lookup** (smart-to-have, Mable's flag). When `/waitlist/` loads with `?parent=<client_nonce>`, currently re-asks for phone (sloppy to pass PII via URL). Cleaner: small new Edge Function `enrichment-prefill` reads parent submission by client_nonce, returns public-safe pre-fillable fields. Lifts enrichment completion rate. No deadline.

12. **Re-run `data-ops/018` for any rows written between SQL run and Mable's form-side fix** (Mable Session 5 push, 2026-05-09 evening). Quick query: `SELECT id, dq_reason, created_at FROM leads.submissions WHERE dq_reason IN ('age', 'location', 'level', 'qual') AND created_at > '<data-ops/018 run time>'`. If non-zero, re-run the same UPDATE block. 5-min job. After this second pass, future submissions won't write deprecated values, and `data-ops/018` retires.

13. **Provider portal Conditional Mediation** (UX polish, ~30 min). Wire `useBrowserAutofill: true` on `/passkey-login` so a saved passkey shows up as autofill on the email field and a single tap completes sign-in. Currently disabled (caused user confusion this session). Future polish, not blocker.

## Decisions and open questions

### Decided this session

- **Auth model: passkey-only with enrolment-only invite link** (was magic-link). UK GDPR Article 32: emailed auth tokens sit at rest in inboxes / IMAP / backups; passkeys never leave the device. Why now: Charlotte raised the concern mid-session; Clara approved the new shape same session.
- **Custom WebAuthn implementation** (Option A from the auth-model decision tree). Supabase Auth's MFA surface is TOTP + SMS only; verified docs say no native passkey support. Why custom over a vendor (Hanko, Stytch, Clerk): no new sub-processor, no new monthly cost, no new vendor in the data-flow disclosure.
- **Auth user creation deferred to register-verify** (not at invite-time). An invited-but-not-enrolled email would otherwise have a dormant auth identity that an attacker could hit with `signInWithOtp`. Migration 0103 made `auth_user_id` nullable to support this.
- **Vault is single source of truth for shared secrets** (`AUDIT_SHARED_SECRET`, `PROVIDER_INVITE_SECRET`). Two-store drift class (Session 9 incident) bit again this session before the refactor; pattern from 0019 extended via 0104. Future shared secrets ship the same shape: `vault.create_secret()` + extend `public.get_shared_secret()` allowlist + read via the helper from any consumer.
- **`service_role` granted on `crm` + `leads` + `audit` schemas with `ALTER DEFAULT PRIVILEGES`** (migration 0105). Was missing project-wide; only surfaced because the new passkey API routes need service-role for pre-session lookups. Closing it project-wide rather than per-table also stops future Edge Function / Server Action work from hitting the same silent failure mode.
- **Demo data fenced via `lib/demo.ts` helper** (not via DB views or RLS). Faster path; the proper-architecture answer (DB views) is its own small refactor when there's appetite. Helper queries demo provider IDs (cached 30s), composes filter clauses inline.
- **Session minting via `admin.generateLink('magiclink')` + server-side `verifyOtp`** (not via direct JWT signing). Supabase doesn't expose a clean "mint session for this user" API; this magic-link path is server-side only (link never leaves the server, never reaches an inbox), so the GDPR concern that motivated rejecting magic-link doesn't apply here. Pragmatic answer; cleaner long-term solution would be a Supabase-issued passkey grant once they add native WebAuthn support.
- **Invite-link routes use non-conflicting names** (`/passkey-login`, `/passkey-enrol`) rather than `/provider/login`, `/provider/enrol`. The existing `proxy.ts` treats `/login` as shared (admin login lives there); shadowing it would have required surface-detection logic inside the shared login page. Renaming was simpler.

### Open questions (none blocking demo, all gating EMS cutover)

- **Outcome → billing event auto-creation**: when provider clicks "Enrolled", should it auto-create a billing trigger? For pilot today, no billing system is wired; outcome marking is just status state. Resolve before first billable enrolment.
- **Lost-device recovery UX**: admin re-issues enrolment link via "Send portal invite" button. Re-issue replaces invite hash; if the provider consumes the new invite, register-verify adds another row to `crm.provider_passkeys`. Untested; should work by construction. Worth one round-trip test before first real-provider cutover.

## Watch items

- 🟡 First overnight runs of the new daily 04:45 UTC `brevo-attribute-reconcile-daily` cron (from Session 36). First scheduled fire 2026-05-10. Should produce zero new dead_letter rows.
- 🟡 Mable's frontend redirect ship for fastrack `cohort_decline` + `l3_mismatch` (her Session 60). Receiver deployed; if any payload arrives with `parent_ref` but lookup fails, `leads.dead_letter source=edge_function_brevo_upsert` will surface it.
- 🟡 Demo provider data filter on admin views — confirmed clean on the four pages updated. If new admin pages are added, `lib/demo.ts` filter must apply. Spot check after next session.
- 🟡 PostgREST schema cache may take a moment to pick up the new 0105 grants. If any service_role calls 404 next session, sanity-check via `has_table_privilege`.
- 🟢 Brevo consent reconcile cron — fixed and verified Session 36. Should remain clean.
- 🟢 Provider portal end-to-end — invite + enrol + sign-in + outcome mark all owner-verified live. Demo passkey enrolled in Charlotte's iCloud Keychain.

## Next session

- **Folder:** platform/
- **First task:** Wire `audit.log_provider_action` via a public-schema wrapper, then run RLS proof + `/ultrareview` to clear two of Clara's three gating conditions before EMS cutover.
- **Cross-project:** Clara already updated this session (`accounts-legal/docs/current-handoff.md` item 2 carries her sign-off + the three conditions). No new outgoing pushes needed beyond what's in this handoff.
