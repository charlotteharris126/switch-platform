"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  type WorkTask,
  updateWorkTaskAction,
  createWorkTaskAction,
} from "./actions";

const COLUMNS: { status: WorkTask["status"]; label: string }[] = [
  { status: "inbox", label: "Inbox" },
  { status: "this_week", label: "This Week" },
  { status: "in_progress", label: "In Progress" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

const SIZE_STYLE: Record<WorkTask["size"], string> = {
  tiny: "bg-emerald-100 text-emerald-800 border-emerald-200",
  small: "bg-sky-100 text-sky-800 border-sky-200",
  big: "bg-amber-100 text-amber-800 border-amber-300",
};

export function WorkBoard({ initialTasks }: { initialTasks: WorkTask[] }) {
  const [tasks, setTasks] = useState<WorkTask[]>(initialTasks);
  const [quickWins, setQuickWins] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const visible = useMemo(
    () => (quickWins ? tasks.filter((t) => t.size === "tiny") : tasks),
    [tasks, quickWins],
  );

  const byColumn = useMemo(() => {
    const map: Record<string, WorkTask[]> = {};
    for (const c of COLUMNS) map[c.status] = [];
    for (const t of visible) (map[t.status] ??= []).push(t);
    for (const c of COLUMNS) map[c.status].sort((a, b) => a.sort_order - b.sort_order);
    return map;
  }, [visible]);

  const dragTask = dragId ? tasks.find((t) => t.id === dragId) ?? null : null;

  function onDragStart(e: DragStartEvent) {
    setDragId(String(e.active.id));
  }

  async function onDragEnd(e: DragEndEvent) {
    setDragId(null);
    const { active, over } = e;
    if (!over) return;
    const id = String(active.id);
    const targetStatus = String(over.id) as WorkTask["status"];
    const task = tasks.find((t) => t.id === id);
    if (!task || !COLUMNS.some((c) => c.status === targetStatus) || task.status === targetStatus) return;

    const prevStatus = task.status;
    const maxSort = Math.max(0, ...tasks.filter((t) => t.status === targetStatus).map((t) => t.sort_order));
    const newSort = maxSort + 1;

    // optimistic
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status: targetStatus, sort_order: newSort } : t)));
    const r = await updateWorkTaskAction(id, { status: targetStatus, sort_order: newSort });
    if (!r.ok) {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status: prevStatus } : t)));
    } else {
      setTasks((prev) => prev.map((t) => (t.id === id ? r.task : t)));
    }
  }

  async function addTask() {
    const title = newTitle.trim();
    if (!title || adding) return;
    setAdding(true);
    const r = await createWorkTaskAction({ title, status: "inbox" });
    setAdding(false);
    if (r.ok) {
      setTasks((prev) => [...prev, r.task]);
      setNewTitle("");
    }
  }

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6">
      <div className="mb-5 flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-[28px] font-extrabold text-[#11242e] leading-tight">Work</h1>
        <label className="flex items-center gap-2 text-sm text-[#5a6a72] cursor-pointer select-none">
          <input type="checkbox" checked={quickWins} onChange={(e) => setQuickWins(e.target.checked)} />
          Quick wins only
        </label>
      </div>

      <div className="mb-5 flex gap-2 max-w-xl">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addTask(); }}
          placeholder="Add a task (lands in Inbox)…"
          className="flex-1 h-9 text-sm border border-[#dad4cb] rounded-lg bg-white px-3 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]"
        />
        <button
          onClick={addTask}
          disabled={adding || !newTitle.trim()}
          className="h-9 px-4 text-sm font-semibold rounded-lg bg-[#11242e] text-white disabled:opacity-40"
        >
          {adding ? "Adding…" : "Add"}
        </button>
      </div>

      <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-start">
          {COLUMNS.map((col) => (
            <Column key={col.status} status={col.status} label={col.label} tasks={byColumn[col.status]} />
          ))}
        </div>
        <DragOverlay>{dragTask ? <Card task={dragTask} overlay /> : null}</DragOverlay>
      </DndContext>
    </main>
  );
}

function Column({ status, label, tasks }: { status: string; label: string; tasks: WorkTask[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div
      ref={setNodeRef}
      className={`rounded-xl border p-2.5 min-h-[140px] transition-colors ${
        isOver ? "border-[#cd8b76] bg-[#cd8b76]/5" : "border-[#e6e1d8] bg-[#faf8f4]"
      }`}
    >
      <div className="flex items-center justify-between px-1 mb-2">
        <span className="text-[11px] font-bold uppercase tracking-[1px] text-[#5a6a72]">{label}</span>
        <span className="text-[11px] font-semibold text-[#5a6a72] tabular-nums">{tasks.length}</span>
      </div>
      <div className="space-y-2">
        {tasks.map((t) => <Card key={t.id} task={t} />)}
      </div>
    </div>
  );
}

function Card({ task, overlay }: { task: WorkTask; overlay?: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  const isNew = !task.seen_by_owner && task.added_by !== "charlotte";
  const overdue = task.due_date && task.status !== "done" && new Date(task.due_date) < new Date(new Date().toDateString());

  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : listeners)}
      {...(overlay ? {} : attributes)}
      className={`rounded-lg border border-[#e0dacf] bg-white p-2.5 shadow-sm cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-30" : ""
      } ${overlay ? "shadow-lg rotate-1" : ""}`}
    >
      <div className="flex items-start gap-2">
        {task.blocked && (
          <span className="mt-0.5 inline-block w-2 h-2 rounded-full bg-rose-500 shrink-0" title={task.blocked_reason ?? "Blocked"} />
        )}
        <p className="text-sm text-[#11242e] leading-snug flex-1">{task.title}</p>
      </div>
      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${SIZE_STYLE[task.size]}`}>{task.size}</span>
        {task.area_tag && (
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#f0ece4] text-[#5a6a72]">{task.area_tag}</span>
        )}
        {task.roadmap_title && (
          <span className="text-[10px] text-[#5a6a72]" title="Part of roadmap rock">▸ {task.roadmap_title}</span>
        )}
        {task.due_date && (
          <span className={`text-[10px] font-medium ${overdue ? "text-rose-600" : "text-[#5a6a72]"}`}>
            {new Date(task.due_date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
          </span>
        )}
        {isNew && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300">
            new · {task.added_by}
          </span>
        )}
      </div>
    </div>
  );
}
