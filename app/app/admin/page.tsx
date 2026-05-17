import Link from "next/link";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { Skeleton } from "@/components/loading-skeleton";
import { getDemoProviderIds, demoProviderInClause } from "@/lib/demo";
import { PeriodPicker, type Preset } from "./_components/period-picker";

type Period = Preset | "custom";

const PRESET_DAYS: Record<Preset, number | null> = {
  "2d": 2,
  "7d": 7,
  "14d": 14,
  "30d": 30,
  "lifetime": null,
};

const PRESET_LABEL: Record<Preset, string> = {
  "2d": "Last 2 days",
  "7d": "Last 7 days",
  "14d": "Last 14 days",
  "30d": "Last 30 days",
  "lifetime": "Lifetime",
};

interface Window {
  label: string;
  isLifetime: boolean;
  thisStartISO: string | null;
  thisEndISO: string | null;
  lastStartISO: string | null;
  lastEndISO: string | null;
  thisStartDate: string | null;
  thisEndDate: string | null;
  lastStartDate: string | null;
  lastEndDate: string | null;
}

function parsePeriod(sp: { period?: string; from?: string; to?: string }): {
  period: Period;
  customFrom?: string;
  customTo?: string;
  window: Window;
} {
  const raw = sp.period ?? "7d";
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  if (raw === "custom" && sp.from && sp.to && ISO_DATE.test(sp.from) && ISO_DATE.test(sp.to)) {
    const fromMs = Date.parse(`${sp.from}T00:00:00Z`);
    const toMs = Date.parse(`${sp.to}T00:00:00Z`);
    if (Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs <= toMs) {
      const spanMs = toMs - fromMs + 24 * 3600 * 1000;
      const thisStartISO = new Date(fromMs).toISOString();
      const thisEndISO = new Date(toMs + 24 * 3600 * 1000).toISOString();
      const lastStartISO = new Date(fromMs - spanMs).toISOString();
      return {
        period: "custom",
        customFrom: sp.from,
        customTo: sp.to,
        window: {
          label: `${sp.from} → ${sp.to}`,
          isLifetime: false,
          thisStartISO,
          thisEndISO,
          lastStartISO,
          lastEndISO: thisStartISO,
          thisStartDate: sp.from,
          thisEndDate: sp.to,
          lastStartDate: new Date(fromMs - spanMs).toISOString().slice(0, 10),
          lastEndDate: new Date(fromMs - 24 * 3600 * 1000).toISOString().slice(0, 10),
        },
      };
    }
  }

  const preset: Preset =
    raw === "2d" || raw === "14d" || raw === "30d" || raw === "lifetime" ? (raw as Preset) : "7d";
  const days = PRESET_DAYS[preset];

  if (days === null) {
    return {
      period: preset,
      window: {
        label: PRESET_LABEL[preset],
        isLifetime: true,
        thisStartISO: null,
        thisEndISO: null,
        lastStartISO: null,
        lastEndISO: null,
        thisStartDate: null,
        thisEndDate: null,
        lastStartDate: null,
        lastEndDate: null,
      },
    };
  }

  const nowMs = Date.now();
  const thisStartMs = nowMs - days * 24 * 3600 * 1000;
  const lastStartMs = nowMs - days * 2 * 24 * 3600 * 1000;
  return {
    period: preset,
    window: {
      label: PRESET_LABEL[preset],
      isLifetime: false,
      thisStartISO: new Date(thisStartMs).toISOString(),
      thisEndISO: null,
      lastStartISO: new Date(lastStartMs).toISOString(),
      lastEndISO: new Date(thisStartMs).toISOString(),
      thisStartDate: new Date(thisStartMs).toISOString().slice(0, 10),
      thisEndDate: new Date(nowMs).toISOString().slice(0, 10),
      lastStartDate: new Date(lastStartMs).toISOString().slice(0, 10),
      lastEndDate: new Date(thisStartMs - 24 * 3600 * 1000).toISOString().slice(0, 10),
    },
  };
}

function gbp(n: number | null): string {
  if (n === null) return "—";
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(n);
}

function pct(n: number | null): string {
  if (n === null) return "—";
  return `${n.toFixed(1)}%`;
}

function distinctEmails(rows: Array<{ email: string | null }> | null | undefined): number {
  return new Set(
    (rows ?? [])
      .map((r) => r.email?.toLowerCase().trim() ?? "")
      .filter((e) => e.length > 0),
  ).size;
}

