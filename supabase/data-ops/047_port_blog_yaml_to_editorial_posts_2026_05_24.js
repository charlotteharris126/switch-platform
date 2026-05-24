#!/usr/bin/env node
/* eslint-disable no-console */
//
// 047_port_blog_yaml_to_editorial_posts_2026_05_24.js
//
// One-shot data-ops port of the 4 launch-set blog drafts from YAML files
// under switchable/site/deploy/data/posts/ into editorial.posts (migration
// 0163). Idempotent: skips any slug that already exists in the table.
// Tag relations land via editorial.post_tags using the tag slug → id map
// from editorial.tags (seeded with 16 rows in migration 0163).
//
// Usage:
//   DATABASE_URL=postgres://… node \
//     platform/supabase/data-ops/047_port_blog_yaml_to_editorial_posts_2026_05_24.js
//
// Charlotte runs this once on her machine. The 4 source YAMLs stay in place
// until the next platform session flips scripts/build-blog-posts.js from
// YAML→DB read. After that flip lands, move/delete the YAML files.
//
// Reason for porting now (before the build flip): unblocks Charlotte to edit
// the 4 drafts in /admin/blog/[slug]/edit immediately. The CMS UI is the
// source of truth for editing going forward; the YAML files become read-only
// historic copies until the flip removes them.
//
// Related:
//   platform/supabase/migrations/0163_editorial_schema_blog_cms.sql
//   platform/supabase/migrations/0165_editorial_post_ideas.sql
//   switchable/site/docs/current-handoff.md Session 72 (Mable's PUSH)
//   platform/docs/changelog.md 2026-05-24 entry (Phase 2 CMS MVP)

const fs   = require('fs');
const path = require('path');

// Lazy-require dependencies that live in switchable/site/deploy so this
// script runs without needing a postgres dep in platform/. Charlotte runs
// it from the switchable/site/deploy directory or with NODE_PATH set.
let yaml, postgres;
try {
  yaml = require('js-yaml');
  postgres = require('postgres');
} catch {
  console.error(
    "Could not load js-yaml + postgres. Run this from " +
    "switchable/site/deploy where both are installed, e.g.:\n" +
    "  cd switchable/site/deploy && DATABASE_URL=… node \\\n" +
    "    ../../../platform/supabase/data-ops/047_port_blog_yaml_to_editorial_posts_2026_05_24.js"
  );
  process.exit(1);
}

const POSTS_DIR = path.resolve(
  __dirname,
  '..', '..', '..',
  'switchable', 'site', 'deploy', 'data', 'posts',
);

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL env var is required.");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 5, prepare: false });

async function main() {
  if (!fs.existsSync(POSTS_DIR)) {
    console.error(`Posts directory not found: ${POSTS_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(POSTS_DIR)
    .filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();

  console.log(`Found ${files.length} YAML files in ${POSTS_DIR}`);

  // Pre-load tag slug → id map. Migration 0163 seeded 16 tags; only those
  // resolve. Unknown slugs in YAMLs are logged and skipped (Charlotte can
  // create them later via /admin/blog/tags when that page lands).
  const tagRows = await sql`SELECT id, slug FROM editorial.tags`;
  const tagIdBySlug = new Map();
  for (const row of tagRows) tagIdBySlug.set(row.slug, row.id);

  let ported = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const filePath = path.join(POSTS_DIR, file);
    let parsed;
    try {
      parsed = yaml.load(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error(`  ✗ ${file}: YAML parse failed — ${err.message}`);
      failed++;
      continue;
    }

    if (!parsed || !parsed.slug || !parsed.title) {
      console.error(`  ✗ ${file}: missing slug or title`);
      failed++;
      continue;
    }

    const slug = String(parsed.slug).trim();
    const existing = await sql`SELECT id FROM editorial.posts WHERE slug = ${slug} LIMIT 1`;
    if (existing.length > 0) {
      console.log(`  – ${slug}: already in DB, skipping`);
      skipped++;
      continue;
    }

    const body = typeof parsed.body === 'string' ? parsed.body : '';
    const readingTime =
      parsed.reading_time_minutes
        || Math.max(1, Math.round(body.trim().split(/\s+/).filter(Boolean).length / 220));

    const status = ['draft', 'scheduled', 'published', 'archived'].includes(parsed.status)
      ? parsed.status
      : 'draft';

    try {
      const [inserted] = await sql`
        INSERT INTO editorial.posts (
          slug, title, dek, excerpt, body,
          category_id, status, publish_date, reading_time_minutes,
          cover_image_url, cover_image_alt, featured, lead_magnet_enabled,
          meta_title, meta_description, og_title, og_description, og_image_url,
          canonical_url, target_keywords, internal_links, related_courses, end_cta
        ) VALUES (
          ${slug},
          ${String(parsed.title)},
          ${parsed.dek ? String(parsed.dek) : null},
          ${parsed.excerpt ? String(parsed.excerpt) : null},
          ${body},
          ${parsed.category || null},
          ${status},
          ${parsed.publish_date ? String(parsed.publish_date) : null},
          ${readingTime},
          ${parsed.cover_image || null},
          ${parsed.cover_image_alt || null},
          ${parsed.featured === true},
          ${parsed.lead_magnet_enabled !== false},
          ${parsed.seo?.meta_title || null},
          ${parsed.seo?.meta_description || null},
          ${parsed.seo?.og_title || null},
          ${parsed.seo?.og_description || null},
          ${parsed.seo?.og_image || null},
          ${parsed.seo?.canonical || null},
          ${Array.isArray(parsed.target_keywords) ? parsed.target_keywords : []},
          ${Array.isArray(parsed.internal_links) ? parsed.internal_links : []},
          ${Array.isArray(parsed.related_courses) ? parsed.related_courses : []},
          ${sql.json(parsed.end_cta || { type: 'course-finder' })}
        )
        RETURNING id, slug
      `;

      // Tag links.
      const tagSlugs = Array.isArray(parsed.tags) ? parsed.tags : [];
      const validTagIds = [];
      const unknownTagSlugs = [];
      for (const t of tagSlugs) {
        const id = tagIdBySlug.get(String(t));
        if (id) validTagIds.push(id);
        else unknownTagSlugs.push(t);
      }
      if (validTagIds.length > 0) {
        await sql`
          INSERT INTO editorial.post_tags ${sql(
            validTagIds.map(tagId => ({ post_id: inserted.id, tag_id: tagId })),
          )}
          ON CONFLICT DO NOTHING
        `;
      }

      console.log(`  ✓ ${slug}: ported (id=${inserted.id}, ${validTagIds.length} tags${unknownTagSlugs.length ? `, unknown: ${unknownTagSlugs.join(', ')}` : ''})`);
      ported++;
    } catch (err) {
      console.error(`  ✗ ${slug}: insert failed — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nSummary: ${ported} ported, ${skipped} skipped, ${failed} failed.`);
  await sql.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("Unhandled error:", err);
  await sql.end({ timeout: 0 }).catch(() => {});
  process.exit(1);
});
