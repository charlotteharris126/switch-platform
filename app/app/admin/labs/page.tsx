import { createAdminClient } from "@/lib/supabase/admin";
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

interface FunnelRow {
  tool: string;
  views: number;
  unlock_intents: number;
  radar_subscribes: number;
  autopilot_subscribes: number;
  view_to_unlock_pct: number | null;
  unlock_to_radar_pct: number | null;
  unlock_to_autopilot_pct: number | null;
}

interface SignupRow {
  created_at: string;
  tool: string;
  email: string;
  payload: Record<string, unknown> | null;
  attribution: Record<string, unknown> | null;
}

interface TargetingRow {
  category: string;
  value: string;
  cnt: number;
}

interface Opportunity {
  title: string;
  why: string;
  score: number;
  potential: string;
  competition: string;
  kind: string;
}

interface RunRow {
  id: string;
  created_at: string;
  town: string | null;
  interests: string[] | null;
  skills: string[] | null;
  summary: string | null;
  opportunities: Opportunity[] | null;
  attribution: Record<string, unknown> | null;
}

const TOOL_LABEL: Record<string, string> = {
  amistuck: "Am I Stuck?",
  gaply: "Gaply",
};

const CATEGORY_LABEL: Record<string, string> = {
  town: "Towns",
  skill: "Skills",
  interest: "Interests",
  budget: "Budget",
};

const CATEGORY_ORDER = ["town", "skill", "interest", "budget"];

