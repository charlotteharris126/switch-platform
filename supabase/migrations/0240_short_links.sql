-- Migration 0240 — leads.short_links (pretty short-link mapping)
-- Date: 2026-08-04
-- Author: Claude (Sasha/platform session) with owner sign-off
-- Reason: pretty links. The fastrack URL sent in SMS + email
--   (switchable.org.uk/funded/thank-you/?ref=<uuid>&course=<slug>&m=1) is long
--   and reads as spammy. Replace with switchable.org.uk/go/<code>, where <code>
--   is a short unguessable code mapping to a submission. This table holds the
--   code -> submission mapping; the go-resolve EF looks it up and 302s to the
--   full thank-you URL; a site /go/<code> route (switchable/site, Mable) fronts
--   it. One code per (submission, kind) so re-sends reuse the same link.
-- Impact (§8): new additive table. Producer = _shared/short-link.ts mintShortLink
--   (called from buildFastrackUrl once the emit is flipped — NOT yet). Consumer
--   = go-resolve EF. No existing consumer. RLS on. Reversible (DOWN drops table).

-- UP
CREATE TABLE IF NOT EXISTS leads.short_links (
  code           TEXT PRIMARY KEY,
  submission_id  BIGINT NOT NULL REFERENCES leads.submissions(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'fastrack',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submission_id, kind)
);
CREATE INDEX IF NOT EXISTS short_links_submission_id_idx ON leads.short_links (submission_id);

ALTER TABLE leads.short_links ENABLE ROW LEVEL SECURITY;

-- Edge Functions (functions_writer): mint (insert) + resolve (select).
GRANT SELECT, INSERT ON leads.short_links TO functions_writer;
CREATE POLICY functions_all_short_links ON leads.short_links
  FOR ALL TO functions_writer
  USING (true) WITH CHECK (true);

-- Reporting: code + submission_id are low-sensitivity mapping rows (no direct PII).
GRANT SELECT ON leads.short_links TO readonly_analytics;
CREATE POLICY analytics_read_short_links ON leads.short_links
  FOR SELECT TO readonly_analytics
  USING (true);

-- DOWN
-- DROP TABLE leads.short_links;
