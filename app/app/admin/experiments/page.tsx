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
}

interface EnrolmentRow {
  submission_id: number;
  status: string | null;
}

interface PageViewCountRow {
  experiment_id: string;
  variant: string;
  total_loads: number;     // every page load (raw row count)
  unique_sessions: number; // COUNT DISTINCT session_id (excludes nulls)
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
  uniqueSessions: number;    // unique visitors per migration 0162 — CVR denominator
  totalLoads: number;        // raw page loads (forensic only — includes refreshes, pre-consent loads, pre-0162 historical rows)
}

interface ExperimentSummary {
  id: string;
  manifest: ManifestEntry | null; // null if in DB but not in current manifest (ended)
  variants: Map<string, VariantStats>;
  totalLeads: number;
  totalQualifiedLeads: number;
  totalUniqueSessions: number;
  totalLoads: number;
  earliest: string | null;
  latest: string | null;
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

export default async function ExperimentsPage() {
  const supabase = await createClient();

  // 1. Pull every submission with experiment_id (re-applications excluded
  //    so counts reflect fresh paid impressions only).
  const submissionsQuery = await supabase
    .schema("leads")
    .from("submissions")
    .select("id, experiment_id, experiment_variant, is_dq, submitted_at")
    .not("experiment_id", "is", null)
    .is("parent_submission_id", null)
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
  //    ads_switchable.get_experiment_view_counts_v2 RPC (migration 0162).
  //    Returns both unique_sessions (the dedupable count — variant-router
  //    mints a 30-minute session UUID per consenting visitor) and total_loads
  //    (raw row count, useful for forensics). unique_sessions is the right
  //    CVR denominator going forward: it dedupes refreshes / back-button
  //    revisits, excludes the owner via the sw_is_owner cookie short-circuit
  //    in variant-router, and counts a visitor once per session regardless
  //    of traffic source (paid, organic, direct, email). v1 from migration
  //    0159 remains live and returns only total loads — preserved for any
  //    external caller.
  const viewsQuery = await supabase
    .schema("ads_switchable")
    .rpc("get_experiment_view_counts_v2");

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

  // View counts: { experimentId → { variant → { uniqueSessions, totalLoads } } }.
  // Rows come back pre-aggregated from the v2 RPC (one row per
  // experiment+variant pair) with both unique-session and total-load counts.
  // BIGINT values come back from postgres as JS strings (per
  // feedback_postgres3_bigint_returns_string.md) so Number() upfront.
  const viewsByExp = new Map<string, Map<string, { uniqueSessions: number; totalLoads: number }>>();
  for (const v of viewRows) {
    let byVariant = viewsByExp.get(v.experiment_id);
    if (!byVariant) {
      byVariant = new Map();
      viewsByExp.set(v.experiment_id, byVariant);
    }
    byVariant.set(v.variant, {
      uniqueSessions: Number(v.unique_sessions),
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
        totalLoads: 0,
        earliest: null,
        latest: null,
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
      v.totalLoads = counts.totalLoads;
      summary.totalUniqueSessions += counts.uniqueSessions;
      summary.totalLoads += counts.totalLoads;
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

      {experiments.map((exp) => {
        const isRunning = exp.manifest != null;
        const variantA = exp.variants.get("a") ?? emptyVariantStats();
        const variantB = exp.variants.get("b") ?? emptyVariantStats();
        const aQual = variantA.qualifiedCount;
        const bQual = variantB.qualifiedCount;
        // "Views" here means unique sessions (1 visitor = 1 view, per migration
        // 0162). totalLoads is kept for forensic display but isn't the CVR
        // denominator any more — refreshes and back-button revisits no longer
        // inflate it.
        const aViews = variantA.uniqueSessions;
        const bViews = variantB.uniqueSessions;
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
                <h2 className="font-extrabold text-[#11242e] text-lg">{exp.id}</h2>
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

            {isRunning && exp.manifest && (
              <div className="text-xs text-[#5a6a72] -mt-2">
                Page: <code className="text-[#11242e]">{exp.manifest.page_url}</code>
              </div>
            )}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variant</TableHead>
                  <TableHead className="text-right">Views</TableHead>
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
                          title={stats.totalLoads > 0
                            ? `${stats.totalLoads.toLocaleString()} raw load${stats.totalLoads === 1 ? "" : "s"} (includes refreshes, pre-consent + pre-2026-05-23 rows where session_id is NULL)`
                            : undefined}
                        >
                          {stats.uniqueSessions > 0 ? stats.uniqueSessions.toLocaleString() : "—"}
                        </TableCell>
                        <TableCell className="text-right">{stats.count}</TableCell>
                        <TableCell className="text-right font-semibold">
                          {stats.qualifiedCount}
                        </TableCell>
                        <TableCell className="text-right text-xs text-[#5a6a72]">
                          {pct(stats.qualifiedCount, stats.uniqueSessions)}
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