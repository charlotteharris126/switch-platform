import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatAgo } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { ResolveButton } from "./resolve-button";

interface DeadLetterRow {
  id: number;
  source: string;
  received_at: string;
  error_context: string | null;
  replayed_at: string | null;
  replay_submission_id: number | null;
  raw_payload: Record<string, unknown> | null;
}

interface SubmissionLite {
  id: number;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  primary_routed_to: string | null;
  parent_submission_id: number | null;
  archived_at: string | null;
  is_dq: boolean | null;
}

const SOURCE_EXPLANATIONS: Record<string, { headline: string; what: string; whatToDo: string }> = {
  edge_function_sheet_append: {
    headline: "Sheet append failed",
    what: "The lead was saved to our database and emailed to you, but the row didn't make it into the provider's Google Sheet. The lead is fine on our side. The provider just can't see it on their tracker yet.",
    whatToDo: "Open the lead, re-trigger routing manually (this re-tries the sheet append). If it keeps failing, the provider's webhook URL is probably wrong; check it on their edit page. Mark resolved once the row is in their sheet.",
  },
  reconcile_backfill: {
    headline: "Lead recovered from Netlify",
    what: "Each row below is an audit entry, not a true error. The hourly reconciliation cron found a lead in Netlify's submission store that was missing from our database, and back-filled it. The lead exists now, but it bypassed the live webhook, so routing may not have triggered.",
    whatToDo: "Open each linked lead and confirm it routed correctly. If it didn't route, route it manually. Once the lead is in the right state, mark this row resolved with a short note (e.g. \"verified routed\" or \"manually routed to EMS\").",
  },
  edge_function_partial_capture: {
    headline: "Partial-form capture failed",
    what: "Someone started filling the form but didn't submit. Their progress failed to save. Doesn't affect submitted leads; only breaks funnel-drop analytics.",
    whatToDo: "Usually self-resolves on the next attempt. Mark resolved if older than 24 hours.",
  },
};

const DEFAULT_EXPLANATION = {
  headline: "Unknown ingestion error",
  what: "An ingestion or webhook step failed for an unknown reason.",
  whatToDo: "Inspect the error context and raw payload below. Replay manually if appropriate, or mark resolved with a note explaining the action taken.",
};

function formatLeadName(s: SubmissionLite | undefined): string {
  if (!s) return "Lead not found";
  const name = [s.first_name, s.last_name].filter(Boolean).join(" ").trim();
  if (name) return name;
  if (s.email) return s.email;
  return `Lead #${s.id}`;
}

function leadStateLabel(s: SubmissionLite | undefined): string {
  if (!s) return "—";
  if (s.archived_at) return "Archived";
  if (s.is_dq) return "DQ";
  if (s.primary_routed_to) return "Routed";
  return "Unrouted";
}

