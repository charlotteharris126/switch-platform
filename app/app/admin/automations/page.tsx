import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

// Phase 6b — admin visibility for the email automations.
//
// Data sources:
//   - crm.email_log: send-level data (counts, statuses, latest send) for the
//     transactional utility path. Shadow-mode rows are tagged via
//     metadata.shadow_log_only and rendered distinctly.
//   - Static metadata for crons + marketing automations. Cron job_run_details
//     live in the cron schema which isn't exposed via PostgREST; tracking
//     run history can layer on later via a wrapped view if Charlotte needs
//     it. For now: email_log activity on the cron-driven email types is
//     evidence enough that the cron itself ran.
//   - Marketing automations are placeholder cards until each is built in
//     Brevo (Phase 5). The page lists what's planned with a link out so the
//     map is clear before any nurture sequence ships.

interface EmailLogAggregateRow {
  email_type: string;
  status: string;
  brevo_message_id: string | null;
  triggered_at: string;
  metadata: Record<string, unknown> | null;
}

interface UtilityRow {
  email_type: string;
  display_name: string;
  trigger_description: string;
  channel: "transactional";
  last_sent_at: string | null;
  sent_24h: number;
  sent_7d: number;
  failed_7d: number;
  bounced_7d: number;
  shadow_only_recent: boolean;
}

interface CronRow {
  name: string;
  schedule_cron: string;
  schedule_human: string;
  description: string;
  status: "active" | "paused";
  function_path: string;
}

interface MarketingRow {
  name: string;
  description: string;
  status: "planned" | "live";
  brevo_link: string;
}

const UTILITY_TYPES: Array<{
  email_type: string;
  display_name: string;
  trigger_description: string;
}> = [
  {
    email_type: "u1_funded",
    display_name: "U1 — Funded welcome",
    trigger_description: "Fires from routing-confirm + netlify-lead-router on every routed lead with funding_category in (gov, loan).",
  },
  {
    email_type: "u1_self",
    display_name: "U1 — Self-funded welcome",
    trigger_description: "Fires from routing-confirm + netlify-lead-router on every routed lead with funding_category=self.",
  },
  {
    email_type: "stalled_funded",
    display_name: "Stalled — Funded",
    trigger_description: "Daily cron at 09:00 UTC. Day-4 open leads (funded), Phase-2 lifecycle gated.",
  },
  {
    email_type: "stalled_self",
    display_name: "Stalled — Self-funded",
    trigger_description: "Daily cron at 09:00 UTC. Day-4 open leads (self-funded), Phase-2 lifecycle gated.",
  },
  {
    email_type: "chaser_funded",
    display_name: "Chaser — Funded",
    trigger_description: "Manual fire from admin dashboard, or cannot_contact status change. Always-allow re-send.",
  },
  {
    email_type: "chaser_self",
    display_name: "Chaser — Self-funded",
    trigger_description: "Manual fire from admin dashboard, or cannot_contact status change. Always-allow re-send.",
  },
  {
    email_type: "u4_funded",
    display_name: "U4 — Funded enrolment",
    trigger_description: "Daily cron at 09:30 UTC. Triggered by SW_ENROL_STATUS flip to enrolled/presumed_enrolled.",
  },
  {
    email_type: "u4_self",
    display_name: "U4 — Self-funded enrolment",
    trigger_description: "Daily cron at 09:30 UTC. Triggered by SW_ENROL_STATUS flip to enrolled/presumed_enrolled.",
  },
];

const CRON_JOBS: CronRow[] = [
  {
    name: "email-stalled-cron-daily",
    schedule_cron: "0 9 * * *",
    schedule_human: "Daily at 09:00 UTC",
    description: "Scans for day-4 open Phase-2 leads, fires stalled emails via sendTransactional.",
    status: "active",
    function_path: "/email-stalled-cron",
  },
  {
    name: "email-u4-cron-daily",
    schedule_cron: "30 9 * * *",
    schedule_human: "Daily at 09:30 UTC",
    description: "Scans for newly enrolled / presumed_enrolled leads, fires U4 confirmation emails.",
    status: "active",
    function_path: "/email-u4-cron",
  },
  {
    name: "brevo-consent-reconcile-daily",
    schedule_cron: "0 4 * * *",
    schedule_human: "Daily at 04:00 UTC",
    description: "Walks Brevo contacts, reconciles channel state vs DB marketing_opt_in. Auto-corrects unsub direction only. Alerts dead_letter on drift > 2%.",
    status: "active",
    function_path: "/brevo-consent-reconcile-daily",
  },
  {
    name: "enrolment-auto-flip-daily",
    schedule_cron: "0 6 * * *",
    schedule_human: "Daily at 06:00 UTC",
    description: "Promotes 14-day-stale 'open' enrolments to 'presumed_enrolled'. PAUSED 2026-05-06 pending day-12 warning email build.",
    status: "paused",
    function_path: "(cron-only, no Edge Function)",
  },
  {
    name: "iris-daily-flags",
    schedule_cron: "30 8 * * *",
    schedule_human: "Daily at 08:30 UTC",
    description: "Iris ad agent — surfaces Meta ad performance flags for Charlotte's daily review.",
    status: "active",
    function_path: "/iris-daily-flags",
  },
];

