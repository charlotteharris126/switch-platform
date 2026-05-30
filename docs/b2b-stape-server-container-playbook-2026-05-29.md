# B2B Stape Server Container (`GTM-P4KGSWSB`) — click-through playbook

Created by Sasha 2026-05-29 in response to Solis audit `switchable/ads-business/docs/b2b-pixel-pipeline-audit-2026-05-29.md` Step 3 (S-1 and S-2 in Sasha's handoff).

**For Charlotte to execute** in two parts: DNS + Stape dashboard (Sasha cannot click). This doc is precise enough that following row-by-row produces the correct end state. No DB change, no migration, no schema bump — this work sits outside Postgres governance entirely.

**Estimated time:** 30-45 minutes including DNS propagation wait.

**Prerequisites:** none on the platform side. Sasha has confirmed there is no Edge Function dependency, no migration to ship, no impact-assessment doc required under `.claude/rules/data-infrastructure.md` (this is dashboard infrastructure, not the business data layer).

---

## Part A — Provision the custom subdomain (S-1)

### A1 — Decide the hostname

Recommended: **`b2b-capi.switchable.org.uk`**

Reasoning: keeps both server endpoints under the Switchable umbrella; mirrors the existing B2C pattern (an owned subdomain rather than the default Stape-supplied one); makes future Cookiebot and privacy-policy disclosure easier because both pixels resolve under the company domain. Alternative names like `business.stape.net` or `capi-b2b.switchable.org.uk` work too — pick one and stay consistent.

### A2 — Open Stape, request the custom domain

1. Log in to Stape → Containers → `GTM-P4KGSWSB` (the B2B server container).
2. Open the container's Settings → Custom Domain (or Domain) section.
3. Enter `b2b-capi.switchable.org.uk`.
4. Stape generates a CNAME target — typically of the form `XXXX.eue.stape.net` or similar. Copy that target.

### A3 — Add the CNAME at the registrar

The Switchable DNS is on (per `accounts-legal/` notes for the Switchable brand) the same registrar handling `switchable.org.uk`. Confirm by opening `accounts-legal/docs/current-handoff.md` or asking Clara if unclear.

1. Log in to the registrar → DNS records for `switchable.org.uk`.
2. Add a new CNAME record:
   - Host / Name: `b2b-capi`
   - Type: `CNAME`
   - Target / Value: the Stape-generated target from A2.4
   - TTL: 3600 (or default)
3. Save.

### A4 — Wait for propagation, then verify in Stape

DNS CNAME propagation typically completes within 5-30 minutes but can take up to 24 hours.

Verify locally:

```bash
dig b2b-capi.switchable.org.uk CNAME +short
```

Should return the Stape target. Or use https://dnschecker.org/ if no terminal access.

Once propagated, return to Stape → `GTM-P4KGSWSB` → Custom Domain. Stape should show the domain as **Active** (green) with SSL provisioned automatically.

If after 30 minutes Stape still shows "Pending DNS verification" while `dig` confirms the record is live, force-refresh in Stape (sometimes their cache lags) and contact Stape support if needed.

### A5 — Update the Cookiebot consent scope (privacy-policy sanity check)

The Switchable privacy policy (Notion `b513628f-e4a2-8294-9da2-01b2a44fb9ce`) lists data sharing with Meta as part of marketing-cookie consent. Since `b2b-capi.switchable.org.uk` is the same legal entity as `switchable.org.uk`, no new disclosure is needed — the existing "we share hashed contact data with Meta for advertising attribution" clause covers it. No Clara coordination required for this change. Logged here for the record.

---

## Part B — Configure the CAPI tags inside the server container (S-2)

Once Part A is complete and the custom subdomain is Active in Stape, log in to Google Tag Manager via the Stape interface (Stape gives you a GTM-style interface for the server container).

Open container `GTM-P4KGSWSB` in the GTM UI.

### B1 — Verify the Facebook (Meta) tag template is installed

Stape Power Up: the Facebook Conversions API tag template lives in the Community Template Gallery. Open Tag Templates → Search Gallery → search "Facebook Conversions API". If not already installed, add it. Permission scopes will prompt: accept them.

### B2 — Create the Lead CAPI tag

Tag name: `[B2B] Meta CAPI - Lead`

Tag type: Facebook Conversions API (community template).

Configuration (cross-reference `switchable/site/docs/tracking-emq-capi.md` § "B2B-specific overrides" → § "Field deltas (against the B2C Tag 1: Meta — Lead table)"):

| Field | Value |
|---|---|
| API Access Token | the B2B pixel's CAPI access token (Meta Events Manager → B2B pixel → Settings → Conversions API → Generate access token) — store in Stape's Secret Manager, do NOT paste in plaintext |
| Pixel ID | the B2B Meta pixel ID (NOT the B2C pixel ID — verify in Events Manager which is which) |
| Test Event Code | leave blank in production; use a test code only during the Step 8 verification cycle and remove after |
| Event Name | `Lead` |
| Event ID | `{{Event Data — event_id}}` (NOT `external_id` — these are different fields) |
| Action Source | `website` |
| Event Source URL | `{{Page URL}}` |
| Custom Data → `content_category` | `{{Event Data — lead_route}}` (will carry `employer_lead` for v1 Riverside) |
| Custom Data → `value` | `400` (universal across B2B routes — hardcoded fine here, no per-route variance) |
| Custom Data → `currency` | `GBP` |
| Custom Data → `audience` | `employer` |
| User Data → `em` | `{{Event Data — user_data.em}}` |
| User Data → `ph` | `{{Event Data — user_data.ph}}` |
| User Data → `fn` | `{{Event Data — user_data.fn}}` |
| User Data → `ln` | `{{Event Data — user_data.ln}}` |
| User Data → `zp` | `{{Event Data — user_data.zp}}` |
| User Data → `country` | `{{Event Data — user_data.country}}` |
| User Data → `external_id` | `{{Event Data — external_id}}` (NOT `event_id` — see canonical doc) |
| User Data → `client_ip_address` | LEAVE BLANK — tag template auto-populates from server request |
| User Data → `client_user_agent` | LEAVE BLANK — tag template auto-populates from server request |
| User Data → `Click ID` (fbc) | **LEAVE BLANK.** Do NOT map `{{Cookie - _fbc}}` here. See canonical doc for the resolution-chain rationale. |
| User Data → `Browser ID` (fbp) | LEAVE BLANK. Same auto-resolution chain. |

Trigger: a custom trigger on the Custom Event `generate_lead` where `lead_route` equals `employer_lead`. Create the trigger in the server container (NOT the web container — they are separate Tag Manager environments).

### B3 — Create the ViewContent CAPI tag (optional v2)

Tag name: `[B2B] Meta CAPI - ViewContent`

Same template as B2. Configuration deltas:

| Field | Value |
|---|---|
| Event Name | `ViewContent` |
| Custom Data → `content_category` | `employer_lead` (or `{{Event Data — lead_route}}` once other B2B routes activate) |
| Custom Data → `audience` | `employer` |
| Custom Data → `content_ids` | `{{Event Data — content_ids}}` (array, if any B2B page emits ViewContent) |
| Custom Data → `content_name` | `{{Event Data — content_name}}` |
| Custom Data → `content_type` | `product` |
| User Data → fields above | same shape as B2; no PII to send because the user hasn't submitted a form yet at ViewContent stage — IP + UA + fbc + fbp via auto-resolution |

Trigger: Custom Event `view_content` (no `lead_route` filter — ViewContent fires before any form data exists).

If no B2B page currently emits `view_content` (current state as of 2026-05-29), skip B3 entirely. Add later when sector pages or the Riverside catalogue browse fires ViewContent.

### B4 — Preview and verify

1. In the server container's GTM, click **Preview**. The Tag Assistant opens, but for sGTM containers it shows incoming requests instead of page loads.
2. From a fresh incognito browser, visit `https://switchable.org.uk/business/construction/` and submit a test lead.
3. The web container (`GTM-TFTFPL6Q`, Mable's M-2) should forward the events to `b2b-capi.switchable.org.uk`. Tag Assistant for the server container shows the incoming request.
4. Verify:
   - Lead event request received at the server endpoint
   - `[B2B] Meta CAPI - Lead` tag fires
   - The tag's outgoing request to Meta succeeds (200 OK) — visible in the tag's preview pane
5. If anything fails: check Event ID mapping, check the Custom Event trigger name matches what the web container is sending, check the API access token is valid.

### B5 — Publish

Top-right of the server container GTM. Version name: `b2b-pipeline-init-2026-05-29`. Version description: `Initial B2B CAPI tags for Meta — Lead + ViewContent. Reads from custom subdomain b2b-capi.switchable.org.uk. Field mappings per switchable/site/docs/tracking-emq-capi.md § B2B-specific overrides.`

Publish.

---

## Part C — Post-fix verification (S-3)

Coordinate this part with Mable (M-2 publish must be done) and Solis (Step 8 of audit doc).

### C1 — Test events in Meta Events Manager

Open Meta Events Manager → B2B pixel → Test Events tab. From a fresh incognito browser, submit a B2B test lead. Within seconds, you should see:

- One Lead event row
- Both "Browser" AND "Server" badges on the row
- Deduplicated indicator (this is what `event_id` matching produces)

If two separate Lead events appear instead of one deduped row, the `event_id` mapping is wrong somewhere in the chain (web container Lead tag → dataLayer → server container CAPI tag). Common cause: server tag has Event ID mapped to `{{Event Data — external_id}}` by mistake. The canonical doc warns about this specifically.

### C2 — Verification SQL (Solis uses this from Postgres MCP)

Once test events are confirmed in Meta, the next 24 hours of real lead traffic should show server-side CAPI events flowing. Solis can verify the pipeline is alive by counting recent B2B leads in the DB and cross-checking against the Stape dashboard's request count:

```sql
-- Pipeline health check, B2B side
-- Counts B2B Employer Leads landed in the DB in the last 24h.
-- Cross-check this against the Stape dashboard for GTM-P4KGSWSB
-- request count over the same window. They should match within a small
-- margin (Lead events 1:1, plus a multiplier for PageView events ~10-50x).
SELECT
  DATE_TRUNC('hour', submitted_at AT TIME ZONE 'Europe/London') AS hour_london,
  COUNT(*) FILTER (WHERE form_name = 's4b-employer-lead-v1')             AS b2b_leads,
  COUNT(*) FILTER (WHERE form_name = 's4b-employer-lead-v1' AND parent_submission_id IS NULL) AS b2b_parent_leads,
  MAX(submitted_at AT TIME ZONE 'Europe/London') AS most_recent_lead
FROM leads.submissions
WHERE submitted_at >= NOW() - INTERVAL '24 hours'
  AND submitted_at < NOW()
GROUP BY 1
ORDER BY 1 DESC;
```

### C3 — Week-1 health re-check

Seven days after Step 8 verification, pull the Browser-vs-Server event split from Meta Events Manager → B2B pixel → Overview. Server count should be tracking Browser count, indicating the CAPI is doing its job.

If Server stays at single digits while Browser is in the dozens, something in the pipeline is still broken downstream of the test-event success. Re-audit the tag triggers and the dataLayer push fields.

---

## Part D — Forward-looking (S-4): Stape free-tier ceiling

`GTM-P4KGSWSB` is currently on Stape's free tier (10,000 requests / month). Cold-start volume sits at 599 requests / 19 days (5% utilisation). Post-fix volume will rise 10-30x.

Conservative model assuming:
- 17 paid leads / 6 days = ~85 leads / month at current spend
- PageView events at ~30x Lead volume (typical for a healthy funnel) = ~2550 PageViews / month
- ViewContent (if v2 ships) at 5-10x Lead volume = ~500 ViewContent / month
- Total: ~3,100 server events / month post-fix at current spend
- 31% utilisation at current ad spend

At 3x ad spend (the Phase 1 acceleration plan):
- ~9,300 server events / month
- 93% utilisation — bumps the ceiling

Watch utilisation in Solis's weekly notes once the pipeline is live. Flag to Charlotte at 70% sustained utilisation. Upgrade path: Stape paid plan (~£20-30/month for 100,000 events) is the obvious next step.

---

## Companion docs

- `switchable/ads-business/docs/b2b-pixel-pipeline-audit-2026-05-29.md` (Solis audit, source of truth, 9-step plan)
- `switchable/site/docs/tracking-emq-capi.md` § "B2B-specific overrides" (canonical CAPI config — this playbook's B2B field tables mirror that doc)
- `switchable/ads-business/docs/gtm-web-container-b2b-playbook-2026-05-29.md` (Mable's web-container playbook — must land in the same publish window as this server-container playbook)
- `switchable/ads-business/docs/gtm-web-container-tag-inventory-2026-05-29.md` (Mable's inventory artefact — needs filling in BEFORE the web-container playbook runs)
