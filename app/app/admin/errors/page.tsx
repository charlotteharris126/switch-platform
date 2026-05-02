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
import { BulkResolveButton } from "./bulk-resolve";

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

// Severity tells you what to do at a glance:
//   "fix"   — something's actually broken; needs your hands.
//   "clean" — self-resolves or was a one-off; bulk-mark it done.
//   "info"  — audit row, not really an error; mark done when convenient.
type Severity = "fix" | "clean" | "info";

interface SourceExplanation {
  headline: string;
  severity: Severity;
  what: string;
  whatToDo: string;
  bulkNote?: string;
  // Plain-English reassurance for clean/info severities, shown next to the
  // bulk button so owner can see WHY it's safe to dismiss without per-row
  // review.
  safeBecause?: string;
}

const SOURCE_EXPLANATIONS: Record<string, SourceExplanation> = {
  edge_function_sheet_append: {
    headline: "Sheet append failed",
    severity: "fix",
    what: "The lead was saved to our database and emailed to you, but the row didn't make it into the provider's Google Sheet — so the provider can't see it on their tracker yet.",
    whatToDo: "Click Open lead → re-trigger routing manually (this retries the sheet append). If it still fails, the provider's sheet webhook URL is probably wrong — fix it on the provider edit page. Once the row is in the sheet, click \"I've handled this\" and note what you did.",
  },
  reconcile_backfill: {
    headline: "Lead recovered from Netlify",
    severity: "info",
    what: "Not a real error. The hourly safety-net cron noticed a lead in Netlify's form store that was missing from our database, and back-filled it. The lead now exists, but it bypassed the live webhook so routing may not have triggered.",
    whatToDo: "Open each linked lead and confirm it routed. If not, route it manually. Once verified, bulk-clean.",
    bulkNote: "Bulk cleanup — Netlify back-fill audit rows, leads verified.",
    safeBecause: "These rows are audit trails for back-fills that already succeeded. The lead is in the database — dismissing the dead-letter row only clears it from this list. Verify routing happened on the lead itself if unsure.",
  },
  edge_function_partial_capture: {
    headline: "Partial-form capture failed",
    severity: "info",
    what: "Someone started filling the form but didn't submit. Saving their progress failed. Submitted leads are unaffected — this only breaks funnel-drop analytics for the abandoned session.",
    whatToDo: "Self-resolves on the next attempt. Bulk-clean any time.",
    bulkNote: "Bulk cleanup — partial-capture failures don't affect any submitted lead.",
    safeBecause: "Partials are abandoned-form attempts — there is no lead to lose. Worst case you lose one row of analytics on someone who never finished the form.",
  },
  edge_function_brevo_upsert: {
    headline: "Brevo contact sync failed",
    severity: "clean",
    what: "Lead saved fine in our database — only the push to Brevo (email tool) failed. The lead can still be routed and emailed. The Brevo contact may be missing or stale; the next contact event will normally repair it.",
    whatToDo: "If the lead is hot right now, open it and click \"Resync to Brevo\". Otherwise bulk-clean — Brevo catches up on the next status change or chaser.",
    bulkNote: "Bulk cleanup — Brevo upsert errors, contacts will resync on next activity.",
    safeBecause: "The lead is safe in our database. Brevo is eventually consistent: the next status update or chaser fire will trigger a resync. Bulk-dismissing here doesn't lose the lead, only the audit of this one failed sync.",
  },
  edge_function_brevo_upsert_no_match: {
    headline: "Brevo sync ran without a course match",
    severity: "info",
    what: "Lead saved fine, contact pushed to Brevo, but the course wasn't in our routing matrix so course-tailored emails won't trigger. Usually means the course slug isn't in matrix.json, or the lead came from a generic landing page.",
    whatToDo: "If the course is real and you want it in the funnel, add it to matrix.json. Otherwise bulk-clean.",
    bulkNote: "Bulk cleanup — no matrix match, leads not affected.",
    safeBecause: "Lead is in the DB and synced to Brevo. Only impact is that the course-specific email sequence didn't fire. If the course matters, add it to matrix.json — that's a code change, not a dead-letter fix.",
  },
  edge_function_brevo_chase: {
    headline: "Provider chaser failed to fire",
    severity: "clean",
    what: "You clicked \"Send chaser\" on a lead, but Brevo refused to add the contact to the chaser list — usually because the contact doesn't exist in Brevo yet, or has unsubscribed. The Last chaser timestamp on the lead was still stamped, so the system knows you tried.",
    whatToDo: "If the chaser genuinely needs to go out, email the learner directly. Otherwise bulk-clean — re-clicking the chaser button won't help.",
    bulkNote: "Bulk cleanup — chaser failures, learner contacted manually or no longer in scope.",
    safeBecause: "These are failed escalation attempts. The lead state on our side is correct. Bulk-dismissing only removes the failure log.",
  },
  netlify_forms: {
    headline: "Form submission couldn't be saved",
    severity: "fix",
    what: "A learner submitted the form on switchable.org.uk but our webhook couldn't write the lead to the database. The lead may still exist in Netlify's form store (the hourly reconcile cron back-fills from there), but it bypassed the live routing path — provider hasn't been notified.",
    whatToDo: "Check the Why-it-failed message — common causes are DB connection blips or a payload that doesn't match the expected schema. Open the lead if back-filled (look for a matching `reconcile_backfill` row), then route manually. If no back-fill row exists, the lead is in Netlify only — pull it from the Netlify forms dashboard and route by hand.",
  },
  netlify_audit: {
    headline: "Form webhook drift detected",
    severity: "fix",
    what: "The hourly Netlify-forms-audit cron found a mismatch between the live webhook config on Netlify and our allowlist. Could be a webhook deleted by accident, a wrong URL, or a new form on Netlify not in the allowlist. The risk is silent lead loss if a form is feeding nowhere.",
    whatToDo: "Read the Why-it-failed message for the specific drift kind. Open Netlify → Forms → check the named form. Reinstate the webhook (URL is in `https://switchable.org.uk/data/form-allowlist.json`) or update the allowlist if a new form is legitimate.",
  },
  edge_function_provider_email: {
    headline: "Provider notification email failed",
    severity: "fix",
    what: "Lead was saved, routed, and appended to the provider's sheet — but the \"new enquiry, check your sheet\" email to the provider didn't send. The provider doesn't know a lead landed unless they look at the sheet manually.",
    whatToDo: "Open the lead, check the routing log — the row reached the provider's sheet. Email the provider directly with the lead reference so they pick it up. Then mark resolved with a note like \"emailed provider manually\".",
  },
  edge_function_crm_push: {
    headline: "CRM push failed (HubSpot etc)",
    severity: "clean",
    what: "Lead is fine in our database — only the push to a provider's external CRM (HubSpot for Courses Direct) failed. Doesn't affect routing or billing on our side; provider may need to refresh the lead manually in their CRM.",
    whatToDo: "Bulk-clean — failed CRM pushes don't block anything. If the provider depends on the CRM sync for follow-up, ping them with the lead reference so they can pull it manually until we restore the integration.",
    bulkNote: "Bulk cleanup — CRM push failures, leads still routed correctly.",
    safeBecause: "The lead is in our DB and visible to the provider via their sheet. The CRM push is a downstream convenience, not a load-bearing path.",
  },
  edge_function_meta_ingest_api: {
    headline: "Meta API returned an error",
    severity: "clean",
    what: "The daily Meta ads ingest cron called the Meta Marketing API and got an error response (auth failure, rate limit, malformed query). Yesterday's spend / lead numbers won't be in the dashboard until the next successful run picks them up.",
    whatToDo: "If it's a one-off, the next 08:00 UTC run will catch up automatically (rolling 7-day window, idempotent). If it's recurring, check `META_ACCESS_TOKEN` validity in Supabase Vault and the ad account ID. Bulk-clean once today's numbers look right on the Profit tracker.",
    bulkNote: "Bulk cleanup — Meta API errors, next ingest run back-fills.",
    safeBecause: "The cron's rolling 7-day window is idempotent — the next successful run picks up missed days. Bulk-dismissing only clears the failure log.",
  },
  edge_function_meta_ingest_fetch: {
    headline: "Couldn't reach Meta API (network)",
    severity: "clean",
    what: "Same as above but the network call itself failed — Meta unreachable, DNS hiccup, or function timeout. Recovers automatically on the next daily run.",
    whatToDo: "Wait for tomorrow's 08:00 UTC ingest. If it keeps failing, check Supabase Edge Function logs for the timeout pattern. Bulk-clean once numbers look right.",
    bulkNote: "Bulk cleanup — transient Meta fetch errors, ingest self-heals.",
    safeBecause: "Rolling-window idempotent ingest covers gaps automatically.",
  },
  edge_function_meta_ingest_parse: {
    headline: "Meta returned non-JSON",
    severity: "clean",
    what: "Meta returned a response we couldn't parse as JSON (usually a 5xx error page or a rate-limit HTML). Same recovery path as the other Meta ingest errors — next run fixes it.",
    whatToDo: "Bulk-clean. If it persists for >2 days, check Meta API status and the Edge Function logs.",
    bulkNote: "Bulk cleanup — Meta parse errors, ingest self-heals.",
    safeBecause: "Rolling-window idempotent ingest covers gaps automatically.",
  },
  edge_function_meta_ingest_upsert: {
    headline: "Meta data couldn't be written to DB",
    severity: "fix",
    what: "Meta returned valid data but the write to `ads_switchable.meta_daily` failed — usually a schema mismatch (Meta added a field), a DB role permission gap, or a constraint violation.",
    whatToDo: "Read the Why-it-failed message — Postgres error codes point at the exact issue. Most likely a schema/grant fix in a migration. Don't bulk-dismiss without resolving, since the data isn't backed up anywhere else.",
  },
};

