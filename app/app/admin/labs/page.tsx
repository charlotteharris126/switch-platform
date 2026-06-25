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
  runs: number;
  unlock_intents: number;
  signups: number;
  run_to_unlock_pct: number | null;
  run_to_signup_pct: number | null;
  unlock_to_signup_pct: number | null;
}

interface SignupRow {
  created_at: string;
  tool: string;
  email: string;
  payload: Record<string, unknown> | null;
  attribution: Record<string, unknown> | null;
}

const TOOL_LABEL: Record<string, string> = {
  amistuck: "Am I Stuck?",
  gaply: "Gaply",
};

export default async function LabsPage() {
  const supabase = createAdminClient();

  const [{ data: funnel, error: funnelErr }, { data: signups, error: signupErr }] =
    await Promise.all([
      supabase.rpc("admin_labs_funnel"),
      supabase.rpc("admin_labs_recent_signups", { p_limit: 50 }),
    ]);

  const rows = (funnel as FunnelRow[] | null) ?? [];
  const signupRows = (signups as SignupRow[] | null) ?? [];

  return (
    <div>
      <PageHeader
        eyebrow="Switchable Labs"
        title="Labs funnel"
        subtitle="Smoke-test funnel for the AI tools. Bot traffic excluded, sessions deduped. £17 click = the unlock button (no money taken yet), signup = email captured."
      />

      {(funnelErr || signupErr) && (
        <p className="mb-6 text-sm text-red-600">
          Couldn&apos;t load Labs data: {funnelErr?.message || signupErr?.message}
        </p>
      )}

      <section className="mb-10">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead className="text-right">£17 clicks</TableHead>
              <TableHead className="text-right">Signups</TableHead>
              <TableHead className="text-right">Run → £17</TableHead>
              <TableHead className="text-right">Run → signup</TableHead>
              <TableHead className="text-right">£17 → signup</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.tool}>
                <TableCell className="font-medium">
                  {TOOL_LABEL[r.tool] ?? r.tool}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.runs}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.unlock_intents}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.signups}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {pct(r.run_to_unlock_pct)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {pct(r.run_to_signup_pct)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {pct(r.unlock_to_signup_pct)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-3 text-xs text-[#5a6a72]">
          Success bar (locked model): run → signup ≥ ~5% promising, &lt; 2% kill.
          Cost-per-email is recorded once ad spend joins by campaign, not a gate on
          its own.
        </p>
      </section>

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
