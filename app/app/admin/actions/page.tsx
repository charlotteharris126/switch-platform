import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PageHeader } from "@/components/page-header";
import { formatDateTime, formatAgo } from "@/lib/format";
import { RealtimeRefresh } from "@/components/realtime-refresh";
import { PendingActions } from "../sheet-activity/pending-actions";
import { InlineOutcomeButtons } from "./inline-outcome-buttons";

// What needs your attention — items that require human judgement, not
// states the auto-chase / auto-flip crons already handle.
//
// Lead-level decisions:
// - Awaiting your call: AI-suggested status changes from sheet notes
//   that need approve/reject.
// - Unrouted: qualified leads with no routing decision yet.
// - Presumed (awaiting confirmation): the cron has flipped a lead;
//   you confirm/dispute, which triggers billing or pauses it.
// - U1 bounces: welcome email to learner bounced; chase manually.
//
// Provider-level patterns (drift signals — chase the provider, not the lead):
// - SLA breaches: provider has N leads sat 'open' past the threshold.
// - Cannot-reach hotspots: provider's cannot_reach rate >20% this week.
// - Zero-confirmation providers: 5+ routings in 30d, no confirmations.
//
// Sections deliberately NOT shown (cron handles them):
// - Approaching 14-day auto-flip: cron flips at day 14.
// - Needs another chase: auto-chaser re-fires on schedule.
// - Cannot reach, no chaser sent: auto-chaser fires SF2 automatically
//   when status flips. Non-empty = system bug — belongs on /admin/errors,
//   not as a task.

// SLA threshold (days). A lead routed >this many days ago that's still
// 'open' counts as past SLA. 7d is tighter than the 14d auto-flip clock
// — gives an early signal before the cron auto-flips.
const SLA_OPEN_DAYS = 7;

// "Recent" window for provider rate metrics (cannot_reach hotspots).
const RECENT_WINDOW_DAYS = 7;

// Window for "no confirmations despite N routings" pattern.
const CONFIRM_PATTERN_DAYS = 30;
const MIN_ROUTINGS_FOR_CONFIRM_PATTERN = 5;

// Cannot-reach rate threshold for a "hotspot" flag.
const CANNOT_REACH_HOTSPOT_PCT = 20;

// Confirmation statuses (B2C + B2B billable).
const CONFIRMATION_STATUSES = new Set([
  "enrolled", "presumed_enrolled",
  "signed", "presumed_employer_signed",
]);

