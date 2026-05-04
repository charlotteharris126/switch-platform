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

interface VariantStats {
  count: number;
  earliest: string | null;
  latest: string | null;
  dqCount: number;
  qualifiedCount: number;
  enrolmentTotal: number;
  enrolmentBillable: number; // status in (enrolled, presumed_enrolled)
  enrolmentInFlight: number; // status in (open, cannot_reach)
  enrolmentLost: number; // status = lost
}

interface ExperimentSummary {
  id: string;
  manifest: ManifestEntry | null; // null if experiment in DB but not in current manifest (already promoted/ended)
  variants: Map<string, VariantStats>;
  totalLeads: number;
  totalQualifiedLeads: number;
  earliest: string | null;
  latest: string | null;
}

const BILLABLE_STATUSES = new Set(["enrolled", "presumed_enrolled"]);
const IN_FLIGHT_STATUSES = new Set(["open", "cannot_reach"]);

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

  // 2. Pull enrolments for every submission carrying an experiment_id, so
  //    per-variant counts can include billable enrolment data alongside
  //    raw lead counts.
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

  // Index enrolments by submission_id for O(1) lookup during aggregation.
  const enrolmentsBySubmission = new Map<number, EnrolmentRow[]>();
  for (const e of enrolRows) {
    const list = enrolmentsBySubmission.get(e.submission_id) ?? [];
    list.push(e);
    enrolmentsBySubmission.set(e.submission_id, list);
  }

  // 3. Fetch the live experiments manifest from the site so currently-
  //    running experiments appear here even with zero leads in the DB.
  const { manifest, error: manifestError } = await fetchManifest();
  const manifestById = new Map<string, ManifestEntry>();
  if (manifest) {
    for (const e of manifest.experiments) manifestById.set(e.id, e);
  }

  // 4. Build per-experiment, per-variant aggregates from the DB rows.
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

    // Roll any enrolments for this submission into the variant's totals.
    const enrolments = enrolmentsBySubmission.get(row.id) ?? [];
    for (const e of enrolments) {
      v.enrolmentTotal += 1;
      if (e.status && BILLABLE_STATUSES.has(e.status)) v.enrolmentBillable += 1;
      else if (e.status && IN_FLIGHT_STATUSES.has(e.status)) v.enrolmentInFlight += 1;
      else if (e.status === "lost") v.enrolmentLost += 1;
    }

    summary.totalLeads += 1;
    if (!row.is_dq) summary.totalQualifiedLeads += 1;
    if (!summary.earliest || row.submitted_at < summary.earliest) summary.earliest = row.submitted_at;
    if (!summary.latest || row.submitted_at > summary.latest) summary.latest = row.submitted_at;
  }

  // 5. Add manifest-only experiments (currently running, no leads yet) so
  //    the page shows them even before any visitor has submitted.
  if (manifest) {
    for (const m of manifest.experiments) {
      if (!byExperiment.has(m.id)) {
        const s = getOrCreateSummary(m.id);
        // Pre-seed both expected variants so the table renders A and B
        // rows with zeros, making the test visibly "in flight".
        s.variants.set("a", emptyVariantStats());
        s.variants.set("b", emptyVariantStats());
      }
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
              No experiments are currently running and none have collected leads
              historically. When a Switchable funded / self-funded / loan-funded
              page YAML carries an <code>experiment:</code> block and the next
              site deploy lands, it shows up here. Each lead row records which
              experiment + variant was served via the <code>experiment_id</code>{" "}
              and <code>experiment_variant</code> columns on{" "}
              <code>leads.submissions</code>; enrolment counts come from{" "}
              <code>crm.enrolments</code> joined on submission id.
            </>
          ) : (
            <>
              Per-variant lead and enrolment counts for every running A/B test
              and every historical one with collected data. Variant A is the
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
        const aBillable = variantA.enrolmentBillable;
        const bBillable = variantB.enrolmentBillable;

        // Lead lift: B vs A on qualified-lead count (50/50 split assumed,
        // so the variant with more qualified leads has the higher
        // conversion rate).
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

        // Enrolment lift: same approach but on billable enrolments. This
        // is the business-truth metric (lead-gen success means nothing if
        // the leads don't enrol). Will be NULL for weeks after launch.
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

        // Lead-confidence threshold: at least 30 qualified leads on each
        // side. Below that, lift number is noise.
        const enoughLeadData = aQual >= 30 && bQual >= 30;

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
                  <TableHead className="text-right">Submissions</TableHead>
                  <TableHead className="text-right">Qualified</TableHead>
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
                        <TableCell className="text-right">{stats.count}</TableCell>
                        <TableCell className="text-right font-semibold">
                          {stats.qualifiedCount}
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
