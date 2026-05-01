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

// One page that surfaces every actionable lead state, so Charlotte never
// has to skim the full leads list to find what needs doing.
//
// Three sections:
// 1. Unrouted — qualified leads sitting in the queue, awaiting a routing
//    decision. Today the only signal is to send to a provider; Phase 2
//    auto-routing slots into the same query.
// 2. Approaching 14-day auto-flip — leads routed 12+ days ago with no
//    terminal-state enrolment outcome. The cron flips them at day 14 to
//    'presumed_enrolled'; this section gives a chance to chase the
//    provider for a real outcome BEFORE that happens.
// 3. Presumed enrolled (awaiting confirmation/dispute) — leads the cron
//    has already flipped. Provider has 7 days to dispute, Charlotte
//    should follow up with the provider for a definitive outcome
//    ('enrolled' triggers billing, 'disputed' resets, 'not_enrolled'
//    closes without billing).

export default async function ActionsPage() {
  const supabase = await createClient();

  const [unroutedRes, approachingFlipRes, presumedEnrolledRes, pendingAiRes] = await Promise.all([
    supabase
      .schema("leads")
      .from("submissions")
      .select("id, submitted_at, first_name, last_name, email, course_id, funding_category")
      .eq("is_dq", false)
      .is("primary_routed_to", null)
      .is("archived_at", null)
      .order("submitted_at", { ascending: true }),

    // Approaching 14-day auto-flip: routed_at older than 12 days, status still
    // 'open'. After migration 0028 the only early state is 'open' — 'contacted'
    // was folded in.
    supabase
      .schema("crm")
      .from("enrolments")
      .select("id, submission_id, provider_id, status, sent_to_provider_at, updated_at")
      .eq("status", "open")
      .lt("sent_to_provider_at", new Date(Date.now() - 12 * 24 * 3600 * 1000).toISOString()),

    supabase
      .schema("crm")
      .from("enrolments")
      .select("id, submission_id, provider_id, status, sent_to_provider_at, status_updated_at, dispute_deadline_at, notes, disputed_at, disputed_reason")
      .eq("status", "presumed_enrolled")
      .order("status_updated_at", { ascending: true }),

    // Pending AI suggestions from sheet Notes edits awaiting owner approval.
    supabase
      .schema("crm")
      .from("pending_updates")
      .select("id, enrolment_id, current_status, suggested_status, ai_summary, ai_confidence, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
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

  const approachingFlip = (approachingFlipRes.data ?? []) as Array<{
    id: number;
    submission_id: number;
    provider_id: string;
    status: string;
    sent_to_provider_at: string;
  }>;

  const presumedEnrolled = (presumedEnrolledRes.data ?? []) as Array<{
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

  // Hydrate enrolment + submission context for pending AI suggestions.
  const pendingEnrolmentIds = pendingAi.map((p) => p.enrolment_id);
  const pendingEnrolMap = new Map<number, { id: number; submission_id: number; provider_id: string }>();
  if (pendingEnrolmentIds.length > 0) {
    const { data } = await supabase
      .schema("crm")
      .from("enrolments")
      .select("id, submission_id, provider_id")
      .in("id", pendingEnrolmentIds);
    for (const e of (data ?? []) as Array<{ id: number; submission_id: number; provider_id: string }>) {
      pendingEnrolMap.set(e.id, e);
    }
  }

  // For the approaching-flip + presumed-enrolled + pending-AI sections we
  // want learner names. Pull all relevant submissions in one query.
  const submissionIdsToLookup = Array.from(
    new Set([
      ...approachingFlip.map((r) => r.submission_id),
      ...presumedEnrolled.map((r) => r.submission_id),
      ...Array.from(pendingEnrolMap.values()).map((e) => e.submission_id),
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

  // Provider names for pending AI section
  const providerIds = Array.from(new Set(Array.from(pendingEnrolMap.values()).map((e) => e.provider_id)));
  const providerMap = new Map<string, string>();
  if (providerIds.length > 0) {
    const { data: provData } = await supabase
      .schema("crm")
      .from("providers")
      .select("provider_id, company_name")
      .in("provider_id", providerIds);
    for (const p of (provData ?? []) as Array<{ provider_id: string; company_name: string }>) {
      providerMap.set(p.provider_id, p.company_name);
    }
  }

  const totalActions = unrouted.length + approachingFlip.length + presumedEnrolled.length + pendingAi.length;

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
              {totalActions} {totalActions === 1 ? "item" : "items"} across {countActiveSections([pendingAi, unrouted, approachingFlip, presumedEnrolled])} {countActiveSections([pendingAi, unrouted, approachingFlip, presumedEnrolled]) === 1 ? "section" : "sections"}.
            </span>
          )
        }
      />

      {/* SECTION 0 — Pending AI suggestions (sheet Notes interpretations awaiting approval) */}
      {pendingAi.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              AI suggestions
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

      {/* SECTION 2 — Approaching 14-day auto-flip */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            Approaching 14-day auto-flip
            {approachingFlip.length > 0 && (
              <Badge className="bg-[#cd8b76] text-white text-[10px] hover:bg-[#cd8b76]">
                {approachingFlip.length}
              </Badge>
            )}
          </CardTitle>
          <p className="text-xs text-[#5a6a72] mt-1">
            Routed 12+ days ago, no outcome yet. Auto-flip cron sets these to <em>presumed enrolled</em> at day 14 — chase the provider now for a real outcome.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {approachingFlip.length === 0 ? (
            <p className="text-xs text-[#5a6a72] p-4">Nothing approaching the auto-flip window.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">Lead</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Course</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Routed</TableHead>
                  <TableHead>Days ago</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {approachingFlip.map((r) => {
                  const sub = submissionsById.get(r.submission_id);
                  const daysAgo = Math.floor((Date.now() - new Date(r.sent_to_provider_at).getTime()) / (24 * 3600 * 1000));
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
                      <TableCell className="text-xs">{sub?.course_id ?? "—"}</TableCell>
                      <TableCell className="text-xs">{r.provider_id}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(r.sent_to_provider_at)}</TableCell>
                      <TableCell className="text-xs font-semibold">
                        {daysAgo}d
                      </TableCell>
                      <TableCell className="text-xs uppercase tracking-wide">{r.status}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* SECTION 3 — Presumed enrolled */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            Presumed enrolled (awaiting confirmation)
            {presumedEnrolled.length > 0 && (
              <Badge className="bg-[#cd8b76] text-white text-[10px] hover:bg-[#cd8b76]">
                {presumedEnrolled.length}
              </Badge>
            )}
          </CardTitle>
          <p className="text-xs text-[#5a6a72] mt-1">
            Auto-flipped after 14 days of provider silence. Resolve to <em>enrolled</em> (triggers billing) or <em>lost</em> (closes without billing). If the provider rebuts the flip, mark <em>disputed</em> on the lead — that pauses billing while you investigate. Open the lead and use the Enrolment outcome form.
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
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function countActiveSections(sections: unknown[][]): number {
  return sections.filter((s) => s.length > 0).length;
}
