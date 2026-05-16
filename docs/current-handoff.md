# Platform Handoff, Session 48, 2026-05-16

## Current state

`SW_PROVIDER_CONTACT_BLOCK` migrated from per-send transactional param to Brevo contact attribute (Wren push, mid-session). Wiring code shipped; Brevo attribute registration + redeploy + one-time backfill pending Charlotte. Per-send param kept in place temporarily so existing templates (still referencing `{{ params.X }}`) don't render blank in the gap window before Wren switches them to `{{ contact.X }}`. Once Wren confirms templates live, follow-up deploy removes the dead param. Wren's other template work (move placeholder to a Brevo HTML block + cut the duplicated "they'll be in touch..." sentence) lands at the same time.

## What was done this session

- **`_shared/route-lead.ts` `renderProviderContactBlock` simplified.** Dropped `isPostFastrack` parameter, unified fallback wording: `<p>They'll be in touch within the next few days by email or phone to talk you through your start date and answer anything you want to ask.</p>`. The regular U1 template's next paragraph already covers eligibility; post-fastrack doesn't need it. `provider` arg typed `ProviderRow | null` so the function serves both matched and unmatched upserts.
- **Attribute write added to `upsertLearnerInBrevo` + `upsertLearnerInBrevoNoMatch`.** Every Switchable learner upsert (matched + no_match + pending) now carries `SW_PROVIDER_CONTACT_BLOCK` on the contact. Regional-match leads render the named-rep + phone paragraph; everyone else renders the fallback.
- **Per-send param kept temporarily** in `sendU1Transactional` to bridge the deploy-vs-template-switch gap. Identical render. Removed in a follow-up after Wren's templates go live.
- **Migration 0145 header not edited** (immutable per `.claude/rules/data-infrastructure.md`). Switch documented in `platform/docs/changelog.md` and `platform/docs/data-architecture.md` instead.
- **Earlier in the session (pre-Wren-push):** `renderProviderContactBlock` extended with `isPostFastrack` arg + per-fastrack fallback wording; four Edge Functions deployed. Superseded by the contact-attribute switch above — re-deploy needed.

## Next steps

1. **Register `SW_PROVIDER_CONTACT_BLOCK` in Brevo** as a contact attribute, text type. Brevo dashboard → Contacts → Settings → Contact Attributes → Add. Name `SW_PROVIDER_CONTACT_BLOCK`. This needs to exist before the redeploy lands writes against it (otherwise Brevo silently drops the attribute on upsert).
2. **Redeploy four Edge Functions** (the previous session-start deploy is stale after the param→attribute switch):
   ```
   supabase functions deploy routing-confirm --no-verify-jwt
   supabase functions deploy netlify-lead-router --no-verify-jwt
   supabase functions deploy admin-test-email --no-verify-jwt
   supabase functions deploy admin-brevo-resync --no-verify-jwt
   ```
3. **One-time backfill of `SW_PROVIDER_CONTACT_BLOCK`** across existing Switchable Brevo contacts. Use the existing `admin-brevo-resync` mechanism (same path as the Phase 3c `SW_REFERRAL_URL` backfill): iterate every non-archived `leads.submissions.id` that has an email, POST to `admin-brevo-resync` in batches. The re-upsert lands the new attribute on each existing contact. Throttle stays at 250ms per call inside the function. Confirm via Brevo contact spot-check on a known EMS Tees Valley email + a known WYK Camden email + a no_match DQ contact (all three should now carry the attribute, with the right paragraph for each lifecycle state).
4. **Signal Wren** once steps 1-3 are done. Wren then pushes both template updates in Brevo: switch `{{ params.SW_PROVIDER_CONTACT_BLOCK }}` to `{{ contact.SW_PROVIDER_CONTACT_BLOCK }}` in both U1 funded templates AND cut the duplicated "they'll be in touch..." sentence from the body paragraph above the placeholder. Placeholder lands inside a Brevo HTML block so the HTML renders raw.
5. **Follow-up: remove the dead per-send param.** Once Wren confirms both templates are live referencing `{{ contact.X }}`, delete the `SW_PROVIDER_CONTACT_BLOCK` line from the `params` object in `sendU1Transactional` (line ~860 of `_shared/route-lead.ts`) and redeploy `routing-confirm` + `netlify-lead-router`. Single-line cleanup; no behaviour change.
6. **Verify on the next two real EMS funded leads.**
   - Lead 1 (pre-fastrack, Tees Valley LA): submit at `/funded/counselling-skills-tees-valley/`, owner-confirm without fastracking. U1 should render the named rep + phone paragraph as styled HTML (no literal tags), AND the body paragraph above no longer duplicates the "they'll be in touch..." sentence.
   - Lead 2 (post-fastrack, same form): submit, complete fastrack, owner-confirm. Same checks.
