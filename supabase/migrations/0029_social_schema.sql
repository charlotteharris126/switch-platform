-- Migration 0029 — Social schema (Session G.1)
-- Date: 2026-04-26
-- Author: Claude (platform Session 10) with owner sign-off
-- Reason: Multi-brand organic social automation. Drafts, engagement targets, OAuth
--         tokens, post analytics. Designed multi-brand (SwitchLeads + Switchable) and
--         multi-channel (LinkedIn personal/company, Meta facebook/instagram, TikTok)
--         from day one — `(brand, channel)` is the unique posting surface key.
--
--         OAuth tokens are encrypted at rest via Supabase Vault (pgsodium-backed).
--         The migration enables the extension, then OAuth callback routes (Session
--         G.2) call `vault.create_secret()` to store ciphertext in `vault.secrets`,
--         retaining only the returned UUID on `social.oauth_tokens`. Edge Functions
--         decrypt via a dedicated SECURITY DEFINER helper (Session G.3) that
--         enforces an allowlist over which secret rows can be read; admin UI never
--         touches plaintext.
--
--         Build sequencing, UI page list, OAuth flow detail, Edge Function inventory,
--         push-notification implementation, and future-extensibility notes live in
--         `platform/docs/admin-dashboard-scoping.md` § Session G — this migration
--         implements only what `platform/docs/data-architecture.md` § "Schema: social"
--         describes.
--
--         RLS posture: admin only at this stage. Every table has RLS enabled with
--         deny-all-by-default; explicit `FOR ALL` policies grant access to
--         authenticated admin users via `admin.is_admin()` (the existing helper
--         from migration 0014). Views set `security_invoker = true` so they
--         inherit the underlying tables' RLS rather than bypassing it as the view
--         owner. Phase 4 may extend specific tables for provider-facing access;
--         not in scope for migration 0029.
--
--         Review notes (multi-agent 2026-04-26 in lieu of /ultrareview, which is
--         not available on the local Claude Code build):
--         - View `security_invoker = true` added (was missing — would have leaked
--           OAuth metadata via `vw_channel_status` to any authenticated user).
--         - View grants added (was missing — dashboard would have hit "permission
--           denied" on first load).
--         - Defensive `REVOKE ALL ON vault.decrypted_secrets FROM authenticated,
--           anon` added (belt-and-braces around Supabase's project-level default).
--         - DELETE removed from grants on `post_analytics` and `engagement_log`
--           (append-only tables; preserves audit trail).
--         - `post_analytics.draft_id` switched ON DELETE CASCADE → ON DELETE
--           RESTRICT to stop draft deletion silently erasing analytics history.
--         - `engagement_queue.expires_at` made NOT NULL with auto-default
--           (detected_at + 48h) so the active-queue view doesn't silently hide
--           rows with a NULL expiry.
--         - Idempotent `IF NOT EXISTS` / `OR REPLACE` / `DROP POLICY IF EXISTS`
--           on every object so a deploy retry doesn't leave the schema half-applied.
--         - Real executable DOWN block (drops every object) — schema is brand new
--           so reversal is safe and the rule §3 is satisfied.
--
-- Related: platform/docs/data-architecture.md § "Schema: social",
--          platform/docs/admin-dashboard-scoping.md § Session G,
--          platform/supabase/migrations/0014_admin_dashboard_read_access.sql (admin.is_admin()),
--          platform/supabase/migrations/0019_vault_helper_for_shared_secrets.sql (Vault precedent).

-- UP

-- =============================================================================
-- 0. Extensions + schema
-- =============================================================================

-- pgsodium provides the cryptographic primitives Supabase Vault sits on top of.
-- The `vault` schema (with `vault.secrets` + `vault.decrypted_secrets` view) is
-- created automatically by Supabase when pgsodium is enabled.
CREATE EXTENSION IF NOT EXISTS pgsodium;

-- pgcrypto powers gen_random_uuid() — already enabled in earlier migrations on
-- this Supabase project, but defensive enable here for portability/local dev.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS social;

GRANT USAGE ON SCHEMA social TO authenticated;

-- Defensive REVOKE: ensure no role outside the postgres/service_role pair can
-- read decrypted vault entries directly. Edge Functions read tokens through a
-- SECURITY DEFINER helper (added in Session G.3) that enforces an allowlist.
-- Admin UI never queries vault directly.
REVOKE ALL ON vault.decrypted_secrets FROM authenticated;
REVOKE ALL ON vault.decrypted_secrets FROM anon;

-- =============================================================================
-- 1. social.drafts
-- =============================================================================

CREATE TABLE IF NOT EXISTS social.drafts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  brand                       TEXT NOT NULL,
  channel                     TEXT NOT NULL,
  scheduled_for               TIMESTAMPTZ,
  status                      TEXT NOT NULL DEFAULT 'pending',
  content                     TEXT NOT NULL,
  pillar                      TEXT,
  hook_type                   TEXT,
  cron_batch_id               UUID,
  approved_by                 UUID REFERENCES auth.users(id),
  approved_at                 TIMESTAMPTZ,
  edit_history                JSONB,
  rejection_reason_category   TEXT,
  rejection_reason            TEXT,
  external_post_id            TEXT,
  published_at                TIMESTAMPTZ,
  publish_error               TEXT,
  schema_version              TEXT NOT NULL DEFAULT '1.0',
  CONSTRAINT social_drafts_brand_chk
    CHECK (brand IN ('switchleads', 'switchable')),
  CONSTRAINT social_drafts_channel_chk
    CHECK (channel IN ('linkedin_personal', 'linkedin_company', 'meta_facebook', 'meta_instagram', 'tiktok')),
  CONSTRAINT social_drafts_status_chk
    CHECK (status IN ('pending', 'approved', 'rejected', 'published', 'failed')),
  CONSTRAINT social_drafts_rejection_reason_required_chk
    CHECK (status <> 'rejected' OR rejection_reason_category IS NOT NULL),
  CONSTRAINT social_drafts_rejection_category_chk
    CHECK (rejection_reason_category IS NULL
           OR rejection_reason_category IN ('voice', 'topic_off', 'factual_wrong', 'duplicate', 'timing', 'other'))
);

CREATE INDEX IF NOT EXISTS social_drafts_brand_channel_status_idx
  ON social.drafts (brand, channel, status);
CREATE INDEX IF NOT EXISTS social_drafts_approved_scheduled_idx
  ON social.drafts (status, scheduled_for) WHERE status = 'approved';

COMMENT ON TABLE social.drafts IS
  'Content drafts in the review pipeline. Cron-generated by social-draft-generate (Mon + Thu); reviewed in /social/drafts; published by social-publish cron when status=approved AND scheduled_for <= now(). Multi-brand, multi-channel from day one.';

-- =============================================================================
-- 2. social.engagement_targets
-- =============================================================================

CREATE TABLE IF NOT EXISTS social.engagement_targets (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  added_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  brand                    TEXT NOT NULL,
  channel                  TEXT NOT NULL DEFAULT 'linkedin_personal',
  name                     TEXT NOT NULL,
  company                  TEXT,
  title                    TEXT,
  profile_url              TEXT NOT NULL,
  why_target               TEXT,
  posting_cadence_estimate TEXT,
  last_engaged_at          TIMESTAMPTZ,
  last_followed_back_at    TIMESTAMPTZ,
  status                   TEXT NOT NULL DEFAULT 'active',
  source                   TEXT,
  last_reviewed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes                    TEXT,
  CONSTRAINT social_targets_brand_chk
    CHECK (brand IN ('switchleads', 'switchable')),
  CONSTRAINT social_targets_channel_chk
    CHECK (channel IN ('linkedin_personal', 'linkedin_company', 'meta_facebook', 'meta_instagram', 'tiktok')),
  CONSTRAINT social_targets_status_chk
    CHECK (status IN ('active', 'retired', 'paused')),
  CONSTRAINT social_targets_brand_profile_uniq
    UNIQUE (brand, profile_url)
);

CREATE INDEX IF NOT EXISTS social_targets_brand_status_idx
  ON social.engagement_targets (brand, status);

COMMENT ON TABLE social.engagement_targets IS
  'Curated list of accounts to engage with. Brand = whose audience we are reaching via this engagement. Same person can legitimately be a target for both brands. last_reviewed_at drives the quarterly review trigger via vw_targets_due_review.';

-- =============================================================================
-- 3. social.engagement_queue
-- =============================================================================
-- expires_at is NOT NULL with auto-default of detected_at + 48 hours. The
-- active-queue view filter (`expires_at > now()`) silently drops NULLs, so
-- making the column NOT NULL with a default eliminates that gap.

CREATE TABLE IF NOT EXISTS social.engagement_queue (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  target_id            UUID NOT NULL REFERENCES social.engagement_targets(id) ON DELETE CASCADE,
  post_url             TEXT NOT NULL,
  post_preview         TEXT,
  detected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  drafted_comment      TEXT,
  status               TEXT NOT NULL DEFAULT 'pending',
  commented_at         TIMESTAMPTZ,
  notification_sent_at TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '48 hours'),
  CONSTRAINT social_queue_status_chk
    CHECK (status IN ('pending', 'commented', 'dismissed', 'expired'))
);

