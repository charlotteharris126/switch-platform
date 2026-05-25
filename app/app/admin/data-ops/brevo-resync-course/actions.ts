"use server";

/* eslint-disable @typescript-eslint/no-explicit-any */

// One-shot per-course Brevo resync. Run after closing/reopening a course
// in the YAML so every existing contact carrying that course as their
// canonical receives the updated SW_COURSE_OPEN attribute.
//
// Architecture mirrors brevo-resync-ems-segment: list IDs once, then panel
// loops in batches of ~30 to stay inside the Netlify Function timeout.
// The EF throttles at 250ms/contact internally.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/allowlist";

export type CourseOption = { course_id: string; learner_count: number };

export type CoursesListResult =
  | { ok: true; courses: CourseOption[] }
  | { ok: false; error: string };

export type CourseIdsResult =
  | { ok: true; course_id: string; ids: number[] }
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

export async function listCoursesWithLearnersAction(): Promise<CoursesListResult> {
  const g = await gate();
  if (!g.ok) return g;

  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("leads")
    .from("submissions")
    .select("course_id")
    .not("course_id", "is", null)
    .is("archived_at", null);

  if (error) return { ok: false, error: error.message };

  const counts = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ course_id: string | null }>) {
    if (!r.course_id) continue;
    counts.set(r.course_id, (counts.get(r.course_id) ?? 0) + 1);
  }
  const courses = Array.from(counts.entries())
    .map(([course_id, learner_count]) => ({ course_id, learner_count }))
    .sort((a, b) => b.learner_count - a.learner_count);

  return { ok: true, courses };
}

export async function listCourseIdsAction(courseId: string): Promise<CourseIdsResult> {
  const g = await gate();
  if (!g.ok) return g;

  const trimmedSlug = courseId.trim();
  if (!trimmedSlug) return { ok: false, error: "course_id is required" };

  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("leads")
    .from("submissions")
    .select("id, course_id, archived_at, submitted_at")
    .eq("course_id", trimmedSlug)
    .is("archived_at", null)
    .order("submitted_at", { ascending: false });

  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    course_id: trimmedSlug,
    ids: (data ?? []).map((r) => r.id as number),
  };
}

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
