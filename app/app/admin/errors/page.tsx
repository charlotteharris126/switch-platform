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
import { formatDateTime, formatAgo, truncate } from "@/lib/format";
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

// Plain-English explanation per `dead_letter.source` value. New sources can be
// added here as Edge Functions evolve. Anything unmatched falls back to a
// generic message.
const SOURCE_EXPLANATIONS: Record<string, { what: string; whatToDo: string }> = {
  edge_function_sheet_append: {
    what: "A lead was routed and saved to the database, but appending the row to the provider's Google Sheet failed. The lead exists in admin; the provider doesn't see it on their tracker.",
    whatToDo: "Open the lead and re-trigger the routing manually (sends to the sheet again). If it keeps failing, check the provider's sheet webhook URL on the provider edit form. Once fixed, mark resolved here.",
  },
  reconcile_backfill: {
    what: "The hourly reconciliation cron found a lead in Netlify's submission store that was missing from our database, and back-filled it. Each row here is a back-fill event — the lead IS now in the database, but it bypassed the live webhook and may not have triggered routing.",
    whatToDo: "Open the linked lead and confirm it was routed correctly. If it skipped routing, route it manually via the lead detail page. Mark resolved here once the lead is in the right state.",
  },
  edge_function_partial_capture: {
    what: "A partial form submission (the learner started filling but didn't complete) failed to capture. Doesn't affect submitted leads, but breaks the funnel-drop analytics.",
    whatToDo: "Usually self-resolves on the next attempt. Mark resolved if the row is older than 24 hours.",
  },
};

const DEFAULT_EXPLANATION = {
  what: "An ingestion or webhook step failed for an unknown reason.",
  whatToDo: "Inspect the error context and raw payload. Replay manually if appropriate, or mark resolved with a note explaining the action taken.",
};

export default async function ErrorsPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema("leads")
    .from("dead_letter")
    .select("id,source,received_at,error_context,replayed_at,replay_submission_id,raw_payload")
    .order("received_at", { ascending: false })
    .limit(200);

  const rows = (data ?? []) as DeadLetterRow[];

  const now = Date.now();
  const unresolved = rows.filter((r) => !r.replayed_at);
  const resolved = rows.filter((r) => r.replayed_at);
  const over7d = unresolved.filter(
    (r) => now - new Date(r.received_at).getTime() > 7 * 24 * 3600 * 1000
  ).length;

  // Group unresolved by source so the page is digestible per category
  const bySource = new Map<string, DeadLetterRow[]>();
  for (const r of unresolved) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source)!.push(r);
  }

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        eyebrow="Tools"
        title="Errors"
        subtitle={
          error ? (
            <span className="text-[#b3412e]">Error: {error.message}</span>
          ) : (
            <>
              {unresolved.length} unresolved · {resolved.length} resolved (last 200 rows shown)
              {over7d > 0 && <span className="text-[#b3412e]"> · {over7d} over 7 days old</span>}
            </>
          )
        }
      />

      {unresolved.length === 0 ? (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="pt-4 text-xs text-emerald-900">
            <strong>Inbox zero.</strong> No unresolved errors. The system is healthy.
          </CardContent>
        </Card>
      ) : (
        <>
          {Array.from(bySource.entries()).map(([source, sourceRows]) => {
            const explanation = SOURCE_EXPLANATIONS[source] ?? DEFAULT_EXPLANATION;
            return (
              <Card key={source}>
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <span className="font-mono text-[#143643]">{source}</span>
                    <Badge className="text-[10px] bg-[#cd8b76] text-white hover:bg-[#cd8b76]">{sourceRows.length}</Badge>
                  </CardTitle>
                  <p className="text-xs text-[#5a6a72] mt-2"><strong className="text-[#11242e]">What this is:</strong> {explanation.what}</p>
                  <p className="text-xs text-[#5a6a72] mt-1"><strong className="text-[#11242e]">What to do:</strong> {explanation.whatToDo}</p>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-16">ID</TableHead>
                        <TableHead>Received</TableHead>
                        <TableHead>Age</TableHead>
                        <TableHead className="w-1/3">Error context</TableHead>
                        <TableHead>Linked lead</TableHead>
                        <TableHead>Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sourceRows.map((r) => {
                        const ageMs = now - new Date(r.received_at).getTime();
                        const isStale = ageMs > 7 * 24 * 3600 * 1000;
                        return (
                          <TableRow key={r.id} className={isStale ? "bg-[#b3412e]/5" : ""}>
                            <TableCell className="font-mono text-xs">{r.id}</TableCell>
                            <TableCell className="text-xs whitespace-nowrap">{formatDateTime(r.received_at)}</TableCell>
                            <TableCell className="text-xs text-[#5a6a72] whitespace-nowrap">
                              {formatAgo(r.received_at)}
                              {isStale ? <Badge variant="destructive" className="ml-2 text-[9px]">Stale</Badge> : null}
                            </TableCell>
                            <TableCell className="text-xs text-[#5a6a72] whitespace-pre-wrap break-words">
                              {truncate(r.error_context, 200)}
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                              {r.replay_submission_id ? (
                                <Link href={`/leads/${r.replay_submission_id}`} className="text-[#cd8b76] hover:text-[#b3412e] font-semibold font-mono">
                                  #{r.replay_submission_id}
                                </Link>
                              ) : "—"}
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
            <p className="text-xs text-[#5a6a72] mt-1">For audit reference. Includes auto-replays from the reconciliation cron and manual marks.</p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">ID</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Resolved</TableHead>
                  <TableHead>Linked lead</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resolved.slice(0, 50).map((r) => (
                  <TableRow key={r.id} className="opacity-70">
                    <TableCell className="font-mono text-xs">{r.id}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatDateTime(r.received_at)}</TableCell>
                    <TableCell className="text-xs">{r.source}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{formatDateTime(r.replayed_at)}</TableCell>
                    <TableCell className="text-xs">
                      {r.replay_submission_id ? (
                        <Link href={`/leads/${r.replay_submission_id}`} className="text-[#cd8b76] hover:text-[#b3412e] font-semibold font-mono">
                          #{r.replay_submission_id}
                        </Link>
                      ) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
