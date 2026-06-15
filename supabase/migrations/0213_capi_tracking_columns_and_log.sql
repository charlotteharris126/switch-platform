-- Migration 0213 — server-side Meta CAPI: tracking columns + send log
-- Date: 2026-06-15
-- Author: Claude (Sasha session) on Charlotte's direction
-- Reason: Add an owned, monitored server-side Conversions API path for the Lead
--   event, both brands (B2C netlify-lead-router, B2B netlify-employer-lead-router).
--   The browser pixel + Stape sGTM path is unmonitored and silently dropped B2B
--   server events. This migration persists the dedup/identity fields the routers
--   already receive but currently discard, and adds a per-send audit log so a
--   daily reconcile can alarm on any gap.
-- Related: platform/docs/capi-server-side-scoping-2026-06-15.md (full plan),
--   switchable/site/deploy/deploy/js/meta-dedup.js (already injects event_id/fbp/fbc
--   as hidden form inputs), _shared/meta-capi.ts (to be added),
--   netlify-lead-router / netlify-employer-lead-router (to read the new fields),
--   capi-reconcile-daily (to be added).
-- Impact assessment:
--   - Changes: 3 additive nullable columns on leads.submissions
--     (event_id, fbp, fbc) + 1 new table leads.capi_log. Additive only.
--   - schema_version: no bump (additive, per schema-versioning rule).
--   - Consumers: nothing reads these columns/table today; n8n / admin / agents
--     unaffected. capi_log is write-only from Edge Functions for now.
--   - Grants: column-level INSERT/UPDATE to functions_writer for the 3 columns
--     (mirrors migration 0018's funding_category pattern — submissions uses
--     column-level grants, not table-wide). functions_writer gets INSERT/SELECT
--     on capi_log + USAGE on its sequence.
--   - Deploy order: this migration FIRST, then the router redeploys that read
--     event_id/fbp/fbc and write capi_log, so an INSERT never references an
--     ungranted column.
--   - Rollback: DOWN below; safe (no other object depends on these).
--   - Sign-off: Charlotte (this session).

-- UP

-- 1. Dedup + identity fields the routers already receive (meta-dedup.js hidden
--    inputs) but drop. event_id is the browser<->server dedup key.
ALTER TABLE leads.submissions
  ADD COLUMN IF NOT EXISTS event_id TEXT,
  ADD COLUMN IF NOT EXISTS fbp      TEXT,
  ADD COLUMN IF NOT EXISTS fbc      TEXT;

GRANT SELECT, INSERT, UPDATE (event_id) ON leads.submissions TO functions_writer;
GRANT SELECT, INSERT, UPDATE (fbp)      ON leads.submissions TO functions_writer;
GRANT SELECT, INSERT, UPDATE (fbc)      ON leads.submissions TO functions_writer;

-- 2. Per-send audit log. One row per CAPI Lead send attempt, both brands.
--    A successful row = events_received >= 1 with a 2xx http_status.
CREATE TABLE IF NOT EXISTS leads.capi_log (
  id              BIGSERIAL PRIMARY KEY,
  submission_id   BIGINT REFERENCES leads.submissions(id) ON DELETE SET NULL,
  brand           TEXT NOT NULL CHECK (brand IN ('b2c', 'b2b')),
  pixel_id        TEXT NOT NULL,
  event_name      TEXT NOT NULL DEFAULT 'Lead',
  event_id        TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  http_status     INTEGER,
  events_received INTEGER,
  fbtrace_id      TEXT,
  error_body      TEXT,
  raw_response    JSONB
);

CREATE INDEX IF NOT EXISTS capi_log_submission_id_idx ON leads.capi_log (submission_id);
CREATE INDEX IF NOT EXISTS capi_log_sent_at_idx       ON leads.capi_log (sent_at);

GRANT SELECT, INSERT ON leads.capi_log TO functions_writer;
GRANT USAGE, SELECT ON SEQUENCE leads.capi_log_id_seq TO functions_writer;

-- DOWN (manual; only safe once no consumer depends on the above)
-- DROP TABLE IF EXISTS leads.capi_log;
-- ALTER TABLE leads.submissions
--   DROP COLUMN IF EXISTS event_id,
--   DROP COLUMN IF EXISTS fbp,
--   DROP COLUMN IF EXISTS fbc;