function deltaLabel(thisP: number, lastP: number): string | null {
  if (thisP === lastP) return "no change";
  const diff = thisP - lastP;
  if (lastP === 0) return `from 0`;
  return `${diff > 0 ? "+" : ""}${diff} vs prior period`;
}

function deltaGBP(thisP: number, lastP: number): string | null {
  if (thisP === lastP) return "no change";
  const diff = thisP - lastP;
  if (lastP === 0) return `from £0`;
  return `${diff > 0 ? "+" : ""}${gbp(diff)} vs prior period`;
}

export default async function AdminHomePage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const { period, customFrom, customTo, window } = parsePeriod(sp);

  return (
    <div className="max-w-6xl space-y-10">
      <RealtimeRefresh
        tables={[
          { schema: "leads", table: "submissions" },
          { schema: "crm", table: "enrolments" },
          { schema: "crm", table: "pending_updates" },
          { schema: "leads", table: "dead_letter" },
        ]}
      />
      <PageHeader
        eyebrow="Overview"
        title="Business health"
        subtitle={
          <span>
            All sections move with the period selector. Lifetime totals shown beneath period figures where useful.
          </span>
        }
      />

      <PeriodPicker active={period} customFrom={customFrom} customTo={customTo} />

      <section>
        <SectionLabel>Top line ({window.label.toLowerCase()})</SectionLabel>
        <Suspense fallback={<TopLineSkeleton />}>
          <TopLineTiles window={window} />
        </Suspense>
      </section>

      <section>
        <Suspense fallback={<PresumedSkeleton />}>
          <PresumedTile window={window} />
        </Suspense>
      </section>

      <section>
        <SectionLabel>Provider scoreboard ({window.label.toLowerCase()})</SectionLabel>
        <Suspense fallback={<ScoreboardSkeleton />}>
          <ScoreboardTable window={window} />
        </Suspense>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Suspense fallback={<NoticeSkeleton />}>
          <DataHealthCard />
        </Suspense>
        <Suspense fallback={<NoticeSkeleton />}>
          <ActionsCard />
        </Suspense>
      </section>
    </div>
  );
}

// --- Top-line tiles ---------------------------------------------------

interface TopLineData {
  leadsThis: number;
  leadsLast: number;
  enrolThis: number;
  enrolLast: number;
  revenueThisGBP: number;
  revenueLifetimeGBP: number;
  revenueIncomplete: boolean;
  metaSpendThis: number;
  metaSpendLast: number;
  metaSpendLifetime: number;
  metaIngestionLive: boolean;
}

