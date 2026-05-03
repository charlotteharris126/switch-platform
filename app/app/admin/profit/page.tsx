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
import { CustomRangeForm } from "./custom-range-form";

// Force dynamic. Without this, page data fetches can be cached across
// navigations even when searchParams change — Custom date Apply would
// update the URL but reuse the prior render's figures.
export const dynamic = "force-dynamic";

type Period = "2d" | "7d" | "14d" | "30d" | "lifetime" | "custom";
type Bucket = "week" | "month";

const PERIOD_DAYS: Record<"2d" | "7d" | "14d" | "30d", number> = {
  "2d": 2,
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

const PERIOD_LABEL: Record<Period, string> = {
  "2d": "Last 2 days",
  "7d": "Last 7 days",
  "14d": "Last 14 days",
  "30d": "Last 30 days",
  lifetime: "Lifetime",
  custom: "Custom",
};

function gbp(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 2,
  }).format(n);
}

function intFmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

function pctFmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function formatDateUK(ymd: string): string {
  return new Date(ymd + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

interface Window {
  fromISO: string;
  toISO: string;
  fromDate: string;
  toDate: string;
  label: string;
}

function resolveWindow(period: Period, customFrom?: string, customTo?: string): Window {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  if (period === "custom") {
    const fromYmd =
      customFrom ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const toYmd = customTo ?? today;
    const labelled = customFrom && customTo;
    return {
      fromISO: fromYmd + "T00:00:00Z",
      toISO: toYmd + "T23:59:59Z",
      fromDate: fromYmd,
      toDate: toYmd,
      label: labelled ? `${formatDateUK(fromYmd)} to ${formatDateUK(toYmd)}` : "Custom",
    };
  }
  if (period === "lifetime") {
    return {
      fromISO: "2020-01-01T00:00:00Z",
      toISO: now.toISOString(),
      fromDate: "2020-01-01",
      toDate: today,
      label: "Lifetime",
    };
  }
  const key = period as "2d" | "7d" | "14d" | "30d";
  const days = PERIOD_DAYS[key];
  const from = new Date(Date.now() - days * 24 * 3600 * 1000);
  return {
    fromISO: from.toISOString(),
    toISO: now.toISOString(),
    fromDate: from.toISOString().slice(0, 10),
    toDate: today,
    label: PERIOD_LABEL[period],
  };
}

function startOfWeek(d: Date): Date {
  const out = new Date(d);
  const day = out.getDay();
  const diff = (day + 6) % 7;
  out.setDate(out.getDate() - diff);
  out.setHours(0, 0, 0, 0);
  return out;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function bucketKey(d: Date, bucket: Bucket): string {
  const start = bucket === "week" ? startOfWeek(d) : startOfMonth(d);
  return start.toISOString().slice(0, 10);
}

function bucketLabel(key: string, bucket: Bucket): string {
  const start = new Date(key + "T00:00:00Z");
  if (bucket === "month") {
    return start.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  }
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const sLabel = start.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const eLabel = end.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${sLabel} to ${eLabel}`;
}

function classifyEnrolment(status: string | null | undefined): "enrolled" | "lost" | "open" {
  if (status === "enrolled") return "enrolled";
  if (status === "lost" || status === "cannot_reach" || status === "not_enrolled") return "lost";
  return "open";
}

function buildHref(params: {
  period?: Period;
  bucket?: Bucket;
  from?: string;
  to?: string;
}) {
  const usp = new URLSearchParams();
  if (params.period && params.period !== "30d") usp.set("period", params.period);
  if (params.bucket && params.bucket !== "week") usp.set("bucket", params.bucket);
  if (params.from) usp.set("from", params.from);
  if (params.to) usp.set("to", params.to);
  const qs = usp.toString();
  return qs ? `/profit?${qs}` : `/profit`;
}

function normalisePeriod(v: string | undefined): Period {
  if (v === "2d" || v === "7d" || v === "14d" || v === "lifetime" || v === "custom") return v;
  return "30d";
}

function normaliseBucket(v: string | undefined): Bucket {
  return v === "month" ? "month" : "week";
}

export default async function ProfitPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; bucket?: string; from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const period = normalisePeriod(sp.period);
  const bucket = normaliseBucket(sp.bucket);
  const customFrom = sp.from;
  const customTo = sp.to;
  const window = resolveWindow(period, customFrom, customTo);

  const supabase = await createClient();

  const [spendRes, leadsRes] = await Promise.all([
    supabase
      .schema("ads_switchable")
      .from("meta_daily")
      .select("date, spend")
      .gte("date", window.fromDate)
      .lte("date", window.toDate),
    supabase
      .schema("leads")
      .from("submissions")
      .select("id, email, submitted_at, primary_routed_to")
      .eq("is_dq", false)
      .is("archived_at", null)
      .is("parent_submission_id", null)
      .gte("submitted_at", window.fromISO)
      .lte("submitted_at", window.toISO),
  ]);

  const submissions = (leadsRes.data ?? []) as Array<{
    id: number;
    email: string | null;
    submitted_at: string;
    primary_routed_to: string | null;
  }>;
  const submissionIds = submissions.map((s) => s.id);

  const enrolmentsRes = submissionIds.length
    ? await supabase
        .schema("crm")
        .from("enrolments")
        .select("submission_id, status")
        .in("submission_id", submissionIds)
    : { data: [] as Array<{ submission_id: number; status: string }> };

  const enrolmentBySub = new Map<number, string>();
  for (const e of (enrolmentsRes.data ?? []) as Array<{ submission_id: number; status: string }>) {
    enrolmentBySub.set(e.submission_id, e.status);
  }

  const spendRows = (spendRes.data ?? []) as Array<{ date: string; spend: number | null }>;

  const totalSpend = spendRows.reduce((s, r) => s + Number(r.spend ?? 0), 0);
  const distinctLeadEmails = new Set(
    submissions
      .map((s) => s.email?.toLowerCase().trim() ?? "")
      .filter((e) => e.length > 0),
  );
  const totalLeads = distinctLeadEmails.size;

  let totalEnrolled = 0;
  let totalLost = 0;
  let totalOpen = 0;
  for (const s of submissions) {
    const klass = classifyEnrolment(enrolmentBySub.get(s.id));
    if (klass === "enrolled") totalEnrolled += 1;
    else if (klass === "lost") totalLost += 1;
    else totalOpen += 1;
  }

  const headlineCpl = totalLeads > 0 ? totalSpend / totalLeads : null;
  const costPerEnrolment = totalEnrolled > 0 ? totalSpend / totalEnrolled : null;
  const enrolmentRate = totalLeads > 0 ? totalEnrolled / totalLeads : null;

  const bucketMap = new Map<
    string,
    { spend: number; leads: number; open: number; lost: number; enrolled: number }
  >();
  function ensure(key: string) {
    if (!bucketMap.has(key)) {
      bucketMap.set(key, { spend: 0, leads: 0, open: 0, lost: 0, enrolled: 0 });
    }
    return bucketMap.get(key)!;
  }
  for (const r of spendRows) {
    const key = bucketKey(new Date(r.date + "T00:00:00Z"), bucket);
    ensure(key).spend += Number(r.spend ?? 0);
  }
  for (const s of submissions) {
    const key = bucketKey(new Date(s.submitted_at), bucket);
    const b = ensure(key);
    b.leads += 1;
    const klass = classifyEnrolment(enrolmentBySub.get(s.id));
    if (klass === "enrolled") b.enrolled += 1;
    else if (klass === "lost") b.lost += 1;
    else b.open += 1;
  }
  const buckets = Array.from(bucketMap.entries()).sort(([a], [b]) => b.localeCompare(a));

  const trackerLabel = bucket === "week" ? "weekly" : "monthly";

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        eyebrow="Tools"
        title="Profit tracker"
        subtitle={
          <>
            Spend, leads, enrolments. Eventually rolls in fixed costs for a full P&amp;L. Lead reconciliation (Meta vs DB)
            lives on <Link href="/errors" className="underline">Data health</Link>.
          </>
        }
      />

      <PeriodPills active={period} customFrom={customFrom} customTo={customTo} bucket={bucket} />

      {period === "custom" ? (
        <CustomRangeForm
          currentFrom={customFrom ?? window.fromDate}
          currentTo={customTo ?? window.toDate}
          bucket={bucket}
        />
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <Tile label="Spend" value={gbp(totalSpend)} />
        <Tile label="Leads" value={intFmt(totalLeads)} note="True (DB count)" />
        <Tile label="CPL" value={gbp(headlineCpl)} highlight />
        <Tile
          label="Enrolments"
          value={intFmt(totalEnrolled)}
          note={`${totalOpen} open, ${totalLost} lost`}
        />
        <Tile label="Enrolment rate" value={pctFmt(enrolmentRate)} note="Enrolled / leads" />
        <Tile label="Cost / enrolment" value={gbp(costPerEnrolment)} highlight />
      </div>

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">
            Tracker, {trackerLabel}
          </h2>
          <BucketToggle
            current={bucket}
            period={period}
            customFrom={customFrom}
            customTo={customTo}
          />
        </div>
        {buckets.length === 0 ? (
          <p className="text-xs text-[#5a6a72] italic">Nothing in this window.</p>
        ) : (
          <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{bucket === "week" ? "Week" : "Month"}</TableHead>
                  <TableHead className="text-right">Spend</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right">Lost</TableHead>
                  <TableHead className="text-right">Enrolled</TableHead>
                  <TableHead className="text-right">Enrol %</TableHead>
                  <TableHead className="text-right">CPL</TableHead>
                  <TableHead className="text-right">Cost / enrol</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {buckets.map(([key, v]) => {
                  const cpl = v.leads > 0 ? v.spend / v.leads : null;
                  const cpe = v.enrolled > 0 ? v.spend / v.enrolled : null;
                  const rate = v.leads > 0 ? v.enrolled / v.leads : null;
                  return (
                    <TableRow key={key}>
                      <TableCell className="text-xs whitespace-nowrap font-semibold">
                        {bucketLabel(key, bucket)}
                      </TableCell>
                      <TableCell className="text-xs text-right font-bold">{gbp(v.spend)}</TableCell>
                      <TableCell className="text-xs text-right">{intFmt(v.leads)}</TableCell>
                      <TableCell className="text-xs text-right text-[#5a6a72]">{v.open}</TableCell>
                      <TableCell className="text-xs text-right text-[#5a6a72]">{v.lost}</TableCell>
                      <TableCell className="text-xs text-right font-bold text-emerald-700">
                        {v.enrolled}
                      </TableCell>
                      <TableCell className="text-xs text-right">{pctFmt(rate)}</TableCell>
                      <TableCell className="text-xs text-right font-bold">{gbp(cpl)}</TableCell>
                      <TableCell className="text-xs text-right font-bold">{gbp(cpe)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

function PeriodPills({
  active,
  customFrom,
  customTo,
  bucket,
}: {
  active: Period;
  customFrom?: string;
  customTo?: string;
  bucket: Bucket;
}) {
  const periods: Period[] = ["2d", "7d", "14d", "30d", "lifetime", "custom"];
  return (
    <div className="flex flex-wrap gap-2">
      {periods.map((p) => {
        const isActive = p === active;
        const href =
          p === "custom"
            ? buildHref({ period: "custom", from: customFrom, to: customTo, bucket })
            : buildHref({ period: p, bucket });
        return (
          <Link
            key={p}
            href={href}
            className={
              isActive
                ? "px-3 h-7 inline-flex items-center text-[10px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#cd8b76] text-white border border-[#cd8b76]"
                : "px-3 h-7 inline-flex items-center text-[10px] font-bold uppercase tracking-[0.08em] rounded-full bg-white text-[#143643] border border-[#dad4cb] hover:border-[#cd8b76]/60"
            }
          >
            {PERIOD_LABEL[p]}
          </Link>
        );
      })}
    </div>
  );
}

function BucketToggle({
  current,
  period,
  customFrom,
  customTo,
}: {
  current: Bucket;
  period: Period;
  customFrom?: string;
  customTo?: string;
}) {
  const buckets: Bucket[] = ["week", "month"];
  return (
    <div className="flex gap-1">
      {buckets.map((b) => {
        const isActive = b === current;
        const href = buildHref({ period, bucket: b, from: customFrom, to: customTo });
        return (
          <Link
            key={b}
            href={href}
            className={
              isActive
                ? "px-2 h-6 inline-flex items-center text-[10px] font-bold uppercase tracking-[0.08em] rounded bg-[#143643] text-white"
                : "px-2 h-6 inline-flex items-center text-[10px] font-bold uppercase tracking-[0.08em] rounded bg-white text-[#143643] border border-[#dad4cb] hover:border-[#143643]/40"
            }
          >
            {b}
          </Link>
        );
      })}
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
