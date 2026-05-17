# Platform Handoff, Session 49, 2026-05-17

## ⚡ PUSH FROM switchable/site 2026-05-17: site-side partial-tracker push is live

Mable's `.track()` wiring on `s4b-employer-lead-v1`, `switchable-waitlist`, `switchable-waitlist-enrichment`, and `fastrack-funded-v1` is live in production (commit `8f5e9b0`, pushed earlier today, Netlify auto-deploy). Pairs with your `2675b00` allowlist extension. Both ends now match. Your "watch `leads.partials` once Mable's push lands" item (Next steps #2) is now active watching, not pending. No Sasha action needed; just removing the dependency tag.

## ⚡ PUSH FROM switchable/email (Wren) 2026-05-17: SW_FASTRACKED attribute + fastrack-qualified transactional trigger

**Context.** Wren is shipping a one-off "last chance to apply" marketing broadcast tomorrow 18 May PM, targeting open `smm-for-ecommerce` leads who haven't fastracked, marketing-consented. EMS Tees Valley SMM cohort starts 21 May. The broadcast's audience filter needs a Brevo-visible flag for "has the learner submitted the fastrack form yet" — `leads.submissions.fastracked_at` exists but Brevo can't see DB columns. Same flag also unblocks future fastrack-chase automations.

**Two distinct deliverables, both gated on you.**

### 1. `SW_FASTRACKED` boolean Brevo contact attribute

- **Create attribute in Brevo dashboard.** Contacts → Settings → Contact Attributes → add `SW_FASTRACKED` as type Boolean.
- **Wire writes at routing time** in `_shared/route-lead.ts`. Add `SW_FASTRACKED: false` to the attribute payload in both `upsertLearnerInBrevo` and `upsertLearnerInBrevoNoMatch` (same call-sites that already carry the other SW_* attrs). Every new contact lands with `false` from the off.
- **Wire write-on-flip in `fastrack-receive`.** After the `leads.fastrack_submissions` child-row insert succeeds (and the `leads.submissions.fastracked_at` stamp), call `upsertBrevoContact` with `SW_FASTRACKED: true`. Same upsert can refresh the other SW_* attrs as a free side effect — useful because it also re-pushes `SW_FASTRACK_URL` (memory: shipped broken 9 May), so the same code path handles the pre-broadcast gate requirement for that attribute on these contacts.
- **Backfill across existing contacts** via the `admin-brevo-resync` panel pattern (just used 2026-05-16 for the three-attribute backfill, 356 contacts). For every Brevo contact with a parent `leads.submissions` row, set `SW_FASTRACKED = (fastracked_at IS NOT NULL)`. Same pass can refresh `SW_FASTRACK_URL` to clear any stale 9-May breakage.
- **Update `switchable/email/CLAUDE.md` attribute list** from 21 → 22 attrs, document the attribute, the false-at-routing/true-at-fastrack semantics, and the backfill mechanic. Wren can take this if cleaner.

### 2. New transactional template trigger: `u-fastrack-qualified` (fires from `fastrack-receive`)

