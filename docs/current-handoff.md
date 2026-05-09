# Platform Handoff, Session 38, 2026-05-09

## Current state

Two of Clara's three EMS-cutover gating conditions cleared this session: audit-log wrapper wired (mig 0106 + Server Action update) and RLS proof signed off 14/14 PASS (data-ops 020 + runbook). Real surprise: the proof caught that migration 0096's write-side policies were no-ops because table-level GRANTs were missing — `markOutcomeAction` has been silently failing since Session 37 despite the "owner-tested" claim. Migration 0108 grants the privileges 0096's comment already promised. Charlotte needs to retest outcome marking on the demo provider before EMS cutover. Clara's third gating condition was a multi-agent cloud diff review that isn't available in this setup; flagged to Charlotte to confirm an alternative review shape (focused single-agent diff review, or her own read).

## What was done this session

Migrations:

- **0106** `public.log_provider_action_v1` — public-schema thin wrapper over `audit.log_provider_action`. SECURITY INVOKER, delegates auth identity through per-request `request.jwt.claims` GUC. Lets supabase-js `.rpc()` reach the audit writer without exposing the audit schema in the Data API. Versioned (`_v1`) for forward-compatible deprecation.
- **0107** `REVOKE EXECUTE FROM anon` on the wrapper. Supabase's project-wide `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE TO {anon, authenticated, service_role}` auto-granted anon despite the 0106 `REVOKE FROM PUBLIC`. Inner audit function already rejects anon (`auth.uid()` NULL), but visible least-privilege wins.
- **0108** `GRANT UPDATE ON crm.enrolments` + `GRANT INSERT ON crm.disputes` to `authenticated`. The bug: migration 0096 shipped policies (`provider_update_enrolments`, `provider_insert_own_disputes`) without the underlying GRANTs, so PostgreSQL short-circuited every write with `42501 permission denied` before RLS even evaluated. Demo provider's enrolments still had seed-time `updated_at` values, confirming Charlotte's "owner-tested" outcome marking never persisted. Fix grants what 0096's comment promised. Row scope still enforced by 0096 policies (re-ran the RLS proof post-grant — cross-tenant writes still return zero rows / RLS rejection).

Server Action:

- **`app/app/provider/leads/[id]/actions.ts`** — `markOutcomeAction` now: SELECTs before-state, updates, calls `public.log_provider_action_v1` with before/after/context. Surfaces audit failure to caller (returns `ok:false`) rather than swallowing. Idempotent on identical-state retry (early return if `before == after`). The atomic UPDATE+audit refactor (single SQL function) is flagged below for Charlotte's call.

RLS proof + runbook:

- **`supabase/data-ops/020_rls_proof_2026_05_09.sql`** — 14 assertions covering helper return value, baseline own-data SELECT, cross-tenant SELECT on 6 tables (submissions, routing_log, enrolments, fastrack_submissions, providers, provider_users), cross-tenant UPDATE on enrolments, cross-tenant INSERT on disputes, audit `actor_provider_id` spoof-rejection, `portal_enabled=false` helper-NULL + table-empty pair. Auth simulated via `SET LOCAL ROLE authenticated` + `set_config('request.jwt.claims', ...)`. All side effects rolled back; one audit-id sequence gap (~3-4 ids) consumed during proof iteration.
- **`docs/rls-proof-2026-05-09.md`** — runbook + result table. 14/14 PASS. Documents what the proof proves and what it doesn't.

Changelog:

- **`docs/changelog.md`** — Session 38 block at top covering 0106/0107/0108 + the missing-GRANT bug.

## Next steps

1. **Charlotte: re-test outcome marking on the demo portal.** Pre-0108, `markOutcomeAction` was silently failing. Post-0108, it should persist. Click 1-2 outcomes in the demo provider portal, confirm `crm.enrolments.updated_at` advances and `audit.actions` gets a new `surface='provider'` row. Quick query: `SELECT id, status, status_updated_at, updated_at FROM crm.enrolments WHERE provider_id='demo-provider-ltd' ORDER BY updated_at DESC LIMIT 5;`. If the audit row also appears with `actor_provider_id='demo-provider-ltd'` and `action='mark_outcome'`, the wrapper + grants are confirmed end-to-end.

2. **Decide an alternative review for Clara's gating condition #3.** The condition was originally framed as a multi-agent cloud diff review that this setup doesn't have. Two workable substitutes: (a) I delegate a focused single-agent code review across migrations 0091-0108 + the `app/app/provider/**` portal routes via the Agent tool with a clear "look for non-reversible migrations, RLS gaps, secret leaks, design-doc-vs-migration drift" brief; (b) Charlotte reads the diff herself. Either clears condition #3 in spirit. Charlotte to call which.

3. **Decide: atomic outcome-marking refactor.** The current `markOutcomeAction` is SELECT → UPDATE → audit RPC, three round-trips. Failure mode: if audit RPC fails after UPDATE succeeds, the user sees an error, retries, but on retry the early-return-if-identical-state path skips audit — leaving a permanent ROPA gap. The proper shape is a single SQL function (e.g. `crm.provider_mark_outcome(submission_id, status, lost_reason)`) that does UPDATE + audit in one transaction with ROLLBACK on failure. Recommendation: ship the atomic refactor before EMS cutover — it's ~30-60 min and removes a real (rare) ROPA gap. Ask Charlotte to confirm before I write 0109.

4. **Disable email OTP at Supabase project level** (Supabase dashboard → Authentication → Providers → Email → disable). Stops `signInWithOtp` working against any provider auth user, even though we never call it ourselves. Defence-in-depth, carried over from Session 37.

