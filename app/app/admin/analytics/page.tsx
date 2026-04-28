import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";

type Period = "2d" | "7d" | "30d" | "lifetime";

const PERIOD_DAYS: Record<Period, number | null> = {
  "2d": 2,
  "7d": 7,
  "30d": 30,
  "lifetime": null,
};

const PERIOD_LABEL: Record<Period, string> = {
  "2d": "Last 2 days",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "lifetime": "Lifetime",
};

function normalisePeriod(v: string | undefined): Period {
  if (v === "2d" || v === "30d" || v === "lifetime") return v;
  return "7d";
}

interface SubmissionRow {
  id: number;
  email: string | null;
  is_dq: boolean | null;
  dq_reason: string | null;
  primary_routed_to: string | null;
  age_band: string | null;
  employment_status: string | null;
  la: string | null;
  postcode: string | null;
  qualification: string | null;
  prior_level_3_or_higher: boolean | null;
  interest: string | null;
  course_id: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  funding_route: string | null;
  funding_category: string | null;
  submitted_at: string;
  archived_at: string | null;
  parent_submission_id: number | null;
  provider_ids: string[] | null;
}

interface PartialRow {
  step_reached: number | null;
  is_complete: boolean | null;
  funding_category: string | null;
  funding_route: string | null;
  first_seen_at: string;
}

interface EnrolmentLite {
  submission_id: number;
  status: string;
}

interface AdSpendRow {
  date: string;
  spend: number | null;
  leads: number | null;
  ad_account_id: string | null;
}

// ─── Step labels for the funnel section ─────────────────────────────────
// Driven by what trackPartial() sends from find-your-course/index.html and
// the funded-course main qualifier. Step 1 = landed; later steps map to
// per-form questions; 90/91 = post-DQ panel events.
const STEP_LABEL: Record<string, string> = {
  "1": "Landed on form",
  "2": "Step 2 (early qualifier)",
  "3": "Step 3 (early qualifier)",
  "4": "Step 4 (mid qualifier)",
  "5": "Step 5 (mid qualifier)",
  "6": "Step 6 (late qualifier)",
  "7": "Step 7 (late qualifier)",
  "8": "Contact details",
  "9": "Submitted",
  "90": "Skipped course matches",
  "91": "Held on DQ panel",
};

