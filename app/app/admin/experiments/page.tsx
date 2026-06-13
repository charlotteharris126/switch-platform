import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

// Source of truth for which experiments are CURRENTLY RUNNING is the
// switchable site's deploy-time manifest at /data/experiments.json. This
// is updated on every site deploy by scripts/build-funded-pages.js. We
// fetch it here so the page can list active experiments even before any
// leads have come through.
const MANIFEST_URL = "https://switchable.org.uk/data/experiments.json";

interface ManifestEntry {
  id: string;
  page_slug: string;
  page_url: string;
  variants: { a: string; b: string };
  started: string | null;
}

interface Manifest {
  schema_version: string;
  generated_at: string;
  experiments: ManifestEntry[];
}

interface SubmissionRow {
  id: number;
  experiment_id: string | null;
  experiment_variant: string | null;
  is_dq: boolean | null;
  submitted_at: string;
  course_id: string | null;
  lead_type: string | null;
}

interface EnrolmentRow {
  submission_id: number;
  status: string | null;
}

interface PageViewCountRow {
  experiment_id: string;
  variant: string;
  total_loads: number;       // every page load including bots + null-session
  unique_sessions: number;   // humans only, deduped (the rate denominator)
  bot_sessions: number;      // bots filtered out (forensic transparency)
  null_session_loads: number; // human loads with no session cookie (pre-0162 / cookie-blocked)
}

interface VariantStats {
  count: number;
  earliest: string | null;
  latest: string | null;
  dqCount: number;
  qualifiedCount: number;
  enrolmentTotal: number;
  enrolmentBillable: number; // status in (enrolled, presumed_enrolled)
  enrolmentInFlight: number; // status in (open, cannot_reach)
  enrolmentLost: number;     // status = lost
  uniqueSessions: number;    // humans only, deduped per migration 0164 — CVR denominator
  botSessions: number;       // crawlers/previewers/scanners filtered out at log time
  nullSessionLoads: number;  // pre-0162 historic loads (no session cookie) — counted only when no clean data exists
  totalLoads: number;        // raw page loads including bots + null-session (forensic only)
}

interface ExperimentSummary {
  id: string;
  manifest: ManifestEntry | null; // null if in DB but not in current manifest (ended)
  variants: Map<string, VariantStats>;
  totalLeads: number;
  totalQualifiedLeads: number;
  totalUniqueSessions: number;
  totalLoadsAll: number;
  earliest: string | null;
  latest: string | null;
  courseIds: Set<string>;     // distinct course_id seen across this experiment's leads
  hasEmployerLeads: boolean;  // any employer_apprenticeship lead → it's a /business/ page test
}

