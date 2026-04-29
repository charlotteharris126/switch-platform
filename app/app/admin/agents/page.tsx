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
import { Card, CardContent } from "@/components/ui/card";

interface Automation {
  jobname: string;
  description: string;
  schedule: string;
}

interface CronRow {
  jobname: string;
  schedule: string;
  active: boolean;
}

interface AgentRow {
  name: string;
  pronouns: string;
  role: string;
  project: string;
  cadence: string;
  status: "active" | "planned";
  automations: Automation[];
}

const AGENTS: AgentRow[] = [
  {
    name: "Mira",
    pronouns: "she/her",
    role: "Business Strategist",
    project: "strategy/",
    cadence: "Monday (weekly review + audit)",
    status: "active",
    automations: [],
  },
  {
    name: "Clara",
    pronouns: "she/her",
    role: "Legal & Accounts",
    project: "accounts-legal/",
    cadence: "Monday",
    status: "active",
    automations: [],
  },
  {
    name: "Paige",
    pronouns: "she/her",
    role: "SwitchLeads Site",
    project: "switchleads/site/",
    cadence: "Monday",
    status: "active",
    automations: [],
  },
  {
    name: "Mable",
    pronouns: "she/her",
    role: "Switchable Site",
    project: "switchable/site/",
    cadence: "Monday",
    status: "active",
    automations: [],
  },
  {
    name: "Cole",
    pronouns: "he/him",
    role: "Claude Code Monitor",
    project: "agents/claude-updates/",
    cadence: "Monday",
    status: "active",
    automations: [],
  },
  {
    name: "Rosa",
    pronouns: "she/her",
    role: "Outreach Pipeline",
    project: "switchleads/outreach/",
    cadence: "Monday",
    status: "active",
    automations: [],
  },
  {
    name: "Iris",
    pronouns: "she/her",
    role: "Switchable Ads",
    project: "switchable/ads/",
    cadence: "Monday",
    status: "active",
    automations: [],
  },
  {
    name: "Nell",
    pronouns: "she/her",
    role: "Client Success",
    project: "switchleads/clients/",
    cadence: "Monday",
    status: "active",
    automations: [],
  },
  {
    name: "Sasha",
    pronouns: "she/her",
    role: "Platform Steward",
    project: "platform/",
    cadence: "Monday + every session start",
    status: "active",
    automations: [
      {
        jobname: "netlify-forms-audit-hourly",
        description: "Catches webhook disablement within 60 min",
        schedule: "Every hour",
      },
      {
        jobname: "purge-stale-partials",
        description: "Deletes incomplete partials older than 90 days",
        schedule: "Daily at 03:00 UTC",
      },
    ],
  },
  {
    name: "Thea",
    pronouns: "she/her",
    role: "SwitchLeads Social",
    project: "switchleads/social/",
    cadence: "Monday + Thursday",
    status: "active",
    automations: [
      {
        jobname: "social-publish-15min",
        description: "Publishes approved drafts via LinkedIn API",
        schedule: "Every 15 min",
      },
      {
        jobname: "social-analytics-sync-daily",
        description: "Pulls post analytics (likes + comments)",
        schedule: "Daily at 04:00 UTC",
      },
    ],
  },
  {
    name: "Esme",
    pronouns: "she/her",
    role: "Switchable Customer Service",
    project: "switchable/customer-service/",
    cadence: "Activates at 5+ replies/day",
    status: "planned",
    automations: [],
  },
];

