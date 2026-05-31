# Impact assessment — newsletter signup → Brevo automation

**Date:** 2026-05-31
**Author:** Claude (Sasha session), for owner review before deploy
**Trigger:** Newsletter signups did nothing past a Netlify email (Charlotte was importing to Brevo by hand). Not-routed (waitlist/no_match) leads needed to land on the newsletter list too.

## 1. What changes (plain English)
Two additions, both inside the existing `netlify-lead-router` deploy:
- **A. Newsletter form.** A new branch: when the form is `switchable-blog-subscribers`, add the email to the Switchable newsletter list (Brevo list 10) and return. No `leads.submissions` row, no nurture, no owner email. Single opt-in (the submit is the consent). Owner decision 2026-05-31.
- **B. Not-routed leads.** In the existing `no_match` Brevo path (`_shared/route-lead.ts` → `upsertLearnerInBrevoNoMatch`), also add list 10 when the lead consented to marketing. Routed leads are excluded — their nurture sequences place them.

## 2. What reads the affected tables / paths
- `netlify-lead-router` is the only consumer of the new branch. The site-wide Netlify "Any form" webhook already delivers `switchable-blog-subscribers` submissions to it (verified: they currently fall through to a no-op). No new webhook to wire.
- `upsertLearnerInBrevoNoMatch` is called from exactly one place (`netlify-lead-router`). Grep-confirmed. The matched path (`upsertLearnerInBrevo`, used by `routing-confirm` etc.) is untouched.

## 3. What writes
- Brevo Contacts API only (`upsertBrevoContact`, already used everywhere). No DB writes added. Failures land in `leads.dead_letter` (newsletter branch: source `netlify_forms`) so nothing is silently lost — same no-data-lost rule as the lead path.

## 4. schema_version bump?
No. No Postgres schema change, no migration, no payload-contract change. `leads.submissions` is not written for newsletter signups.

## 5. Data migration / existing rows?
None automatic. Existing 28 consented waitlist contacts are already on the marketing list; they are NOT retro-added to list 10 by this change (it only fires on new submissions going forward). If Charlotte wants the existing 28 back-filled onto list 10, that's a one-off `admin-brevo-resync`-style data-op — flagged, not built here.

## 6. New scoped role / RLS?
No.

## 7. New env var (REQUIRED before deploy has any effect)
`BREVO_LIST_ID_SWITCHABLE_NEWSLETTER = 10` — set in Supabase → Edge Functions → Manage secrets. **Until set:** the newsletter branch dead-letters every signup (so they surface, not vanish) and the no_match path simply skips the newsletter list-add (existing behaviour unchanged). Deliberate: no silent drop on the form path, no breakage on the lead path.

## 8. Rollback plan
Revert the two edits (one branch in `netlify-lead-router/index.ts`, one list-add in `route-lead.ts`) and redeploy. Or, to disable without redeploy: unset `BREVO_LIST_ID_SWITCHABLE_NEWSLETTER` — newsletter signups then dead-letter (visible) and no_match reverts to marketing-list-only. No data to unwind.

## 9. Sign-off
PENDING. Owner sets the env var + runs `supabase functions deploy netlify-lead-router`. Sasha cannot deploy or set secrets.

## Cross-project note (Mable, switchable/site)
The `form-allowlist.json` entry for `switchable-blog-subscribers` still says "No webhook yet… Charlotte manually imports submissions." That's now stale — it's handled via the site-wide webhook + this router branch. Purpose text wants updating (doc-only, `webhook_url` stays `null` because it rides the site-wide webhook, not a per-form one).