7. **Verify the non-EMS path.** Submit a WYK Camden funded lead, owner-confirm. U1 should now render the unified fallback paragraph in place of the previous empty string.
8. **Watch invited portal users walk through** (carry from Session 47). Andy, Jake, George, Nick (EMS) and Jane, Freya (Riverside) still at `status='invited'`.
9. **First real B2C ad-driven lead, confirm full chain** (carry from Session 47).
10. **Optional env vars** in Supabase Vault when ready (carry from Session 47): `BREVO_SENDER_EMAIL_LEADS = hello@switchleads.co.uk`, `OWNER_CC_ALL_EMAILS = hello@switchable.careers`.
11. **Launch WYK + Courses Direct portals** when ready (carry from Session 47).
12. **Lead-assignment "in session" lock (Phase 2)** (carry from Session 46-47).
13. **Tighten data-ops audit-log template** (carry from Session 44).
14. **WYK + CD sheet-vs-DB reconcile** (carry, backlog 869d994nb).
15. **`/provider/leads` N+1 + cursor siblings** (carry, backlog 869d994qf).
16. **`RealtimeRefresh lead_notes` subscription scope** (carry, backlog 869d994t5).
17. **RLS `(SELECT fn())` wrap on `crm.disputes` + `leads.fastrack_submissions`** (carry, backlog 869d994un).
18. **Solis carry-forward** (carry from Session 47). Schema naming `ads_business` vs `ads_switchable_business`. `crm.employer_signings` design before first Riverside Employer Signed event.
19. **CLI migration registry cleanup** (carry from Session 47). `supabase migration list --linked` shows 0141 through 0145 in local but not remote.

## Decisions and open questions

**Decisions:**

- **`SW_PROVIDER_CONTACT_BLOCK` is now a Brevo contact attribute, not a per-send param.** Why: it was the only SW_* in the U1 funded templates that wasn't a contact attribute, which made it invisible in Brevo template preview (preview only resolves contact attributes) and architecturally special-cased vs the other 18 SW_* attributes. Charlotte hit the preview gap during today's QA. The Session 47 rationale ("avoids the attribute-wiring backfill rule") was real but small compared to the cost of preview-invisibility + special-casing — Wren's call to align it with the rest of the set. Backfill discipline applies: one-time backfill in step 3, then standard updates on every new upsert thereafter.
- **`renderProviderContactBlock` lost the `isPostFastrack` parameter and the variant-specific fallback wording.** Wren's call: the regular U1 template's next paragraph already covers the eligibility beat ("...so EMS can confirm you qualify ahead of the call..."), and the post-fastrack template doesn't need that beat at all. One unified fallback serves both. Simpler function, simpler attribute, less divergence to maintain.
- **Per-send param kept in place temporarily.** One-line redundancy; identical render to the contact attribute. Stays until both U1 funded templates are switched live in Brevo, then removed in a follow-up deploy. Stops any U1 funded send in the gap window from rendering blank against the still-live `{{ params.X }}` templates.
- **Migration 0145 header not edited.** Per `.claude/rules/data-infrastructure.md` migrations are immutable once applied. The param→attribute switch is a Brevo wiring change, not a DB schema change. Recorded in `changelog.md` + `data-architecture.md`.

**Open questions:** none this session.

## Watch items

- **Brevo attribute registration + backfill ordering.** Charlotte must register the attribute in Brevo before redeploying — otherwise Brevo silently drops the attribute on every upsert (no error, just dropped) and the backfill writes nothing.
- **Gap window between redeploy and Wren's template push.** Until Wren's templates switch to `{{ contact.X }}`, the per-send param keeps existing sends working. If the param is removed too early (step 5 before step 4), the gap window renders blank.
- **First real EMS funded U1 send post-deploy + post-template-switch** confirms: styled HTML (no literal tags), no duplicated "they'll be in touch..." sentence, attribute resolves correctly per LA, post-fastrack variant renders the right paragraph.
- **First non-EMS funded U1 send post-deploy** confirms the unified fallback paragraph renders in place of the previous empty string.
- **CLI migration registry drift** (carry from Session 47). 0141 through 0145 in local but not remote. Production correct.
- **Audit row lands on every new SLA acceptance** (carry from Session 46-47).
- **`SLA: X/N accepted` badge** on `/admin/providers/<id>` (carry from Session 46-47).
- **TEST_MODE = false** in Supabase Vault. Re-verify before any session that might trigger a real B2B submission.
- **First real cohort_decline fastrack** (carry from Session 44).
- **First fire of `dead-letter-alert-hourly` cron** (carry from Session 44).
- **First real B2B Riverside submission** (carry from Session 46-47).

## Next session

- **Folder:** `platform`
- **First task:** Confirm Charlotte completed steps 1-4 above (Brevo registration, redeploy, backfill, signal Wren) and Wren has pushed her template updates. Then run the verification: one Tees Valley EMS pre-fastrack + one post-fastrack + one WYK Camden non-EMS post-fastrack. Confirm styled HTML, no duplicated sentence, correct paragraph per LA, fallback renders for non-EMS. Once verified, ship the follow-up cleanup (remove per-send param from `sendU1Transactional`, redeploy `routing-confirm` + `netlify-lead-router`).
- **Cross-project:** switchable/email — Wren is mid-push on both U1 funded templates. Her handoff already reflects the work order. Charlotte signals her after step 3 completes.
