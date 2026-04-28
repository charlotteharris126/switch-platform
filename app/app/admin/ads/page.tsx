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
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .schema("ads_switchable")
    .from("meta_daily")
    .select("id, date, ad_account_id, spend, leads, impressions, clicks, cost_per_lead, fetched_at")
    .gte("date", cutoff)
    .order("date", { ascending: false });

  const rows = (data ?? []) as AdSpendRow[];
  const manualRows = rows.filter((r) => r.ad_account_id === "manual_paste");
  const apiRows = rows.filter((r) => r.ad_account_id !== "manual_paste");

  const totalSpend = rows.reduce((s, r) => s + Number(r.spend ?? 0), 0);
  const totalLeads = rows.reduce((s, r) => s + Number(r.leads ?? 0), 0);
  const blendedCpl = totalLeads > 0 ? totalSpend / totalLeads : null;

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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Tile label="30-day spend" value={gbp(totalSpend)} />
          <Tile label="30-day leads" value={intFmt(totalLeads)} />
          <Tile label="Blended CPL" value={gbp(blendedCpl)} />
          <Tile label="Days logged" value={`${rows.length} of 30`} />
        </div>
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

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-4">
      <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">{label}</p>
      <p className="text-2xl font-extrabold mt-2 tracking-tight text-[#11242e]">{value}</p>
    </div>
  );
}
