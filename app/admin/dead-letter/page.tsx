import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
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

export default async function DeadLetterPage() {
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema("leads")
    .from("dead_letter")
    .select("id,source,received_at,error_context,replayed_at,replay_submission_id,raw_payload")
    .order("received_at", { ascending: false })
    .limit(200);

  const rows = (data ?? []) as Array<{
    id: number;
    source: string;
    received_at: string;
    error_context: string | null;
    replayed_at: string | null;
    replay_submission_id: number | null;
    raw_payload: Record<string, unknown> | null;
  }>;

  const unresolved = rows.filter((r) => !r.replayed_at);
  const now = Date.now();
  const over7d = unresolved.filter(
    (r) => now - new Date(r.received_at).getTime() > 7 * 24 * 3600 * 1000
  ).length;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Dead letter</h1>
        <p className="text-sm text-slate-500 mt-1">
          {error ? (
            <span className="text-rose-600">Error: {error.message}</span>
          ) : (
            <>
              {rows.length} rows · {unresolved.length} unresolved
              {over7d > 0 && <span className="text-rose-600"> · {over7d} over 7 days old</span>}
            </>
          )}
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">ID</TableHead>
              <TableHead>Received</TableHead>
              <TableHead>Age</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Error context</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Replayed</TableHead>
              <TableHead>Linked lead</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-slate-500 py-10">
                  Dead letter is empty.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const ageMs = now - new Date(r.received_at).getTime();
                const isResolved = !!r.replayed_at;
                const isStale = !isResolved && ageMs > 7 * 24 * 3600 * 1000;
                return (
                  <TableRow key={r.id} className={isStale ? "bg-rose-50/50" : ""}>
                    <TableCell className="font-mono text-xs">{r.id}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatDateTime(r.received_at)}
                    </TableCell>
                    <TableCell className="text-xs text-slate-600 whitespace-nowrap">
                      {formatAgo(r.received_at)}
                    </TableCell>
                    <TableCell className="text-xs">{r.source}</TableCell>
                    <TableCell className="text-xs text-slate-600">
                      {truncate(r.error_context, 60)}
                    </TableCell>
                    <TableCell>
                      {isResolved ? (
                        <Badge className="text-xs bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                          Replayed
                        </Badge>
                      ) : isStale ? (
                        <Badge variant="destructive" className="text-xs">
                          Stale
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          Unresolved
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {formatDateTime(r.replayed_at)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.replay_submission_id ? (
                        <Link
                          href={`/leads/${r.replay_submission_id}`}
                          className="text-blue-600 hover:underline font-mono"
                        >
                          #{r.replay_submission_id}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
