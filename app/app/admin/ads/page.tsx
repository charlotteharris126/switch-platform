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
import { Card, CardContent } from "@/components/ui/card";
import { PasteForm } from "./paste-form";
import { DeleteButton } from "./delete-button";

interface AdSpendRow {
  id: number;
  date: string;
  ad_account_id: string | null;
  spend: number | null;
  leads: number | null;
  impressions: number | null;
  clicks: number | null;
  cost_per_lead: number | null;
  fetched_at: string | null;
}

function gbp(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 2 }).format(n);
}

function intFmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function formatDateUK(d: string): string {
  return new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default async function AdsPage() {
  const supabase = await createClient();

  // Pull last 30 days. Manual rows + (eventually) API rows in one set.
  const cutoffDate = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const cutoffISO = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const [adsRes, dbLeadsRes] = await Promise.all([
    supabase
      .schema("ads_switchable")
      .from("meta_daily")
      .select("id, date, ad_account_id, spend, leads, impressions, clicks, cost_per_lead, fetched_at")
      .gte("date", cutoffDate)
      .order("date", { ascending: false }),
    // Qualified leads in our DB, same 30-day window. True CPL denominator.
    // Pilot assumption: Meta is the dominant paid channel, so total qualified
    // leads ≈ Meta-attributable leads. Filter on attribution once SwitchLeads
    // ads or organic ramp.
    supabase
      .schema("leads")
      .from("submissions")
      .select("email")
      .eq("is_dq", false)
      .is("archived_at", null)
      .gte("submitted_at", cutoffISO),
  ]);

  const { data, error } = adsRes;
  const rows = (data ?? []) as AdSpendRow[];
  const manualRows = rows.filter((r) => r.ad_account_id === "manual_paste");
  const apiRows = rows.filter((r) => r.ad_account_id !== "manual_paste");

  const totalSpend = rows.reduce((s, r) => s + Number(r.spend ?? 0), 0);
  const metaReportedLeads = rows.reduce((s, r) => s + Number(r.leads ?? 0), 0);
  const metaCpl = metaReportedLeads > 0 ? totalSpend / metaReportedLeads : null;

  // True CPL: Meta spend ÷ qualified leads in our DB (distinct emails).
  const dbLeadRows = (dbLeadsRes.data ?? []) as Array<{ email: string | null }>;
  const dbDistinctLeads = new Set(
    dbLeadRows.map((r) => r.email?.toLowerCase().trim() ?? "").filter((e) => e.length > 0)
  ).size;
  const trueCpl = dbDistinctLeads > 0 ? totalSpend / dbDistinctLeads : null;

  // Variance: how much higher True CPL is than Meta CPL. Meta typically
  // under-reports leads (cookie blocking, iOS), so True CPL > Meta CPL is
  // normal. The reverse direction (DB undercount) signals a system issue.
  const variancePct =
    metaCpl !== null && trueCpl !== null && metaCpl > 0
      ? ((trueCpl - metaCpl) / metaCpl) * 100
      : null;

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        eyebrow="Tools"
        title="Ad spend"
        subtitle={
          error ? (
            <span className="text-[#b3412e]">Error: {error.message}</span>
          ) : (
            <>Switchable Meta spend, last 30 days. Pasted manually for now; auto-ingested via Meta Marketing API once that's wired.</>
          )
        }
      />

      {apiRows.length === 0 && manualRows.length === 0 ? (
        <Card className="bg-[#fef9f5] border-[#cd8b76]/40">
          <CardContent className="pt-4 text-xs text-[#11242e]">
            <strong>No spend logged yet.</strong> Paste yesterday&rsquo;s totals from Meta Ads Manager below. Open the
            account, set date range to "Yesterday", note the total spend and leads, then enter them here. Takes 30
            seconds a day.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Tile label="30-day spend" value={gbp(totalSpend)} />
            <Tile label="True CPL" value={gbp(trueCpl)} note={`Spend ÷ ${intFmt(dbDistinctLeads)} DB leads`} highlight />
            <Tile label="Meta-reported CPL" value={gbp(metaCpl)} note={`Spend ÷ ${intFmt(metaReportedLeads)} Meta leads`} />
            <Tile
              label="Variance"
              value={variancePct === null ? "—" : `${variancePct >= 0 ? "+" : ""}${variancePct.toFixed(0)}%`}
              note={
                variancePct === null
                  ? "Need both numbers"
                  : variancePct > 0
                    ? "Meta under-reports (normal)"
                    : variancePct < -5
                      ? "DB under-reports — investigate"
                      : "Aligned"
              }
            />
          </div>
          <p className="text-[10px] text-[#5a6a72] italic">
            <strong>True CPL</strong> uses our database lead count (ground truth). <strong>Meta-reported</strong> uses
            Meta&rsquo;s pixel/CAPI count. Meta typically under-counts due to cookie blocking and iOS, so True CPL is
            usually higher. Lead reconciliation lives on <Link href="/errors" className="underline">Data health</Link>.
          </p>
        </>
      )}

      <section>
        <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">Add a day</h2>
        <PasteForm />
      </section>

      <section>
        <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">Last 30 days</h2>
        {rows.length === 0 ? (
          <p className="text-xs text-[#5a6a72] italic">Nothing logged in the last 30 days.</p>
        ) : (
          <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Impressions</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">CPL</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs whitespace-nowrap">{formatDateUK(r.date)}</TableCell>
                    <TableCell className="text-xs text-right font-bold">{gbp(r.spend)}</TableCell>
                    <TableCell className="text-xs text-right">{intFmt(r.leads)}</TableCell>
                    <TableCell className="text-xs text-right text-[#5a6a72]">{intFmt(r.impressions)}</TableCell>
                    <TableCell className="text-xs text-right text-[#5a6a72]">{intFmt(r.clicks)}</TableCell>
                    <TableCell className="text-xs text-right font-bold">{gbp(r.cost_per_lead)}</TableCell>
                    <TableCell className="text-[10px] text-[#5a6a72]">
                      {r.ad_account_id === "manual_paste" ? "Manual" : "API"}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.ad_account_id === "manual_paste" ? <DeleteButton date={r.date} /> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  highlight,
}: {
  label: string;
  value: string;
  note?: string;
  highlight?: boolean;
}) {
  const border = highlight ? "border-2 border-[#cd8b76]" : "border border-[#dad4cb]";
  const valueCls = highlight ? "text-[#cd8b76]" : "text-[#11242e]";
  return (
    <div className={`bg-white ${border} rounded-xl p-4`}>
      <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">{label}</p>
      <p className={`text-2xl font-extrabold mt-2 tracking-tight ${valueCls}`}>{value}</p>
      {note ? <p className="text-[10px] text-[#5a6a72] mt-1">{note}</p> : null}
    </div>
  );
}
