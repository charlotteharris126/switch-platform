import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { formatDateTime } from "@/lib/format";
import { EditDraftForm } from "./edit-draft-form";

interface DraftFull {
  id: string;
  brand: string;
  channel: string;
  status: string;
  content: string;
  pillar: string | null;
  hook_type: string | null;
  scheduled_for: string | null;
  cron_batch_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason_category: string | null;
  rejection_reason: string | null;
  external_post_id: string | null;
  published_at: string | null;
  publish_error: string | null;
  edit_history: Array<{ edited_at: string; before: { content: string; scheduled_for: string | null } }> | null;
  created_at: string;
  updated_at: string;
}

export default async function SocialDraftDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data, error } = await supabase
    .schema("social")
    .from("drafts")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return <div className="text-[#b3412e]">Error loading draft: {error.message}</div>;
  }
  if (!data) notFound();

  const draft = data as DraftFull;
  const editHistory = draft.edit_history ?? [];

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <Link href="/social/drafts" className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#cd8b76] hover:text-[#b3412e]">
          ← All drafts
        </Link>
        <div className="flex items-baseline gap-3 mt-2">
          <h1 className="text-[28px] font-extrabold text-[#11242e] tracking-tight">Draft</h1>
          <Badge className={statusBadgeClass(draft.status)}>{draft.status.replace(/_/g, " ")}</Badge>
        </div>
        <PageHeader
          eyebrow="Social"
          title=""
          subtitle={
            <span>
              <span className="font-bold uppercase tracking-wide text-[#143643]">{draft.brand}</span>
              <span> · {draft.channel.replace(/_/g, " ")}</span>
              {draft.pillar ? <> · <span className="text-[#5a6a72]">{draft.pillar}</span></> : null}
              {draft.hook_type ? <> · <span className="text-[#5a6a72]">{draft.hook_type}</span></> : null}
            </span>
          }
        />
      </div>

      <EditDraftForm
        draftId={draft.id}
        status={draft.status}
        initialContent={draft.content}
        initialScheduledFor={draft.scheduled_for}
      />

      {/* Status-specific metadata */}
      {draft.status === "published" && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Published</CardTitle></CardHeader>
          <CardContent className="text-xs space-y-2">
            <FieldRow label="Published at" value={formatDateTime(draft.published_at)} />
            <FieldRow label="LinkedIn URN" value={draft.external_post_id} mono />
          </CardContent>
        </Card>
      )}

      {draft.status === "failed" && draft.publish_error && (
        <Card className="border-[#cd8b76]/60 bg-[#fbf9f5]">
          <CardHeader><CardTitle className="text-sm">Last publish error</CardTitle></CardHeader>
          <CardContent className="text-xs text-[#11242e] whitespace-pre-wrap break-words">
            {draft.publish_error}
          </CardContent>
        </Card>
      )}

      {draft.status === "rejected" && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Rejection</CardTitle></CardHeader>
          <CardContent className="text-xs space-y-2">
            <FieldRow label="Category" value={draft.rejection_reason_category} />
            <FieldRow label="Reason" value={draft.rejection_reason} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm">Audit</CardTitle></CardHeader>
        <CardContent className="text-xs space-y-2">
          <FieldRow label="Created" value={formatDateTime(draft.created_at)} />
          <FieldRow label="Last updated" value={formatDateTime(draft.updated_at)} />
          <FieldRow label="Approved at" value={formatDateTime(draft.approved_at)} />
          <FieldRow label="Cron batch" value={draft.cron_batch_id} mono />
        </CardContent>
      </Card>

      {editHistory.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Edit history ({editHistory.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {editHistory.map((entry, i) => (
              <details key={i} className="border-l-2 border-[#dad4cb] pl-3">
                <summary className="text-xs font-bold cursor-pointer text-[#143643]">
                  Edited {formatDateTime(entry.edited_at)}
                </summary>
                <div className="mt-2 text-xs space-y-1">
                  <p className="text-[#5a6a72]">Previous content:</p>
                  <pre className="text-xs bg-[#f4f1ed] p-3 rounded whitespace-pre-wrap break-words">{entry.before.content}</pre>
                  {entry.before.scheduled_for !== draft.scheduled_for && (
                    <p className="text-[#5a6a72]">Was scheduled for: {formatDateTime(entry.before.scheduled_for)}</p>
                  )}
                </div>
              </details>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function FieldRow({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-[#5a6a72] min-w-32">{label}</span>
      <span className={"text-[#11242e] break-all " + (mono ? "font-mono" : "")}>{value || "—"}</span>
    </div>
  );
}

function statusBadgeClass(status: string): string {
  const base = "text-[10px] uppercase tracking-wide";
  switch (status) {
    case "pending":   return `${base} bg-[#143643] text-white hover:bg-[#143643]`;
    case "approved":  return `${base} bg-[#cd8b76] text-white hover:bg-[#cd8b76]`;
    case "published": return `${base} bg-emerald-100 text-emerald-800 hover:bg-emerald-100`;
    case "failed":    return `${base} bg-red-100 text-red-800 hover:bg-red-100`;
    case "rejected":  return `${base} bg-[#dad4cb] text-[#143643] hover:bg-[#dad4cb]`;
    default:          return `${base} bg-[#f4f1ed] text-[#5a6a72] hover:bg-[#f4f1ed]`;
  }
}