CREATE INDEX IF NOT EXISTS social_queue_status_detected_idx
  ON social.engagement_queue (status, detected_at);
CREATE INDEX IF NOT EXISTS social_queue_target_idx
  ON social.engagement_queue (target_id);

COMMENT ON TABLE social.engagement_queue IS
  'Specific posts to comment on this week. Populated by social-engagement-ingest Edge Function from forwarded LinkedIn notification emails. Brand inferred via JOIN to engagement_targets. Auto-expires 48h after detection.';

-- =============================================================================
-- 4. social.post_analytics
-- =============================================================================
-- ON DELETE RESTRICT on draft_id: deleting a published draft should not silently
-- destroy its analytics history. If a draft must be removed, analytics rows
-- need explicit cleanup first — that explicit step is the audit trail.

CREATE TABLE IF NOT EXISTS social.post_analytics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        UUID NOT NULL REFERENCES social.drafts(id) ON DELETE RESTRICT,
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  impressions     INT,
  reactions       INT,
  comments        INT,
  shares          INT,
  clicks          INT,
  follower_count  INT
);

CREATE INDEX IF NOT EXISTS social_analytics_draft_captured_idx
  ON social.post_analytics (draft_id, captured_at DESC);

COMMENT ON TABLE social.post_analytics IS
  'Time-series performance per published post. social-analytics-sync runs daily and pulls metrics for posts <30 days old. Brand inferred via JOIN to drafts. Append-only — DELETE not granted to authenticated.';