const DQ_REASON_LABEL: Record<string, string> = {
  "qual": "Wanted professional-body qual (self-funded)",
  "budget": "Budget under £200 / no spend",
  "no_match": "No course match for selection",
  "cohort_closed": "Cohort closed (waitlist)",
  "postcode_mismatch": "Postcode outside eligible area",
  "outside_england": "Outside England",
  "age_below_min": "Age below minimum",
  "full_time_ed": "In full-time education",
  "overqualified": "Already at Level 3+",
  "employment_mismatch": "Employment status excluded",
  "owner_test_submission": "Owner test row",
  "dummy_test_email": "Dummy/test email",
  "waitlist": "Waitlist signup",
  "waitlist_enrichment": "Waitlist enrichment form",
};

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const sp = await searchParams;
  const period = normalisePeriod(sp.period);
  const days = PERIOD_DAYS[period];

  const supabase = await createClient();

  const cutoff = days === null ? null : new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

  // Pull every submission in scope. We need rich row data to do all the
  // bucketing in JS; pulling once and grouping in TypeScript is far simpler
  // than running 25 separate aggregate queries.
  let subsQ = supabase
    .schema("leads")
    .from("submissions")
    .select(
      "id, email, is_dq, dq_reason, primary_routed_to, age_band, employment_status, la, postcode, qualification, prior_level_3_or_higher, interest, course_id, utm_source, utm_medium, utm_campaign, funding_route, funding_category, submitted_at, archived_at, parent_submission_id, provider_ids",
    )
    .is("archived_at", null);
  if (cutoff) subsQ = subsQ.gte("submitted_at", cutoff);

  let partialsQ = supabase
    .schema("leads")
    .from("partials")
    .select("step_reached, is_complete, funding_category, funding_route, first_seen_at");
  if (cutoff) partialsQ = partialsQ.gte("first_seen_at", cutoff);

  const [subsRes, partialsRes, enrolRes, providersRes, adsRes] = await Promise.all([
    subsQ,
    partialsQ,
    supabase.schema("crm").from("enrolments").select("submission_id, status"),
    supabase.schema("crm").from("providers").select("provider_id, company_name, active"),
    supabase
      .schema("ads_switchable")
      .from("meta_daily")
      .select("date, spend, leads, ad_account_id")
      .gte("date", cutoff ? cutoff.slice(0, 10) : "1970-01-01"),
  ]);

  const subs = (subsRes.data ?? []) as SubmissionRow[];
  const partials = (partialsRes.data ?? []) as PartialRow[];
  const enrolments = (enrolRes.data ?? []) as EnrolmentLite[];
  const providers = (providersRes.data ?? []) as Array<{ provider_id: string; company_name: string; active: boolean }>;
  const adRows = (adsRes.data ?? []) as AdSpendRow[];

  // Derived sets
  const enrolledSubIds = new Set(enrolments.filter((e) => e.status === "enrolled" || e.status === "presumed_enrolled").map((e) => e.submission_id));
  const totalAdSpend = adRows.reduce((s, r) => s + Number(r.spend ?? 0), 0);

  // Dedupe by email for sections that count *people* (demographics, DQ
  // patterns, geographic). Sections that count *events* keep all rows
  // (sources, funnel, time): each submission has its own UTM and timestamp
  // and collapsing them would lose those signals.
  //
  // Tie-breaker rule: keep the latest non-DQ row per email if any exists,
  // otherwise the latest row (so demographics shows the version of the
  // person we'd actually engage with).
  const subsByEmail = new Map<string, SubmissionRow>();
  for (const s of subs) {
    const key = s.email?.toLowerCase().trim() ?? "";
    if (!key) continue;
    const existing = subsByEmail.get(key);
    if (!existing) {
      subsByEmail.set(key, s);
      continue;
    }
    const existingScore = (existing.is_dq ? 0 : 100) + new Date(existing.submitted_at).getTime() / 1e10;
    const incomingScore = (s.is_dq ? 0 : 100) + new Date(s.submitted_at).getTime() / 1e10;
    if (incomingScore > existingScore) subsByEmail.set(key, s);
  }
  const peopleSubs = Array.from(subsByEmail.values());

  // Helper: filter to "live" leads (we can use just non-DQ count or DQ count)
  const totalLeads = subs.length;
  const totalQualified = subs.filter((s) => !s.is_dq).length;
  const totalDQ = subs.filter((s) => s.is_dq).length;
  const totalRouted = subs.filter((s) => s.primary_routed_to).length;
  const totalEnrolled = subs.filter((s) => enrolledSubIds.has(s.id)).length;
  const totalUniquePeople = peopleSubs.length;
  const totalUniqueDQ = peopleSubs.filter((s) => s.is_dq).length;

  // ─── Section 1: Lead source quality ─────────────────────────────────
  // Group by utm_source × utm_campaign. utm_medium often duplicates source so
  // it goes in the row label rather than a separate axis.
  const sourceMap = new Map<
    string,
    { source: string; medium: string | null; campaign: string | null; total: number; qualified: number; routed: number; enrolled: number }
  >();
  for (const s of subs) {
    const key = `${s.utm_source ?? "(none)"}|${s.utm_medium ?? "(none)"}|${s.utm_campaign ?? "(none)"}`;
    let bucket = sourceMap.get(key);
    if (!bucket) {
      bucket = {
        source: s.utm_source ?? "(none)",
        medium: s.utm_medium,
        campaign: s.utm_campaign,
        total: 0,
        qualified: 0,
        routed: 0,
        enrolled: 0,
      };
      sourceMap.set(key, bucket);
    }
    bucket.total++;
    if (!s.is_dq) bucket.qualified++;
    if (s.primary_routed_to) bucket.routed++;
    if (enrolledSubIds.has(s.id)) bucket.enrolled++;
  }
  const sourceRows = Array.from(sourceMap.values()).sort((a, b) => b.total - a.total);

  // ─── Section 2: Demographics (deduped by email) ─────────────────────
  const ageBands = bucketBy(peopleSubs, (s) => s.age_band, enrolledSubIds);
  const employments = bucketBy(peopleSubs, (s) => s.employment_status, enrolledSubIds);
  const interests = bucketBy(peopleSubs, (s) => s.interest, enrolledSubIds);
  const qualifications = bucketBy(peopleSubs, (s) => s.qualification, enrolledSubIds);
  const priorL3 = bucketBy(peopleSubs, (s) => (s.prior_level_3_or_higher === null ? null : s.prior_level_3_or_higher ? "Yes (Level 3+)" : "No"), enrolledSubIds);

  // ─── Section 3: Funnel drop-off ─────────────────────────────────────
  const stepMap = new Map<number, { step: number; total: number; completed: number; abandoned: number }>();
  for (const p of partials) {
    if (p.step_reached === null) continue;
    let bucket = stepMap.get(p.step_reached);
    if (!bucket) {
      bucket = { step: p.step_reached, total: 0, completed: 0, abandoned: 0 };
      stepMap.set(p.step_reached, bucket);
    }
    bucket.total++;
    if (p.is_complete) bucket.completed++;
    else bucket.abandoned++;
  }
  const funnelRows = Array.from(stepMap.values()).sort((a, b) => a.step - b.step);
  const funnelMaxTotal = Math.max(1, ...funnelRows.map((r) => r.total));

  // ─── Section 4: Course demand vs supply ─────────────────────────────
  const courseMap = new Map<string, { course: string; leads: number; providers: Set<string>; routed: number; enrolled: number }>();
  for (const s of subs) {
    const c = s.course_id;
    if (!c) continue;
    let bucket = courseMap.get(c);
    if (!bucket) {
      bucket = { course: c, leads: 0, providers: new Set(), routed: 0, enrolled: 0 };
      courseMap.set(c, bucket);
    }
    bucket.leads++;
    for (const p of s.provider_ids ?? []) bucket.providers.add(p);
    if (s.primary_routed_to) bucket.routed++;
    if (enrolledSubIds.has(s.id)) bucket.enrolled++;
  }
  const courseRows = Array.from(courseMap.values())
    .map((r) => ({ ...r, providerCount: r.providers.size }))
    .sort((a, b) => b.leads - a.leads);

  // ─── Section 5: DQ pattern analysis (deduped by email) ──────────────
  const dqMap = new Map<string, number>();
  for (const s of peopleSubs) {
    if (!s.is_dq) continue;
    const reason = s.dq_reason ?? "(unspecified)";
    dqMap.set(reason, (dqMap.get(reason) ?? 0) + 1);
  }
  const dqRows = Array.from(dqMap.entries())
    .map(([reason, count]) => ({ reason, count, label: DQ_REASON_LABEL[reason] ?? reason }))
    .sort((a, b) => b.count - a.count);
  const dqMax = Math.max(1, ...dqRows.map((r) => r.count));

  // ─── Section 6: Geographic distribution (deduped by email) ──────────
  const laMap = new Map<string, { la: string; total: number; qualified: number; enrolled: number }>();
  for (const s of peopleSubs) {
    const la = s.la?.trim();
    if (!la) continue;
    let bucket = laMap.get(la);
    if (!bucket) {
      bucket = { la, total: 0, qualified: 0, enrolled: 0 };
      laMap.set(la, bucket);
    }
    bucket.total++;
    if (!s.is_dq) bucket.qualified++;
    if (enrolledSubIds.has(s.id)) bucket.enrolled++;
  }
  const laRows = Array.from(laMap.values()).sort((a, b) => b.total - a.total);

  // Postcode prefix (outward code, e.g. "SW1A") for self-funded leads. Also
  // deduped by email so one person counts once even if they submitted twice.
  const postcodeMap = new Map<string, number>();
  for (const s of peopleSubs) {
    if (!s.postcode) continue;
    const pc = s.postcode.replace(/\s+/g, "").toUpperCase();
    const outward = pc.slice(0, Math.max(2, pc.length - 3));
    postcodeMap.set(outward, (postcodeMap.get(outward) ?? 0) + 1);
  }
  const postcodeRows = Array.from(postcodeMap.entries())
    .map(([outward, n]) => ({ outward, n }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 12);

  // ─── Notable patterns: deterministic flags worth acting on ─────────
  // Each rule is small, opinionated, and self-explaining. Surfaces only
  // when there's enough data to be confident. Not a "smart insights" pile;
  // just facts the page would otherwise bury.
  const notable: Array<{ tone: "bad" | "ok" | "good"; text: string; href?: string }> = [];
  if (totalUniqueDQ >= 5) {
    const topDQ = dqRows[0];
    if (topDQ && topDQ.count / totalUniqueDQ >= 0.25) {
      notable.push({
        tone: "bad",
        text: `${pct(topDQ.count, totalUniqueDQ)} of DQ'd people fell out for "${topDQ.label}". Worth tightening the form copy or adding a provider that covers it.`,
      });
    }
  }
  for (const r of courseRows) {
    if (r.providerCount === 0 && r.leads >= 3) {
      notable.push({
        tone: "bad",
        text: `Course "${r.course}" has ${r.leads} lead${r.leads === 1 ? "" : "s"} and zero providers attached. Demand without supply.`,
      });
    }
  }
  if (sourceRows.length > 0 && sourceRows[0].total >= 5) {
    const top = sourceRows[0];
    notable.push({
      tone: "ok",
      text: `Top source: ${top.source} (${top.medium ?? "—"} / ${top.campaign ?? "—"}) with ${top.total} leads, ${pct(top.qualified, top.total)} qualified.`,
    });
  }
  if (totalRouted > 0 && totalEnrolled > 0) {
    const conv = (totalEnrolled / totalRouted) * 100;
    if (conv >= 10) {
      notable.push({
        tone: "good",
        text: `Conversion (lifetime): ${conv.toFixed(1)}% routed-to-enrolled. Healthy at pilot scale.`,
      });
    } else if (conv < 5 && totalRouted >= 20) {
      notable.push({
        tone: "bad",
        text: `Conversion (lifetime): ${conv.toFixed(1)}% routed-to-enrolled. Worth investigating provider follow-up speed or lead quality.`,
      });
    }
  }

  // ─── Section 7: Time patterns ───────────────────────────────────────
  const dowCounts = Array(7).fill(0);
  const hourCounts = Array(24).fill(0);
  for (const s of subs) {
    const d = new Date(s.submitted_at);
    dowCounts[d.getUTCDay()]++;
    hourCounts[d.getUTCHours()]++;
  }
  const dowMax = Math.max(1, ...dowCounts);
  const hourMax = Math.max(1, ...hourCounts);

  return (
    <div className="max-w-6xl space-y-8">
      <PageHeader
        eyebrow="Operations"
        title="Analytics"
        subtitle={
          <span>
            {PERIOD_LABEL[period]} unless noted. {totalLeads} submissions from {totalUniquePeople} unique people,{" "}
            {totalQualified} submissions qualified, {totalRouted} routed, {totalEnrolled} enrolled. Sections that count{" "}
            <em>people</em> dedupe by email; sections that count <em>events</em> (sources, funnel, time) keep every row.
          </span>
        }
      />

      <PeriodPills active={period} />

      {notable.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[10px] uppercase tracking-[2px] text-[#5a6a72] font-bold">Notable</h2>
          <div className="space-y-2">
            {notable.map((n, i) => {
              const cls =
                n.tone === "bad"
                  ? "border-[#cd8b76]/40 bg-[#fef9f5]"
                  : n.tone === "good"
                    ? "border-emerald-200 bg-emerald-50"
                    : "border-[#dad4cb] bg-white";
              const dot =
                n.tone === "bad" ? "bg-[#cd8b76]" : n.tone === "good" ? "bg-emerald-500" : "bg-[#143643]";
              return (
                <div key={i} className={`border ${cls} rounded-lg px-4 py-2.5 flex items-start gap-3`}>
                  <span className={`mt-1.5 inline-block w-2 h-2 rounded-full ${dot} flex-shrink-0`} />
                  <p className="text-xs text-[#11242e]">{n.text}</p>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Section 1: Sources */}
      <Section title="Lead source quality" subtitle="Where leads come from and how well each source converts.">
        {sourceRows.length === 0 ? (
          <Empty>No data in this window.</Empty>
        ) : (
          <DataTable
            head={["Source", "Medium / Campaign", "Leads", "Qualified", "Routed", "Enrolled", "Conv %"]}
            rows={sourceRows.map((r) => [
              r.source,
              `${r.medium ?? "—"} / ${r.campaign ?? "—"}`,
              String(r.total),
              `${r.qualified} (${pct(r.qualified, r.total)})`,
              `${r.routed} (${pct(r.routed, r.total)})`,
              `${r.enrolled}`,
              pct(r.enrolled, r.total),
            ])}
            rightAlign={[2, 3, 4, 5, 6]}
          />
        )}
        {totalAdSpend > 0 && (
          <p className="text-[10px] text-[#5a6a72] mt-2 italic">
            Blended CPL across all sources for {PERIOD_LABEL[period].toLowerCase()}: {gbp(totalLeads > 0 ? totalAdSpend / totalLeads : null)}.
          </p>
        )}
      </Section>

      {/* Section 2: Demographics */}
      <Section title="Demographics" subtitle="Who's submitting, who qualifies, who enrols.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <DemographicCard title="Age band" rows={ageBands} />
          <DemographicCard title="Employment status" rows={employments} />
          <DemographicCard title="Course interest (self-funded)" rows={interests} />
          <DemographicCard title="Qualification goal (self-funded)" rows={qualifications} />
          <DemographicCard title="Prior Level 3 or higher" rows={priorL3} />
        </div>
      </Section>

      {/* Section 3: Funnel */}
      <Section
        title="Funnel drop-off"
        subtitle="How far people get on the form before they leave. Step 1 = landed; later steps = each question they answered. Bigger abandoned bar = bigger problem."
      >
        {funnelRows.length === 0 ? (
          <Empty>No partial submissions captured in this window.</Empty>
        ) : (
          <div className="bg-white border border-[#dad4cb] rounded-xl p-4 space-y-2">
            {funnelRows.map((r) => {
              const completedPct = (r.completed / funnelMaxTotal) * 100;
              const abandonedPct = (r.abandoned / funnelMaxTotal) * 100;
              return (
                <div key={r.step} className="space-y-1">
                  <div className="flex justify-between items-baseline text-xs">
                    <span className="font-bold text-[#11242e]">
                      {STEP_LABEL[String(r.step)] ?? `Step ${r.step}`}
                    </span>
                    <span className="text-[#5a6a72]">
                      {r.total} sessions · {r.completed} completed · {r.abandoned} abandoned
                    </span>
                  </div>
                  <div className="h-3 w-full bg-[#f4f1ed] rounded-full overflow-hidden flex">
                    <div className="bg-emerald-500" style={{ width: `${completedPct}%` }} />
                    <div className="bg-[#cd8b76]" style={{ width: `${abandonedPct}%` }} />
                  </div>
                </div>
              );
            })}
            <div className="flex gap-4 mt-3 text-[10px] text-[#5a6a72]">
              <span><span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1" /> Completed</span>
              <span><span className="inline-block w-2 h-2 rounded-full bg-[#cd8b76] mr-1" /> Abandoned</span>
            </div>
          </div>
        )}
      </Section>

      {/* Section 4: Course demand vs supply */}
      <Section
        title="Course demand vs supply"
        subtitle="Which courses pull leads, and whether we have providers covering them. A row with leads but zero providers is a gap to fill."
      >
        {courseRows.length === 0 ? (
          <Empty>No course-tagged leads in this window.</Empty>
        ) : (
          <DataTable
            head={["Course", "Leads", "Routed", "Enrolled", "Providers", "Status"]}
            rows={courseRows.map((r) => [
              r.course,
              String(r.leads),
              `${r.routed} (${pct(r.routed, r.leads)})`,
              String(r.enrolled),
              String(r.providerCount),
              r.providerCount === 0 ? "Demand without supply" : r.providerCount === 1 ? "Single provider" : "OK",
            ])}
            rightAlign={[1, 2, 3, 4]}
            highlight={(row) => row[5] === "Demand without supply"}
          />
        )}
      </Section>

      {/* Section 5: DQ pattern analysis */}
      <Section
        title="DQ pattern analysis"
        subtitle="Why people get DQ'd. Tall bars are the biggest leakage points to consider in copy or eligibility tuning. Counts unique people, not events."
      >
        {dqRows.length === 0 ? (
          <Empty>No DQ rows in this window.</Empty>
        ) : (
          <div className="bg-white border border-[#dad4cb] rounded-xl p-4 space-y-2">
            {dqRows.map((r) => (
              <div key={r.reason} className="space-y-1">
                <div className="flex justify-between items-baseline text-xs">
                  <span className="text-[#11242e]"><strong>{r.label}</strong> <span className="font-mono text-[10px] text-[#5a6a72]">({r.reason})</span></span>
                  <span className="text-[#5a6a72]">
                    {r.count} ({pct(r.count, totalUniqueDQ)})
                  </span>
                </div>
                <div className="h-3 w-full bg-[#f4f1ed] rounded-full overflow-hidden">
                  <div className="bg-[#cd8b76] h-full" style={{ width: `${(r.count / dqMax) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Section 6: Geographic */}
      <Section title="Geographic distribution" subtitle="Where leads come from. Funded leads tag a local authority; self-funded leads share their postcode.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <h3 className="text-[10px] uppercase tracking-[2px] text-[#5a6a72] font-bold mb-2">By local authority (funded)</h3>
            {laRows.length === 0 ? (
              <Empty>No LA-tagged leads.</Empty>
            ) : (
              <DataTable
                head={["Local authority", "Leads", "Qualified", "Enrolled"]}
                rows={laRows.slice(0, 12).map((r) => [r.la, String(r.total), String(r.qualified), String(r.enrolled)])}
                rightAlign={[1, 2, 3]}
              />
            )}
          </div>
          <div>
            <h3 className="text-[10px] uppercase tracking-[2px] text-[#5a6a72] font-bold mb-2">By postcode prefix (self-funded)</h3>
            {postcodeRows.length === 0 ? (
              <Empty>No postcode-tagged leads.</Empty>
            ) : (
              <DataTable
                head={["Postcode", "Leads"]}
                rows={postcodeRows.map((r) => [r.outward, String(r.n)])}
                rightAlign={[1]}
              />
            )}
          </div>
        </div>
      </Section>

      {/* Section 7: Time patterns */}
      <Section title="Time patterns" subtitle="When people submit. Useful for outreach call timing and ad scheduling.">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white border border-[#dad4cb] rounded-xl p-4">
            <h3 className="text-[10px] uppercase tracking-[2px] text-[#5a6a72] font-bold mb-3">By day of week</h3>
            <div className="space-y-2">
              {DOW_NAMES.map((name, i) => (
                <div key={name} className="flex items-center gap-2 text-xs">
                  <span className="w-10 text-[#5a6a72] font-semibold">{name}</span>
                  <div className="flex-1 h-3 bg-[#f4f1ed] rounded-full overflow-hidden">
                    <div className="bg-[#143643] h-full" style={{ width: `${(dowCounts[i] / dowMax) * 100}%` }} />
                  </div>
                  <span className="w-10 text-right font-bold text-[#11242e]">{dowCounts[i]}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="bg-white border border-[#dad4cb] rounded-xl p-4">
            <h3 className="text-[10px] uppercase tracking-[2px] text-[#5a6a72] font-bold mb-3">By hour of day (UTC)</h3>
            <div className="grid grid-cols-12 gap-px h-32 items-end">
              {hourCounts.map((n, i) => (
                <div key={i} className="flex flex-col items-center justify-end h-full" title={`${i}:00 - ${n} leads`}>
                  <div className="w-full bg-[#cd8b76]" style={{ height: `${(n / hourMax) * 100}%` }} />
                </div>
              ))}
            </div>
            <div className="grid grid-cols-12 gap-px text-[9px] text-[#5a6a72] mt-1">
              {Array.from({ length: 12 }, (_, i) => (
                <div key={i} className="text-center">{i * 2}</div>
              ))}
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

function bucketBy(
  subs: SubmissionRow[],
  keyFn: (s: SubmissionRow) => string | null,
  enrolledIds: Set<number>,
): Array<{ key: string; total: number; qualified: number; dq: number; enrolled: number }> {
  const m = new Map<string, { key: string; total: number; qualified: number; dq: number; enrolled: number }>();
  for (const s of subs) {
    const k = keyFn(s);
    if (k === null || k === undefined || k === "") continue;
    let b = m.get(k);
    if (!b) {
      b = { key: k, total: 0, qualified: 0, dq: 0, enrolled: 0 };
      m.set(k, b);
    }
    b.total++;
    if (s.is_dq) b.dq++;
    else b.qualified++;
    if (enrolledIds.has(s.id)) b.enrolled++;
  }
  return Array.from(m.values()).sort((a, b) => b.total - a.total);
}

function pct(n: number, total: number): string {
  if (total === 0) return "—";
  return `${Math.round((n / total) * 1000) / 10}%`;
}

function gbp(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 2 }).format(n);
}

function PeriodPills({ active }: { active: Period }) {
  const periods: Period[] = ["2d", "7d", "30d", "lifetime"];
  return (
    <div className="flex flex-wrap gap-2">
      {periods.map((p) => {
        const isActive = p === active;
        const href = p === "7d" ? "/analytics" : `/analytics?period=${p}`;
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

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-bold uppercase tracking-[2px] text-[#11242e]">{title}</h2>
        {subtitle ? <p className="text-xs text-[#5a6a72] mt-1">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-[#5a6a72] italic">{children}</p>;
}

function DataTable({
  head,
  rows,
  rightAlign,
  highlight,
}: {
  head: string[];
  rows: string[][];
  rightAlign?: number[];
  highlight?: (row: string[]) => boolean;
}) {
  const rightSet = new Set(rightAlign ?? []);
  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl overflow-x-auto shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
      <table className="w-full text-sm">
        <thead className="text-[10px] uppercase tracking-wide text-[#5a6a72] bg-[#f4f1ed]">
          <tr>
            {head.map((h, i) => (
              <th key={i} className={`px-4 py-2 ${rightSet.has(i) ? "text-right" : "text-left"}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={`border-t border-[#dad4cb] ${highlight && highlight(r) ? "bg-[#fef9f5]" : ""}`}>
              {r.map((cell, j) => (
                <td key={j} className={`px-4 py-2 text-xs ${rightSet.has(j) ? "text-right font-bold" : ""}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DemographicCard({
  title,
  rows,
}: {
  title: string;
  rows: Array<{ key: string; total: number; qualified: number; dq: number; enrolled: number }>;
}) {
  if (rows.length === 0) {
    return (
      <div className="bg-white border border-[#dad4cb] rounded-xl p-4">
        <h3 className="text-[10px] uppercase tracking-[2px] text-[#5a6a72] font-bold mb-2">{title}</h3>
        <Empty>No data.</Empty>
      </div>
    );
  }
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-4">
      <h3 className="text-[10px] uppercase tracking-[2px] text-[#5a6a72] font-bold mb-3">{title}</h3>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.key} className="space-y-1">
            <div className="flex justify-between items-baseline text-xs">
              <span className="font-semibold text-[#11242e]">{r.key}</span>
              <span className="text-[10px] text-[#5a6a72]">
                {r.total} total · <span className="text-emerald-700 font-semibold">{r.qualified} q</span> · {r.dq} dq · {r.enrolled} en
              </span>
            </div>
            <div className="h-2 w-full bg-[#f4f1ed] rounded-full overflow-hidden flex">
              <div className="bg-emerald-500" style={{ width: `${(r.qualified / max) * 100}%` }} />
              <div className="bg-[#cd8b76]" style={{ width: `${(r.dq / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
