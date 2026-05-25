"use server";

/* eslint-disable @typescript-eslint/no-explicit-any */

// One-shot: resync the EMS marketing-consented non-enrolled segment
// through admin-brevo-resync. Gates the EMS new-course broadcast.
//
// Architecture:
//   - previewEmsSegmentAction() — count + sample (auto-loads on mount).
//   - listEmsSegmentIdsAction() — full ID list, returned once before batching.
//   - runResyncBatchAction(ids[]) — fires admin-brevo-resync over a CHUNK of
//     IDs. Called repeatedly by the panel in batches of ~30 so each call
//     completes inside the Netlify Function timeout (~10-26s default). EF
//     itself throttles at 250ms/contact → ~22s per 30-id chunk. Panel
//     orchestrates the loop + accumulates results.
//
// Why chunked: the full 117-contact resync takes ~80s wall time at the EF's
// throttle. A single Server Action can't wait that long on Netlify Functions
// (the wrapper times out before the EF returns). Chunking moves orchestration
// to the browser, which has no such limit.

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

export type SegmentIdsResult =
  | { ok: true; ids: number[] }
  | { ok: false; error: string };

export type ResyncOneResult = {
  id: number;
  status: "ok" | "skipped" | "error";
  reason?: string;
};

export type BatchResult =
  | { ok: true; results: ResyncOneResult[] }
  | { ok: false; error: string };

async function gate() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user || !isAdmin(userData.user.email)) {
    return { ok: false as const, error: "Not authorised" };
  }
  return { ok: true as const, supabase };
}

async function loadFilteredSegmentRows() {
  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("leads")
    .from("submissions")
    .select("id, email, course_id, fastracked_at, primary_routed_to, marketing_opt_in, archived_at, submitted_at")
    .eq("primary_routed_to", EMS_PROVIDER_ID)
    .eq("marketing_opt_in", true)
    .is("archived_at", null)
    .order("submitted_at", { ascending: false });
  if (error) return { ok: false as const, error: error.message };

  const ids = (data ?? []).map((r) => r.id as number);
  if (ids.length === 0) return { ok: true as const, rows: [] as any[] };

  const { data: enrolRows, error: enrolErr } = await admin
    .schema("crm")
    .from("enrolments")
    .select("submission_id, status, updated_at")
    .eq("provider_id", EMS_PROVIDER_ID)
    .in("submission_id", ids)
    .order("updated_at", { ascending: false });
  if (enrolErr) return { ok: false as const, error: enrolErr.message };

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
  return { ok: true as const, rows: filtered };
}

export async function previewEmsSegmentAction(): Promise<SegmentPreviewResult> {
  const g = await gate();
  if (!g.ok) return g;
  const r = await loadFilteredSegmentRows();
  if (!r.ok) return r;
  return {
    ok: true,
    total: r.rows.length,
    sample: r.rows.slice(0, 8).map((row) => ({
      id: row.id as number,
      email: (row.email as string | null) ?? null,
      course_id: (row.course_id as string | null) ?? null,
      fastracked: row.fastracked_at != null,
    })),
  };
}

export async function listEmsSegmentIdsAction(): Promise<SegmentIdsResult> {
  const g = await gate();
  if (!g.ok) return g;
  const r = await loadFilteredSegmentRows();
  if (!r.ok) return r;
  return { ok: true, ids: r.rows.map((row) => row.id as number) };
}

// Fires admin-brevo-resync over a chunk of IDs. Panel calls this in a loop
// with batches sized to fit inside the Netlify Function timeout.
export async function runResyncBatchAction(submissionIds: number[]): Promise<BatchResult> {
  const g = await gate();
  if (!g.ok) return g;

  if (!Array.isArray(submissionIds) || submissionIds.length === 0) {
    return { ok: true, results: [] };
  }
  const validated = submissionIds.filter((v) => Number.isFinite(v));
  if (validated.length === 0) {
    return { ok: false, error: "submissionIds must contain valid numbers" };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    return { ok: false, error: "Server misconfigured: NEXT_PUBLIC_SUPABASE_URL missing" };
  }
  const admin = createAdminClient();
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
      body: JSON.stringify({ submissionIds: validated }),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  let body: { results?: ResyncOneResult[]; error?: string };
  try {
    body = (await resp.json()) as { results?: ResyncOneResult[]; error?: string };
  } catch {
    return { ok: false, error: `Edge Function ${resp.status}: non-JSON response` };
  }
  if (!resp.ok || body.error) {
    return { ok: false, error: body.error ?? `Edge Function ${resp.status}` };
  }
  return { ok: true, results: Array.isArray(body.results) ? body.results : [] };
}