-- =============================================================================
-- 5. social.engagement_log
-- =============================================================================

CREATE TABLE IF NOT EXISTS social.engagement_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        UUID REFERENCES social.drafts(id) ON DELETE SET NULL,
  brand           TEXT NOT NULL,
  engager_name    TEXT NOT NULL,
  engager_company TEXT,
  engager_title   TEXT,
  engagement_type TEXT,
  is_icp          BOOLEAN NOT NULL DEFAULT false,
  notes           TEXT,
  tagged_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  tagged_by       UUID REFERENCES auth.users(id),
  CONSTRAINT social_log_brand_chk
    CHECK (brand IN ('switchleads', 'switchable')),
  CONSTRAINT social_log_engagement_type_chk
    CHECK (engagement_type IS NULL
           OR engagement_type IN ('comment', 'reaction', 'share', 'profile_view'))
);

CREATE INDEX IF NOT EXISTS social_log_brand_icp_idx
  ON social.engagement_log (brand, is_icp);

COMMENT ON TABLE social.engagement_log IS
  'Manual ICP tagging of engagers (until volume justifies automation). brand denormalised here for easier filtering — set on insert from the joined drafts row. Append-only — DELETE not granted to authenticated.';

-- =============================================================================
-- 6. social.oauth_tokens
-- =============================================================================
--
-- Tokens themselves live encrypted in vault.secrets. This table holds metadata +
-- a UUID reference (access_token_secret_id, refresh_token_secret_id) to the
-- vault row. The OAuth callback route (Session G.2) calls vault.create_secret()
-- with the raw token at insert time and stores the returned UUID here. Edge
-- Functions read decrypted via a SECURITY DEFINER helper (Session G.3) that
-- enforces an allowlist over the secret_id columns of this table; admin UI
-- never surfaces raw tokens.