export default async function AgentsPage() {
  const supabase = await createClient();
  const { data: cronData, error: cronError } = await supabase.rpc("admin_cron_status");
  const cronRows = (cronData ?? []) as CronRow[];
  const cronByName = new Map(cronRows.map((c) => [c.jobname, c]));

  const totalActiveAgents = AGENTS.filter((a) => a.status === "active").length;
  const expectedAutomations = AGENTS.flatMap((a) => a.automations);
  const liveAutomations = expectedAutomations.filter(
    (auto) => cronByName.get(auto.jobname)?.active === true,
  ).length;
  const sessionTriggered = AGENTS.filter((a) => a.automations.length === 0 && a.status === "active").length;

  return (
    <div className="max-w-5xl space-y-6">
      <PageHeader
        eyebrow="Tools"
        title="Agents"
        subtitle={
          cronError ? (
            <span className="text-[#b3412e]">Cron status unavailable: {cronError.message}</span>
          ) : (
            <>The agent team, the project each one owns, and the automations running on their behalf. Cron status is live from the database.</>
          )
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Tile label="Active agents" value={`${totalActiveAgents} of ${AGENTS.length}`} />
        <Tile label="Automations live" value={`${liveAutomations} of ${expectedAutomations.length}`} />
        <Tile label="Session-triggered" value={`${sessionTriggered}`} />
      </div>

      <section>
        <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72] mb-3">Roster</h2>
        <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Cadence</TableHead>
                <TableHead>Automations</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {AGENTS.map((a) => (
                <TableRow key={a.name}>
                  <TableCell className="text-xs whitespace-nowrap align-top">
                    <div className="font-bold text-[#11242e]">{a.name}</div>
                    <div className="text-[10px] text-[#5a6a72]">{a.pronouns}</div>
                  </TableCell>
                  <TableCell className="text-xs align-top">
                    {a.role}
                    {a.status === "planned" && (
                      <span className="ml-2 inline-block px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-[1px] bg-[#f4f1ed] text-[#5a6a72] border border-[#dad4cb]">
                        Planned
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs font-mono text-[#5a6a72] align-top">{a.project}</TableCell>
                  <TableCell className="text-xs text-[#5a6a72] align-top">{a.cadence}</TableCell>
                  <TableCell className="text-xs align-top">
                    {a.automations.length === 0 ? (
                      <span className="text-[#5a6a72] italic">Session-triggered</span>
                    ) : (
                      <ul className="space-y-2">
                        {a.automations.map((auto) => {
                          const cron = cronByName.get(auto.jobname);
                          const status = cron == null
                            ? "missing"
                            : cron.active
                              ? "live"
                              : "paused";
                          const dotClass = status === "live"
                            ? "bg-[#5a8f5e]"
                            : status === "paused"
                              ? "bg-[#cd8b76]"
                              : "bg-[#b3412e]";
                          const dotTitle = status === "live"
                            ? "Active"
                            : status === "paused"
                              ? "Scheduled but disabled"
                              : "Not scheduled in cron.job";
                          return (
                            <li key={auto.jobname} className="flex items-start gap-2">
                              <span
                                className={`inline-block w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${dotClass}`}
                                title={dotTitle}
                              />
                              <div>
                                <div className="font-mono text-[11px] font-bold text-[#11242e]">{auto.jobname}</div>
                                <div className="text-[10px] text-[#5a6a72]">{auto.description}</div>
                                <div className="text-[10px] text-[#5a6a72] font-mono">
                                  {cron?.schedule ?? auto.schedule}
                                </div>
                                {status === "missing" && (
                                  <div className="text-[10px] text-[#b3412e]">Not found in cron schedule</div>
                                )}
                                {status === "paused" && (
                                  <div className="text-[10px] text-[#cd8b76]">Scheduled but disabled</div>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <Card className="bg-[#fef9f5] border-[#cd8b76]/40">
        <CardContent className="pt-4 text-xs text-[#11242e] space-y-2">
          <p>
            <strong>Reading the table.</strong> &ldquo;Session-triggered&rdquo; means the agent runs inside a Claude Code session
            (typically Monday) rather than on a cron. &ldquo;Automations&rdquo; are scheduled jobs that run on the agent&rsquo;s
            behalf without human input. Green dot = live in cron.job and active. Rose dot = scheduled but disabled.
            Red dot = expected by this page but missing from cron.job entirely.
          </p>
          <p>
            <strong>Sources.</strong> The roster comes from <code className="font-mono">agents/CLAUDE.md</code> and individual
            agent CLAUDE.md files. Cron status comes from <code className="font-mono">admin.cron_status()</code>, which reads
            <code className="font-mono"> cron.job</code> live (admin-only). For deeper drilldowns (last run, errors), check
            Sasha&rsquo;s Monday report or the infrastructure manifest.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-4">
      <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">{label}</p>
      <p className="text-2xl font-extrabold mt-2 tracking-tight text-[#11242e]">{value}</p>
    </div>
  );
}