- **Trigger condition** (inside `fastrack-receive`, after the child-row insert): `cohort_confirmed === true AND l3_reconfirmed === false`. That's the qualify path — learner committed to the cohort AND didn't self-report a Level 3 (so no L3 mismatch). The two existing DQ paths (`cohort_confirmed === false` → cohort_decline, `l3_reconfirmed === true` → l3_mismatch_self_reported) stay silent on this email.
- **Send via `sendTransactional`** in `_shared/brevo.ts`. Template ID = TBD from Wren once she's published the template in Brevo dashboard. Template will reuse the existing `SW_PROVIDER_CONTACT_BEFORE` / `SW_PROVIDER_PHONE` / `SW_PROVIDER_CONTACT_AFTER` three-attribute composition for the named-rep + bold-phone block, so no new attribute wiring needed for content rendering. Same `SW_PROVIDER_NAME` / `SW_COURSE_NAME` / `SW_COURSE_INTAKE_DATE` already populated.
- **Idempotency** in `crm.email_log` on `(submission_id, 'u_fastrack_qualified')` per the existing utility-send pattern. Will need a new `email_type` value — add `'u_fastrack_qualified'` to whatever enum / check constraint governs the column (migration if needed).
- **Legal basis:** contract. Goes regardless of `marketing_opt_in` — this is an operational confirmation of a successful application step plus a heads-up that a named human is about to call them. Standard utility track.
- **Sequencing.** This trigger is independent of the broadcast send. Wren publishes the template + provides the template ID; you wire the hook + ship. No hard deadline (the broadcast going out doesn't gate on this), but ideally live within a few days of broadcast send so any fastrack qualifies that broadcast drives land on the new ack.

### Timing reality

- **Hard target: SW_FASTRACKED attribute + wiring + backfill landed by tomorrow 18 May midday UK.** That lets Wren's broadcast filter use the Brevo attribute cleanly: `SW_COURSE_SLUG = smm-for-ecommerce AND SW_ENROL_STATUS = open AND SW_FASTRACKED = false AND SW_CONSENT_MARKETING = true`.
- **Fallback if not in time:** Wren pulls the audience via DB SQL (open SMM, `fastracked_at IS NULL`, `marketing_opt_in = true`), one-off Brevo list segment for this single send. Attribute work then catches up after. Broadcast doesn't gate on you, but cleaner Brevo-native filter is the preferred path.

### Schema / governance notes

- Brevo attribute set is a data contract between routing and email. Additive boolean attribute, old consumers (templates not referencing it) safely ignore. No payload `schema_version` bump.
- Per data-infrastructure rule §8: no DB schema change needed for the attribute itself; the `email_type` enum addition (if applicable) ships as its own forward migration with the standard impact-assessment header.
- Log both pieces in `platform/docs/changelog.md` on ship.

### Cross-references

- Existing fastrack architecture: migration `0087_fastrack_submissions.sql`, `fastrack-receive` Edge Function (live), parent stamp on `leads.submissions.fastracked_at`.
- Existing three-attribute provider-contact composition: `_shared/route-lead.ts` `renderProviderContactValues`, `switchable/email/CLAUDE.md` lines 54-60.
- Backfill pattern reference: `admin-brevo-resync` panel, used 2026-05-16 for `SW_PROVIDER_CONTACT_*` backfill (356 contacts).
- Pre-broadcast gate hard rule: `switchable/email/CLAUDE.md` lines 123-136.

## Current state

Five fixes shipped to admin + provider portal. Tab-refocus slowness fixed twice (RealtimeRefresh visibility handler gated to >5min hidden, then redundant `supabase.auth.getUser()` removed from admin layout); admin overview fully rebuilt per the Session 48 directive with period picker, per-section Suspense streaming, and provider scoreboard; `/provider/leads` default landing tab is now Fresh with an orthogonal Overdue queue and `cannot_reach` dropped from the Fastrack tab; `netlify-partial-capture` allowlist extended to cover the six forms Mable wired yesterday. Referral programme diagnosed end-to-end (capture pipe intact, near-zero share volume at the top of funnel) and cross-project asks routed to Wren and Mable. All five commits live.

## What was done this session

- **Admin overview rebuild** (commit `c0eaead`). New `/admin/page.tsx`: period picker (2d/7d/14d/30d/lifetime/custom with native date inputs), per-section `<Suspense>` boundaries so the page chrome paints instantly while tiles stream. Top-line tiles: Total leads, Confirmed enrolments, CPL, CPE, Confirmed income (period, post free-3 cap), Ad spend, P/L (period headline + lifetime in note). Presumed-this-period as a separate tile for auto-flip cohort tracking. Provider scoreboard with four attributable columns (Leads / Enrolled / Conversion / Income) + rollup row. Data health + Actions cards moved out of layout into the page body. New `app/admin/_components/period-picker.tsx` client component.
- **`/admin` slowness fix round 1** (commit `c0eaead`). `RealtimeRefresh` visibility handler now only fires `router.refresh()` after the tab has been hidden >5min (websocket-suspend threshold). Dropped the `focus` listener entirely; it was double-firing with `visibilitychange` and triggering on cross-app focus.
- **`/provider/leads` Fresh + Overdue filter pills** (commit `c0eaead`). Fresh is the new default landing tab. Overdue pill rose-coloured when count > 0, slate when zero. Sidebar surfaces both at the top of the snapshot. Lead-overdue helpers extracted to `lib/lead-overdue.ts` so server page can count overdue rows without duplicating client logic.
- **Fresh/Overdue orthogonal fix** (commit `b39c4aa`). Charlotte caught Fresh pulling up overdue rows: Fresh = `status='open'` and Overdue = `isOverdueRow(...)` overlapped on overdue-uncontacted leads, so the global sort pinned them to the top of Fresh. Fresh now excludes overdue rows. Sidebar Fresh count mirrors the pill.
- **Fastrack tab drops `cannot_reach`** (commit `561a6da`). Charlotte's call: once the provider has logged the lead is unreachable, the fastrack signal is spent. `FASTRACK_SETTLED` set extended from {lost, enrolled, presumed_enrolled} to add `cannot_reach`.
- **`/admin` slowness fix round 2** (commit `b518dcc`). Diagnosed that `proxy.ts` middleware already calls `supabase.auth.getUser()` on every request, and the admin layout was calling it again. Layout now reads local `getSession()` (no network); proxy is the security boundary. Defensive null check bounces to `/login` if cookies expired between middleware and layout. Saves ~100-300ms per click. Charlotte confirmed "platform does seem a little faster" post-deploy.
- **`netlify-partial-capture` ALLOWED_FORMS extended** (commit `2675b00`). Added `s4b-employer-lead-v1`, `switchable-waitlist`, `switchable-waitlist-enrichment`, `fastrack-funded-v1` to the Set. Function redeployed via `supabase functions deploy netlify-partial-capture`. `config.toml` already had `verify_jwt = false` set. Mable wired `.track()` calls into the corresponding six Switchable forms yesterday; without the allowlist extension all four new ones would have been rejected with `disallowed_form_name`.
- **Referral programme diagnosis.** Queried `leads.submissions` + `crm.email_log`: 455 submissions in last 60 days, zero `referrer_lead_id` populated. Capture pipe verified intact via source-read (`extractRefCode`, `processReferral`, `/refer/` page script emitting `https://switchable.org.uk/course-finder/?ref=<CODE>` via WhatsApp/SMS/Email/Copy buttons). Issue is upstream: only 1 friend has ever clicked a real referral URL (May 10, code `BAYH9H59`, dropped at funded form step 6). Zero `/refer/` page traffic in `leads.partials`. U1 funded: 64 sent, 12 opens, 5 clicks; none of those clicks landed on `/refer/`. The 36 `?ref=` URLs that ARE in `page_url` are the waitlist pre-fill mechanism (`?ref=<email>&phone=<num>`), a namespace collision with the referral programme.
- **Cross-project pushes added.** `switchable/email/docs/current-handoff.md` got a Wren ask to review the U1 funded + U1 self template referral CTA prominence (promote out of PS if buried). `switchable/site/docs/current-handoff.md` got a paired Mable + Sasha ask to ship a fire-and-forget `/refer/` page-view beacon + receiver Edge Function + a surfaced metric on `/admin/referrals`.
- **AdminShell trimmed.** HealthBar removed from topbar; nav badges removed from sidebar (moved to overview body per directive). Layout query count dropped from 5 to 0 (only auth + MFA remain, both now lighter).
- **Sasha session-start health check ran clean.** 16 crons active including all critical; 21 submissions in last 24h (18 non-DQ); zero unrouted >48h; zero new dead-letter rows in last 24h; RLS on across `leads`/`crm`/`ads_*`.

## Next steps

1. Verify the rebuilt `/admin` overview against real data across all period buckets. Click 2d/7d/14d/30d/lifetime, eyeball P/L tile period vs lifetime split, confirm scoreboard math (per-provider Leads / Enrolled / Conversion / Income) rolls up correctly into the totals.
2. Watch `leads.partials` for the four newly-allowed form names (`s4b-employer-lead-v1`, `switchable-waitlist`, `switchable-waitlist-enrichment`, `fastrack-funded-v1`) once Mable's site-side push lands. If 24h passes with still zero partials for one specific form, investigate that form's `.track()` wiring.
3. Replay or write-off the 12 `sheet_drift_detected` dead-letter rows accumulated since 2026-05-14. Trigger `republish-provider-sheet` from `/admin/errors` for each affected provider.
4. If `/admin` still lags after `b518dcc`, instrument `proxy.ts`'s `updateSession` cost as the next diagnostic layer. The proxy runs `supabase.auth.getUser()` on every request including sub-route navs; if that's the residual cost, options are caching the user via a signed cookie or skipping it on already-validated session cookies.
5. Repair CLI migration registry drift: `0141-0145` local but not on remote per `supabase migration list --linked` (carry from Session 47). Production is correct; only the local registry is out of sync.
6. Per-provider CPL / CPE / P/L: design a campaign->provider mapping (either `crm.providers.ad_campaigns text[]` or `ads_switchable.campaign_provider_map`) so the scoreboard can carry those columns. The bottom of the scoreboard explicitly flags this gap.
7. Optional follow-up from B: extend callback + stale-attempt timers to working hours (currently only first-attempt uses working hours per Session 48). Cheap if a provider complains about weekend stale-attempt badges.
8. Brevo template orphan deletion (carry from Session 48): once Wren confirms `u1-funded` template is verified live on a real EMS or WYK lead, delete the orphan `SW_PROVIDER_CONTACT_BLOCK` attribute + `u1-funded-post-fastrack` template from Brevo dashboard.
9. Carry from Session 47/48: invited portal users at `status='invited'` (Andy / Jake / George / Nick EMS, Jane / Freya Riverside); WYK + Courses Direct portal launch when ready; lead-assignment in-session lock (Phase 2); data-ops audit-log template tighten; WYK + CD sheet-vs-DB reconcile; `/provider/leads` N+1 + cursor siblings; RealtimeRefresh `lead_notes` subscription scope; RLS `(SELECT fn())` wrap on `crm.disputes` + `leads.fastrack_submissions`.
10. Solis carry: schema naming `ads_business` vs `ads_switchable_business`; `crm.employer_signings` design before first Riverside Employer Signed event.

## Decisions and open questions

**Decisions:**

- **Fresh and Overdue are mutually exclusive on `/provider/leads`.** Fresh = `status='open'` AND not overdue. Overdue = past SLA regardless of attempt state. The previous shape overlapped (Overdue is a subset of Fresh when both fire on the same lead) and made the Fresh tab look like Overdue because the global sort pinned overdue rows to the top. Orthogonal split removes the ambiguity; sidebar Fresh count mirrors the pill.
- **`cannot_reach` added to `FASTRACK_SETTLED`.** Charlotte's call: once the provider has logged unreachable, the fastrack signal is spent. Reverses the earlier "keep cannot_reach in so a learner who comes back can still be picked up" rationale.
- **Admin layout no longer revalidates the user with `supabase.auth.getUser()`.** `proxy.ts` is the security boundary; layout trusts it. Local `getSession()` is enough for user email + AAL check. Defensive null check bounces to `/login` if cookies expired between middleware and layout (shouldn't happen in practice).
- **`/admin` overview rebuilt with Option A on the scoreboard.** Per-provider Leads / Enrolled / Conversion / Income only; per-provider CPL / CPE / P/L deferred pending a campaign->provider mapping. Top-line tiles roll up across all providers and carry the spend-based metrics.
- **AdminShell HealthBar and sidebar nav badges removed.** Per directive: those metrics moved to the overview body. Side effect: admin sub-pages (`/admin/leads`, `/admin/actions`, etc.) no longer show those signals. Intentional consequence of the move; easy to add back on sub-pages if it bothers in practice.
- **Referral programme is not broken at the platform layer.** Capture pipe is intact; `/refer/` page works; share buttons emit correct URLs; `extractRefCode` + `processReferral` fire on a valid `?ref=<8-char-code>` payload. Issue is upstream (low CTA prominence in U1, no `/refer/` page-view telemetry). Routed to Wren + Mable.
- **P/L formula** (Session 48 open question): confirmed as period revenue minus period ad spend only; tooling costs and provider commissions not netted off at this scale. Lifetime totals shown as a note beneath the period figure.
- **"Fresh" definition** (Session 48 open question): no contact attempt logged yet (`status='open'`), with the orthogonal Overdue subtraction added this session. Fastrack-first ordering within Fresh handled by the existing global sort.

**Open questions:** None this session.

## Watch items

- **`/admin` slowness post-deploy.** Charlotte confirmed "platform does seem a little faster" after `b518dcc`. Continue to monitor whether tab-refocus + first-click lag has fully gone. If not, `proxy.ts` middleware is the next layer.
- **`leads.partials` for the four newly-allowed form names** post-Mable-push. Should populate within hours of her site-side fix landing. Investigate any one that stays at zero after 24h.
- **12 `sheet_drift_detected` dead-letter rows.** Oldest 2026-05-14 06:00 UTC, none > 7 days. Accumulating from the daily reconcile cron; not urgent but needs an operator pass.
- **Wren's `u1-funded` template publish** (carry from Session 48). Once live, verify on the next real EMS Tees Valley funded lead + WYK Camden non-EMS lead. Then delete the Brevo orphans.
- **CLI migration registry drift** `0141-0145` local but not on remote (carry from Session 47). Production correct.
- **First Friday-late or Saturday-routed lead post-Session-48 deploy.** Confirm the overdue badge does NOT fire over the weekend per the working-hours timer.
- **`TEST_MODE = false`** in Supabase Vault. Re-verify before any session that might trigger a real B2B submission.
- **First real `cohort_decline` fastrack** (carry from Session 44).
- **First fire of `dead-letter-alert-hourly` cron** (carry from Session 44).
- **First real B2B Riverside submission** (carry from Session 46-47).
- **Invited portal users walking through** (Andy / Jake / George / Nick EMS, Jane / Freya Riverside; all still at `status='invited'`).
- **Audit row lands on every new SLA acceptance** (carry from Session 46-47).
- **`SLA: X/N accepted` badge** on `/admin/providers/<id>` (carry from Session 46-47).
- **First real B2C ad-driven lead, confirm full chain** (carry from Session 47).

## Next session

- **Folder:** `platform`
- **First task:** Verify the rebuilt `/admin` overview against real data across every period bucket. Click through 2d / 7d / 14d / 30d / lifetime and a custom range; confirm tile values, scoreboard math, and rollup row. Then check whether the layout `getUser` removal has fully resolved the tab-refocus lag; if not, instrument the `proxy.ts` `updateSession` cost as the next diagnostic.
- **Cross-project:** Wren has the U1 referral CTA prominence ask in `switchable/email/docs/current-handoff.md`. Mable has the paired `/refer/` page-view beacon ask in `switchable/site/docs/current-handoff.md`; once Mable's spec for the beacon lands here, build the Edge Function receiver + `leads.page_views` extension + surface the metric on `/admin/referrals`.
