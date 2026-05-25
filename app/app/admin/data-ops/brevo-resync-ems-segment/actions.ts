"use server";

/* eslint-disable @typescript-eslint/no-explicit-any */

// One-shot: resync the EMS marketing-consented non-enrolled segment
// through admin-brevo-resync. Gates the EMS new-course broadcast.
//
// Why this segment specifically: Wren's pre-broadcast gate (Pair from
// 2026-05-10 incident, codified in switchable/email/CLAUDE.md) requires
// a backfill on every contact in the broadcast filter when the wiring of
// any attribute the template references changes. The 2026-05-25 push
// changed SW_FASTRACK_COMPLETED from per-contact to per-canonical AND
// introduces SW_PENDING_RESTART — both touch broadcast targeting.
//
// Filter: EMS-routed (primary_routed_to = 'enterprise-made-simple'),
// marketing-consented (marketing_opt_in = true), not enrolled
// (latest enrolment status NOT in (enrolled, presumed_enrolled) OR no
// enrolment row). Mirrors the spec from handoff item 23.
//
// Throwaway: deletes cleanly after Wren confirms the broadcast shipped
// cleanly. Logged in changelog for the next agent.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/allowlist";

const EMS_PROVIDER_ID = "enterprise-made-simple";

export type SegmentPreview = {
  ok: true;
  total: number;
  sample: Array<{ id: number; email: string | null; course_id: string | null; fastracked: boolean }>;
};

export type SegmentPreviewResult = SegmentPreview | { ok: false; error: string };

export type ResyncOneResult = {
  id: number;
  status: "ok" | "skipped" | "error";
  reason?: string;
};

export type RunResult =
  | {
      ok: true;
      total_requested: number;
      ok_count: number;
      skipped_count: number;
      error_count: number;
      results: ResyncOneResult[];
    }
  | { ok: false; error: string };

async function gate() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user || !isAdmin(userData.user.email)) {
    return { ok: false as const, error: "Not authorised" };
  }
  return { ok: true as const, supabase };
}

// Used by both preview + run so the segment is computed identically.
// Joining latest enrolment via ROW_NUMBER keeps multi-enrolment leads
// (rare) on their freshest state — matches how billing reads it.
const SEGMENT_QUERY = `
  WITH latest_enrolment AS (
    SELECT
      e.submission_id,
      e.status,
      ROW_NUMBER() OVER (PARTITION BY e.submission_id ORDER BY e.updated_at DESC) AS rn
    FROM crm.enrolments e
    WHERE e.provider_id = $1
  )
  SELECT
    s.id,
    s.email,
    s.course_id,
    (s.fastracked_at IS NOT NULL) AS fastracked
  FROM leads.submissions s
  LEFT JOIN latest_enrolment le
    ON le.submission_id = s.id AND le.rn = 1
  WHERE s.primary_routed_to = $1
    AND s.marketing_opt_in = true
    AND s.archived_at IS NULL
    AND (le.status IS NULL OR le.status NOT IN ('enrolled', 'presumed_enrolled'))
  ORDER BY s.submitted_at DESC
`;

export async function previewEmsSegmentAction(): Promise<SegmentPreviewResult> {
  const g = await gate();
  if (!g.ok) return g;

  const admin = createAdminClient();
  // RPC the raw SQL via a one-off — but Supabase server client doesn't expose
  // raw SQL. Use a Postgres function call via a dedicated select instead.
  // Simpler: use the schema query through PostgREST with explicit filter
  // composition.
  const { data, error } = await admin
    .schema("leads")
    .from("submissions")
    .select("id, email, course_id, fastracked_at, primary_routed_to, marketing_opt_in, archived_at, submitted_at")
    .eq("primary_routed_to", EMS_PROVIDER_ID)
    .eq("marketing_opt_in", true)
    .is("archived_at", null)
    .order("submitted_at", { ascending: false });

  if (error) return { ok: false, error: error.message };

  // Exclude enrolled / presumed-enrolled by joining crm.enrolments.
  // PostgREST can't OUTER JOIN cleanly across schemas in one call, so we
  // pull enrolment statuses in a second query and filter client-side.
  const ids = (data ?? []).map((r) => r.id as number);
  if (ids.length === 0) {
    return { ok: true, total: 0, sample: [] };
  }

  const { data: enrolRows, error: enrolErr } = await admin
    .schema("crm")
    .from("enrolments")
    .select("submission_id, status, updated_at")
    .eq("provider_id", EMS_PROVIDER_ID)
    .in("submission_id", ids)
    .order("updated_at", { ascending: false });

  if (enrolErr) return { ok: false, error: enrolErr.message };

  const latestStatusBySubmission = new Map<number, string>();
  for (const row of (enrolRows ?? []) as Array<{ submission_id: number; status: string; updated_at: string }>) {
    if (!latestStatusBySubmission.has(row.submission_id)) {
      latestStatusBySubmission.set(row.submission_id, row.status);
    }
  }

  const EXCLUDED = new Set(["enrolled", "presumed_enrolled"]);
  const filtered = (data ?? []).filter((r) => {
    const status = latestStatusBySubmission.get(r.id as number);
    return !status || !EXCLUDED.has(status);
  });

  return {
    ok: true,
    total: filtered.length,
    sample: filtered.slice(0, 8).map((r) => ({
      id: r.id as number,
      email: (r.email as string | null) ?? null,
      course_id: (r.course_id as string | null) ?? null,
      fastracked: r.fastracked_at != null,
    })),
  };
}