5. **Cleanup duplicate secret stores** (Charlotte action, ~5 min): delete `PROVIDER_INVITE_SECRET` from Supabase Edge Function secrets dashboard, delete `PROVIDER_INVITE_SECRET` + `AUDIT_SHARED_SECRET` from Netlify env. Vault-RPC bypasses both now. Carried over from Session 37.

6. **P4 admin polish** (~1-2h): last-login column on `/admin/providers`, "providers without recent login" tile on `/admin` home, provider-side activity panel on `/admin/leads/[id]`, Brevo "new lead routed" template updated to deep-link `/provider/leads/[id]`. Templates dormant until Brevo IDs set.

7. **EMS cutover sequence** (target mid-next-week, gated on step 1 + 2 clearing). Day 0 invite, days 0-14 parallel sheet + portal, day 14 emails switch to portal-only, day 21 sheet append disabled. Clara's optional PPA clarification paragraph folds into addendum stack ticket [869d61kft](https://app.clickup.com/t/869d61kft) when it next goes out.

8. **SwitchLeads provider-facing Brevo template drafts** (when auto-flip cron re-arms): `BREVO_TEMPLATE_PROVIDER_PRESUMED_WARNING` (day-12), day-14 confirmation, day-19 dispute reminder. Charlotte voice (`charlotte-voice.md`), no PII (count + portal link only). Owner approves before live.

9. **Re-arm auto-flip + day-12 warning crons** when prerequisites clear: Wren's day-12 template + Mira's activity-gate framework + provider heads-up emails (Nell). Clara's PPA review now cleared. One SQL block re-schedules both.

10. **Verify Mable's fastrack frontend redirect** for cohort_decline + l3_mismatch. Watch `leads.dead_letter` 24-48h for any `edge_function_brevo_upsert` rows with payload `switchable-waitlist-enrichment` carrying `parent_ref` + `source_form='fastrack-cohort-decline'` or `'fastrack-l3-mismatch'`. Clean = working.

11. **Pre-fill enrichment form via backend lookup** (smart-to-have, Mable's flag). When `/waitlist/` loads with `?parent=<client_nonce>`, currently re-asks for phone (sloppy to pass PII via URL). Cleaner: small new Edge Function `enrichment-prefill` reads parent submission by client_nonce, returns public-safe pre-fillable fields. Lifts enrichment completion rate. No deadline.

12. **Re-run `data-ops/018` for any rows written between SQL run and Mable's form-side fix** (Mable Session 5 push, 2026-05-09 evening). Quick query: `SELECT id, dq_reason, created_at FROM leads.submissions WHERE dq_reason IN ('age', 'location', 'level', 'qual') AND created_at > '<data-ops/018 run time>'`. If non-zero, re-run the same UPDATE block. After this second pass, `data-ops/018` retires.

13. **Provider portal Conditional Mediation** (UX polish, ~30 min). Wire `useBrowserAutofill: true` on `/passkey-login` so a saved passkey shows up as autofill. Currently disabled (caused user confusion in Session 37).

## Decisions and open questions

### Decided this session

- **Public-schema wrapper over schema-exposure** (option b from the audit-bridge decision tree). Adding `public.log_provider_action_v1` keeps the audit schema closed and gives a stable surface to deprecate without dragging the schema with it. Versioned (`_v1`) so future shape changes ship `_v2` with a deprecation window per data-infrastructure §12.
- **Server Action surfaces audit failure** (not swallow + log). If audit write fails after UPDATE succeeds, `markOutcomeAction` returns `ok:false` so the caller sees the failure rather than the row landing without audit evidence. Trade-off: idempotent retry of the same state skips audit (early-return path). The atomic refactor in next-step #3 fixes this properly.
- **0108 grants surfaced bug, not policy intent change.** The 0096 comment explicitly described the GRANT shape ("server-side Server Actions are the trust boundary, full-table UPDATE granted"); the GRANT was just never written. 0108 implements the promised state, doesn't change policy intent.

### Open questions

- **Atomic outcome-marking refactor before EMS cutover?** See next step #3. Recommendation: yes. ~30-60 min, removes the ROPA gap on audit failure.
- **Demo provider re-test confirms 0108 fix end-to-end?** See next step #1. Until Charlotte clicks an outcome and the DB confirms, the fix is verified at the SQL layer only.

## Watch items

- 🟡 **Demo provider outcome marking** — pre-0108, never persisted. Post-0108, expected to work. Confirm via the query in next step #1 after Charlotte clicks an outcome.
- 🟡 **Audit row format from the new wrapper** — first real audit-via-wrapper row will land when Charlotte tests outcome marking. Verify `surface='provider'`, `actor_provider_id` in `context`, `before`/`after` populated.
- 🟡 First overnight runs of the new daily 04:45 UTC `brevo-attribute-reconcile-daily` cron (from Session 36). First scheduled fire 2026-05-10. Should produce zero new dead_letter rows.
- 🟡 Mable's frontend redirect ship for fastrack `cohort_decline` + `l3_mismatch`. If any payload arrives with `parent_ref` but lookup fails, `leads.dead_letter source=edge_function_brevo_upsert` will surface it.
- 🟡 PostgREST schema cache may take a moment to pick up 0108 grants. If Charlotte's first outcome click still fails with permission denied, wait ~30s and retry.
- 🟢 Provider portal RLS — proven 14/14 against demo + EMS. Cross-tenant reads/writes blocked at row level.

## Next session

- **Folder:** platform/
- **First task:** Confirm Charlotte's demo retest + audit row format (from watch items above), then write 0109 atomic-outcome-mark function if Charlotte greenlights it. Then resolve Clara's gating condition #3 via the route Charlotte picks (delegated review or her own read), then EMS cutover sequence kicks off.
- **Cross-project:** No new outgoing pushes needed. Clara's gating conditions #1 and #2 cleared; condition #3 is open pending the substitute-review decision in next-step #2.