const DEFAULT_EXPLANATION: SourceExplanation = {
  headline: "Unknown ingestion error",
  severity: "fix",
  what: "An ingestion or webhook step failed for a reason we don't have a plain-English explanation for yet. The exact failure is in the Why-it-failed column on the row.",
  whatToDo: "Read the error message in the row. If a lead is linked, click Open lead to inspect. If it's a system error (auth/config/network), check the relevant Edge Function logs in Supabase. Once you've handled it, click \"I've handled this\" and note what you did.",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  fix: "Action needed",
  clean: "Just clean up",
  info: "Informational",
};

const SEVERITY_PILL: Record<Severity, string> = {
  fix: "bg-[#b3412e] text-white",
  clean: "bg-[#cd8b76] text-white",
  info: "bg-[#dad4cb] text-[#11242e]",
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

  // Lead reconciliation window: align to Meta's earliest data so we're
  // comparing the same period on both sides. Falls back to last 30 days if
  // Meta has no rows yet.
  const earliestMetaRes = await supabase
    .schema("ads_switchable")
    .from("meta_daily")
    .select("date")
    .order("date", { ascending: true })
    .limit(1);
  const earliestMetaDate = (earliestMetaRes.data?.[0] as { date: string } | undefined)?.date ?? null;
  const reconcileCutoffDate = earliestMetaDate ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const reconcileCutoffISO = new Date(reconcileCutoffDate + "T00:00:00Z").toISOString();

  const [deadLetterRes, routingLogRes, liveRoutedRes, archivedRes, childCount, metaLeadsRes, dbLeadsRes] = await Promise.all([
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
    // Meta-reported leads (last 30 days, sum across all rows).
    supabase
      .schema("ads_switchable")
      .from("meta_daily")
      .select("leads")
      .gte("date", reconcileCutoffDate),
    // DB qualified leads (last 30 days). Distinct emails to match the
    // de-duped count we use elsewhere.
    supabase
      .schema("leads")
      .from("submissions")
      .select("email")
      .eq("is_dq", false)
      .is("archived_at", null)
      .gte("submitted_at", reconcileCutoffISO),
  ]);

  const metaReported30d = ((metaLeadsRes.data ?? []) as Array<{ leads: number | null }>).reduce(
    (s, r) => s + Number(r.leads ?? 0),
    0,
  );
  const dbDistinct30d = new Set(
    ((dbLeadsRes.data ?? []) as Array<{ email: string | null }>)
      .map((r) => r.email?.toLowerCase().trim() ?? "")
      .filter((e) => e.length > 0),
  ).size;

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
        title="Data health"
        subtitle={
          deadLetterRes.error ? (
            <span className="text-[#b3412e]">Error: {deadLetterRes.error.message}</span>
          ) : (
            <>Two sections: does the database reconcile, and is anything broken right now.</>
          )
        }
      />

      <ReconciliationCard
        data={reconciliation}
        metaReported={metaReported30d}
        dbDistinct={dbDistinct30d}
        windowStartDate={reconcileCutoffDate}
      />

      <ErrorsSectionHeader unresolvedCount={unresolved.length} resolvedCount={resolved.length} over7dCount={over7d} />

      {unresolved.length === 0 ? (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="pt-4 text-xs text-emerald-900">
            <strong>No errors.</strong> Every webhook, sheet append, and ingestion ran cleanly. Nothing needs your attention here.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="bg-[#fef9f5] border-[#cd8b76]/40">
            <CardContent className="pt-4 text-xs text-[#11242e] space-y-2">
              <p>
                <strong>What these are:</strong> background sync failures (sheet appends, Brevo upserts, audit back-fills). Every lead is still in the database — none of these have stopped a lead from reaching a provider. Each card below explains exactly what failed and what (if anything) needs doing.
              </p>
              <ul className="space-y-1 ml-3">
                <li><span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-[#b3412e] text-white font-bold mr-2">ACTION NEEDED</span> Open the lead, follow the steps in the card, then click <em>Mark resolved</em>.</li>
                <li><span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-[#cd8b76] text-white font-bold mr-2">JUST CLEAN UP</span> Safe to clear in bulk — the system catches up automatically.</li>
                <li><span className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-[#dad4cb] text-[#11242e] font-bold mr-2">INFORMATIONAL</span> Audit rows, not real errors. Bulk-clean any time.</li>
              </ul>
              <p className="text-[#5a6a72]">
                <strong>About &ldquo;Mark resolved&rdquo;:</strong> it&rsquo;s an acknowledgement, not a re-run. One click clears the row from this list — it does not retry the underlying sync. If you need a retry, the per-row card tells you where.
              </p>
            </CardContent>
          </Card>

          {(() => {
            // Sort sources so action-needed cards come first.
            const ordered = Array.from(bySource.entries()).sort(([a], [b]) => {
              const sevA = (SOURCE_EXPLANATIONS[a] ?? DEFAULT_EXPLANATION).severity;
              const sevB = (SOURCE_EXPLANATIONS[b] ?? DEFAULT_EXPLANATION).severity;
              const order: Severity[] = ["fix", "clean", "info"];
              return order.indexOf(sevA) - order.indexOf(sevB);
            });
            return ordered;
          })().map(([source, sourceRows]) => {
            const explanation = SOURCE_EXPLANATIONS[source] ?? DEFAULT_EXPLANATION;
            const showBulk = explanation.severity === "clean" || explanation.severity === "info";
            return (
              <Card key={source}>
                <CardHeader>
                  <CardTitle className="text-sm flex flex-wrap items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide ${SEVERITY_PILL[explanation.severity]}`}>
                      {SEVERITY_LABEL[explanation.severity]}
                    </span>
                    <span>{explanation.headline}</span>
                    <Badge className="text-[10px] bg-[#cd8b76] text-white hover:bg-[#cd8b76]">{sourceRows.length}</Badge>
                    <span className="font-mono text-[10px] text-[#5a6a72] font-normal">{source}</span>
                  </CardTitle>
                  <p className="text-xs text-[#5a6a72] mt-2"><strong className="text-[#11242e]">What this is:</strong> {explanation.what}</p>
                  <p className="text-xs text-[#5a6a72] mt-1"><strong className="text-[#11242e]">What to do:</strong> {explanation.whatToDo}</p>
                  {showBulk ? (
                    <div className="mt-3 space-y-2">
                      <BulkResolveButton
                        source={source}
                        count={sourceRows.length}
                        defaultNote={explanation.bulkNote ?? `Bulk cleanup — ${explanation.headline.toLowerCase()}.`}
                      />
                      {explanation.safeBecause ? (
                        <p className="text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2 py-1.5">
                          <strong>Safe to dismiss without per-row review:</strong> {explanation.safeBecause}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Lead</TableHead>
                        <TableHead>Why it failed</TableHead>
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
                        const errMsg = (r.error_context ?? "").split("\n")[0] || "—";
                        const errShort = errMsg.length > 140 ? errMsg.slice(0, 140) + "…" : errMsg;
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
                                {formName !== "—" ? ` · ${formName}` : ""}
                              </div>
                            </TableCell>
                            <TableCell
                              className="text-[11px] text-[#11242e] font-mono leading-tight"
                              title={r.error_context ?? undefined}
                            >
                              {errShort}
                            </TableCell>
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
                              <div className="flex flex-col gap-1">
                                {explanation.severity === "fix" && sid != null && (
                                  <Link
                                    href={`/leads/${sid}`}
                                    className="text-[10px] font-bold uppercase tracking-wide text-white bg-[#cd8b76] hover:bg-[#b3412e] px-3 h-7 rounded inline-flex items-center justify-center"
                                  >
                                    Open lead
                                  </Link>
                                )}
                                <ResolveButton
                                  errorId={r.id}
                                  defaultNote={`Acknowledged — ${explanation.headline.toLowerCase()}.`}
                                  requireNote={explanation.severity === "fix"}
                                />
                              </div>
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

function ReconciliationCard({
  data,
  metaReported,
  dbDistinct,
  windowStartDate,
}: {
  data: ReconciliationData;
  metaReported: number;
  dbDistinct: number;
  windowStartDate: string;
}) {
  const gap = data.routing_log_rows - data.unique_people_routed;
  const accountedFor = data.archived_routed_rows + data.linked_reapplications + data.rapid_fire_dupes;
  const dbReconciles = gap === accountedFor;

  const windowLabel = new Date(windowStartDate + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  let leadStatus: "ok" | "meta_low" | "db_low" | "no_data";
  let leadLabel: string;
  let leadDetail: string;

  if (metaReported === 0 && dbDistinct === 0) {
    leadStatus = "no_data";
    leadLabel = "No data yet";
    leadDetail = "Either Meta ingestion hasn't run or no leads in the last 30 days.";
  } else if (metaReported === 0) {
    leadStatus = "no_data";
    leadLabel = "Awaiting Meta ingestion";
    leadDetail = `${dbDistinct} DB leads logged. Meta numbers will appear here after the daily ingest runs.`;
  } else {
    const dbVsMeta = (dbDistinct - metaReported) / metaReported;
    if (dbVsMeta < -0.05) {
      leadStatus = "db_low";
      leadLabel = "DB undercounting";
      leadDetail = `DB count (${dbDistinct}) is ${Math.abs(Math.round(dbVsMeta * 100))}% below Meta's count (${metaReported}). This should never happen — every form submit lands in our DB directly. Investigate the webhook path.`;
    } else if (metaReported < dbDistinct * 0.75) {
      leadStatus = "meta_low";
      leadLabel = "Meta tracking degraded";
      leadDetail = `Meta is reporting ${metaReported} leads, our DB has ${dbDistinct}. Meta normally under-counts by 10-25% (cookie blocking, iOS), but ${Math.round(((dbDistinct - metaReported) / dbDistinct) * 100)}% is high. Check the Meta pixel and CAPI on the funded funnel.`;
    } else {
      leadStatus = "ok";
      leadLabel = "Aligned";
      leadDetail = `Within normal range. Meta reports ${metaReported}, DB has ${dbDistinct} (gap is the expected cookie-blocking shortfall).`;
    }
  }

  const everythingReconciles = dbReconciles && (leadStatus === "ok" || leadStatus === "no_data");
  const anyDrift = !dbReconciles || leadStatus === "db_low";

  const cardCls = anyDrift
    ? "border-[#b3412e]/40 bg-[#b3412e]/5"
    : everythingReconciles
      ? "border-emerald-200"
      : "border-[#cd8b76]/40 bg-[#fef9f5]";

  const overallBadge = anyDrift
    ? { cls: "bg-[#b3412e] text-white hover:bg-[#b3412e]", label: "Drift, investigate" }
    : everythingReconciles
      ? { cls: "bg-emerald-600 text-white hover:bg-emerald-600", label: "All reconciled ✓" }
      : { cls: "bg-[#cd8b76] text-white hover:bg-[#cd8b76]", label: leadLabel };

  const leadBadge =
    leadStatus === "db_low"
      ? "bg-[#b3412e] text-white hover:bg-[#b3412e]"
      : leadStatus === "meta_low"
        ? "bg-[#cd8b76] text-white hover:bg-[#cd8b76]"
        : leadStatus === "ok"
          ? "bg-emerald-600 text-white hover:bg-emerald-600"
          : "bg-[#dad4cb] text-[#11242e] hover:bg-[#dad4cb]";

  return (
    <Card className={cardCls}>
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          Reconciliation
          <Badge className={`text-[10px] ${overallBadge.cls}`}>{overallBadge.label}</Badge>
        </CardTitle>
        <p className="text-xs text-[#5a6a72] mt-1">
          Two sanity checks: do our internal counts add up, and do they match what Meta reports.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <section>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-[10px] font-bold uppercase tracking-[2px] text-[#11242e]">Database</h3>
            {dbReconciles ? (
              <Badge className="text-[10px] bg-emerald-600 text-white hover:bg-emerald-600">Match</Badge>
            ) : (
              <Badge className="text-[10px] bg-[#b3412e] text-white hover:bg-[#b3412e]">Drift</Badge>
            )}
          </div>
          <p className="text-xs text-[#5a6a72] mb-3">
            Every send to a provider is logged. The same person can appear more than once (re-applied for a different course; double-submitted by accident). Unique-people count must equal raw sends minus known duplicates.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-xs">
            <Metric label="Sends logged" value={data.routing_log_rows} />
            <Metric label="Unique people" value={data.unique_people_routed} highlight />
            <Metric label="Difference" value={gap} />
          </div>
          <ul className="text-xs text-[#11242e] mt-3 space-y-1">
            {data.archived_routed_rows > 0 && (
              <li>
                <strong>{data.archived_routed_rows}</strong> archived test rows (sent at the time, soft-deleted from the live set).
              </li>
            )}
            <li>
              <strong>{data.linked_reapplications}</strong> re-applications (same person, different course).
            </li>
            <li>
              <strong>{data.rapid_fire_dupes}</strong> rapid-fire duplicates (same person, multiple submits before the dedupe caught up).
            </li>
          </ul>
          {!dbReconciles && (
            <p className="text-xs text-[#b3412e] mt-2">
              <strong>{gap - accountedFor}</strong> row(s) unexplained — needs investigation.
            </p>
          )}
        </section>

        <section className="border-t border-[#dad4cb] pt-5">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-[10px] font-bold uppercase tracking-[2px] text-[#11242e]">Meta vs DB (since {windowLabel})</h3>
            <Badge className={`text-[10px] ${leadBadge}`}>{leadLabel}</Badge>
          </div>
          <p className="text-xs text-[#5a6a72] mb-3">
            Every lead in our DB (ground truth) should also be visible to Meta&rsquo;s tracking. Meta normally under-counts 10-25% (cookie blocking, iOS). The reverse — DB lower than Meta — means our form pipeline is dropping leads.
          </p>
          <div className="grid grid-cols-3 gap-4 text-xs mb-2">
            <Metric label="DB leads (truth)" value={dbDistinct} highlight />
            <Metric label="Meta-reported" value={metaReported} />
            <Metric label="Difference" value={dbDistinct - metaReported} />
          </div>
          <p className="text-xs text-[#11242e]">{leadDetail}</p>
        </section>
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

function ErrorsSectionHeader({
  unresolvedCount,
  resolvedCount,
  over7dCount,
}: {
  unresolvedCount: number;
  resolvedCount: number;
  over7dCount: number;
}) {
  return (
    <div className="mt-2">
      <h2 className="text-sm font-bold text-[#11242e] uppercase tracking-[2px] mb-1">Errors</h2>
      <p className="text-xs text-[#5a6a72]">
        {unresolvedCount === 0 ? (
          <>No unresolved errors. {resolvedCount > 0 ? `${resolvedCount} resolved (audit trail below)` : null}</>
        ) : (
          <>
            {unresolvedCount} unresolved · {resolvedCount} resolved
            {over7dCount > 0 && <span className="text-[#b3412e]"> · {over7dCount} over 7 days old</span>}
          </>
        )}
      </p>
    </div>
  );
}