export default async function LabsPage() {
  const supabase = createAdminClient();

  const [
    { data: funnel, error: funnelErr },
    { data: signups, error: signupErr },
    { data: targeting, error: targetingErr },
    { data: runs, error: runsErr },
  ] = await Promise.all([
    supabase.rpc("admin_labs_funnel"),
    supabase.rpc("admin_labs_recent_signups", { p_limit: 50 }),
    supabase.rpc("admin_labs_targeting", { p_tool: "gaply" }),
    supabase
      .from("events")
      .select("id, created_at, payload, attribution")
      .eq("tool", "gaply")
      .eq("event", "run")
      .not("payload->opportunities", "is", null)
      .order("created_at", { ascending: false })
      .limit(20)
      .schema("labs"),
  ]);

  const rows = (funnel as FunnelRow[] | null) ?? [];
  const signupRows = (signups as SignupRow[] | null) ?? [];
  const targetingRows = (targeting as TargetingRow[] | null) ?? [];
  const runRows: RunRow[] = ((runs as Array<{ id: string; created_at: string; payload: Record<string, unknown>; attribution: Record<string, unknown> | null }> | null) ?? []).map((r) => ({
    id: r.id,
    created_at: r.created_at,
    town: r.payload?.town as string | null,
    interests: r.payload?.interests as string[] | null,
    skills: r.payload?.skills as string[] | null,
    summary: r.payload?.summary as string | null,
    opportunities: r.payload?.opportunities as Opportunity[] | null,
    attribution: r.attribution,
  }));

  // Group targeting rows by category
  const byCategory: Record<string, TargetingRow[]> = {};
  for (const r of targetingRows) {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  }

  const hasTargeting = targetingRows.length > 0;

  return (
    <div>
      <PageHeader
        eyebrow="Switchable Labs"
        title="Labs funnel"
        subtitle="Gaply smoke-test funnel. Bot traffic excluded, sessions deduped. View = page load, £17 click = unlock button (no money taken yet)."
      />

      {(funnelErr || signupErr || targetingErr) && (
        <p className="mb-6 text-sm text-red-600">
          Couldn&apos;t load Labs data:{" "}
          {funnelErr?.message || signupErr?.message || targetingErr?.message}
        </p>
      )}

      {/* Funnel */}
      <section className="mb-10">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead className="text-right">Views</TableHead>
              <TableHead className="text-right">£17 clicks</TableHead>
              <TableHead className="text-right">Radar</TableHead>
              <TableHead className="text-right">Autopilot</TableHead>
              <TableHead className="text-right">View → £17</TableHead>
              <TableHead className="text-right">£17 → Radar</TableHead>
              <TableHead className="text-right">£17 → Autopilot</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.tool}>
                <TableCell className="font-medium">
                  {TOOL_LABEL[r.tool] ?? r.tool}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.views}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.unlock_intents}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.radar_subscribes}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.autopilot_subscribes}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {pct(r.view_to_unlock_pct)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {pct(r.unlock_to_radar_pct)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {pct(r.unlock_to_autopilot_pct)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-3 text-xs text-[#5a6a72]">
          Gaply only. Am I Stuck? not in test yet. Radar and Autopilot subscribe clicks
          are intent signals — no card taken.
        </p>
      </section>

      {/* Targeting signals */}
      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold text-[#11242e]">
          Who is using Gaply (from run events)
        </h2>
        {!hasTargeting ? (
          <p className="text-sm text-[#5a6a72]">No run data yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-6 max-w-3xl">
            {CATEGORY_ORDER.filter((c) => byCategory[c]?.length).map((cat) => (
              <div key={cat}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#5a6a72]">
                  {CATEGORY_LABEL[cat] ?? cat}
                </h3>
                <div className="space-y-1">
                  {byCategory[cat].slice(0, 10).map((r) => (
                    <div key={r.value} className="flex items-center gap-2">
                      <div
                        className="h-2 rounded-full bg-[#059669]"
                        style={{
                          width: `${Math.round(
                            (r.cnt / byCategory[cat][0].cnt) * 120
                          )}px`,
                          minWidth: "4px",
                        }}
                      />
                      <span className="text-xs text-[#11242e] capitalize">{r.value}</span>
                      <span className="ml-auto text-xs tabular-nums text-[#5a6a72]">
                        {r.cnt}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-[#5a6a72]">
          From tool runs only. Sessions where someone used the quiz at least once.
        </p>
      </section>

      {/* Income models */}
      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold text-[#11242e]">Income models</h2>
        <div className="grid grid-cols-2 gap-4 max-w-2xl">
          <a
            href="/models/gaply-calculator.html"
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-lg border border-[#dde3e7] bg-white p-4 hover:border-[#b0bec5] transition-colors"
          >
            <div className="text-xs font-bold uppercase tracking-wide text-[#059669] mb-1">Labs calculator</div>
            <div className="text-sm font-semibold text-[#11242e] mb-1">Income model</div>
            <div className="text-xs text-[#5a6a72]">Gaply (Test B), Test A — existing operators, Am I Stuck? Presets per product, Conservative / Mid / Strong scenarios.</div>
          </a>
          <a
            href="/models/gaply-vs-pps.html"
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-lg border border-[#dde3e7] bg-white p-4 hover:border-[#b0bec5] transition-colors"
          >
            <div className="text-xs font-bold uppercase tracking-wide text-[#2563eb] mb-1">Comparison</div>
            <div className="text-sm font-semibold text-[#11242e] mb-1">Gaply vs SwitchLeads PPS</div>
            <div className="text-xs text-[#5a6a72]">Side-by-side at equal ad spend. Seeded with real DB unit economics — 6.4% conversion, £22 CPL.</div>
          </a>
        </div>
      </section>

      {/* Run outputs */}
      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold text-[#11242e]">
          What the AI is returning (recent runs with stored output)
        </h2>
        {runsErr && <p className="text-sm text-red-600 mb-3">{runsErr.message}</p>}
        {runRows.length === 0 ? (
          <p className="text-sm text-[#5a6a72]">No runs with stored output yet. Runs from after 25 June 2026 will appear here.</p>
        ) : (
          <div className="space-y-6">
            {runRows.map((run) => (
              <div key={run.id} className="border border-[#dde3e7] rounded-lg p-4 bg-white">
                <div className="flex items-start justify-between gap-4 mb-2">
                  <div>
                    <span className="font-semibold text-[#11242e] capitalize">{run.town ?? "Unknown town"}</span>
                    <span className="text-xs text-[#5a6a72] ml-2">{fmtDate(run.created_at)}</span>
                    {source(run.attribution) && (
                      <span className="text-xs text-[#5a6a72] ml-2">· {source(run.attribution)}</span>
                    )}
                  </div>
                </div>
                {(run.interests?.length || run.skills?.length) && (
                  <p className="text-xs text-[#5a6a72] mb-3">
                    {run.interests?.join(", ")}
                    {run.interests?.length && run.skills?.length ? " · " : ""}
                    {run.skills?.join(", ")}
                  </p>
                )}
                {run.summary && <p className="text-xs italic text-[#5a6a72] mb-3">{run.summary}</p>}
                {run.opportunities && (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[#dde3e7]">
                        <th className="text-left py-1 pr-3 font-semibold text-[#11242e] w-6">#</th>
                        <th className="text-left py-1 pr-3 font-semibold text-[#11242e]">Business</th>
                        <th className="text-right py-1 pr-3 font-semibold text-[#11242e] w-12">Score</th>
                        <th className="text-left py-1 pr-3 font-semibold text-[#11242e] w-20">Competition</th>
                        <th className="text-left py-1 font-semibold text-[#11242e] w-24">Potential</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.opportunities.map((opp, i) => (
                        <tr key={i} className="border-b border-[#f0f0f0] last:border-0">
                          <td className="py-1 pr-3 text-[#5a6a72]">{i + 1}</td>
                          <td className="py-1 pr-3 text-[#11242e]">
                            <div className="font-medium">{opp.title}</div>
                            <div className="text-[#5a6a72] mt-0.5">{opp.why}</div>
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums font-medium">{opp.score}%</td>
                          <td className="py-1 pr-3 text-[#5a6a72]">{opp.competition}</td>
                          <td className="py-1 text-[#5a6a72]">{opp.potential}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recent signups */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-[#11242e]">
          Recent signups ({signupRows.length})
        </h2>
        {signupRows.length === 0 ? (
          <p className="text-sm text-[#5a6a72]">No signups yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Tool</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Context</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {signupRows.map((s, i) => (
                <TableRow key={`${s.created_at}-${i}`}>
                  <TableCell className="whitespace-nowrap">
                    {fmtDate(s.created_at)}
                  </TableCell>
                  <TableCell>{TOOL_LABEL[s.tool] ?? s.tool}</TableCell>
                  <TableCell>{s.email}</TableCell>
                  <TableCell className="text-[#5a6a72]">{context(s)}</TableCell>
                  <TableCell className="text-[#5a6a72]">
                    {source(s.attribution)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

function pct(v: number | null): string {
  return v == null ? "—" : `${v}%`;
}

function fmtDate(s: string): string {
  try {
    return new Date(s).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return s;
  }
}

function context(s: SignupRow): string {
  const p = s.payload ?? {};
  if (s.tool === "gaply") return (p.town as string) ?? "";
  return (p.job as string) ?? (p.role as string) ?? "";
}

function source(a: Record<string, unknown> | null): string {
  if (!a) return "";
  return [a.utm_source, a.utm_campaign].filter(Boolean).join(" / ");
}