const MARKETING_AUTOMATIONS: MarketingRow[] = [
  {
    name: "N1 — Funded nurture (day 2)",
    description: "First nurture email after match. Entry: SW_CONSENT_MARKETING=true AND SW_FUNDING_CATEGORY in (gov, loan) AND SW_MATCH_STATUS=matched.",
    status: "planned",
    brevo_link: "https://app.brevo.com/automation/list",
  },
  {
    name: "N2 — Funded nurture (day 8)",
    description: "Second nurture email. Continues from N1 with timed delay.",
    status: "planned",
    brevo_link: "https://app.brevo.com/automation/list",
  },
  {
    name: "N3 — Funded nurture (day 15)",
    description: "Third nurture email. Exits if SW_ENROL_STATUS in (enrolled, presumed_enrolled).",
    status: "planned",
    brevo_link: "https://app.brevo.com/automation/list",
  },
  {
    name: "Referral cold-lead",
    description: "Daily filter: contacts created 28+ days ago AND SW_ENROL_STATUS not in (enrolled, presumed_enrolled) AND SW_CONSENT_MARKETING=true.",
    status: "planned",
    brevo_link: "https://app.brevo.com/automation/list",
  },
  {
    name: "Referral lost-lead",
    description: "Triggers when SW_ENROL_STATUS in (cannot_contact, lost) AND SW_CONSENT_MARKETING=true.",
    status: "planned",
    brevo_link: "https://app.brevo.com/automation/list",
  },
  {
    name: "Monthly newsletter",
    description: "Manual Brevo campaign. Segment: SW_CONSENT_MARKETING=true AND not enrolled.",
    status: "planned",
    brevo_link: "https://app.brevo.com/campaigns",
  },
];

const CONSENT_DRIFT_KIND = "brevo_consent_drift_alert";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function inWindow(iso: string, hoursBack: number): boolean {
  const cutoff = Date.now() - hoursBack * 3600 * 1000;
  return new Date(iso).getTime() >= cutoff;
}