export default async function ErrorsPage() {
  const supabase = await createClient();

  const [deadLetterRes, routingLogRes, liveRoutedRes, archivedRes, childCount] = await Promise.all([
    supabase
      .schema("leads")
      .from("dead_letter")
      .select("id,source,received_at,error_context,replayed_at,replay_submission_id,raw_payload")
      .order("received_at", { ascending: false })
      .limit(200),
    supabase.schema("leads").from("routing_log").select("submission_id"),
    // All live (non-archived) routed submissions. We fetch emails so we can
    // count distinct people, and parent_submission_id so we can split
    // linked re-applications from rapid-fire same-email duplicates.
    supabase
      .schema("leads")
      .from("submissions")
      .select("email,parent_submission_id")
      .not("primary_routed_to", "is", null)
      .is("archived_at", null),
    // Archived submission IDs. Used to count routing-log rows pointing at
    // soft-deleted leads. (Archiving nulls primary_routed_to so a direct
    // filter on that column won't see them.)
    supabase
      .schema("leads")
      .from("submissions")
      .select("id")
      .not("archived_at", "is", null),
    supabase
      .schema("leads")
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .not("primary_routed_to", "is", null)
      .not("parent_submission_id", "is", null)
      .is("archived_at", null),
  ]);

  const routingLogRows = ((routingLogRes.data ?? []) as Array<{ submission_id: number }>).map((r) => r.submission_id);
  const archivedIds = new Set(((archivedRes.data ?? []) as Array<{ id: number }>).map((r) => r.id));
  const archivedRoutedRows = routingLogRows.filter((id) => archivedIds.has(id)).length;

  const liveRows = (liveRoutedRes.data ?? []) as Array<{ email: string | null; parent_submission_id: number | null }>;
  const liveRowCount = liveRows.length;
  const liveDistinctEmails = new Set(
    liveRows.map((r) => r.email?.toLowerCase().trim() ?? "").filter((e) => e.length > 0)
  ).size;
  const linkedReapplications = childCount.count ?? 0;
  const sameEmailDupes = Math.max(0, liveRowCount - liveDistinctEmails);
  const rapidFireDupes = Math.max(0, sameEmailDupes - linkedReapplications);

  const reconciliation: ReconciliationData = {
    routing_log_rows: routingLogRows.length,
    unique_people_routed: liveDistinctEmails,
    archived_routed_rows: archivedRoutedRows,
    linked_reapplications: linkedReapplications,
    rapid_fire_dupes: rapidFireDupes,
  };

  const rows = (deadLetterRes.data ?? []) as DeadLetterRow[];

  // Pull every submission_id we can find: from replay_submission_id OR
  // raw_payload.submission_id (reconcile_backfill puts the lead reference there).
  const submissionIds = new Set<number>();
  for (const r of rows) {
    if (r.replay_submission_id) submissionIds.add(r.replay_submission_id);
    const sid = (r.raw_payload as { submission_id?: number } | null)?.submission_id;
    if (typeof sid === "number") submissionIds.add(sid);
  }

  const subsRes = submissionIds.size
    ? await supabase
        .schema("leads")
        .from("submissions")
        .select("id,email,first_name,last_name,primary_routed_to,parent_submission_id,archived_at,is_dq")
        .in("id", Array.from(submissionIds))
    : { data: [] as SubmissionLite[] };

  const subsById = new Map<number, SubmissionLite>();
  for (const s of (subsRes.data ?? []) as SubmissionLite[]) subsById.set(s.id, s);

  const now = Date.now();
  const unresolved = rows.filter((r) => !r.replayed_at);
  const resolved = rows.filter((r) => r.replayed_at);
  const over7d = unresolved.filter(
    (r) => now - new Date(r.received_at).getTime() > 7 * 24 * 3600 * 1000
  ).length;

  const bySource = new Map<string, DeadLetterRow[]>();
  for (const r of unresolved) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source)!.push(r);
  }

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        eyebrow="Tools"
        title="Errors & DB reconciliation"
        subtitle={
          deadLetterRes.error ? (
            <span className="text-[#b3412e]">Error: {deadLetterRes.error.message}</span>
          ) : (
            <>
              {unresolved.length} item{unresolved.length === 1 ? "" : "s"} to review · {resolved.length} resolved
              {over7d > 0 && <span className="text-[#b3412e]"> · {over7d} over 7 days old</span>}
            </>
          )
        }
      />

      <ReconciliationCard data={reconciliation} />

      {unresolved.length === 0 ? (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="pt-4 text-xs text-emerald-900">
            <strong>Inbox zero.</strong> Nothing to review.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="bg-[#fef9f5] border-[#cd8b76]/40">
            <CardContent className="pt-4 text-xs text-[#11242e]">
              <strong>What &ldquo;Mark resolved&rdquo; means:</strong> click it once you&rsquo;ve checked the lead and confirmed it&rsquo;s in the right state (routed, in the sheet, or genuinely DQ&rsquo;d). The note you write becomes part of the audit trail. It does <em>not</em> trigger any automation. It&rsquo;s purely an acknowledgement that you&rsquo;ve dealt with the row.
            </CardContent>
          </Card>

          {Array.from(bySource.entries()).map(([source, sourceRows]) => {
            const explanation = SOURCE_EXPLANATIONS[source] ?? DEFAULT_EXPLANATION;
            return (
              <Card key={source}>
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <span>{explanation.headline}</span>
                    <Badge className="text-[10px] bg-[#cd8b76] text-white hover:bg-[#cd8b76]">{sourceRows.length}</Badge>
                    <span className="font-mono text-[10px] text-[#5a6a72] font-normal">{source}</span>
                  </CardTitle>
                  <p className="text-xs text-[#5a6a72] mt-2"><strong className="text-[#11242e]">What this is:</strong> {explanation.what}</p>
                  <p className="text-xs text-[#5a6a72] mt-1"><strong className="text-[#11242e]">What to do:</strong> {explanation.whatToDo}</p>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Lead</TableHead>
                        <TableHead>Form</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Received</TableHead>
                        <TableHead>Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sourceRows.map((r) => {
                        const ageMs = now - new Date(r.received_at).getTime();
                        const isStale = ageMs > 7 * 24 * 3600 * 1000;
                        const sid =
                          r.replay_submission_id ??
                          (r.raw_payload as { submission_id?: number } | null)?.submission_id ??
                          null;
                        const lead = sid != null ? subsById.get(sid) : undefined;
                        const formName =
                          (r.raw_payload as { form_name?: string } | null)?.form_name ?? "—";
                        return (
                          <TableRow key={r.id} className={isStale ? "bg-[#b3412e]/5" : ""}>
                            <TableCell className="text-xs">
                              {sid != null ? (
                                <Link href={`/leads/${sid}`} className="text-[#143643] hover:text-[#cd8b76] font-semibold">
                                  {formatLeadName(lead)}
                                </Link>
                              ) : (
                                <span className="text-[#5a6a72]">No lead linked</span>
                              )}
                              <div className="text-[10px] text-[#5a6a72] font-mono">
                                {sid != null ? `#${sid}` : `dead-letter #${r.id}`}
                                {lead?.email ? ` · ${lead.email}` : ""}
                              </div>
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap text-[#5a6a72]">{formName}</TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              <span className={
                                lead?.archived_at ? "text-[#5a6a72]" :
                                lead?.primary_routed_to ? "text-emerald-700 font-semibold" :
                                lead?.is_dq ? "text-[#5a6a72]" :
                                "text-[#b3412e] font-semibold"
                              }>
                                {leadStateLabel(lead)}
                              </span>
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap text-[#5a6a72]">
                              {formatAgo(r.received_at)}
                              <div className="text-[10px]">{formatDateTime(r.received_at)}</div>
                              {isStale ? <Badge variant="destructive" className="ml-0 mt-1 text-[9px]">Stale</Badge> : null}
                            </TableCell>
                            <TableCell>
                              <ResolveButton errorId={r.id} />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            );
          })}
        </>
      )}

      {resolved.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Resolved (recent)</CardTitle>
            <p className="text-xs text-[#5a6a72] mt-1">For audit reference. Includes auto-replays and manual resolutions.</p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Resolved</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resolved.slice(0, 50).map((r) => {
                  const sid =
                    r.replay_submission_id ??
                    (r.raw_payload as { submission_id?: number } | null)?.submission_id ??
                    null;
                  const lead = sid != null ? subsById.get(sid) : undefined;
                  return (
                    <TableRow key={r.id} className="opacity-70">
                      <TableCell className="text-xs">
                        {sid != null ? (
                          <Link href={`/leads/${sid}`} className="text-[#143643] hover:text-[#cd8b76] font-semibold">
                            {formatLeadName(lead)}
                          </Link>
                        ) : (
                          <span className="text-[#5a6a72]">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{r.source}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(r.received_at)}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{formatDateTime(r.replayed_at)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

interface ReconciliationData {
  routing_log_rows: number;
  unique_people_routed: number;
  archived_routed_rows: number;
  linked_reapplications: number;
  rapid_fire_dupes: number;
}

function ReconciliationCard({ data }: { data: ReconciliationData }) {
  const gap = data.routing_log_rows - data.unique_people_routed;
  const accountedFor = data.archived_routed_rows + data.linked_reapplications + data.rapid_fire_dupes;
  const reconciles = gap === accountedFor;

  return (
    <Card className={reconciles ? "border-emerald-200" : "border-[#b3412e]/40 bg-[#b3412e]/5"}>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          DB reconciliation: routing
          {reconciles ? (
            <Badge className="text-[10px] bg-emerald-600 text-white hover:bg-emerald-600">All accounted for</Badge>
          ) : (
            <Badge className="text-[10px] bg-[#b3412e] text-white hover:bg-[#b3412e]">Gap: investigate</Badge>
          )}
        </CardTitle>
        <p className="text-xs text-[#5a6a72] mt-2">
          Why this exists: the raw routing log records every send to a provider. The unique-people KPI on Overview counts distinct emails. The two won&rsquo;t match exactly. This card shows where the difference comes from.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-xs">
          <Metric label="Routing-log rows (raw sends)" value={data.routing_log_rows} />
          <Metric label="Unique people routed (KPI)" value={data.unique_people_routed} highlight />
          <Metric label="Gap to explain" value={gap} />
        </div>
        <div className="mt-5 border-t border-[#dad4cb] pt-4">
          <p className="text-[10px] uppercase tracking-wide text-[#5a6a72] font-bold mb-2">Gap breakdown</p>
          <ul className="text-xs text-[#11242e] space-y-1.5">
            <li>
              <strong>{data.archived_routed_rows}</strong> archived test rows (sent at the time, then later soft-deleted from the live set)
            </li>
            <li>
              <strong>{data.linked_reapplications}</strong> linked re-applications (same person came back for a different course; system tagged as parent/child)
            </li>
            <li>
              <strong>{data.rapid_fire_dupes}</strong> same-email duplicates (one person submitted multiple times in a short window before the dedupe could catch up)
            </li>
          </ul>
          <p className="text-xs text-[#11242e] mt-3">
            {reconciles ? (
              <>Total: <strong>{accountedFor}</strong> = the gap. Reconciles cleanly.</>
            ) : (
              <>Total accounted for: <strong>{accountedFor}</strong>. Remaining: <strong className="text-[#b3412e]">{gap - accountedFor}</strong> row(s) need investigating.</>
            )}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div>
      <div className={`text-2xl font-bold ${highlight ? "text-[#cd8b76]" : "text-[#143643]"}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-[#5a6a72] font-bold mt-1">{label}</div>
    </div>
  );
}
