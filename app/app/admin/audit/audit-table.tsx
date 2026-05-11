// Shared audit-row table. Renders any list of audit.actions rows with a
// consistent layout — used by /admin/audit (global) and
// /admin/providers/[id]/audit (per-provider).

import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface AuditRow {
  id: number;
  created_at: string;
  actor_user_id: string | null;
  actor_email: string | null;
  surface: "provider" | "admin" | "system" | string;
  action: string;
  target_table: string | null;
  target_id: string | null;
  before_value: Record<string, unknown> | null;
  after_value: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
}

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-[#5a6a72] p-6">
        No audit activity matches this filter.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-44">When</TableHead>
          <TableHead className="w-24">Surface</TableHead>
          <TableHead>Actor</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Target</TableHead>
          <TableHead className="min-w-[24rem]">Change</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <AuditTableRow key={r.id} row={r} />
        ))}
      </TableBody>
    </Table>
  );
}

function AuditTableRow({ row }: { row: AuditRow }) {
  const submissionId =
    row.context && typeof row.context === "object" && "submission_id" in row.context
      ? (row.context as { submission_id?: number }).submission_id
      : null;

  return (
    <TableRow>
      <TableCell className="text-xs whitespace-nowrap font-mono align-top">
        {formatDateTime(row.created_at)}
      </TableCell>
      <TableCell className="align-top">
        <SurfaceBadge surface={row.surface} />
      </TableCell>
      <TableCell className="text-xs align-top">
        <div className="text-[#11242e]">{row.actor_email ?? "—"}</div>
      </TableCell>
      <TableCell className="text-xs align-top">
        <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
          {row.action}
        </code>
      </TableCell>
      <TableCell className="text-xs align-top">
        <div className="font-mono text-[11px] text-[#5a6a72]">
          {row.target_table ?? "—"}
        </div>
        {row.target_id && (
          <div className="font-mono text-[11px] text-[#11242e]">
            #{row.target_id}
          </div>
        )}
        {submissionId != null && (
          <div className="text-[11px] mt-1">
            <Link
              href={`/leads/${submissionId}`}
              className="text-[#cd8b76] hover:text-[#b3412e] font-semibold"
            >
              lead #{submissionId} →
            </Link>
          </div>
        )}
      </TableCell>
      <TableCell className="align-top">
        <ChangeSummary
          before={row.before_value}
          after={row.after_value}
          context={row.context}
        />
      </TableCell>
    </TableRow>
  );
}

function ChangeSummary({
  before,
  after,
  context,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
}) {
  const beforeEntries = before ? Object.entries(before) : [];
  const afterEntries = after ? Object.entries(after) : [];
  const allKeys = new Set([...beforeEntries.map(([k]) => k), ...afterEntries.map(([k]) => k)]);

  if (allKeys.size === 0 && !context) {
    return <span className="text-xs text-[#5a6a72]">—</span>;
  }

  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-[#11242e] hover:text-[#cd8b76] select-none">
        {summariseChange(before, after, context)}
      </summary>
      <div className="mt-2 space-y-2 border-l-2 border-[#dde3e6] pl-3">
        {allKeys.size > 0 && (
          <div className="space-y-0.5">
            {[...allKeys].map((k) => {
              const b = before?.[k];
              const a = after?.[k];
              return (
                <div key={k} className="font-mono text-[11px]">
                  <span className="text-[#5a6a72]">{k}:</span>{" "}
                  <span className="text-rose-700">{formatJson(b)}</span>
                  {" → "}
                  <span className="text-emerald-700">{formatJson(a)}</span>
                </div>
              );
            })}
          </div>
        )}
        {context && Object.keys(context).length > 0 && (
          <pre className="text-[10px] font-mono text-[#5a6a72] whitespace-pre-wrap break-all max-h-40 overflow-auto">
            {JSON.stringify(context, null, 2)}
          </pre>
        )}
      </div>
    </details>
  );
}

function summariseChange(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  context: Record<string, unknown> | null,
): string {
  if (before && "status" in before && after && "status" in after) {
    const b = String(before.status);
    const a = String(after.status);
    if (b !== a) return `status: ${b} → ${a}`;
  }
  if (!before && after && Object.keys(after).length > 0) {
    return `set ${Object.keys(after).join(", ")}`;
  }
  if (before && !after && Object.keys(before).length > 0) {
    return `cleared ${Object.keys(before).join(", ")}`;
  }
  if (context && "bulk_mode" in context) {
    return `bulk ${(context as { bulk_mode?: string }).bulk_mode ?? ""}`;
  }
  if (before && after) {
    return "changed (click to expand)";
  }
  return "details (click to expand)";
}

function formatJson(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function SurfaceBadge({ surface }: { surface: string }) {
  const tone: Record<string, string> = {
    admin: "bg-blue-100 text-blue-900 border-blue-200",
    provider: "bg-emerald-100 text-emerald-900 border-emerald-200",
    system: "bg-slate-100 text-slate-700 border-slate-200",
  };
  const cls = tone[surface] ?? tone.system;
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${cls}`}
    >
      {surface}
    </span>
  );
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