async function loadTopLine(window: Window): Promise<TopLineData> {
  const supabase = await createClient();
  const demoIds = await getDemoProviderIds(supabase);
  const demoIn = demoProviderInClause(demoIds);

  // Submissions: distinct emails of non-DQ leads.
  let leadsThisQ = supabase
    .schema("leads")
    .from("submissions")
    .select("email")
    .eq("is_dq", false)
    .is("archived_at", null);
  if (window.thisStartISO) leadsThisQ = leadsThisQ.gte("submitted_at", window.thisStartISO);
  if (window.thisEndISO) leadsThisQ = leadsThisQ.lt("submitted_at", window.thisEndISO);
  if (demoIn) leadsThisQ = leadsThisQ.or(`primary_routed_to.is.null,primary_routed_to.not.in.${demoIn}`);

  let leadsLastQ = supabase
    .schema("leads")
    .from("submissions")
    .select("email")
    .eq("is_dq", false)
    .is("archived_at", null);
  if (window.lastStartISO) leadsLastQ = leadsLastQ.gte("submitted_at", window.lastStartISO);
  if (window.lastEndISO) leadsLastQ = leadsLastQ.lt("submitted_at", window.lastEndISO);
  if (demoIn) leadsLastQ = leadsLastQ.or(`primary_routed_to.is.null,primary_routed_to.not.in.${demoIn}`);

  // Enrolments confirmed this period (by status_updated_at)
  let enrolThisQ = supabase
    .schema("crm")
    .from("enrolments")
    .select("id, billed_amount, provider_id, status_updated_at", { count: "exact" })
    .eq("status", "enrolled");
  if (window.thisStartISO) enrolThisQ = enrolThisQ.gte("status_updated_at", window.thisStartISO);
  if (window.thisEndISO) enrolThisQ = enrolThisQ.lt("status_updated_at", window.thisEndISO);
  if (demoIn) enrolThisQ = enrolThisQ.not("provider_id", "in", demoIn);

  // Enrolments confirmed last period (just count for delta)
  let enrolLastQ = supabase
    .schema("crm")
    .from("enrolments")
    .select("id", { count: "exact", head: true })
    .eq("status", "enrolled");
  if (window.lastStartISO) enrolLastQ = enrolLastQ.gte("status_updated_at", window.lastStartISO);
  if (window.lastEndISO) enrolLastQ = enrolLastQ.lt("status_updated_at", window.lastEndISO);
  if (demoIn) enrolLastQ = enrolLastQ.not("provider_id", "in", demoIn);

  // Meta ad spend this period
  let metaThisQ = supabase.schema("ads_switchable").from("meta_daily").select("spend");
  if (window.thisStartDate) metaThisQ = metaThisQ.gte("date", window.thisStartDate);
  if (window.thisEndDate) metaThisQ = metaThisQ.lte("date", window.thisEndDate);

  let metaLastQ = supabase.schema("ads_switchable").from("meta_daily").select("spend");
  if (window.lastStartDate) metaLastQ = metaLastQ.gte("date", window.lastStartDate);
  if (window.lastEndDate) metaLastQ = metaLastQ.lte("date", window.lastEndDate);

  const metaLifetimeQ = supabase.schema("ads_switchable").from("meta_daily").select("spend");

  // Provider pricing for revenue calc + lifetime revenue (via vw_provider_billing_state)
  const billingQ = demoIn
    ? supabase
        .schema("crm")
        .from("vw_provider_billing_state")
        .select("provider_id, pricing_model, confirmed_enrolled, billable_count")
        .not("provider_id", "in", demoIn)
    : supabase
        .schema("crm")
        .from("vw_provider_billing_state")
        .select("provider_id, pricing_model, confirmed_enrolled, billable_count");

  const providersQ = supabase
    .schema("crm")
    .from("providers")
    .select("provider_id, per_enrolment_fee, pricing_model")
    .eq("is_demo", false);

  const [
    leadsThisRes,
    leadsLastRes,
    enrolThisRes,
    enrolLastRes,
    metaThisRes,
    metaLastRes,
    metaLifetimeRes,
    billingRes,
    providersRes,
  ] = await Promise.all([
    leadsThisQ,
    leadsLastQ,
    enrolThisQ,
    enrolLastQ,
    metaThisQ,
    metaLastQ,
    metaLifetimeQ,
    billingQ,
    providersQ,
  ]);

  const leadsThis = distinctEmails(leadsThisRes.data as Array<{ email: string | null }>);
  const leadsLast = distinctEmails(leadsLastRes.data as Array<{ email: string | null }>);
  const enrolThisCount = enrolThisRes.count ?? 0;
  const enrolLast = enrolLastRes.count ?? 0;

  const providers = (providersRes.data ?? []) as Array<{
    provider_id: string;
    per_enrolment_fee: number | null;
    pricing_model: string | null;
  }>;
  const providerMeta = new Map(providers.map((p) => [p.provider_id, p]));

  // Revenue this period: sum of billed_amount on this-period enrolments
  // (billed_amount snapshots the fee at the time of bill or confirm, post free-3).
  // Fallback: when billed_amount is null (not yet billed), derive from provider fee.
  let revenueThisGBP = 0;
  let revenueIncomplete = false;
  const periodEnrols = (enrolThisRes.data ?? []) as Array<{
    id: number;
    billed_amount: number | null;
    provider_id: string;
  }>;
  // Count how many free slots are already used per provider as of period start;
  // anything above the cap (3) in this period is billable.
  const usedBefore = new Map<string, number>();
  if (window.thisStartISO) {
    const usedBeforeQuery = demoIn
      ? supabase
          .schema("crm")
          .from("enrolments")
          .select("provider_id")
          .eq("status", "enrolled")
          .lt("status_updated_at", window.thisStartISO)
          .not("provider_id", "in", demoIn)
      : supabase
          .schema("crm")
          .from("enrolments")
          .select("provider_id")
          .eq("status", "enrolled")
          .lt("status_updated_at", window.thisStartISO);
    const { data: priorEnrols } = await usedBeforeQuery;
    for (const r of (priorEnrols ?? []) as Array<{ provider_id: string }>) {
      usedBefore.set(r.provider_id, (usedBefore.get(r.provider_id) ?? 0) + 1);
    }
  }
  const freeUsedInPeriod = new Map<string, number>();
  for (const e of periodEnrols) {
    if (e.billed_amount !== null && e.billed_amount !== undefined) {
      revenueThisGBP += Number(e.billed_amount);
      continue;
    }
    const meta = providerMeta.get(e.provider_id);
    if (!meta) continue;
    if (meta.pricing_model === "per_enrolment_flat" && meta.per_enrolment_fee !== null) {
      const priorUsed = usedBefore.get(e.provider_id) ?? 0;
      const usedThisPeriod = freeUsedInPeriod.get(e.provider_id) ?? 0;
      const totalUsedAfter = priorUsed + usedThisPeriod + 1;
      if (totalUsedAfter <= 3) {
        freeUsedInPeriod.set(e.provider_id, usedThisPeriod + 1);
        continue;
      }
      revenueThisGBP += Number(meta.per_enrolment_fee);
    } else if (meta.pricing_model === "per_enrolment_percent") {
      revenueIncomplete = true;
    }
  }

  // Lifetime confirmed revenue (for the small "lifetime" note under P/L tile)
  const billingRows = (billingRes.data ?? []) as Array<{
    provider_id: string;
    pricing_model: string | null;
    confirmed_enrolled: number;
    billable_count: number;
  }>;
  let revenueLifetimeGBP = 0;
  for (const r of billingRows) {
    const meta = providerMeta.get(r.provider_id);
    if (!meta) continue;
    const fee = meta.per_enrolment_fee !== null ? Number(meta.per_enrolment_fee) : null;
    if (meta.pricing_model === "per_enrolment_flat" && fee !== null) {
      const confirmedBillable = Math.max(0, r.confirmed_enrolled - 3);
      revenueLifetimeGBP += confirmedBillable * fee;
    } else if (meta.pricing_model === "per_enrolment_percent" && r.billable_count > 0) {
      revenueIncomplete = true;
    }
  }

  const metaSpendThis = ((metaThisRes.data ?? []) as Array<{ spend: number | null }>).reduce(
    (s, r) => s + Number(r.spend ?? 0),
    0,
  );
  const metaSpendLast = ((metaLastRes.data ?? []) as Array<{ spend: number | null }>).reduce(
    (s, r) => s + Number(r.spend ?? 0),
    0,
  );
  const metaSpendLifetime = ((metaLifetimeRes.data ?? []) as Array<{ spend: number | null }>).reduce(
    (s, r) => s + Number(r.spend ?? 0),
    0,
  );
  const metaIngestionLive = metaSpendLifetime > 0;

  return {
    leadsThis,
    leadsLast,
    enrolThis: enrolThisCount,
    enrolLast,
    revenueThisGBP,
    revenueLifetimeGBP,
    revenueIncomplete,
    metaSpendThis,
    metaSpendLast,
    metaSpendLifetime,
    metaIngestionLive,
  };
}