export default async function AutomationsPage() {
  const supabase = await createClient();

  // Pull all email_log activity in the last 7 days. Small enough for current
  // volume to aggregate in JS rather than a per-type SQL groupby. Revisit if
  // email_log grows past ~10k rows/week.
  const sevenDaysAgoISO = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const { data: rawRows } = await supabase
    .schema("crm")
    .from("email_log")
    .select("email_type, status, brevo_message_id, triggered_at, metadata")
    .gte("triggered_at", sevenDaysAgoISO)
    .order("triggered_at", { ascending: false })
    .limit(5000);

  const logs = (rawRows ?? []) as EmailLogAggregateRow[];

  // Latest-send-per-email-type (lifetime — separate query, just one column).
  const { data: latestRows } = await supabase
    .schema("crm")
    .from("email_log")
    .select("email_type, triggered_at")
    .order("triggered_at", { ascending: false })
    .limit(500);
  const latestPerType = new Map<string, string>();
  for (const r of (latestRows ?? []) as Array<{ email_type: string; triggered_at: string }>) {
    if (!latestPerType.has(r.email_type)) latestPerType.set(r.email_type, r.triggered_at);
  }

  // Aggregate per email_type
  const utilityRows: UtilityRow[] = UTILITY_TYPES.map((meta) => {
    const ofType = logs.filter((l) => l.email_type === meta.email_type);
    const sent24h = ofType.filter(
      (l) => inWindow(l.triggered_at, 24) && ["sent", "delivered", "opened", "clicked"].includes(l.status),
    ).length;
    const sent7d = ofType.filter(
      (l) => ["sent", "delivered", "opened", "clicked"].includes(l.status),
    ).length;
    const failed7d = ofType.filter((l) => l.status === "failed").length;
    const bounced7d = ofType.filter((l) =>
      ["bounced_hard", "bounced_soft"].includes(l.status),
    ).length;

    // Shadow-mode detection: any row in last 24h flagged shadow_log_only=true.
    const recent24h = ofType.filter((l) => inWindow(l.triggered_at, 24));
    const shadowOnly =
      recent24h.length > 0 &&
      recent24h.every((l) => l.metadata && (l.metadata as Record<string, unknown>).shadow_log_only === true);

    return {
      email_type: meta.email_type,
      display_name: meta.display_name,
      trigger_description: meta.trigger_description,
      channel: "transactional" as const,
      last_sent_at: latestPerType.get(meta.email_type) ?? null,
      sent_24h: sent24h,
      sent_7d: sent7d,
      failed_7d: failed7d,
      bounced_7d: bounced7d,
      shadow_only_recent: shadowOnly,
    };
  });

  // Global shadow-mode flag: true if all transactional types with recent
  // activity show shadow_only_recent. Surfaces the parity-window state.
  const typesWithRecentActivity = utilityRows.filter((u) => u.sent_24h > 0);
  const globalShadowMode =
    typesWithRecentActivity.length > 0 &&
    typesWithRecentActivity.every((u) => u.shadow_only_recent);

  // Latest unresolved consent-drift alert (Phase 3d output) for the banner.
  const { data: driftRows } = await supabase
    .schema("leads")
    .from("dead_letter")
    .select("id, received_at, error_context, raw_payload")
    .eq("source", CONSENT_DRIFT_KIND)
    .is("replayed_at", null)
    .order("received_at", { ascending: false })
    .limit(1);
  const latestDrift = (driftRows ?? [])[0] as
    | { id: number; received_at: string; error_context: string | null; raw_payload: Record<string, unknown> }
    | undefined;

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Automations"
        title="Email automations"
        subtitle="Visibility on the utility transactional path, the daily crons that drive it, and the marketing automations queued for build."
      />

      {globalShadowMode && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">Shadow mode active.</p>
          <p className="mt-1">
            Transactional sends are being logged but NOT delivered to Brevo. The old list-add automations
            are still doing the actual sending until cutover. Flip{" "}
            <code className="rounded bg-amber-100 px-1">BREVO_SHADOW_MODE=false</code> + redeploy the 5
            sending functions when parity check is green to go live.
          </p>
        </div>
      )}

      {latestDrift && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">
          <p className="font-semibold">Consent drift alert (unresolved)</p>
          <p className="mt-1">{latestDrift.error_context ?? "drift threshold exceeded"}</p>
          <p className="mt-1 text-xs text-rose-800">
            Detected at {formatDate(latestDrift.received_at)}. See dead_letter row #{latestDrift.id} for
            full breakdown.
          </p>
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-bold text-[#11242e]">Utility email automations (transactional)</h2>
        <p className="text-sm text-[#5a6a72]">
          Code-driven sends from Edge Functions. Every send is logged in <code>crm.email_log</code> with
          status, brevo_message_id, and per-row metadata.
        </p>
        <div className="overflow-x-auto rounded-md border border-[#e3e8eb]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead className="text-right">Last sent</TableHead>
                <TableHead className="text-right">24h</TableHead>
                <TableHead className="text-right">7d</TableHead>
                <TableHead className="text-right">Failed (7d)</TableHead>
                <TableHead className="text-right">Bounced (7d)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {utilityRows.map((row) => (
                <TableRow key={row.email_type}>
                  <TableCell className="font-medium">
                    {row.display_name}
                    {row.shadow_only_recent && (
                      <Badge variant="outline" className="ml-2 border-amber-400 text-amber-800">
                        shadow
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-[#5a6a72] max-w-md">{row.trigger_description}</TableCell>
                  <TableCell className="text-right text-sm">{formatDate(row.last_sent_at)}</TableCell>
                  <TableCell className="text-right">{row.sent_24h}</TableCell>
                  <TableCell className="text-right">{row.sent_7d}</TableCell>
                  <TableCell className={`text-right ${row.failed_7d > 0 ? "text-rose-700 font-semibold" : ""}`}>
                    {row.failed_7d}
                  </TableCell>
                  <TableCell className={`text-right ${row.bounced_7d > 0 ? "text-amber-700 font-semibold" : ""}`}>
                    {row.bounced_7d}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-bold text-[#11242e]">Daily crons</h2>
        <p className="text-sm text-[#5a6a72]">
          pg_cron jobs that drive the cron-triggered sends and reconciliation work. Full run history in{" "}
          <code>cron.job_run_details</code>.
        </p>
        <div className="overflow-x-auto rounded-md border border-[#e3e8eb]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {CRON_JOBS.map((cron) => (
                <TableRow key={cron.name}>
                  <TableCell className="font-mono text-xs">{cron.name}</TableCell>
                  <TableCell className="text-sm">{cron.schedule_human}</TableCell>
                  <TableCell>
                    {cron.status === "active" ? (
                      <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">active</Badge>
                    ) : (
                      <Badge className="bg-stone-200 text-stone-700 hover:bg-stone-200">paused</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-[#5a6a72] max-w-xl">{cron.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-bold text-[#11242e]">Marketing automations</h2>
        <p className="text-sm text-[#5a6a72]">
          Consent-gated sends, built and managed inside Brevo. None live yet — placeholders here are the
          planned set, gated on Phase 3 channel enforcement (already built) plus your sequence design and
          template work.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {MARKETING_AUTOMATIONS.map((row) => (
            <div
              key={row.name}
              className="rounded-md border border-[#e3e8eb] bg-white p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold text-[#11242e]">{row.name}</h3>
                <Badge className="bg-stone-100 text-stone-700 hover:bg-stone-100 shrink-0">
                  {row.status}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-[#5a6a72]">{row.description}</p>
              <a
                href={row.brevo_link}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-xs font-semibold text-[#287271] hover:underline"
              >
                Build in Brevo →
              </a>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