export async function runEmsResyncAction(): Promise<RunResult> {
  const g = await gate();
  if (!g.ok) return g;

  const preview = await previewEmsSegmentAction();
  if (!preview.ok) return preview;
  if (preview.total === 0) {
    return {
      ok: true,
      total_requested: 0,
      ok_count: 0,
      skipped_count: 0,
      error_count: 0,
      results: [],
    };
  }

  // Re-run the segment query to get the full ID list (preview returned a
  // sample but the resync needs every id).
  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("leads")
    .from("submissions")
    .select("id, primary_routed_to, marketing_opt_in, archived_at, submitted_at")
    .eq("primary_routed_to", EMS_PROVIDER_ID)
    .eq("marketing_opt_in", true)
    .is("archived_at", null)
    .order("submitted_at", { ascending: false });

  if (error) return { ok: false, error: error.message };
  const allIds = (data ?? []).map((r) => r.id as number);

  // Filter by enrolment status (same logic as preview).
  const { data: enrolRows, error: enrolErr } = await admin
    .schema("crm")
    .from("enrolments")
    .select("submission_id, status, updated_at")
    .eq("provider_id", EMS_PROVIDER_ID)
    .in("submission_id", allIds)
    .order("updated_at", { ascending: false });
  if (enrolErr) return { ok: false, error: enrolErr.message };

  const latestStatusBySubmission = new Map<number, string>();
  for (const row of (enrolRows ?? []) as Array<{ submission_id: number; status: string }>) {
    if (!latestStatusBySubmission.has(row.submission_id)) {
      latestStatusBySubmission.set(row.submission_id, row.status);
    }
  }
  const EXCLUDED = new Set(["enrolled", "presumed_enrolled"]);
  const submissionIds = allIds.filter((id) => {
    const status = latestStatusBySubmission.get(id);
    return !status || !EXCLUDED.has(status);
  });

  // Fire admin-brevo-resync with the full ID list. EF throttles internally
  // (250ms per call) so 117 IDs → ~30-90s wall time. Within EF timeout.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    return { ok: false, error: "Server misconfigured: NEXT_PUBLIC_SUPABASE_URL missing" };
  }
  const { data: secretData, error: secretErr } = await admin.rpc("get_shared_secret", {
    p_name: "AUDIT_SHARED_SECRET",
  });
  if (secretErr || typeof secretData !== "string" || !secretData) {
    return {
      ok: false,
      error: `Could not read AUDIT_SHARED_SECRET from vault: ${secretErr?.message ?? "no value returned"}`,
    };
  }

  let resp: Response;
  try {
    resp = await fetch(`${supabaseUrl}/functions/v1/admin-brevo-resync`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-audit-key": secretData },
      body: JSON.stringify({ submissionIds }),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  // admin-brevo-resync returns { results: [...] } on success, no top-level ok.
  let body: { results?: ResyncOneResult[]; error?: string };
  try {
    body = (await resp.json()) as { results?: ResyncOneResult[]; error?: string };
  } catch {
    return { ok: false, error: `Edge Function ${resp.status}: non-JSON response` };
  }
  if (!resp.ok || body.error) {
    return { ok: false, error: body.error ?? `Edge Function ${resp.status}` };
  }
  const results = Array.isArray(body.results) ? body.results : [];
  return {
    ok: true,
    total_requested: submissionIds.length,
    ok_count: results.filter((r) => r.status === "ok").length,
    skipped_count: results.filter((r) => r.status === "skipped").length,
    error_count: results.filter((r) => r.status === "error").length,
    results,
  };
}