async function TopLineTiles({ window }: { window: Window }) {
  const d = await loadTopLine(window);
  const cpl = d.metaIngestionLive && d.leadsThis > 0 ? d.metaSpendThis / d.leadsThis : null;
  const cpe = d.metaIngestionLive && d.enrolThis > 0 ? d.metaSpendThis / d.enrolThis : null;
  const profitThis = d.metaIngestionLive ? d.revenueThisGBP - d.metaSpendThis : null;
  const profitLifetime = d.metaIngestionLive ? d.revenueLifetimeGBP - d.metaSpendLifetime : null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <Tile
        label="Total leads"
        value={d.leadsThis}
        note={window.isLifetime ? null : deltaLabel(d.leadsThis, d.leadsLast)}
        href="/leads?dq=no"
      />
      <Tile
        label="Confirmed enrolments"
        value={d.enrolThis}
        note={window.isLifetime ? null : deltaLabel(d.enrolThis, d.enrolLast)}
        href="/leads?stage=enrolled"
        theme="good"
      />
      <Tile
        label="Cost per lead"
        value={cpl === null ? "—" : gbp(cpl)}
        note={
          !d.metaIngestionLive
            ? "Awaiting Meta ingestion"
            : d.leadsThis === 0
              ? "No leads this period"
              : `${gbp(d.metaSpendThis)} ÷ ${d.leadsThis} leads`
        }
      />
      <Tile
        label="Cost per enrolment"
        value={cpe === null ? "—" : gbp(cpe)}
        note={
          !d.metaIngestionLive
            ? "Awaiting Meta ingestion"
            : d.enrolThis === 0
              ? "No enrolments this period"
              : `${gbp(d.metaSpendThis)} ÷ ${d.enrolThis} confirmed`
        }
      />
      <Tile
        label="Confirmed income"
        value={gbp(d.revenueThisGBP)}
        note={d.revenueIncomplete ? "Plus % of CD self-funded" : "Period, post free-3 cap"}
        theme="good"
      />
      <Tile
        label="Ad spend"
        value={d.metaIngestionLive ? gbp(d.metaSpendThis) : "—"}
        note={
          window.isLifetime
            ? null
            : d.metaIngestionLive
              ? deltaGBP(d.metaSpendThis, d.metaSpendLast)
              : "Click to add daily totals"
        }
        href="/profit"
      />
      <Tile
        label="Profit / loss"
        value={profitThis === null ? "—" : gbp(profitThis)}
        note={
          !d.metaIngestionLive
            ? "Awaiting Meta ingestion"
            : `Lifetime: ${gbp(profitLifetime)}`
        }
        theme={profitThis !== null && profitThis < 0 ? "bad" : profitThis !== null && profitThis > 0 ? "good" : undefined}
        span={2}
      />
    </div>
  );
}