CREATE TABLE IF NOT EXISTS social.oauth_tokens (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand                    TEXT NOT NULL,
  channel                  TEXT NOT NULL,
  provider                 TEXT NOT NULL,
  external_account_id      TEXT,
  access_token_secret_id   UUID NOT NULL,
  refresh_token_secret_id  UUID,
  expires_at               TIMESTAMPTZ,
  scopes                   TEXT[],
  last_refreshed_at        TIMESTAMPTZ,
  authorised_by            UUID REFERENCES auth.users(id),
  authorised_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT social_oauth_brand_chk
    CHECK (brand IN ('switchleads', 'switchable')),
  CONSTRAINT social_oauth_channel_chk
    CHECK (channel IN ('linkedin_personal', 'linkedin_company', 'meta_facebook', 'meta_instagram', 'tiktok')),
  CONSTRAINT social_oauth_provider_chk
    CHECK (provider IN ('linkedin', 'meta', 'tiktok')),
  CONSTRAINT social_oauth_brand_channel_uniq
    UNIQUE (brand, channel)
);

COMMENT ON TABLE social.oauth_tokens IS
  'Per-(brand, channel) OAuth metadata. access_token_secret_id and refresh_token_secret_id reference vault.secrets rows where the actual ciphertext lives. (brand, channel) is the unique posting surface key. The owner''s personal LinkedIn token can be reused across brands by inserting a second row pointing to the same vault secret.';

-- =============================================================================
-- 7. social.push_subscriptions
-- =============================================================================

CREATE TABLE IF NOT EXISTS social.push_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL,
  keys_p256dh  TEXT NOT NULL,
  keys_auth    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT social_push_user_endpoint_uniq
    UNIQUE (user_id, endpoint)
);

COMMENT ON TABLE social.push_subscriptions IS
  'Web Push subscriptions per admin user. Used by social-engagement-ingest to send notifications when a target posts. Cascade-delete on user removal.';

-- =============================================================================
-- 8. Views
-- =============================================================================
-- Every view sets `security_invoker = true` so it runs with the caller's
-- privileges and inherits the underlying table's RLS. Without this flag, views
-- run as their owner (postgres) and bypass RLS entirely — that would be a leak
-- path for vw_channel_status (OAuth metadata) and the others.

CREATE OR REPLACE VIEW social.vw_pending_drafts
  WITH (security_invoker = true) AS
  SELECT * FROM social.drafts
   WHERE status = 'pending'
   ORDER BY brand, scheduled_for NULLS LAST;

COMMENT ON VIEW social.vw_pending_drafts IS
  'Drafts awaiting review, brand-grouped, oldest-scheduled first. Drives /social/drafts.';

CREATE OR REPLACE VIEW social.vw_post_performance
  WITH (security_invoker = true) AS
  SELECT d.id, d.brand, d.channel, d.pillar, d.content, d.published_at,
         MAX(pa.impressions)                          AS latest_impressions,
         MAX(pa.reactions + pa.comments + pa.shares)  AS latest_engagement
    FROM social.drafts d
    LEFT JOIN social.post_analytics pa ON pa.draft_id = d.id
   WHERE d.status = 'published'
   GROUP BY d.id;

COMMENT ON VIEW social.vw_post_performance IS
  'Per-post latest performance snapshot. Drives /social/published and feeds the Monday performance review.';

CREATE OR REPLACE VIEW social.vw_engagement_queue_active
  WITH (security_invoker = true) AS
  SELECT q.id, q.post_url, q.post_preview, q.drafted_comment, q.detected_at,
         t.brand, t.name AS target_name, t.company AS target_company,
         t.profile_url AS target_profile_url
    FROM social.engagement_queue q
    JOIN social.engagement_targets t ON t.id = q.target_id
   WHERE q.status = 'pending' AND q.expires_at > now()
   ORDER BY q.detected_at DESC;

