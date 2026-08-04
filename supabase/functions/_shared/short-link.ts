// Pretty short-links. Maps a short unguessable code to a submission's fastrack
// URL. `switchable.org.uk/go/<code>` (site route, Mable) -> go-resolve EF ->
// 302 to the full /funded/thank-you/ URL. mintShortLink is called when building
// the fastrack link (once the emit is flipped); resolveShortLink powers the EF.
//
// Code charset excludes look-alikes (0/o, 1/l/i) so codes read cleanly and are
// never ambiguous when typed. 6 chars from a 30-char set = ~30^6 ≈ 7e8 combos.

import type { Sql } from "npm:postgres@3";

const CODE_CHARSET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0 o 1 l i
const CODE_LEN = 6;

function generateCode(): string {
  const bytes = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_CHARSET[bytes[i] % CODE_CHARSET.length];
  }
  return out;
}

// Idempotent per (submission_id, kind): re-sends of the same fastrack link reuse
// the same code. Caller runs as functions_writer.
export async function mintShortLink(
  sql: Sql,
  submissionId: number,
  kind = "fastrack",
): Promise<string> {
  const existing = await sql<Array<{ code: string }>>`
    SELECT code FROM leads.short_links WHERE submission_id = ${submissionId} AND kind = ${kind} LIMIT 1
  `;
  if (existing[0]) return existing[0].code;

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = generateCode();
    try {
      const inserted = await sql<Array<{ code: string }>>`
        INSERT INTO leads.short_links (code, submission_id, kind)
        VALUES (${code}, ${submissionId}, ${kind})
        ON CONFLICT (submission_id, kind) DO NOTHING
        RETURNING code
      `;
      if (inserted[0]) return inserted[0].code;
      // (submission_id, kind) already taken by a concurrent insert — fetch it.
      const again = await sql<Array<{ code: string }>>`
        SELECT code FROM leads.short_links WHERE submission_id = ${submissionId} AND kind = ${kind} LIMIT 1
      `;
      if (again[0]) return again[0].code;
    } catch (err) {
      // Most likely a code (PK) collision — retry with a fresh code.
      if (attempt === 5) throw err;
    }
  }
  throw new Error("mintShortLink: exhausted code-generation retries");
}

// Build the full thank-you target for a submission (mirrors buildFastrackUrl in
// route-lead.ts). Returns null if the submission has no client_nonce.
export function buildFastrackTarget(
  clientNonce: string | null,
  courseId: string | null,
  marketingOptIn: boolean,
): string | null {
  if (!clientNonce) return null;
  const params = [`ref=${encodeURIComponent(clientNonce)}`];
  if (courseId) params.push(`course=${encodeURIComponent(courseId)}`);
  params.push(`m=${marketingOptIn ? "1" : "0"}`);
  return `https://switchable.org.uk/funded/thank-you/?${params.join("&")}`;
}

// Resolve a code to its target URL. Returns null when the code is unknown or the
// submission can't build a target. Caller runs as functions_writer.
export async function resolveShortLink(sql: Sql, code: string): Promise<string | null> {
  const rows = await sql<Array<{
    client_nonce: string | null;
    course_id: string | null;
    marketing_opt_in: boolean | null;
    kind: string;
  }>>`
    SELECT s.client_nonce, s.course_id, s.marketing_opt_in, l.kind
      FROM leads.short_links l
      JOIN leads.submissions s ON s.id = l.submission_id
     WHERE l.code = ${code}
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  // Only 'fastrack' kind is defined today; future kinds add their own target builder.
  return buildFastrackTarget(row.client_nonce, row.course_id, row.marketing_opt_in === true);
}
