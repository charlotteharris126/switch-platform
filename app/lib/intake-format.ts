// Helpers for displaying intake/cohort identifiers in the provider portal.
//
// Intake IDs are slugs of the form "<region>-<YYYY>-<MM>-<DD>", e.g.
// "tees-valley-2026-05-21" or "lift-camden-2026-06-03". Region segments
// can contain multiple hyphenated words. The DB doesn't carry the
// human-readable date, so we parse the slug.

export interface ParsedIntake {
  raw: string;
  region: string | null;
  date: Date | null;
}

const SLUG_RE = /^(.+?)-(\d{4})-(\d{2})-(\d{2})$/;

export function parseIntakeId(slug: string): ParsedIntake {
  const m = slug.match(SLUG_RE);
  if (!m) return { raw: slug, region: null, date: null };
  const [, region, yyyy, mm, dd] = m;
  const d = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return { raw: slug, region: null, date: null };
  return {
    raw: slug,
    region: humaniseRegion(region),
    date: d,
  };
}

export function formatIntakeId(slug: string): string {
  const parsed = parseIntakeId(slug);
  if (!parsed.date) return slug;
  const dateStr = parsed.date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return parsed.region ? `${parsed.region}, ${dateStr}` : dateStr;
}

function humaniseRegion(slug: string): string {
  return slug
    .split("-")
    .map((s) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)))
    .join(" ");
}