COMMENT ON VIEW social.vw_engagement_queue_active IS
  'Live engagement queue (not commented, not expired). Drives /social/queue (mobile-first).';

CREATE OR REPLACE VIEW social.vw_targets_due_review
  WITH (security_invoker = true) AS
  SELECT * FROM social.engagement_targets
   WHERE status = 'active'
     AND last_reviewed_at < now() - INTERVAL '90 days';

COMMENT ON VIEW social.vw_targets_due_review IS
  'Engagement targets due quarterly review. Drives the /social/targets badge and the social-targets-quarterly-flag cron.';

CREATE OR REPLACE VIEW social.vw_rejection_patterns
  WITH (security_invoker = true) AS
  SELECT brand, rejection_reason_category, COUNT(*) AS reject_count,
         DATE_TRUNC('week', updated_at) AS week
    FROM social.drafts
   WHERE status = 'rejected'
   GROUP BY brand, rejection_reason_category, week
   ORDER BY week DESC, reject_count DESC;

COMMENT ON VIEW social.vw_rejection_patterns IS
  'Reject-reason rollup by week. Feeds the next social-draft-generate cycle so the prompt adjusts for recurring rejection categories.';

CREATE OR REPLACE VIEW social.vw_channel_status
  WITH (security_invoker = true) AS
  SELECT brand, channel, provider, external_account_id, expires_at,
         CASE
           WHEN expires_at IS NULL                            THEN 'no_expiry'
           WHEN expires_at > now() + INTERVAL '7 days'        THEN 'healthy'
           WHEN expires_at > now()                            THEN 'expiring_soon'
           ELSE 'expired'
         END AS health_status
    FROM social.oauth_tokens
   ORDER BY brand, channel;

COMMENT ON VIEW social.vw_channel_status IS
  'Per-(brand, channel) OAuth token health. Drives the /social/settings health badges and surfaces tokens needing reconnect.';

-- =============================================================================
-- 9. RLS — admin only at this stage
-- =============================================================================
-- Every table: RLS enabled, deny-all default, explicit admin policies for
-- SELECT + INSERT + UPDATE + DELETE via admin.is_admin(). Phase 4 may extend
-- specific tables for provider-facing access; not in scope here.
--
-- Append-only tables (post_analytics, engagement_log) ship without DELETE in
-- their grants — see section 10. The RLS policy is permissive across all
-- actions; the absence of the underlying GRANT enforces append-only at the
-- privilege layer.
--
-- DROP POLICY IF EXISTS guards make the migration idempotent. ON ENABLE is a
-- no-op if RLS is already on. Same for the policy creation logic.

ALTER TABLE social.drafts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE social.engagement_targets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE social.engagement_queue      ENABLE ROW LEVEL SECURITY;
ALTER TABLE social.post_analytics        ENABLE ROW LEVEL SECURITY;
ALTER TABLE social.engagement_log        ENABLE ROW LEVEL SECURITY;
ALTER TABLE social.oauth_tokens          ENABLE ROW LEVEL SECURITY;
ALTER TABLE social.push_subscriptions    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_all_drafts                ON social.drafts;
DROP POLICY IF EXISTS admin_all_engagement_targets    ON social.engagement_targets;
DROP POLICY IF EXISTS admin_all_engagement_queue      ON social.engagement_queue;
DROP POLICY IF EXISTS admin_all_post_analytics        ON social.post_analytics;
DROP POLICY IF EXISTS admin_all_engagement_log        ON social.engagement_log;
DROP POLICY IF EXISTS admin_all_oauth_tokens          ON social.oauth_tokens;
DROP POLICY IF EXISTS admin_own_push_subscriptions    ON social.push_subscriptions;

CREATE POLICY admin_all_drafts ON social.drafts
  FOR ALL TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

CREATE POLICY admin_all_engagement_targets ON social.engagement_targets
  FOR ALL TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

CREATE POLICY admin_all_engagement_queue ON social.engagement_queue
  FOR ALL TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

CREATE POLICY admin_all_post_analytics ON social.post_analytics
  FOR ALL TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

CREATE POLICY admin_all_engagement_log ON social.engagement_log
  FOR ALL TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

