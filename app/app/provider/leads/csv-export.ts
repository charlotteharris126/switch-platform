// CSV export helper for the provider leads list. Split out from
// leads-table.tsx so it can be dynamically imported only when a provider
// actually clicks Export — keeps the table bundle lighter on every other
// render. Trade-off: ~50ms extra on the first click while the chunk
// downloads, which is invisible behind the user gesture.

import { STATUS_LABEL, type LeadStatus } from "@/lib/lead-status";
import type { LeadRow } from "./leads-table";

export function downloadCsv(rows: LeadRow[]) {
  const headers = [
    "Lead ID",
    "Name",
    "Email",
    "Course",
    "Funding",
    "Status",
    "Routed at",
    "Fastrack",
    "Callback pending",
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.id.toString(),
        r.name,
        r.email ?? "",
        r.course_id ?? "",
        r.funding_category ?? "",
        STATUS_LABEL[r.status as LeadStatus] ?? r.status,
        r.routed_at ?? "",
        r.has_fastrack ? "Yes" : "No",
        r.callback_pending ? "Yes" : "No",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  const csv = lines.join("\r\n");
  // BOM so Excel opens UTF-8 cleanly without mangling non-ASCII names.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `switchleads-leads-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
