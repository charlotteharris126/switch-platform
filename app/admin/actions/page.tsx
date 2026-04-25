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
import { formatDateTime } from "@/lib/format";

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

  const [unroutedRes, approachingFlipRes, presumedEnrolledRes] = await Promise.all([
    supabase
      .schema("leads")
      .from("submissions")
      .select("id, submitted_at, first_name, last_name, email, course_id, funding_category")
      .eq("is_dq", false)
      .is("primary_routed_to", null)
      .is("archived_at", null)
      .order("submitted_at", { ascending: true }),

    // Approaching 14-day auto-flip: routed_at older than 12 days, but
    // crm.enrolments status is NULL or in early state. Done as a SQL view-
    // style filter via two queries combined client-side; a dedicated view
    // would be cleaner once the pattern is proven.
    supabase
      .schema("crm")
      .from("enrolments")
      .select("id, submission_id, provider_id, status, sent_to_provider_at, updated_at")
      .in("status", ["open", "contacted"])
      .lt("sent_to_provider_at", new Date(Date.now() - 12 * 24 * 3600 * 1000).toISOString()),

    supabase
      .schema("crm")
      .from("enrolments")
      .select("id, submission_id, provider_id, status, sent_to_provider_at, status_updated_at, dispute_deadline_at, notes")
      .eq("status", "presumed_enrolled")
      .order("status_updated_at", { ascending: true }),
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
  }>;

  // For the approaching-flip + presumed-enrolled sections we want learner
  // names. Pull all relevant submissions in one query.
  const submissionIdsToLookup = Array.from(
    new Set([
      ...approachingFlip.map((r) => r.submission_id),
      ...presumedEnrolled.map((r) => r.submission_id),
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

  const totalActions = unrouted.length + approachingFlip.length + presumedEnrolled.length;

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        eyebrow="Actions"
        title="What needs your attention"
        subtitle={
          totalActions === 0 ? (
            <span>Nothing pending. Inbox zero.</span>
          ) : (
            <span>
              {totalActions} {totalActions === 1 ? "lead" : "leads"} across {countActiveSections([unrouted, approachingFlip, presumedEnrolled])} {countActiveSections([unrouted, approachingFlip, presumedEnrolled]) === 1 ? "section" : "sections"}.
            </span>
          )
        }
      />

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
            Auto-flipped after 14 days of provider silence. Confirm <em>enrolled</em> (triggers billing), <em>disputed</em> (provider says didn&apos;t enrol), or <em>not enrolled</em> (closes without billing). Open the lead and use the Enrolment outcome form.
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
                      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(r.status_updated_at)}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        {r.dispute_deadline_at ? formatDateTime(r.dispute_deadline_at) : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-[#5a6a72]">{r.notes ?? "—"}</TableCell>
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