// --- Presumed tile ---------------------------------------------------

async function PresumedTile({ window }: { window: Window }) {
  const supabase = await createClient();
  const demoIds = await getDemoProviderIds(supabase);
  const demoIn = demoProviderInClause(demoIds);

  let q = supabase
    .schema("crm")
    .from("enrolments")
    .select("id", { count: "exact", head: true })
    .eq("status", "presumed_enrolled");
  if (window.thisStartISO) q = q.gte("status_updated_at", window.thisStartISO);
  if (window.thisEndISO) q = q.lt("status_updated_at", window.thisEndISO);
  if (demoIn) q = q.not("provider_id", "in", demoIn);

  const { count } = await q;
  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-4 max-w-md">
      <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">
        Presumed enrolments ({window.label.toLowerCase()})
      </p>
      <p className="text-3xl font-extrabold mt-2 tracking-tight text-[#11242e]">{count ?? 0}</p>
      <p className="text-[10px] text-[#5a6a72] mt-1 italic">
        Should trend to ~0 as auto-flip cron lands. Kept visible for cohort tracking.
      </p>
    </div>
  );
}

// --- Provider scoreboard --------------------------------------------

interface ScoreboardRow {
  provider_id: string;
  company_name: string | null;
  leads: number;
  enrolled: number;
  presumed: number;
  conversion_pct: number | null;
  income_gbp: number;
  free_used_this_period: number;
}

async function loadScoreboard(window: Window): Promise<ScoreboardRow[]> {
  const supabase = await createClient();
  const demoIds = await getDemoProviderIds(supabase);
  const demoIn = demoProviderInClause(demoIds);

  const providersRes = await supabase
    .schema("crm")
    .from("providers")
    .select("provider_id, company_name, per_enrolment_fee, pricing_model, active")
    .eq("is_demo", false)
    .eq("active", true);

  const providers = (providersRes.data ?? []) as Array<{
    provider_id: string;
    company_name: string | null;
    per_enrolment_fee: number | null;
    pricing_model: string | null;
  }>;

  // Per-provider leads in this period (routed_to = provider)
  let leadsQ = supabase
    .schema("leads")
    .from("submissions")
    .select("email, primary_routed_to")
    .eq("is_dq", false)
    .is("archived_at", null)
    .not("primary_routed_to", "is", null);
  if (window.thisStartISO) leadsQ = leadsQ.gte("submitted_at", window.thisStartISO);
  if (window.thisEndISO) leadsQ = leadsQ.lt("submitted_at", window.thisEndISO);

  // Per-provider enrolments this period
  let enrolQ = supabase
    .schema("crm")
    .from("enrolments")
    .select("provider_id, status, billed_amount, status_updated_at")
    .in("status", ["enrolled", "presumed_enrolled"]);
  if (window.thisStartISO) enrolQ = enrolQ.gte("status_updated_at", window.thisStartISO);
  if (window.thisEndISO) enrolQ = enrolQ.lt("status_updated_at", window.thisEndISO);

  // Prior free-cap usage per provider (so we know who's still inside their free 3)
  let priorQ = supabase
    .schema("crm")
    .from("enrolments")
    .select("provider_id")
    .eq("status", "enrolled");
  if (window.thisStartISO) priorQ = priorQ.lt("status_updated_at", window.thisStartISO);

  const [leadsRes, enrolRes, priorRes] = await Promise.all([leadsQ, enrolQ, priorQ]);

  const leadRows = (leadsRes.data ?? []) as Array<{
    email: string | null;
    primary_routed_to: string;
  }>;
  const enrolRows = (enrolRes.data ?? []) as Array<{
    provider_id: string;
    status: string;
    billed_amount: number | null;
  }>;
  const priorRows = (priorRes.data ?? []) as Array<{ provider_id: string }>;

  const leadsByProvider = new Map<string, Set<string>>();
  for (const r of leadRows) {
    const key = r.email?.toLowerCase().trim() ?? "";
    if (!key) continue;
    const s = leadsByProvider.get(r.primary_routed_to) ?? new Set<string>();
    s.add(key);
    leadsByProvider.set(r.primary_routed_to, s);
  }

  const priorUsed = new Map<string, number>();
  for (const r of priorRows) {
    priorUsed.set(r.provider_id, (priorUsed.get(r.provider_id) ?? 0) + 1);
  }

  const enrolByProvider = new Map<string, { enrolled: number; presumed: number; rows: typeof enrolRows }>();
  for (const e of enrolRows) {
    const v = enrolByProvider.get(e.provider_id) ?? { enrolled: 0, presumed: 0, rows: [] };
    if (e.status === "enrolled") v.enrolled += 1;
    if (e.status === "presumed_enrolled") v.presumed += 1;
    v.rows.push(e);
    enrolByProvider.set(e.provider_id, v);
  }

  const rows: ScoreboardRow[] = providers.map((p) => {
    const leads = leadsByProvider.get(p.provider_id)?.size ?? 0;
    const eb = enrolByProvider.get(p.provider_id) ?? { enrolled: 0, presumed: 0, rows: [] };
    const totalEnrolled = eb.enrolled + eb.presumed;
    const conversion = leads > 0 ? Math.round((totalEnrolled / leads) * 1000) / 10 : null;

    let income = 0;
    let freeUsedThisPeriod = 0;
    let priorRemaining = Math.max(0, 3 - (priorUsed.get(p.provider_id) ?? 0));
    for (const e of eb.rows) {
      if (e.status !== "enrolled") continue;
      if (e.billed_amount !== null && e.billed_amount !== undefined) {
        income += Number(e.billed_amount);
        continue;
      }
      if (p.pricing_model === "per_enrolment_flat" && p.per_enrolment_fee !== null) {
        if (priorRemaining > 0) {
          priorRemaining -= 1;
          freeUsedThisPeriod += 1;
          continue;
        }
        income += Number(p.per_enrolment_fee);
      }
      // percent pricing left blank in income column; flagged via tooltip below
    }

    return {
      provider_id: p.provider_id,
      company_name: p.company_name,
      leads,
      enrolled: eb.enrolled,
      presumed: eb.presumed,
      conversion_pct: conversion,
      income_gbp: income,
      free_used_this_period: freeUsedThisPeriod,
    };
  });

  rows.sort((a, b) => b.leads - a.leads);
  return rows;
}