CREATE POLICY admin_all_oauth_tokens ON social.oauth_tokens
  FOR ALL TO authenticated
  USING (admin.is_admin())
  WITH CHECK (admin.is_admin());

CREATE POLICY admin_own_push_subscriptions ON social.push_subscriptions
  FOR ALL TO authenticated
  USING (admin.is_admin() AND user_id = auth.uid())
  WITH CHECK (admin.is_admin() AND user_id = auth.uid());

-- =============================================================================
-- 10. Grants
-- =============================================================================
-- Table-level grants. RLS policies above filter rows; without these grants
-- Postgres rejects the query before RLS runs.
--
-- post_analytics + engagement_log are append-only (audit-relevant): SELECT,
-- INSERT, UPDATE granted; DELETE deliberately not granted. The RLS policy
-- would otherwise allow it; the missing privilege is the second line of
-- defence. Together: an admin can record a row, correct typos via UPDATE, but
-- cannot DELETE history.
--
-- Views: explicit GRANT SELECT — required because views are separate objects
-- from their backing tables. Without these, every view-based dashboard query
-- returns "permission denied for view".

GRANT SELECT, INSERT, UPDATE, DELETE ON social.drafts             TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON social.engagement_targets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON social.engagement_queue   TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON social.post_analytics     TO authenticated;
GRANT SELECT, INSERT, UPDATE         ON social.engagement_log     TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON social.oauth_tokens       TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON social.push_subscriptions TO authenticated;

GRANT SELECT ON social.vw_pending_drafts          TO authenticated;
GRANT SELECT ON social.vw_post_performance        TO authenticated;
GRANT SELECT ON social.vw_engagement_queue_active TO authenticated;
GRANT SELECT ON social.vw_targets_due_review      TO authenticated;
GRANT SELECT ON social.vw_rejection_patterns      TO authenticated;
GRANT SELECT ON social.vw_channel_status          TO authenticated;

-- =============================================================================
-- 11. Migration summary
-- =============================================================================

DO $$
DECLARE
  v_table_count INT;
  v_view_count  INT;
  v_policy_count INT;
BEGIN
  SELECT COUNT(*) INTO v_table_count
    FROM information_schema.tables
   WHERE table_schema = 'social' AND table_type = 'BASE TABLE';
  SELECT COUNT(*) INTO v_view_count
    FROM information_schema.views
   WHERE table_schema = 'social';
  SELECT COUNT(*) INTO v_policy_count
    FROM pg_policies
   WHERE schemaname = 'social';
  RAISE NOTICE 'social schema created: % tables, % views, % RLS policies',
    v_table_count, v_view_count, v_policy_count;
END $$;

-- DOWN
-- -- Reversible: schema is brand new with no data dependencies outside its own
-- -- tables. Dropping the social namespace cleanly reverses this migration.
-- -- Vault entries created by Session G.2's OAuth flow live in vault.secrets and
-- -- need separate cleanup if those have run before this DOWN is invoked.
-- --
-- DROP VIEW  IF EXISTS social.vw_channel_status;
-- DROP VIEW  IF EXISTS social.vw_rejection_patterns;
-- DROP VIEW  IF EXISTS social.vw_targets_due_review;
-- DROP VIEW  IF EXISTS social.vw_engagement_queue_active;
-- DROP VIEW  IF EXISTS social.vw_post_performance;
-- DROP VIEW  IF EXISTS social.vw_pending_drafts;
-- DROP TABLE IF EXISTS social.push_subscriptions;
-- DROP TABLE IF EXISTS social.oauth_tokens;
-- DROP TABLE IF EXISTS social.engagement_log;
-- DROP TABLE IF EXISTS social.post_analytics;
-- DROP TABLE IF EXISTS social.engagement_queue;
-- DROP TABLE IF EXISTS social.engagement_targets;
-- DROP TABLE IF EXISTS social.drafts;
-- REVOKE USAGE ON SCHEMA social FROM authenticated;
-- DROP SCHEMA IF EXISTS social;
-- -- pgsodium + pgcrypto extensions left enabled — other schemas may rely on them.
-- -- vault.decrypted_secrets revokes left in place — defensive baseline either way.
