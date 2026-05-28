"use client";

import { useState, useTransition, useMemo, useEffect, useRef } from "react";
import { updateRoadmapTaskAction, type RoadmapTask, type UpdatePatch } from "./actions";

const REVENUE_MODELS = [
  { key: "foundation", label: "Foundation" },
  { key: "provider", label: "Provider per-enrolment" },
  { key: "apprenticeship", label: "Apprenticeship Employer Signed" },
  { key: "affiliate", label: "Affiliate stack" },
  { key: "ppl", label: "PPL referrals" },
  { key: "app", label: "App subscription" },
  { key: "newsletter-sponsorship", label: "Newsletter sponsorship" },
  { key: "placements", label: "Sponsored placements" },
  { key: "report", label: "Consumer quarterly report" },
  { key: "whitelabel", label: "White-label B2B SaaS (legacy)" },
  { key: "whitelabel-consumer-tools", label: "Whitelabel — consumer tools" },
  { key: "whitelabel-provider-os", label: "Whitelabel — Provider OS" },
] as const;

// Top-tier Phase 1 lanes. Order + labels + goals come from
// platform/docs/admin-roadmap-spec.md (Mira, 2026-05-25 hierarchy update).
const LANES = [
  { key: "per-enrolment-scale",   sort: 1,   label: "Per-enrolment + apprenticeship scale", goal: "£5-7k/mo combined by month 9" },
  { key: "provider-os",           sort: 2,   label: "Whitelabel Provider OS",                 goal: "£1.5-3k MRR (5-10 customers) by month 9" },
  { key: "affiliate-stack",       sort: 3,   label: "Affiliate + PPL stack",                  goal: "£700-1.4k/mo by month 9" },
  { key: "audience-build",        sort: 4,   label: "Audience build (minimum-viable)",        goal: "3-5.5k newsletter subs by month 9" },
  { key: "operational-backbone",  sort: 5,   label: "Operational backbone",                   goal: "Live by end of Phase 1 week 2" },
  { key: "deferred-phase-2",      sort: 99,  label: "Deferred to Phase 2",                    goal: "Activated after £6k profit holds" },
  { key: "complete",              sort: 100, label: "Already shipped",                        goal: "" },
] as const;

const PHASES = [
  { key: "p1", label: "Phase 1: Foundation (months 0-3)" },
  { key: "p2", label: "Phase 2: App + audience (months 4-9)" },
  { key: "p3", label: "Phase 3: Scale + recurring (months 9-18)" },
  { key: "p4", label: "Phase 4: Mature (months 18-30+)" },
] as const;

const STATUSES = ["to_do", "in_progress", "blocked", "review", "complete"] as const;
type Status = (typeof STATUSES)[number];

const STATUS_LABELS: Record<Status, string> = {
  to_do: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  review: "Review",
  complete: "Complete",
};

const STATUS_COLOURS: Record<Status, string> = {
  to_do: "bg-gray-100 text-gray-700",
  in_progress: "bg-blue-100 text-blue-800",
  blocked: "bg-red-100 text-red-800",
  review: "bg-amber-100 text-amber-800",
  complete: "bg-green-100 text-green-800",
};