async function ScoreboardTable({ window }: { window: Window }) {
  const rows = await loadScoreboard(window);
  const totals = {
    leads: rows.reduce((s, r) => s + r.leads, 0),
    enrolled: rows.reduce((s, r) => s + r.enrolled, 0),
    presumed: rows.reduce((s, r) => s + r.presumed, 0),
    income: rows.reduce((s, r) => s + r.income_gbp, 0),
  };
  const totalEnrolled = totals.enrolled + totals.presumed;
  const totalConversion = totals.leads > 0 ? Math.round((totalEnrolled / totals.leads) * 1000) / 10 : null;

  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
      <table className="w-full text-sm">
        <thead className="text-[10px] uppercase tracking-wide text-[#5a6a72] bg-[#f4f1ed]">
          <tr>
            <th className="px-4 py-2 text-left">Provider</th>
            <th className="px-4 py-2 text-right">Leads</th>
            <th className="px-4 py-2 text-right">Enrolled</th>
            <th className="px-4 py-2 text-right">Conversion</th>
            <th className="px-4 py-2 text-right">Income</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-8 text-center text-[#5a6a72]">
                No active providers.
              </td>
            </tr>
          ) : (
            rows.map((r) => {
              const totalE = r.enrolled + r.presumed;
              return (
                <tr key={r.provider_id} className="border-t border-[#dad4cb]">
                  <td className="px-4 py-3">
                    <Link
                      href={`/providers/${encodeURIComponent(r.provider_id)}`}
                      className="font-medium text-[#143643] hover:text-[#cd8b76]"
                    >
                      {r.company_name ?? r.provider_id}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right font-bold">{r.leads}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="font-bold text-emerald-700">{totalE}</span>
                    {r.presumed > 0 ? (
                      <span className="text-[10px] text-[#5a6a72]">
                        {" "}
                        ({r.enrolled} confirmed + {r.presumed} presumed)
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right font-bold">
                    {r.conversion_pct === null ? "—" : `${r.conversion_pct}%`}
                  </td>
                  <td className="px-4 py-3 text-right font-bold">
                    {gbp(r.income_gbp)}
                    {r.free_used_this_period > 0 ? (
                      <span className="text-[10px] text-[#5a6a72] block">
                        +{r.free_used_this_period} free
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
        {rows.length > 0 ? (
          <tfoot className="text-xs bg-[#f4f1ed] border-t border-[#dad4cb]">
            <tr>
              <td className="px-4 py-3 font-bold uppercase tracking-wide text-[#5a6a72] text-[10px]">
                Total
              </td>
              <td className="px-4 py-3 text-right font-bold">{totals.leads}</td>
              <td className="px-4 py-3 text-right font-bold text-emerald-700">{totalEnrolled}</td>
              <td className="px-4 py-3 text-right font-bold">
                {totalConversion === null ? "—" : `${totalConversion}%`}
              </td>
              <td className="px-4 py-3 text-right font-bold">{gbp(totals.income)}</td>
            </tr>
          </tfoot>
        ) : null}
      </table>
      <p className="text-[10px] text-[#5a6a72] px-4 py-3 italic border-t border-[#dad4cb]">
        Per-provider CPL / CPE / P/L need a campaign→provider mapping (not in schema yet); rollups stay on top-line tiles for now.
      </p>
    </div>
  );
}

// --- Data health + actions cards (moved out of layout) --------------

async function DataHealthCard() {
  const supabase = await createClient();
  const { data: healthRows } = await supabase
    .from("vw_admin_health")
    .select("leads_last_7d, unrouted_over_48h, errors_over_7d, errors_unresolved_total, needs_status_update_count");
  const h = (healthRows?.[0] as
    | {
        leads_last_7d: number;
        unrouted_over_48h: number;
        errors_over_7d: number;
        errors_unresolved_total: number;
        needs_status_update_count: number;
      }
    | undefined) ?? null;

  if (!h) {
    return (
      <div className="bg-white border border-[#dad4cb] rounded-xl p-5">
        <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">Data health</p>
        <p className="text-sm text-[#5a6a72]">Health view unavailable.</p>
      </div>
    );
  }

  const stale = h.errors_over_7d > 0 || h.unrouted_over_48h > 0;
  const warn = stale || h.needs_status_update_count > 0 || h.errors_unresolved_total > 0;
  const dot = stale ? "bg-[#b3412e]" : warn ? "bg-[#cd8b76]" : "bg-emerald-600";

  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className={`w-2 h-2 rounded-full ${dot}`} />
        <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">Data health</p>
      </div>
      <ul className="space-y-2 text-sm">
        <HealthRow label="Leads in last 7 days" value={h.leads_last_7d} tone={h.leads_last_7d > 0 ? "good" : "neutral"} href="/leads" />
        <HealthRow label="Unrouted > 48h" value={h.unrouted_over_48h} tone={h.unrouted_over_48h > 0 ? "bad" : "good"} href="/actions" />
        <HealthRow label="Errors > 7 days old" value={h.errors_over_7d} tone={h.errors_over_7d > 0 ? "bad" : "good"} href="/errors" />
        <HealthRow label="Open errors total" value={h.errors_unresolved_total} tone={h.errors_unresolved_total > 0 ? "warn" : "good"} href="/errors" />
        <HealthRow label="Needs status update" value={h.needs_status_update_count} tone={h.needs_status_update_count > 0 ? "warn" : "good"} href="/actions" />
      </ul>
    </div>
  );
}

async function ActionsCard() {
  const supabase = await createClient();
  const fiveDaysAgoISO = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();

  const [presumedRes, pendingAiRes, needsChasingRes, cannotReachRes, deadLetterRes, unroutedRes] = await Promise.all([
    supabase.schema("crm").from("enrolments").select("id", { count: "exact", head: true }).eq("status", "presumed_enrolled"),
    supabase.schema("crm").from("pending_updates").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase
      .schema("crm")
      .from("vw_enrolments_chaser_state")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")
      .not("latest_chaser_at", "is", null)
      .lt("latest_chaser_at", fiveDaysAgoISO),
    supabase
      .schema("crm")
      .from("vw_enrolments_chaser_state")
      .select("id", { count: "exact", head: true })
      .eq("status", "cannot_reach")
      .is("latest_chaser_at", null),
    supabase.schema("leads").from("dead_letter").select("id", { count: "exact", head: true }).is("replayed_at", null),
    supabase
      .schema("leads")
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .eq("is_dq", false)
      .is("primary_routed_to", null)
      .is("archived_at", null),
  ]);

  const presumed = presumedRes.count ?? 0;
  const aiPending = pendingAiRes.count ?? 0;
  const chasing = needsChasingRes.count ?? 0;
  const cannotReach = cannotReachRes.count ?? 0;
  const errors = deadLetterRes.count ?? 0;
  const unrouted = unroutedRes.count ?? 0;

  const total = presumed + aiPending + chasing + cannotReach + errors + unrouted;

  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-5">
      <div className="flex items-baseline justify-between mb-4">
        <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">Needs your attention</p>
        {total === 0 ? (
          <span className="text-xs text-emerald-700 font-bold">Inbox zero</span>
        ) : (
          <span className="text-xs text-[#5a6a72]">{total} items</span>
        )}
      </div>
      <ul className="space-y-2 text-sm">
        <HealthRow label="AI suggestions to review" value={aiPending} tone={aiPending > 0 ? "warn" : "good"} href="/actions" />
        <HealthRow label="Unrouted leads" value={unrouted} tone={unrouted > 0 ? "warn" : "good"} href="/leads?routed=no&dq=no" />
        <HealthRow label="Presumed enrolled" value={presumed} tone={presumed > 0 ? "warn" : "good"} href="/actions" />
        <HealthRow label="Needs another chase" value={chasing} tone={chasing > 0 ? "warn" : "good"} href="/actions" />
        <HealthRow label="Cannot reach (no chase sent)" value={cannotReach} tone={cannotReach > 0 ? "warn" : "good"} href="/actions" />
        <HealthRow label="Unresolved errors" value={errors} tone={errors > 0 ? "bad" : "good"} href="/errors" />
      </ul>
    </div>
  );
}

// --- Shared bits ----------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">{children}</p>
  );
}

function HealthRow({
  label,
  value,
  tone,
  href,
}: {
  label: string;
  value: number;
  tone: "good" | "warn" | "bad" | "neutral";
  href?: string;
}) {
  const colour =
    tone === "bad"
      ? "text-[#b3412e]"
      : tone === "warn"
        ? "text-[#cd8b76]"
        : tone === "good"
          ? "text-emerald-700"
          : "text-[#11242e]";
  const inner = (
    <div className="flex items-baseline justify-between py-1.5">
      <span className="text-[#5a6a72]">{label}</span>
      <span className={`font-bold tabular-nums ${colour}`}>{value}</span>
    </div>
  );
  return href ? (
    <li>
      <Link href={href} className="block hover:bg-[#f4f1ed] -mx-2 px-2 rounded transition-colors">
        {inner}
      </Link>
    </li>
  ) : (
    <li>{inner}</li>
  );
}

function Tile({
  label,
  value,
  note,
  href,
  theme,
  span,
}: {
  label: string;
  value: number | string;
  note: string | null;
  href?: string;
  theme?: "good" | "bad";
  span?: 2;
}) {
  const valueCls =
    theme === "good"
      ? "text-emerald-700"
      : theme === "bad"
        ? "text-[#b3412e]"
        : "text-[#11242e]";
  const wrapper = `bg-white border border-[#dad4cb] rounded-xl p-5 shadow-[0_1px_2px_rgba(17,36,46,0.04)] block transition-all ${span === 2 ? "md:col-span-2" : ""}`;
  const inner = (
    <>
      <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">{label}</p>
      <p className={`text-3xl font-extrabold mt-2 tracking-tight ${valueCls}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      {note ? <p className="text-[10px] text-[#5a6a72] mt-2">{note}</p> : null}
    </>
  );
  return href ? (
    <Link href={href} className={`${wrapper} hover:shadow-[0_4px_12px_rgba(17,36,46,0.12)]`}>
      {inner}
    </Link>
  ) : (
    <div className={wrapper}>{inner}</div>
  );
}

// --- Skeletons ------------------------------------------------------

function TopLineSkeleton() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} className="bg-white border border-[#dad4cb] rounded-xl p-5">
          <Skeleton className="h-2.5 w-24 mb-3" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-2 w-32 mt-3" />
        </div>
      ))}
    </div>
  );
}

function PresumedSkeleton() {
  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-4 max-w-md">
      <Skeleton className="h-2.5 w-40 mb-3" />
      <Skeleton className="h-8 w-12" />
    </div>
  );
}

function ScoreboardSkeleton() {
  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex justify-between py-3 border-b border-[#dad4cb] last:border-0">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-12" />
        </div>
      ))}
    </div>
  );
}

function NoticeSkeleton() {
  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-5">
      <Skeleton className="h-2.5 w-24 mb-4" />
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex justify-between py-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-8" />
        </div>
      ))}
    </div>
  );
}
