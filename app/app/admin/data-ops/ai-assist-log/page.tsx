// /admin/data-ops/ai-assist-log — recent AI-assist calls + cost rollup.
// Reads editorial.ai_assist_log via the admin client (RLS allows admin read).
// Lightweight read-only view: last 50 calls + daily/weekly/monthly totals.

import { PageHeader } from "@/components/page-header";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Row = {
  id: number;
  kind: string;
  post_slug: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  latency_ms: number;
  ok: boolean;
  error_message: string | null;
  created_at: string;
};

async function loadRecent(): Promise<Row[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .schema("editorial")
    .from("ai_assist_log")
    .select("id, kind, post_slug, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, latency_ms, ok, error_message, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`Could not read ai_assist_log: ${error.message}`);
  return (data ?? []) as Row[];
}

async function loadTotals(): Promise<{ today: number; week: number; month: number; lifetime: number; calls_today: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_ai_assist_totals");
  if (!error && data) {
    const row = Array.isArray(data) ? data[0] : data;
    return {
      today: Number(row?.today ?? 0),
      week: Number(row?.week ?? 0),
      month: Number(row?.month ?? 0),
      lifetime: Number(row?.lifetime ?? 0),
      calls_today: Number(row?.calls_today ?? 0),
    };
  }
  // RPC not in schema (no migration yet) — fall back to computing in JS from
  // the full log table. Cheap for current volumes.
  const { data: all } = await admin
    .schema("editorial")
    .from("ai_assist_log")
    .select("cost_usd, created_at");
  const now = Date.now();
  const D = 24 * 60 * 60 * 1000;
  let today = 0, week = 0, month = 0, lifetime = 0, calls_today = 0;
  for (const r of (all ?? []) as Array<{ cost_usd: number; created_at: string }>) {
    const ageMs = now - new Date(r.created_at).getTime();
    lifetime += Number(r.cost_usd || 0);
    if (ageMs <= 30 * D) month += Number(r.cost_usd || 0);
    if (ageMs <= 7 * D)  week  += Number(r.cost_usd || 0);
    if (ageMs <= 1 * D)  { today += Number(r.cost_usd || 0); calls_today++; }
  }
  return { today, week, month, lifetime, calls_today };
}

export default async function AiAssistLogPage() {
  let rows: Row[] = [];
  let totals = { today: 0, week: 0, month: 0, lifetime: 0, calls_today: 0 };
  let loadError: string | null = null;
  try {
    [rows, totals] = await Promise.all([loadRecent(), loadTotals()]);
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const fmtUsd = (n: number) => `$${n.toFixed(4)}`;
  const fmtCents = (n: number) => `${(n * 100).toFixed(3)}¢`;

  return (
    <div className="max-w-6xl space-y-6 py-6">
      <PageHeader
        eyebrow="Tools"
        title="AI assist log"
        subtitle="Every Suggest button click in /admin/blog logs here. Cost, latency, model, and any error message. Rate limit on the Edge Function: 30 calls/min, 200 calls/day."
      />

      {loadError && (
        <p className="text-sm text-[#b3412e] bg-white border border-[#e9b3a4] rounded-md p-3">
          Could not load log: {loadError}
        </p>
      )}

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Today" value={fmtUsd(totals.today)} sub={`${totals.calls_today} calls`} />
        <Stat label="Last 7 days" value={fmtUsd(totals.week)} />
        <Stat label="Last 30 days" value={fmtUsd(totals.month)} />
        <Stat label="Lifetime" value={fmtUsd(totals.lifetime)} />
      </section>

      <section className="bg-white rounded-xl border border-[#e5dfd8] overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[#f5f2eb] text-[#5a6a72] uppercase tracking-wide">
            <tr>
              <th className="text-left px-3 py-2 font-bold">When</th>
              <th className="text-left px-3 py-2 font-bold">Kind</th>
              <th className="text-left px-3 py-2 font-bold">Post</th>
              <th className="text-right px-3 py-2 font-bold">Tokens (in / out / cached)</th>
              <th className="text-right px-3 py-2 font-bold">Cost</th>
              <th className="text-right px-3 py-2 font-bold">Latency</th>
              <th className="text-left px-3 py-2 font-bold">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loadError && (
              <tr><td colSpan={7} className="text-center px-3 py-8 text-[#5a6a72]">No calls yet.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-[#f5f2eb] hover:bg-[#fafaf7]">
                <td className="px-3 py-2 font-mono text-[10px]">{new Date(r.created_at).toLocaleString("en-GB")}</td>
                <td className="px-3 py-2 font-bold">{r.kind}</td>
                <td className="px-3 py-2 font-mono text-[10px]">{r.post_slug ?? "—"}</td>
                <td className="px-3 py-2 text-right font-mono">{r.input_tokens} / {r.output_tokens} / {r.cache_read_tokens}</td>
                <td className="px-3 py-2 text-right font-mono">{fmtCents(Number(r.cost_usd))}</td>
                <td className="px-3 py-2 text-right font-mono">{r.latency_ms}ms</td>
                <td className="px-3 py-2">
                  {r.ok
                    ? <span className="inline-block px-2 py-0.5 rounded-full bg-[#dcefea] text-[#1f5f5e] border border-[#bcdfd8] text-[10px] font-bold">OK</span>
                    : <span className="inline-block px-2 py-0.5 rounded-full bg-[#f7d8d0] text-[#8a2e1a] border border-[#e9b3a4] text-[10px] font-bold" title={r.error_message ?? undefined}>FAIL</span>
                  }
                  {!r.ok && r.error_message && (
                    <p className="text-[10px] text-[#8a2e1a] mt-1 max-w-md truncate" title={r.error_message}>{r.error_message}</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-[#e5dfd8] rounded-xl p-3">
      <p className="text-[10px] font-bold uppercase tracking-wide text-[#5a6a72]">{label}</p>
      <p className="text-xl font-extrabold text-[#11242e] mt-1">{value}</p>
      {sub && <p className="text-[10px] text-[#5a6a72] mt-0.5">{sub}</p>}
    </div>
  );
}