export default async function ActionsPage() {
  const supabase = await createClient();

  const slaCutoffISO = new Date(Date.now() - SLA_OPEN_DAYS * 24 * 3600 * 1000).toISOString();
  const recentCutoffISO = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const confirmWindowCutoffISO = new Date(Date.now() - CONFIRM_PATTERN_DAYS * 24 * 3600 * 1000).toISOString();

  const [
    unroutedRes,
    presumedEnrolledRes,
    pendingAiRes,
    slaBreachRes,
    recentEnrolmentsRes,
    confirmWindowEnrolmentsRes,
    u1BounceRes,
  ] = await Promise.all([
    supabase
      .schema("leads")
      .from("submissions")
      .select("id, submitted_at, first_name, last_name, email, course_id, funding_category")
      .eq("is_dq", false)
      .is("primary_routed_to", null)
      .is("archived_at", null)
      .order("submitted_at", { ascending: true }),

    // Presumed-state queue spans both lead types: learner
    // presumed_enrolled (14-day auto-flip) AND employer
    // presumed_employer_signed (60-day auto-flip). Both states share the
    // same 7-day dispute window semantics.
    supabase
      .schema("crm")
      .from("enrolments")
      .select("id, submission_id, provider_id, status, sent_to_provider_at, status_updated_at, dispute_deadline_at, notes, disputed_at, disputed_reason")
      .in("status", ["presumed_enrolled", "presumed_employer_signed"])
      .order("status_updated_at", { ascending: true }),

    // Pending AI suggestions from sheet Notes edits awaiting owner approval.
    supabase
      .schema("crm")
      .from("pending_updates")
      .select("id, enrolment_id, current_status, suggested_status, ai_summary, ai_confidence, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false }),

    // SLA breaches: open enrolments routed > SLA_OPEN_DAYS ago. Aggregated
    // per-provider in JS below. Excludes paused / archived providers.
    supabase
      .schema("crm")
      .from("enrolments")
      .select("provider_id")
      .eq("status", "open")
      .lt("sent_to_provider_at", slaCutoffISO),

    // Cannot-reach hotspots: every enrolment created in the last
    // RECENT_WINDOW_DAYS, aggregate per-provider in JS for rate calc.
    supabase
      .schema("crm")
      .from("enrolments")
      .select("provider_id, status")
      .gte("sent_to_provider_at", recentCutoffISO),

    // Zero-confirmation pattern: every enrolment in the last
    // CONFIRM_PATTERN_DAYS, aggregate per-provider in JS for the
    // 5+ routings with no confirmations rule.
    supabase
      .schema("crm")
      .from("enrolments")
      .select("provider_id, status")
      .gte("sent_to_provider_at", confirmWindowCutoffISO),

    // U1 bounces: welcome email to the learner bounced (hard or soft).
    // Source is crm.email_log; email_type='u1_funded' / 'u1_self' / etc.
    supabase
      .schema("crm")
      .from("email_log")
      .select("id, submission_id, recipient_email, email_type, status, sent_at, error_text")
      .like("email_type", "u1_%")
      .like("status", "bounced_%")
      .order("sent_at", { ascending: false })
      .limit(50),
  ]);

  const unrouted = (unroutedRes.data ?? []) as Array<{
    id: number;
    submitted_at: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    course_id: string | null;
    funding_category: string | null;
  }>;

  const presumedEnrolledRaw = (presumedEnrolledRes.data ?? []) as Array<{
    id: number;
    submission_id: number;
    provider_id: string;
    status: string;
    sent_to_provider_at: string;
    status_updated_at: string;
    dispute_deadline_at: string | null;
    notes: string | null;
    disputed_at: string | null;
    disputed_reason: string | null;
  }>;

  const pendingAi = (pendingAiRes.data ?? []) as Array<{
    id: number;
    enrolment_id: number;
    current_status: string;
    suggested_status: string;
    ai_summary: string | null;
    ai_confidence: string | null;
    created_at: string;
  }>;

  const slaBreachRaw = (slaBreachRes.data ?? []) as Array<{ provider_id: string }>;
  const recentEnrolments = (recentEnrolmentsRes.data ?? []) as Array<{ provider_id: string; status: string }>;
  const confirmWindowEnrolments = (confirmWindowEnrolmentsRes.data ?? []) as Array<{ provider_id: string; status: string }>;
  const u1BouncesRaw = (u1BounceRes.data ?? []) as Array<{
    id: number;
    submission_id: number;
    recipient_email: string;
    email_type: string;
    status: string;
    sent_at: string | null;
    error_text: string | null;
  }>;

  // Provider lookup: company_name + active/archived for both filtering paused
  // providers off the per-provider cards AND for showing company names.
  const { data: allProvidersData } = await supabase
    .schema("crm")
    .from("providers")
    .select("provider_id, company_name, active, archived_at, is_demo");
  const providersById = new Map<string, { company_name: string; active: boolean; archived_at: string | null; is_demo: boolean }>(
    ((allProvidersData ?? []) as Array<{ provider_id: string; company_name: string; active: boolean; archived_at: string | null; is_demo: boolean }>)
      .map((p) => [p.provider_id, p]),
  );
  const demoProviderIds = new Set<string>(
    Array.from(providersById.entries()).filter(([, v]) => v.is_demo).map(([k]) => k),
  );

  // A provider counts for per-provider cards only if active AND not archived
  // AND not demo. Paused/archived providers (CD, WYK) drop out — Charlotte
  // can't action their leads via them anyway.
  function providerEligibleForCards(providerId: string): boolean {
    const p = providersById.get(providerId);
    if (!p) return false;
    return p.active && !p.archived_at && !p.is_demo;
  }
  function notDemo<T extends { provider_id: string }>(r: T): boolean {
    return !demoProviderIds.has(r.provider_id);
  }
  const presumedEnrolled = presumedEnrolledRaw.filter(notDemo);
  const u1Bounces = u1BouncesRaw; // not provider-tagged; filter via submission lookup later

  // ── Provider-level aggregates ──────────────────────────────────────────
  // SLA breaches: per-provider count of open enrolments routed > SLA_OPEN_DAYS ago.
  const slaByProvider = new Map<string, number>();
  for (const r of slaBreachRaw) {
    if (!providerEligibleForCards(r.provider_id)) continue;
    slaByProvider.set(r.provider_id, (slaByProvider.get(r.provider_id) ?? 0) + 1);
  }
  const slaBreaches = Array.from(slaByProvider.entries())
    .map(([provider_id, count]) => ({ provider_id, count }))
    .sort((a, b) => b.count - a.count);

  // Cannot-reach hotspots: per-provider count + rate over RECENT_WINDOW_DAYS.
  const recentByProvider = new Map<string, { total: number; cannotReach: number }>();
  for (const r of recentEnrolments) {
    if (!providerEligibleForCards(r.provider_id)) continue;
    const bucket = recentByProvider.get(r.provider_id) ?? { total: 0, cannotReach: 0 };
    bucket.total += 1;
    if (r.status === "cannot_reach") bucket.cannotReach += 1;
    recentByProvider.set(r.provider_id, bucket);
  }
  const cannotReachHotspots = Array.from(recentByProvider.entries())
    .filter(([, v]) => v.total >= 3 && (v.cannotReach / v.total) * 100 > CANNOT_REACH_HOTSPOT_PCT)
    .map(([provider_id, v]) => ({
      provider_id,
      total: v.total,
      cannotReach: v.cannotReach,
      pct: (v.cannotReach / v.total) * 100,
    }))
    .sort((a, b) => b.pct - a.pct);

  // Zero-confirmation pattern: 5+ routings in CONFIRM_PATTERN_DAYS, none
  // ended in a confirmation status.
  const confirmWindowByProvider = new Map<string, { total: number; confirmed: number }>();
  for (const r of confirmWindowEnrolments) {
    if (!providerEligibleForCards(r.provider_id)) continue;
    const bucket = confirmWindowByProvider.get(r.provider_id) ?? { total: 0, confirmed: 0 };
    bucket.total += 1;
    if (CONFIRMATION_STATUSES.has(r.status)) bucket.confirmed += 1;
    confirmWindowByProvider.set(r.provider_id, bucket);
  }
  const zeroConfirmProviders = Array.from(confirmWindowByProvider.entries())
    .filter(([, v]) => v.total >= MIN_ROUTINGS_FOR_CONFIRM_PATTERN && v.confirmed === 0)
    .map(([provider_id, v]) => ({ provider_id, total: v.total }))
    .sort((a, b) => b.total - a.total);

  // Hydrate enrolment + submission context for pending AI suggestions.
  // Demo-provider enrolments are skipped via the same filter as above.
  const pendingEnrolmentIds = pendingAi.map((p) => p.enrolment_id);
  const pendingEnrolMap = new Map<number, { id: number; submission_id: number; provider_id: string }>();
  if (pendingEnrolmentIds.length > 0) {
    const { data } = await supabase
      .schema("crm")
      .from("enrolments")
      .select("id, submission_id, provider_id")
      .in("id", pendingEnrolmentIds);
    for (const e of (data ?? []) as Array<{ id: number; submission_id: number; provider_id: string }>) {
      if (demoProviderIds.has(e.provider_id)) continue;
      pendingEnrolMap.set(e.id, e);
    }
  }

  // Learner names for sections that render lead-level rows.
  const submissionIdsToLookup = Array.from(
    new Set([
      ...presumedEnrolled.map((r) => r.submission_id),
      ...Array.from(pendingEnrolMap.values()).map((e) => e.submission_id),
      ...u1Bounces.map((r) => r.submission_id),
    ])
  );

  let submissionsById = new Map<number, { id: number; first_name: string | null; last_name: string | null; email: string | null; course_id: string | null }>();
  if (submissionIdsToLookup.length > 0) {
    const { data: subData } = await supabase
      .schema("leads")
      .from("submissions")
      .select("id, first_name, last_name, email, course_id")
      .in("id", submissionIdsToLookup);
    if (subData) {
      submissionsById = new Map(subData.map((s) => [s.id, s]));
    }
  }

  // Provider names for pending AI section (re-uses the master providersById map).
  const providerMap = new Map<string, string>();
  for (const [providerId, info] of providersById) {
    providerMap.set(providerId, info.company_name);
  }

  const allSections = [
    pendingAi,
    unrouted,
    presumedEnrolled,
    u1Bounces,
    slaBreaches,
    cannotReachHotspots,
    zeroConfirmProviders,
  ];
  const totalActions = allSections.reduce((sum, s) => sum + s.length, 0);

  return (
    <div className="max-w-6xl space-y-6">
      <RealtimeRefresh
        tables={[
          { schema: "leads", table: "submissions" },
          { schema: "crm", table: "enrolments" },
          { schema: "crm", table: "pending_updates" },
        ]}
      />
      <PageHeader
        eyebrow="Actions"
        title="What needs your attention"
        subtitle={
          totalActions === 0 ? (
            <span>Nothing pending. Inbox zero.</span>
          ) : (
            <span>
              {totalActions} {totalActions === 1 ? "item" : "items"} across {countActiveSections(allSections)} {countActiveSections(allSections) === 1 ? "section" : "sections"}.
            </span>
          )
        }
      />

      {/* SECTION 0 — Awaiting your call: AI-suggested status changes from sheet Notes that need your decision */}
      {pendingAi.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              Awaiting your call
              <Badge className="bg-[#cd8b76] text-white text-[10px] hover:bg-[#cd8b76]">
                {pendingAi.length}
              </Badge>
            </CardTitle>
            <p className="text-xs text-[#5a6a72] mt-1">
              Provider notes Claude thinks imply a status change. Approve to apply, reject to ignore, or set a different status.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingAi.map((p) => {
              const enrol = pendingEnrolMap.get(p.enrolment_id);
              const sub = enrol ? submissionsById.get(enrol.submission_id) : null;
              const providerName = enrol ? providerMap.get(enrol.provider_id) ?? enrol.provider_id : "—";
              const leadName = sub
                ? [sub.first_name, sub.last_name].filter(Boolean).join(" ") || `#${sub.id}`
                : `Enrolment #${p.enrolment_id}`;
              return (
                <div
                  key={p.id}
                  className="border border-[#dad4cb] rounded-lg p-3 bg-[#fdfcfa]"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
                    <div>
                      <p className="font-medium text-sm">
                        {sub?.id ? (
                          <Link href={`/leads/${sub.id}`} className="text-[#143643] hover:text-[#cd8b76]">
                            {leadName}
                          </Link>
                        ) : (
                          leadName
                        )}
                        <span className="text-xs text-[#5a6a72] ml-2">
                          {providerName} · {sub?.course_id ?? "—"}
                        </span>
                      </p>
                      <p className="text-xs text-[#5a6a72] mt-1">
                        Current: <span className="font-medium text-[#143643]">{p.current_status}</span>
                        {" · "}
                        Suggested: <span className="font-medium text-[#143643]">{p.suggested_status}</span>
                        {p.ai_confidence ? ` (${p.ai_confidence})` : ""}
                      </p>
                    </div>
                    <span className="text-xs text-[#5a6a72]" title={formatDateTime(p.created_at)}>
                      {formatAgo(p.created_at)}
                    </span>
                  </div>
                  {p.ai_summary ? (
                    <p className="text-sm italic text-[#5a6a72] mb-3">&ldquo;{p.ai_summary}&rdquo;</p>
                  ) : null}
                  <PendingActions pendingUpdateId={p.id} suggestedStatus={p.suggested_status} />
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      {/* SECTION 1 — Unrouted */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            Unrouted
            {unrouted.length > 0 && (
              <Badge className="bg-[#cd8b76] text-white text-[10px] hover:bg-[#cd8b76]">
                {unrouted.length}
              </Badge>
            )}
          </CardTitle>
          <p className="text-xs text-[#5a6a72] mt-1">
            Qualified leads waiting to be sent to a provider. Oldest first.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {unrouted.length === 0 ? (
            <p className="text-xs text-[#5a6a72] p-4">All qualified leads routed.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">ID</TableHead>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Course</TableHead>
                  <TableHead>Funding</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unrouted.map((r) => (
                  <TableRow key={r.id} className="hover:bg-[#f4f1ed]/60">
                    <TableCell className="font-mono text-xs">
                      <Link href={`/leads/${r.id}`} className="text-[#cd8b76] hover:text-[#b3412e] font-semibold">
                        {r.id}
                      </Link>
                    </TableCell>
                    <TableCell className="text-xs text-[#5a6a72] whitespace-nowrap">
                      {formatDateTime(r.submitted_at)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {[r.first_name, r.last_name].filter(Boolean).join(" ") || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-[#5a6a72]">{r.email ?? "—"}</TableCell>
                    <TableCell className="text-xs">{r.course_id ?? "—"}</TableCell>
                    <TableCell className="text-xs uppercase tracking-wide font-semibold text-[#143643]">
                      {r.funding_category ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* SECTION 3 — Presumed states (both lead types) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            Presumed (awaiting confirmation)
            {presumedEnrolled.length > 0 && (
              <Badge className="bg-[#cd8b76] text-white text-[10px] hover:bg-[#cd8b76]">
                {presumedEnrolled.length}
              </Badge>
            )}
          </CardTitle>
          <p className="text-xs text-[#5a6a72] mt-1">
            Learner leads auto-flip to <em>presumed enrolled</em> after 14 days of provider silence; employer (B2B) leads flip to <em>presumed signed</em> after 60 days. Mark the real outcome here (triggers billing on enrolled / signed). If the provider rebuts, open the lead to record a dispute (pauses billing while you investigate).
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {presumedEnrolled.length === 0 ? (
            <p className="text-xs text-[#5a6a72] p-4">No presumed-enrolled leads awaiting confirmation.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Lead</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Flipped</TableHead>
                  <TableHead>Dispute deadline</TableHead>
                  <TableHead>Notes</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {presumedEnrolled.map((r) => {
                  const sub = submissionsById.get(r.submission_id);
                  return (
                    <TableRow key={r.id} className="hover:bg-[#f4f1ed]/60">
                      <TableCell className="font-mono text-xs">
                        <Link href={`/leads/${r.submission_id}`} className="text-[#cd8b76] hover:text-[#b3412e] font-semibold">
                          {r.submission_id}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">
                        {sub ? [sub.first_name, sub.last_name].filter(Boolean).join(" ") || "—" : "—"}
                      </TableCell>
                      <TableCell className="text-xs">{r.provider_id}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        {formatDateTime(r.status_updated_at)}
                        {r.disputed_at && (
                          <Badge className="ml-2 text-[9px] bg-[#cd8b76] text-white hover:bg-[#cd8b76]">
                            DISPUTED
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        {r.dispute_deadline_at ? formatDateTime(r.dispute_deadline_at) : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-[#5a6a72]">
                        {r.disputed_reason ?? r.notes ?? "—"}
                      </TableCell>
                      <TableCell>
                        <InlineOutcomeButtons submissionId={r.submission_id} currentStatus={r.status} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* SECTION 4 — U1 welcome email bounces */}
      {u1Bounces.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              U1 welcome email bounced
              <Badge className="bg-[#cd8b76] text-white text-[10px] hover:bg-[#cd8b76]">
                {u1Bounces.length}
              </Badge>
            </CardTitle>
            <p className="text-xs text-[#5a6a72] mt-1">
              Welcome email to the learner bounced (hard or soft). The learner won't get any automated nurture — chase them on phone if possible or mark the lead lost.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Lead</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Bounced</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {u1Bounces.map((r) => {
                  const sub = submissionsById.get(r.submission_id);
                  return (
                    <TableRow key={r.id} className="hover:bg-[#f4f1ed]/60">
                      <TableCell className="font-mono text-xs">
                        <Link href={`/leads/${r.submission_id}`} className="text-[#cd8b76] hover:text-[#b3412e] font-semibold">
                          {r.submission_id}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">
                        {sub ? [sub.first_name, sub.last_name].filter(Boolean).join(" ") || "—" : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-[#5a6a72]">{r.recipient_email}</TableCell>
                      <TableCell className="text-xs uppercase tracking-wide">{r.status.replace("bounced_", "")}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap" title={r.sent_at ? formatDateTime(r.sent_at) : ""}>
                        {r.sent_at ? formatAgo(r.sent_at) : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-[#5a6a72] max-w-[260px] truncate" title={r.error_text ?? ""}>
                        {r.error_text ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* SECTION 5 — Provider patterns: SLA breach + cannot-reach hotspot + zero-confirm */}
      {(slaBreaches.length > 0 || cannotReachHotspots.length > 0 || zeroConfirmProviders.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">Provider patterns</CardTitle>
            <p className="text-xs text-[#5a6a72] mt-1">
              Drift signals at the provider level — chase the provider, not individual leads. Paused / archived providers excluded.
            </p>
          </CardHeader>
          <CardContent className="space-y-5">

            {/* SLA breaches */}
            {slaBreaches.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="font-semibold text-sm text-[#143643]">Leads past SLA ({SLA_OPEN_DAYS}d)</h3>
                  <Badge className="bg-[#cd8b76] text-white text-[10px] hover:bg-[#cd8b76]">
                    {slaBreaches.reduce((sum, r) => sum + r.count, 0)}
                  </Badge>
                </div>
                <p className="text-xs text-[#5a6a72] mb-2">
                  Routed {SLA_OPEN_DAYS}+ days ago, status still <em>open</em>. Auto-flip cron will mop these up at day 14 — but if the count is high, chase the provider for real outcomes first.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead className="text-right">Open &gt; {SLA_OPEN_DAYS}d</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {slaBreaches.map((r) => (
                      <TableRow key={r.provider_id} className="hover:bg-[#f4f1ed]/60">
                        <TableCell className="text-sm">
                          <Link href={`/providers/${encodeURIComponent(r.provider_id)}`} className="text-[#143643] hover:text-[#cd8b76]">
                            {providersById.get(r.provider_id)?.company_name ?? r.provider_id}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right font-semibold">{r.count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Cannot-reach hotspots */}
            {cannotReachHotspots.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="font-semibold text-sm text-[#143643]">Cannot-reach hotspots ({RECENT_WINDOW_DAYS}d)</h3>
                  <Badge className="bg-[#cd8b76] text-white text-[10px] hover:bg-[#cd8b76]">
                    {cannotReachHotspots.length}
                  </Badge>
                </div>
                <p className="text-xs text-[#5a6a72] mb-2">
                  Providers where &gt;{CANNOT_REACH_HOTSPOT_PCT}% of recent routings hit cannot_reach. Either the lead quality dropped or the provider is slow to call.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead className="text-right">Cannot reach</TableHead>
                      <TableHead className="text-right">Total routings</TableHead>
                      <TableHead className="text-right">Rate</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cannotReachHotspots.map((r) => (
                      <TableRow key={r.provider_id} className="hover:bg-[#f4f1ed]/60">
                        <TableCell className="text-sm">
                          <Link href={`/providers/${encodeURIComponent(r.provider_id)}`} className="text-[#143643] hover:text-[#cd8b76]">
                            {providersById.get(r.provider_id)?.company_name ?? r.provider_id}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right text-xs">{r.cannotReach}</TableCell>
                        <TableCell className="text-right text-xs">{r.total}</TableCell>
                        <TableCell className="text-right font-semibold text-[#b3412e]">{r.pct.toFixed(0)}%</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Zero-confirmation providers */}
            {zeroConfirmProviders.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="font-semibold text-sm text-[#143643]">Zero confirmations despite {MIN_ROUTINGS_FOR_CONFIRM_PATTERN}+ routings ({CONFIRM_PATTERN_DAYS}d)</h3>
                  <Badge className="bg-[#cd8b76] text-white text-[10px] hover:bg-[#cd8b76]">
                    {zeroConfirmProviders.length}
                  </Badge>
                </div>
                <p className="text-xs text-[#5a6a72] mb-2">
                  Providers who received {MIN_ROUTINGS_FOR_CONFIRM_PATTERN}+ leads in the last {CONFIRM_PATTERN_DAYS} days but confirmed zero. Conversion problem at their end, or they're not updating statuses.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead className="text-right">Routings ({CONFIRM_PATTERN_DAYS}d)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {zeroConfirmProviders.map((r) => (
                      <TableRow key={r.provider_id} className="hover:bg-[#f4f1ed]/60">
                        <TableCell className="text-sm">
                          <Link href={`/providers/${encodeURIComponent(r.provider_id)}`} className="text-[#143643] hover:text-[#cd8b76]">
                            {providersById.get(r.provider_id)?.company_name ?? r.provider_id}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right font-semibold">{r.total}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

          </CardContent>
        </Card>
      )}
    </div>
  );
}

function countActiveSections(sections: unknown[][]): number {
  return sections.filter((s) => s.length > 0).length;
}
