"use server";

/* eslint-disable @typescript-eslint/no-explicit-any */

// One-shot per-course Brevo resync. Run after closing a course in the YAML
// (accepting_applications: false) so every existing contact carrying that
// course as their canonical receives the updated SW_COURSE_OPEN = false
// attribute. Wren's N1-N3 exit condition then fires on the next daily check.
//
// Why per-course (not "any contact whose canonical might have flipped"):
// closing a course is an editorial event, so the operator already knows the
// scope. Targeted resync is cheap (~50 contacts per course typically) and
// avoids re-syncing the entire learner base unnecessarily.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/allowlist";

export type CourseOption = { course_id: string; learner_count: number };

export type CoursesListResult =
  | { ok: true; courses: CourseOption[] }
  | { ok: false; error: string };

export type ResyncOneResult = {
  id: number;
  status: "ok" | "skipped" | "error";
  reason?: string;
};

export type RunResult =
  | {
      ok: true;
      course_id: string;
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

// List every course_id that has at least one non-archived submission, with
// learner counts. Drives the dropdown so Charlotte can pick the slug she
// just closed without typing it.
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

export async function runCourseResyncAction(courseId: string): Promise<RunResult> {
  const g = await gate();
  if (!g.ok) return g;

  const trimmedSlug = courseId.trim();
  if (!trimmedSlug) return { ok: false, error: "course_id is required" };

  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("leads")
    .from("submissions")
    .select("id, course_id, archived_at")
    .eq("course_id", trimmedSlug)
    .is("archived_at", null)
    .order("submitted_at", { ascending: false });

  if (error) return { ok: false, error: error.message };
  const submissionIds = (data ?? []).map((r) => r.id as number);

  if (submissionIds.length === 0) {
    return {
      ok: true,
      course_id: trimmedSlug,
      total_requested: 0,
      ok_count: 0,
      skipped_count: 0,
      error_count: 0,
      results: [],
    };
  }

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
    course_id: trimmedSlug,
    total_requested: submissionIds.length,
    ok_count: results.filter((r) => r.status === "ok").length,
    skipped_count: results.filter((r) => r.status === "skipped").length,
    error_count: results.filter((r) => r.status === "error").length,
    results,
  };
}