// Canonical enrolment status enum: migration 0151 enrolments_status_check.
// Bucketing mirrors /admin/leads page stage filter so both surfaces agree.
const BILLABLE_STATUSES = new Set([
  // Learner-lead (B2C)
  "enrolled", "presumed_enrolled",
  // Employer-lead (B2B)
  "signed", "presumed_employer_signed",
]);
const IN_FLIGHT_STATUSES = new Set([
  // Learner-lead (B2C)
  "open", "attempt_1_no_answer", "attempt_2_no_answer", "attempt_3_no_answer",
  "enrolment_meeting_booked", "cannot_reach",
  // Employer-lead (B2B)
  "engaged", "in_progress",
]);
const LOST_STATUSES = new Set([
  "lost",        // Learner-lead (B2C)
  "not_signed",  // Employer-lead (B2B)
]);

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateOnly(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "—";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Turn an experiment slug into a readable title. Pulls a trailing date suffix
// (-YYYY-MM or -YYYY-MM-DD) out as a tidy period tag and title-cases the rest.
// The raw slug is kept and shown separately for cross-reference. The slug is
// the only identifier the manifest carries — there's no human name field — so
// this is presentation only, no data dependency.
function humaniseExperimentId(id: string): { title: string; period: string | null } {
  const m = id.match(/-(\d{4})-(\d{2})(?:-\d{2})?$/);
  let base = id;
  let period: string | null = null;
  if (m) {
    base = id.slice(0, m.index);
    const monthIdx = parseInt(m[2], 10) - 1;
    if (monthIdx >= 0 && monthIdx < 12) period = `${MONTHS[monthIdx]} ${m[1]}`;
  }
  const title = base
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return { title: title || id, period };
}

// What page/form is this experiment actually testing? The slug doesn't say,
// so resolve it from real signals: the course_id its leads carry (course
// pages), an employer-lead marker (/business/ pages), or the live manifest
// page URL (covers brand-new experiments with no leads yet).
function describeTarget(
  courseIds: Set<string>,
  hasEmployerLeads: boolean,
  pageUrl: string | null,
): { label: string; value: string } | null {
  if (courseIds.size > 0) {
    return { label: "Course", value: Array.from(courseIds).join(", ") };
  }
  if (pageUrl?.startsWith("/funded/")) {
    return { label: "Course", value: pageUrl.replace(/^\/funded\/|\/$/g, "") };
  }
  if (hasEmployerLeads || pageUrl?.startsWith("/business")) {
    // pageUrl is the reliable discriminator (universal vs a sector page). Ended
    // employer experiments have no manifest, and their leads can't tell sectors
    // apart, so stay generic rather than guess — the ID line below still shows
    // the slug (e.g. construction-hero-deputy) for the specifics.
    const sector = pageUrl?.match(/^\/business\/([^/]+)\/?$/)?.[1];
    const value = sector ? `${sector} (${pageUrl})` : pageUrl ?? "apprenticeship lead form";
    return { label: "Employer page", value };
  }
  if (pageUrl) return { label: "Page", value: pageUrl };
  return null;
}

function emptyVariantStats(): VariantStats {
  return {
    count: 0,
    earliest: null,
    latest: null,
    dqCount: 0,
    qualifiedCount: 0,
    enrolmentTotal: 0,
    enrolmentBillable: 0,
    enrolmentInFlight: 0,
    enrolmentLost: 0,
    uniqueSessions: 0,
    botSessions: 0,
    nullSessionLoads: 0,
    totalLoads: 0,
  };
}

async function fetchManifest(): Promise<{ manifest: Manifest | null; error: string | null }> {
  try {
    const res = await fetch(MANIFEST_URL, { next: { revalidate: 60 } });
    if (!res.ok) {
      return { manifest: null, error: `Manifest fetch returned ${res.status}` };
    }
    const data = (await res.json()) as Manifest;
    return { manifest: data, error: null };
  } catch (e) {
    return { manifest: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export default async function ExperimentsPage({
  searchParams,
}: {
  searchParams: Promise<{ show_ended?: string }>;
}) {
  const showEnded = (await searchParams).show_ended === "1";
  const supabase = await createClient();

  // 1. Pull every submission with experiment_id (re-applications excluded
  //    so counts reflect fresh paid impressions only). Archived rows are
  //    excluded so admin-marked test leads (owner-test-toggle.tsx) drop
  //    out of the experiments view automatically, no manual SQL needed.
  //    Added 2026-05-30 after B2B test cleanup surfaced the gap.
  const submissionsQuery = await supabase
    .schema("leads")
    .from("submissions")
    .select("id, experiment_id, experiment_variant, is_dq, submitted_at, course_id, lead_type")
    .not("experiment_id", "is", null)
    .is("parent_submission_id", null)
    .is("archived_at", null)
    .order("submitted_at", { ascending: false })
    .limit(5000);

  const subRows = (submissionsQuery.data ?? []) as SubmissionRow[];

  // 2. Pull enrolments for every submission carrying an experiment_id.
  const submissionIds = subRows.map((r) => r.id);
  let enrolRows: EnrolmentRow[] = [];
  if (submissionIds.length > 0) {
    const enrolQuery = await supabase
      .schema("crm")
      .from("enrolments")
      .select("submission_id, status")
      .in("submission_id", submissionIds);
    enrolRows = (enrolQuery.data ?? []) as EnrolmentRow[];
  }

  // 3. Pull aggregated page view counts per experiment+variant via the
  //    ads_switchable.get_experiment_view_counts_v3 RPC (migration 0164).
  //    Returns unique_sessions (humans only, deduped — the rate denominator),
  //    bot_sessions (crawlers/previewers/scanners filtered at log time, kept
  //    for forensic transparency), null_session_loads (real loads from
  //    pre-0162 historicals or visitors who blocked the session cookie), and
  //    total_loads (everything including bots, kept as forensic upper bound).
  //    unique_sessions is the right denominator: it excludes bots, owner QA,
  //    refreshes, back-button revisits, and link-preview fetchers; it counts
  //    a real human visitor once per 30-minute session regardless of source.
  //    v2 (migration 0162) stays live for unfiltered callers.
  const viewsQuery = await supabase
    .schema("ads_switchable")
    .rpc("get_experiment_view_counts_v3");

  const viewRows = (viewsQuery.data ?? []) as PageViewCountRow[];

  // 4. Fetch the live experiments manifest from the site.
  const { manifest, error: manifestError } = await fetchManifest();
  const manifestById = new Map<string, ManifestEntry>();
  if (manifest) {
    for (const e of manifest.experiments) manifestById.set(e.id, e);
  }

  // 5. Index enrolments and views for O(1) lookup during aggregation.
  const enrolmentsBySubmission = new Map<number, EnrolmentRow[]>();
  for (const e of enrolRows) {
    const list = enrolmentsBySubmission.get(e.submission_id) ?? [];
    list.push(e);
    enrolmentsBySubmission.set(e.submission_id, list);
  }

  // View counts come back pre-aggregated from the v3 RPC (one row per
  // experiment+variant pair) with humans-only unique_sessions plus three
  // forensic columns. BIGINT values come back from postgres as JS strings
  // (per feedback_postgres3_bigint_returns_string.md) so Number() upfront.
  const viewsByExp = new Map<
    string,
    Map<
      string,
      { uniqueSessions: number; botSessions: number; nullSessionLoads: number; totalLoads: number }
    >
  >();
  for (const v of viewRows) {
    let byVariant = viewsByExp.get(v.experiment_id);
    if (!byVariant) {
      byVariant = new Map();
      viewsByExp.set(v.experiment_id, byVariant);
    }
    byVariant.set(v.variant, {
      uniqueSessions: Number(v.unique_sessions),
      botSessions: Number(v.bot_sessions),
      nullSessionLoads: Number(v.null_session_loads),
      totalLoads: Number(v.total_loads),
    });
  }

  // 6. Build per-experiment, per-variant aggregates.
  const byExperiment = new Map<string, ExperimentSummary>();

  function getOrCreateSummary(id: string): ExperimentSummary {
    let s = byExperiment.get(id);
    if (!s) {
      s = {
        id,
        manifest: manifestById.get(id) ?? null,
        variants: new Map(),
        totalLeads: 0,
        totalQualifiedLeads: 0,
        totalUniqueSessions: 0,
        totalLoadsAll: 0,
        earliest: null,
        latest: null,
        courseIds: new Set<string>(),
        hasEmployerLeads: false,
      };
      byExperiment.set(id, s);
    }
    return s;
  }

  for (const row of subRows) {
    const expId = row.experiment_id;
    if (!expId) continue;
    const variant = row.experiment_variant ?? "unknown";
    const summary = getOrCreateSummary(expId);

    let v = summary.variants.get(variant);
    if (!v) {
      v = emptyVariantStats();
      summary.variants.set(variant, v);
    }
    v.count += 1;
    if (row.is_dq) v.dqCount += 1;
    else v.qualifiedCount += 1;

    if (row.course_id) summary.courseIds.add(row.course_id);
    if (row.lead_type === "employer_apprenticeship") summary.hasEmployerLeads = true;

    if (!v.earliest || row.submitted_at < v.earliest) v.earliest = row.submitted_at;
    if (!v.latest || row.submitted_at > v.latest) v.latest = row.submitted_at;

    const enrolments = enrolmentsBySubmission.get(row.id) ?? [];
    for (const e of enrolments) {
      v.enrolmentTotal += 1;
      if (e.status && BILLABLE_STATUSES.has(e.status)) v.enrolmentBillable += 1;
      else if (e.status && IN_FLIGHT_STATUSES.has(e.status)) v.enrolmentInFlight += 1;
      else if (e.status && LOST_STATUSES.has(e.status)) v.enrolmentLost += 1;
    }

    summary.totalLeads += 1;
    if (!row.is_dq) summary.totalQualifiedLeads += 1;
    if (!summary.earliest || row.submitted_at < summary.earliest) summary.earliest = row.submitted_at;
    if (!summary.latest || row.submitted_at > summary.latest) summary.latest = row.submitted_at;
  }

  // 7. Merge view counts into existing summaries (and create summaries for
  //    experiments that have views but no leads yet).
  for (const [expId, byVariant] of viewsByExp) {
    const summary = getOrCreateSummary(expId);
    for (const [variant, counts] of byVariant) {
      let v = summary.variants.get(variant);
      if (!v) {
        v = emptyVariantStats();
        summary.variants.set(variant, v);
      }
      v.uniqueSessions = counts.uniqueSessions;
      v.botSessions = counts.botSessions;
      v.nullSessionLoads = counts.nullSessionLoads;
      v.totalLoads = counts.totalLoads;
      summary.totalUniqueSessions += counts.uniqueSessions;
      summary.totalLoadsAll += counts.totalLoads;
    }
  }

  // 8. For every experiment in the current manifest, ensure both A and B rows
  //    exist — even if only one variant has collected leads or views so far.
  //    Without this, the challenger row is invisible until its first lead lands.
  if (manifest) {
    for (const m of manifest.experiments) {
      const s = getOrCreateSummary(m.id);
      if (!s.variants.has("a")) s.variants.set("a", emptyVariantStats());
      if (!s.variants.has("b")) s.variants.set("b", emptyVariantStats());
    }
  }

  // Sort: currently-running first (by manifest started date desc), then
  // historical (by latest lead date desc).
  const experiments = Array.from(byExperiment.values()).sort((a, b) => {
    const aRunning = a.manifest != null;
    const bRunning = b.manifest != null;
    if (aRunning !== bRunning) return aRunning ? -1 : 1;
    const aDate = a.manifest?.started ?? a.latest ?? "";
    const bDate = b.manifest?.started ?? b.latest ?? "";
    return bDate.localeCompare(aDate);
  });

  // Ended = in the DB with collected data but no longer in the live manifest.
  // Hidden by default to keep the page focused on what's running; revealed by
  // the Show ended toggle (?show_ended=1).
  const endedCount = experiments.filter((e) => e.manifest == null).length;
  const visibleExperiments = showEnded
    ? experiments
    : experiments.filter((e) => e.manifest != null);

  return (
    <div className="max-w-6xl space-y-8">
      <PageHeader
        eyebrow="Tools"
        title="Experiments"
        subtitle={
          submissionsQuery.error ? (
            <span className="text-[#b3412e]">Error loading lead data: {submissionsQuery.error.message}</span>
          ) : experiments.length === 0 ? (
            <>
              No experiments are currently running and none have collected data
              historically. When a page YAML carries an <code>experiment:</code>{" "}
              block and the next site deploy lands, it shows up here. Page views
              are logged server-side by the variant-router Edge Function; leads
              record which variant was served via the <code>experiment_id</code>{" "}
              and <code>experiment_variant</code> columns on{" "}
              <code>leads.submissions</code>.
            </>
          ) : (
            <>
              Per-variant page views, leads, and enrolments for every running A/B
              test and every historical one with collected data. Variant A is the
              canonical page; variant B is the challenger. Re-applications are
              excluded so lead counts reflect fresh paid impressions only.
              {manifestError && (
                <span className="block text-[#b3412e] mt-1 text-xs">
                  Note: live manifest unreachable ({manifestError}). Showing
                  historical data only.
                </span>
              )}
            </>
          )
        }
      />

      {endedCount > 0 && (
        <div className="flex items-center gap-3 -mt-4">
          <Link
            href={showEnded ? "/experiments" : "/experiments?show_ended=1"}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border border-[#dad4cb] bg-white text-[#5a6a72] hover:border-[#11242e] hover:text-[#11242e] transition-colors"
          >
            {showEnded ? "Hide ended" : `Show ended (${endedCount})`}
          </Link>
        </div>
      )}

      {experiments.length > 0 && visibleExperiments.length === 0 && (
        <p className="text-sm text-[#5a6a72]">
          No experiments are running right now. {endedCount} ended —{" "}
          <Link href="/experiments?show_ended=1" className="underline hover:text-[#11242e]">
            show ended
          </Link>
          .
        </p>
      )}

      {visibleExperiments.map((exp) => {
        const isRunning = exp.manifest != null;
        const { title: expTitle, period: expPeriod } = humaniseExperimentId(exp.id);
        const target = describeTarget(exp.courseIds, exp.hasEmployerLeads, exp.manifest?.page_url ?? null);
        const variantA = exp.variants.get("a") ?? emptyVariantStats();
        const variantB = exp.variants.get("b") ?? emptyVariantStats();
        const aQual = variantA.qualifiedCount;
        const bQual = variantB.qualifiedCount;
        // Unique sessions is the canonical denominator post-migration 0162
        // (sw_session is strictly-necessary functional, set unconditionally).
        // Pre-0162 experiments (counselling, smm) have NULL session_id on
        // every row, so uniqueSessions reads zero and we fall back to
        // totalLoads to preserve the historical view. Active experiments
        // post-0162 will never hit the fallback. The variant cell flags the
        // fallback case visually with an asterisk + tooltip.
        const aViews = variantA.uniqueSessions > 0 ? variantA.uniqueSessions : variantA.totalLoads;
        const bViews = variantB.uniqueSessions > 0 ? variantB.uniqueSessions : variantB.totalLoads;
        const aBillable = variantA.enrolmentBillable;
        const bBillable = variantB.enrolmentBillable;

        // 50/50 split check: how close is the view split to equal?
        const totalViews = aViews + bViews;
        const splitLabel = totalViews === 0
          ? "No views yet"
          : `${aViews.toLocaleString()} A / ${bViews.toLocaleString()} B (${pct(aViews, totalViews)} / ${pct(bViews, totalViews)})`;

        // Lead lift: B vs A on qualified-lead count.
        let leadLift = "—";
        if (aQual > 0 && bQual > 0) {
          const liftPct = ((bQual - aQual) / aQual) * 100;
          const sign = liftPct > 0 ? "+" : "";
          leadLift = `${sign}${liftPct.toFixed(1)}%`;
        } else if (aQual === 0 && bQual > 0) {
          leadLift = "B-only";
        } else if (bQual === 0 && aQual > 0) {
          leadLift = "A-only";
        }

        // Enrolment lift: B vs A on billable enrolments.
        let enrolLift = "—";
        if (aBillable > 0 && bBillable > 0) {
          const liftPct = ((bBillable - aBillable) / aBillable) * 100;
          const sign = liftPct > 0 ? "+" : "";
          enrolLift = `${sign}${liftPct.toFixed(1)}%`;
        } else if (aBillable === 0 && bBillable > 0) {
          enrolLift = "B-only";
        } else if (bBillable === 0 && aBillable > 0) {
          enrolLift = "A-only";
        }

        // Lead confidence: at least 30 qualified leads on each side.
        const enoughLeadData = aQual >= 30 && bQual >= 30;

        // View split health: within 45/55 is fine; outside that is worth flagging.
        const splitHealthy = totalViews === 0 || (
          aViews / totalViews >= 0.45 && aViews / totalViews <= 0.55
        );

        return (
          <section
            key={exp.id}
            className="rounded-2xl border border-[#e5dfd8] bg-white p-6 space-y-4"
          >
            <div className="flex items-baseline justify-between gap-4 flex-wrap">
              <div className="flex items-baseline gap-3 flex-wrap">
                <h2 className="font-extrabold text-[#11242e] text-lg">{expTitle}</h2>
                {expPeriod && (
                  <span className="text-xs font-semibold text-[#5a6a72]">{expPeriod}</span>
                )}
                {isRunning ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[#dcefea] text-[#1f5f5e] border border-[#bcdfd8]">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#2A9D8F]"></span>
                    Live
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-[#f0ebe5] text-[#5a6a72] border border-[#dad4cb]">
                    Ended
                  </span>
                )}
              </div>
              <span className="text-xs text-[#5a6a72]">
                {isRunning && exp.manifest?.started ? (
                  <>Started {formatDateOnly(exp.manifest.started)}</>
                ) : (
                  <>
                    {formatDateOnly(exp.earliest)} → {formatDateOnly(exp.latest)}
                  </>
                )}
                {" · "}
                {totalViews > 0 && (
                  <>{totalViews.toLocaleString()} view{totalViews === 1 ? "" : "s"} · </>
                )}
                {exp.totalLeads} submission{exp.totalLeads === 1 ? "" : "s"} ({exp.totalQualifiedLeads} qualified)
              </span>
            </div>

            {target && (
              <div className="-mt-2 text-sm text-[#11242e]">
                <span className="text-[#5a6a72]">Testing: </span>
                <span className="font-semibold">{target.label}</span>
                {" — "}
                <code className="text-[#11242e]">{target.value}</code>
              </div>
            )}

            <div className="text-xs text-[#5a6a72] flex items-center gap-2 flex-wrap">
              <span className="uppercase tracking-wider text-[10px] font-semibold">ID</span>
              <code className="text-[#5a6a72]">{exp.id}</code>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variant</TableHead>
                  <TableHead
                    className="text-right"
                    title="Unique sessions per migration 0162 (post-2026-05-23). For experiments that ran entirely before 0162, this falls back to raw page loads marked with an asterisk — treat those as forensic upper bound, not clean visitor counts."
                  >
                    Unique sessions
                  </TableHead>
                  <TableHead className="text-right">Submissions</TableHead>
                  <TableHead className="text-right">Qualified</TableHead>
                  <TableHead className="text-right">View → lead</TableHead>
                  <TableHead className="text-right">DQ rate</TableHead>
                  <TableHead className="text-right">Enrolled</TableHead>
                  <TableHead className="text-right">In flight</TableHead>
                  <TableHead className="text-right">Lead → enrol</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Array.from(exp.variants.entries())
                  .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
                  .map(([variant, stats]) => {
                    return (
                      <TableRow key={variant}>
                        <TableCell className="font-semibold">
                          {variant === "a"
                            ? "A (canonical)"
                            : variant === "b"
                              ? "B (challenger)"
                              : variant}
                        </TableCell>
                        <TableCell
                          className="text-right font-semibold"
                          title={
                            stats.uniqueSessions > 0
                              ? `Unique human sessions per migration 0164. Bots filtered server-side from user_agent (${stats.botSessions.toLocaleString()} bot session${stats.botSessions === 1 ? "" : "s"} excluded). Owner QA excluded via sw_is_owner cookie. Refreshes / back-button deduped via sw_session UUID. Forensic upper bound (everything including bots + null-session loads): ${stats.totalLoads.toLocaleString()}.`
                              : `No clean session data — this experiment ran entirely before migration 0162 landed on 2026-05-23. Showing raw load count (includes refreshes, bot hits, pre-cookie loads). Treat as a forensic upper bound, not a clean visitor count.`
                          }
                        >
                          {stats.uniqueSessions > 0
                            ? stats.uniqueSessions.toLocaleString()
                            : stats.totalLoads > 0
                              ? `${stats.totalLoads.toLocaleString()}*`
                              : "—"}
                        </TableCell>
                        <TableCell className="text-right">{stats.count}</TableCell>
                        <TableCell className="text-right font-semibold">
                          {stats.qualifiedCount}
                        </TableCell>
                        <TableCell className="text-right text-xs text-[#5a6a72]">
                          {pct(stats.qualifiedCount, stats.uniqueSessions > 0 ? stats.uniqueSessions : stats.totalLoads)}
                        </TableCell>
                        <TableCell className="text-right text-xs text-[#5a6a72]">
                          {pct(stats.dqCount, stats.count)}
                        </TableCell>
                        <TableCell className="text-right font-semibold text-[#1f5f5e]">
                          {stats.enrolmentBillable}
                        </TableCell>
                        <TableCell className="text-right text-xs text-[#5a6a72]">
                          {stats.enrolmentInFlight}
                        </TableCell>
                        <TableCell className="text-right text-xs text-[#5a6a72]">
                          {pct(stats.enrolmentBillable, stats.qualifiedCount)}
                        </TableCell>
                        <TableCell className="text-xs text-[#5a6a72]">
                          {formatDate(stats.latest)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>

            <div className="flex items-center gap-8 pt-2 border-t border-[#f0ebe5] flex-wrap">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#5a6a72] font-semibold">
                  View split
                </div>
                <div className={`text-sm font-semibold ${splitHealthy ? "text-[#11242e]" : "text-[#b3412e]"}`}>
                  {splitLabel}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#5a6a72] font-semibold">
                  Lead lift (B vs A)
                </div>
                <div className="text-2xl font-extrabold text-[#11242e]">
                  {leadLift}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#5a6a72] font-semibold">
                  Enrolment lift (B vs A)
                </div>
                <div className="text-2xl font-extrabold text-[#11242e]">
                  {enrolLift}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#5a6a72] font-semibold">
                  Lead confidence
                </div>
                <div
                  className={
                    enoughLeadData
                      ? "text-sm font-semibold text-[#11242e]"
                      : "text-sm font-semibold text-[#b3412e]"
                  }
                >
                  {enoughLeadData
                    ? "Enough data to read"
                    : `Need ≥30 per side (have ${aQual}/${bQual})`}
                </div>
              </div>
            </div>

            {(aBillable > 0 || bBillable > 0) && (
              <p className="text-[11px] text-[#5a6a72] italic">
                Enrolment data is a lagging indicator — leads take 2–6 weeks to
                convert (or be marked lost). Read the lead lift early; trust
                the enrolment lift when the totals stabilise.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}