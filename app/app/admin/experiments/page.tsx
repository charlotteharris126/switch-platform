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

interface SubmissionRow {
  id: number;
  experiment_id: string | null;
  experiment_variant: string | null;
  is_dq: boolean | null;
  submitted_at: string;
}

interface VariantStats {
  count: number;
  earliest: string;
  latest: string;
  dqCount: number;
}

interface ExperimentSummary {
  id: string;
  variants: Map<string, VariantStats>;
  totalLeads: number;
  totalQualifiedLeads: number;
  earliest: string;
  latest: string;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateOnly(iso: string): string {
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

export default async function ExperimentsPage() {
  const supabase = await createClient();

  // Pull every submission that carries an experiment_id. Re-applications
  // (parent_submission_id is set) are excluded from variant attribution
  // counts because they don't represent fresh paid impressions — same
  // filter the rest of the dashboard uses for paid-lead counting.
  const { data, error } = await supabase
    .schema("leads")
    .from("submissions")
    .select("id, experiment_id, experiment_variant, is_dq, submitted_at")
    .not("experiment_id", "is", null)
    .is("parent_submission_id", null)
    .order("submitted_at", { ascending: false })
    .limit(5000);

  const rows = (data ?? []) as SubmissionRow[];

  // Aggregate by experiment_id → variant. JS-side because the supabase-js
  // client doesn't expose GROUP BY directly and we expect O(hundreds) of
  // rows per experiment at pilot scale, well within a single-pass aggregate.
  const byExperiment = new Map<string, ExperimentSummary>();
  for (const row of rows) {
    const expId = row.experiment_id;
    const variant = row.experiment_variant ?? "unknown";
    if (!expId) continue;

    let summary = byExperiment.get(expId);
    if (!summary) {
      summary = {
        id: expId,
        variants: new Map(),
        totalLeads: 0,
        totalQualifiedLeads: 0,
        earliest: row.submitted_at,
        latest: row.submitted_at,
      };
      byExperiment.set(expId, summary);
    }

    let v = summary.variants.get(variant);
    if (!v) {
      v = { count: 0, earliest: row.submitted_at, latest: row.submitted_at, dqCount: 0 };
      summary.variants.set(variant, v);
    }
    v.count += 1;
    if (row.is_dq) v.dqCount += 1;
    if (row.submitted_at < v.earliest) v.earliest = row.submitted_at;
    if (row.submitted_at > v.latest) v.latest = row.submitted_at;

    summary.totalLeads += 1;
    if (!row.is_dq) summary.totalQualifiedLeads += 1;
    if (row.submitted_at < summary.earliest) summary.earliest = row.submitted_at;
    if (row.submitted_at > summary.latest) summary.latest = row.submitted_at;
  }

  // Sort experiments by most recent activity first.
  const experiments = Array.from(byExperiment.values()).sort((a, b) =>
    b.latest.localeCompare(a.latest),
  );

  return (
    <div className="max-w-6xl space-y-8">
      <PageHeader
        eyebrow="Tools"
        title="Experiments"
        subtitle={
          error ? (
            <span className="text-[#b3412e]">Error loading experiments: {error.message}</span>
          ) : experiments.length === 0 ? (
            <>
              No experiments have collected leads yet. When a Switchable funded /
              self-funded / loan-funded page YAML carries an <code>experiment:</code>{" "}
              block and starts receiving traffic, it shows up here. Each lead row
              records which experiment + variant was served to the visitor (via
              the <code>experiment_id</code> and <code>experiment_variant</code>{" "}
              columns on <code>leads.submissions</code>).
            </>
          ) : (
            <>
              Per-variant lead counts for every A/B experiment that has captured
              at least one submission. Variant A is the canonical page; variant B
              is the challenger. Re-applications are excluded so counts reflect
              fresh paid impressions only.
            </>
          )
        }
      />

      {experiments.map((exp) => {
        const variantA = exp.variants.get("a");
        const variantB = exp.variants.get("b");
        const aCount = variantA?.count ?? 0;
        const bCount = variantB?.count ?? 0;
        const aQual = aCount - (variantA?.dqCount ?? 0);
        const bQual = bCount - (variantB?.dqCount ?? 0);

        // With a 50/50 sticky-cookie split, total visitors are split
        // approximately evenly across variants. The variant with more
        // qualified leads has the higher conversion rate. Express that
        // as a relative lift of B over A.
        let lift: string = "—";
        let liftLabel: string = "Lift (B vs A)";
        if (aQual > 0 && bQual > 0) {
          const liftPct = ((bQual - aQual) / aQual) * 100;
          const sign = liftPct > 0 ? "+" : "";
          lift = `${sign}${liftPct.toFixed(1)}%`;
        } else if (aQual === 0 && bQual > 0) {
          lift = "B-only leads";
        } else if (bQual === 0 && aQual > 0) {
          lift = "A-only leads";
        }

        // Statistical-significance flag: very rough, just "do we have enough
        // data to read into the lift". Threshold: at least 30 qualified
        // leads on each side. Below that, treat the lift as noise.
        const enoughData = aQual >= 30 && bQual >= 30;

        return (
          <section
            key={exp.id}
            className="rounded-2xl border border-[#e5dfd8] bg-white p-6 space-y-4"
          >
            <div className="flex items-baseline justify-between gap-4 flex-wrap">
              <h2 className="font-extrabold text-[#11242e] text-lg">{exp.id}</h2>
              <span className="text-xs text-[#5a6a72]">
                {formatDateOnly(exp.earliest)} → {formatDateOnly(exp.latest)} ·{" "}
                {exp.totalLeads} total submission{exp.totalLeads === 1 ? "" : "s"} ({exp.totalQualifiedLeads} qualified)
              </span>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variant</TableHead>
                  <TableHead className="text-right">Submissions</TableHead>
                  <TableHead className="text-right">Qualified</TableHead>
                  <TableHead className="text-right">DQ rate</TableHead>
                  <TableHead>First seen</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Array.from(exp.variants.entries())
                  .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
                  .map(([variant, stats]) => {
                    const isCanonical = variant === "a";
                    const qualified = stats.count - stats.dqCount;
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
                          {qualified}
                        </TableCell>
                        <TableCell className="text-right text-xs text-[#5a6a72]">
                          {pct(stats.dqCount, stats.count)}
                        </TableCell>
                        <TableCell className="text-xs text-[#5a6a72]">
                          {formatDate(stats.earliest)}
                        </TableCell>
                        <TableCell className="text-xs text-[#5a6a72]">
                          {formatDate(stats.latest)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>

            {variantA && variantB && (
              <div className="flex items-center gap-6 pt-2 border-t border-[#f0ebe5]">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[#5a6a72] font-semibold">
                    {liftLabel}
                  </div>
                  <div className="text-2xl font-extrabold text-[#11242e]">
                    {lift}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-[#5a6a72] font-semibold">
                    Confidence
                  </div>
                  <div
                    className={
                      enoughData
                        ? "text-sm font-semibold text-[#11242e]"
                        : "text-sm font-semibold text-[#b3412e]"
                    }
                  >
                    {enoughData
                      ? "Enough data to read"
                      : `Need ≥30 per side (have ${aQual}/${bQual} qualified)`}
                  </div>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