export function RoadmapClient({ initialTasks }: { initialTasks: RoadmapTask[] }) {
  const [tasks, setTasks] = useState<RoadmapTask[]>(initialTasks);
  const [filterLane, setFilterLane] = useState<string>("");
  const [filterModel, setFilterModel] = useState<string>("");
  const [filterPhase, setFilterPhase] = useState<string>("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [hideComplete, setHideComplete] = useState<boolean>(true);

  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      if (filterLane && t.lane !== filterLane) return false;
      if (filterModel && t.revenue_model !== filterModel) return false;
      if (filterPhase && t.phase !== filterPhase) return false;
      if (filterStatus && t.status !== filterStatus) return false;
      if (hideComplete && (t.status === "complete" || t.lane === "complete")) return false;
      return true;
    });
  }, [tasks, filterLane, filterModel, filterPhase, filterStatus, hideComplete]);

  // Two-tier grouping: top by lane (sorted via lane_sort_order from LANES),
  // second by revenue_model within each lane. Drives the section layout.
  const groupedByLaneThenModel = useMemo(() => {
    const groups = new Map<string, Map<string, RoadmapTask[]>>();
    for (const t of filteredTasks) {
      if (!groups.has(t.lane)) groups.set(t.lane, new Map());
      const laneGroup = groups.get(t.lane)!;
      if (!laneGroup.has(t.revenue_model)) laneGroup.set(t.revenue_model, []);
      laneGroup.get(t.revenue_model)!.push(t);
    }
    return groups;
  }, [filteredTasks]);

  // Per-lane stats — sit under each lane header so Charlotte can scan
  // progress without expanding the section.
  const laneCounts = useMemo(() => {
    const counts = new Map<string, { total: number; complete: number; inProgress: number; blocked: number }>();
    for (const t of tasks) {
      const entry = counts.get(t.lane) ?? { total: 0, complete: 0, inProgress: 0, blocked: 0 };
      entry.total += 1;
      if (t.status === "complete") entry.complete += 1;
      else if (t.status === "in_progress") entry.inProgress += 1;
      else if (t.status === "blocked") entry.blocked += 1;
      counts.set(t.lane, entry);
    }
    return counts;
  }, [tasks]);

  const counts = useMemo(() => {
    const total = tasks.length;
    const complete = tasks.filter((t) => t.status === "complete").length;
    const inProgress = tasks.filter((t) => t.status === "in_progress").length;
    const blocked = tasks.filter((t) => t.status === "blocked").length;
    return { total, complete, inProgress, blocked, remaining: total - complete };
  }, [tasks]);

  function applyUpdate(taskId: string, updated: RoadmapTask) {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)));
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Roadmap</h1>
        <p className="text-sm text-gray-600 mt-1">
          {counts.complete} / {counts.total} complete · {counts.inProgress} in progress · {counts.blocked} blocked · {counts.remaining} remaining
        </p>
      </header>

      <div className="mb-6 flex flex-wrap gap-3 items-center text-sm">
        <select
          value={filterLane}
          onChange={(e) => setFilterLane(e.target.value)}
          className="border rounded px-2 py-1"
        >
          <option value="">All lanes</option>
          {LANES.map((l) => (
            <option key={l.key} value={l.key}>{l.label}</option>
          ))}
        </select>
        <select
          value={filterModel}
          onChange={(e) => setFilterModel(e.target.value)}
          className="border rounded px-2 py-1"
        >
          <option value="">All revenue models</option>
          {REVENUE_MODELS.map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </select>
        <select
          value={filterPhase}
          onChange={(e) => setFilterPhase(e.target.value)}
          className="border rounded px-2 py-1"
        >
          <option value="">All phases</option>
          {PHASES.map((p) => (
            <option key={p.key} value={p.key}>{p.label}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="border rounded px-2 py-1"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={hideComplete}
            onChange={(e) => setHideComplete(e.target.checked)}
          />
          Hide complete
        </label>
      </div>

      {LANES.map((lane) => {
        const laneGroup = groupedByLaneThenModel.get(lane.key);
        if (!laneGroup || laneGroup.size === 0) return null;
        const cnt = laneCounts.get(lane.key) ?? { total: 0, complete: 0, inProgress: 0, blocked: 0 };
        return (
          <section key={lane.key} className="mb-10">
            <header className="mb-4 border-b-2 border-gray-800 pb-2">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-xl font-bold">{lane.label}</h2>
                <p className="text-xs text-gray-500">
                  {cnt.complete}/{cnt.total} complete
                  {cnt.inProgress > 0 ? ` · ${cnt.inProgress} in progress` : ""}
                  {cnt.blocked > 0 ? ` · ${cnt.blocked} blocked` : ""}
                </p>
              </div>
              {lane.goal && (
                <p className="text-xs text-gray-600 mt-1">Goal: {lane.goal}</p>
              )}
            </header>
            {REVENUE_MODELS.map((m) => {
              const modelTasks = laneGroup.get(m.key);
              if (!modelTasks || modelTasks.length === 0) return null;
              return (
                <div key={m.key} className="mb-6 ml-2">
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">{m.label}</h3>
                  <ul className="space-y-2">
                    {modelTasks.map((t) => (
                      <TaskRow key={t.id} task={t} onUpdate={applyUpdate} />
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
        );
      })}

      {filteredTasks.length === 0 && (
        <p className="text-gray-500 italic">No tasks match the current filters.</p>
      )}
    </main>
  );
}

function TaskRow({
  task,
  onUpdate,
}: {
  task: RoadmapTask;
  onUpdate: (id: string, updated: RoadmapTask) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [localStatus, setLocalStatus] = useState<Status>(task.status);
  const [localNotes, setLocalNotes] = useState<string>(task.notes ?? "");
  const [showNotes, setShowNotes] = useState<boolean>(Boolean(task.notes));
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const notesDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalStatus(task.status);
    setLocalNotes(task.notes ?? "");
  }, [task.status, task.notes]);

  function saveStatus(next: Status) {
    setLocalStatus(next);
    startTransition(async () => {
      const result = await updateRoadmapTaskAction(task.id, { status: next });
      if (result.ok) {
        onUpdate(task.id, result.task);
        setSavedAt(Date.now());
      } else {
        // revert on failure
        setLocalStatus(task.status);
        console.error("update failed:", result.error);
      }
    });
  }

  function scheduleNotesSave(value: string) {
    setLocalNotes(value);
    if (notesDebounce.current) clearTimeout(notesDebounce.current);
    notesDebounce.current = setTimeout(() => {
      const patch: UpdatePatch = { notes: value || null };
      startTransition(async () => {
        const result = await updateRoadmapTaskAction(task.id, patch);
        if (result.ok) {
          onUpdate(task.id, result.task);
          setSavedAt(Date.now());
        } else {
          console.error("update failed:", result.error);
        }
      });
    }, 500);
  }

  const isComplete = localStatus === "complete";

  function moveLane(nextLane: string) {
    if (nextLane === task.lane) return;
    startTransition(async () => {
      const result = await updateRoadmapTaskAction(task.id, { lane: nextLane });
      if (result.ok) {
        onUpdate(task.id, result.task);
        setSavedAt(Date.now());
      } else {
        console.error("update failed:", result.error);
      }
    });
  }

  return (
    <li className={`border rounded p-3 ${isComplete ? "bg-gray-50" : "bg-white"}`}>
      <div className="flex items-start gap-3">
        <select
          value={localStatus}
          onChange={(e) => saveStatus(e.target.value as Status)}
          disabled={isPending}
          className={`text-xs px-2 py-1 rounded border ${STATUS_COLOURS[localStatus]}`}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>

        <div className="flex-1 min-w-0">
          <div className={`text-sm font-medium ${isComplete ? "line-through text-gray-500" : ""}`}>
            {task.title}
          </div>
          {task.description && (
            <div className="text-xs text-gray-600 mt-1">{task.description}</div>
          )}
          {task.target_milestone && (
            <div className="text-xs text-amber-700 mt-1">→ {task.target_milestone}</div>
          )}
          <div className="text-xs text-gray-400 mt-1 flex flex-wrap gap-2 items-center">
            <span>{task.phase.toUpperCase()}</span>
            {task.agent_tags.length > 0 && (
              <span>· {task.agent_tags.join(", ")}</span>
            )}
            <span>·</span>
            <select
              value={task.lane}
              onChange={(e) => moveLane(e.target.value)}
              disabled={isPending}
              title="Move task to a different lane"
              className="text-xs border rounded px-1 py-0.5 text-gray-600"
            >
              {LANES.map((l) => (
                <option key={l.key} value={l.key}>{l.label}</option>
              ))}
            </select>
            {savedAt && (
              <span className="text-green-600">· saved</span>
            )}
            {isPending && (
              <span className="text-blue-600">· saving…</span>
            )}
          </div>

          <button
            onClick={() => setShowNotes((v) => !v)}
            className="text-xs text-blue-600 mt-2 underline"
          >
            {showNotes ? "Hide notes" : localNotes ? "Show notes" : "Add notes"}
          </button>

          {showNotes && (
            <textarea
              value={localNotes}
              onChange={(e) => scheduleNotesSave(e.target.value)}
              placeholder="Notes, blockers, links, results…"
              className="mt-2 w-full text-sm border rounded p-2 min-h-[60px]"
            />
          )}
        </div>
      </div>
    </li>
  );
}
