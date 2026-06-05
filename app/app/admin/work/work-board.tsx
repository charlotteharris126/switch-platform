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
  type TaskPatch,
  updateWorkTaskAction,
  createWorkTaskAction,
  deleteWorkTaskAction,
} from "./actions";

const COLUMNS: { status: WorkTask["status"]; label: string }[] = [
  { status: "inbox", label: "Inbox" },
  { status: "this_week", label: "This Week" },
  { status: "in_progress", label: "In Progress" },
  { status: "review", label: "Review" },
  { status: "done", label: "Done" },
];

// Business areas = the "Category" single-select. Free text in the DB; this is
// the canonical pick-list (mirrors the workspace ticketing-discipline tags).
const CATEGORIES = [
  "switchable-site", "switchable-ads", "switchable-email", "switchable-seo", "switchable-social",
  "switchleads-site", "switchleads-outreach", "switchleads-email", "switchleads-ads",
  "switchleads-seo", "switchleads-social", "switchleads-clients",
  "platform", "accounts-legal", "strategy", "labs",
];

const PRIORITIES: WorkTask["priority"][] = ["low", "normal", "high", "urgent"];
const PRIORITY_STYLE: Record<WorkTask["priority"], string> = {
  low: "bg-slate-100 text-slate-500 border-slate-200",
  normal: "bg-slate-100 text-slate-600 border-slate-200",
  high: "bg-amber-100 text-amber-800 border-amber-300",
  urgent: "bg-rose-100 text-rose-800 border-rose-300",
};

const SUGGESTED_TAGS = ["quick-win", "awaiting-approval", "big-project", "waiting", "research", "bug"];

const VIEWS = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "overdue", label: "Overdue" },
  { key: "soon", label: "Due soon" },
  { key: "blocked", label: "Blocked" },
  { key: "quick", label: "Quick wins" },
  { key: "big", label: "Big projects" },
  { key: "stalled", label: "Stalled" },
] as const;

const DAY = 86400000;

function matchesView(t: WorkTask, view: string, startOfToday: number, now: number): boolean {
  const due = t.due_date ? new Date(t.due_date).getTime() : null;
  switch (view) {
    case "new": return !t.seen_by_owner && t.added_by !== "charlotte";
    case "overdue": return due !== null && t.status !== "done" && due < startOfToday;
    case "soon": return due !== null && t.status !== "done" && due >= startOfToday && due <= startOfToday + 3 * DAY;
    case "blocked": return t.blocked;
    case "quick": return t.tags.includes("quick-win");
    case "big": return t.tags.includes("big-project");
    case "stalled": return t.status === "in_progress" && now - new Date(t.updated_at).getTime() > 5 * DAY;
    default: return true;
  }
}

export function WorkBoard({ initialTasks }: { initialTasks: WorkTask[] }) {
  const [tasks, setTasks] = useState<WorkTask[]>(initialTasks);
  const [view, setView] = useState<string>("all");
  const [catFilter, setCatFilter] = useState("");
  const [prioFilter, setPrioFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<WorkTask | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const allTags = useMemo(() => Array.from(new Set(tasks.flatMap((t) => t.tags))).sort(), [tasks]);

  const visible = useMemo(() => {
    const now = Date.now();
    const startOfToday = new Date(new Date().toDateString()).getTime();
    return tasks.filter(
      (t) =>
        matchesView(t, view, startOfToday, now) &&
        (catFilter ? t.area_tag === catFilter : true) &&
        (prioFilter ? t.priority === prioFilter : true) &&
        (tagFilter ? t.tags.includes(tagFilter) : true),
    );
  }, [tasks, view, catFilter, prioFilter, tagFilter]);

  const activeFilters = (view !== "all" ? 1 : 0) + (catFilter ? 1 : 0) + (prioFilter ? 1 : 0) + (tagFilter ? 1 : 0);

  const byColumn = useMemo(() => {
    const map: Record<string, WorkTask[]> = {};
    for (const c of COLUMNS) map[c.status] = [];
    for (const t of visible) (map[t.status] ??= []).push(t);
    for (const c of COLUMNS) map[c.status].sort((a, b) => a.sort_order - b.sort_order);
    return map;
  }, [visible]);

  const dragTask = dragId ? tasks.find((t) => t.id === dragId) ?? null : null;

  function patchLocal(id: string, patch: Partial<WorkTask>) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
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
    patchLocal(id, { status: targetStatus, sort_order: maxSort + 1 });
    const r = await updateWorkTaskAction(id, { status: targetStatus, sort_order: maxSort + 1 });
    if (!r.ok) patchLocal(id, { status: prevStatus });
    else setTasks((prev) => prev.map((t) => (t.id === id ? r.task : t)));
  }

  async function addTask() {
    const title = newTitle.trim();
    if (!title || adding) return;
    setAdding(true);
    const r = await createWorkTaskAction({ title, status: "inbox" });
    setAdding(false);
    if (r.ok) { setTasks((prev) => [...prev, r.task]); setNewTitle(""); }
  }

  async function saveTask(id: string, patch: TaskPatch) {
    const r = await updateWorkTaskAction(id, patch);
    if (r.ok) { setTasks((prev) => prev.map((t) => (t.id === id ? r.task : t))); setSelected(r.task); }
    return r;
  }

  async function removeTask(id: string) {
    const r = await deleteWorkTaskAction(id);
    if (r.ok) { setTasks((prev) => prev.filter((t) => t.id !== id)); setSelected(null); }
    return r;
  }

  // Opening a card marks it seen — so an agent-added "New" task stops being new
  // the moment you look at it. (Tasks you added yourself are never "New".)
  function openTask(t: WorkTask) {
    setSelected(t);
    if (!t.seen_by_owner && t.added_by !== "charlotte") {
      patchLocal(t.id, { seen_by_owner: true });
      updateWorkTaskAction(t.id, { seen_by_owner: true });
    }
  }

  return (
    <main className="mx-auto max-w-[1400px] px-4 py-6">
      <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-[28px] font-extrabold text-[#11242e] leading-tight">Work</h1>
        <span className="text-xs text-[#5a6a72]">
          {visible.length} shown
          {activeFilters > 0 && (
            <button
              onClick={() => { setView("all"); setCatFilter(""); setPrioFilter(""); setTagFilter(""); }}
              className="ml-2 underline hover:text-[#11242e]"
            >
              clear filters
            </button>
          )}
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        {VIEWS.map((v) => (
          <button key={v.key} onClick={() => setView(v.key)}
            className={`text-xs px-2.5 h-7 rounded-full border transition-colors ${
              view === v.key ? "bg-[#11242e] text-white border-[#11242e]" : "bg-white text-[#5a6a72] border-[#dad4cb] hover:border-[#11242e]"}`}>
            {v.label}
          </button>
        ))}
        <span className="w-px h-5 bg-[#dad4cb] mx-1" />
        <select value={catFilter} onChange={(e) => setCatFilter(e.target.value)}
          className="h-7 text-xs border border-[#dad4cb] rounded-lg bg-white px-2 text-[#11242e] focus:outline-none focus:border-[#cd8b76]">
          <option value="">Category: any</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={prioFilter} onChange={(e) => setPrioFilter(e.target.value)}
          className="h-7 text-xs border border-[#dad4cb] rounded-lg bg-white px-2 text-[#11242e] focus:outline-none focus:border-[#cd8b76]">
          <option value="">Priority: any</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {allTags.length > 0 && (
          <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}
            className="h-7 text-xs border border-[#dad4cb] rounded-lg bg-white px-2 text-[#11242e] focus:outline-none focus:border-[#cd8b76]">
            <option value="">Tag: any</option>
            {allTags.map((t) => <option key={t} value={t}>#{t}</option>)}
          </select>
        )}
      </div>

      <div className="mb-5 flex gap-2 max-w-xl">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") addTask(); }}
          placeholder="Add a task (lands in Inbox)…"
          className="flex-1 h-9 text-sm border border-[#dad4cb] rounded-lg bg-white px-3 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]"
        />
        <button onClick={addTask} disabled={adding || !newTitle.trim()}
          className="h-9 px-4 text-sm font-semibold rounded-lg bg-[#11242e] text-white disabled:opacity-40">
          {adding ? "Adding…" : "Add"}
        </button>
      </div>

      <DndContext sensors={sensors} onDragStart={(e: DragStartEvent) => setDragId(String(e.active.id))} onDragEnd={onDragEnd}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-start">
          {COLUMNS.map((col) => (
            <Column key={col.status} status={col.status} label={col.label} tasks={byColumn[col.status]} onOpen={openTask} />
          ))}
        </div>
        <DragOverlay>{dragTask ? <Card task={dragTask} overlay /> : null}</DragOverlay>
      </DndContext>

      {selected && (
        <TaskModal
          task={tasks.find((t) => t.id === selected.id) ?? selected}
          onClose={() => setSelected(null)}
          onSave={saveTask}
          onDelete={removeTask}
        />
      )}
    </main>
  );
}

function Column({ status, label, tasks, onOpen }: {
  status: string; label: string; tasks: WorkTask[]; onOpen: (t: WorkTask) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div ref={setNodeRef}
      className={`rounded-xl border p-2.5 min-h-[140px] transition-colors ${
        isOver ? "border-[#cd8b76] bg-[#cd8b76]/5" : "border-[#e6e1d8] bg-[#faf8f4]"}`}>
      <div className="flex items-center justify-between px-1 mb-2">
        <span className="text-[11px] font-bold uppercase tracking-[1px] text-[#5a6a72]">{label}</span>
        <span className="text-[11px] font-semibold text-[#5a6a72] tabular-nums">{tasks.length}</span>
      </div>
      <div className="space-y-2">{tasks.map((t) => <Card key={t.id} task={t} onOpen={onOpen} />)}</div>
    </div>
  );
}

function Card({ task, overlay, onOpen }: { task: WorkTask; overlay?: boolean; onOpen?: (t: WorkTask) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  const isNew = !task.seen_by_owner && task.added_by !== "charlotte";
  const overdue = task.due_date && task.status !== "done" && new Date(task.due_date) < new Date(new Date().toDateString());

  return (
    <div ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : listeners)} {...(overlay ? {} : attributes)}
      onClick={() => { if (!overlay && !isDragging) onOpen?.(task); }}
      className={`rounded-lg border border-[#e0dacf] bg-white p-2.5 shadow-sm cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-30" : ""} ${overlay ? "shadow-lg rotate-1" : ""}`}>
      <div className="flex items-start gap-2">
        {task.blocked && <span className="mt-0.5 inline-block w-2 h-2 rounded-full bg-rose-500 shrink-0" title={task.blocked_reason ?? "Blocked"} />}
        <p className="text-sm text-[#11242e] leading-snug flex-1">{task.title}</p>
      </div>
      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        {task.priority !== "normal" && (
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${PRIORITY_STYLE[task.priority]}`}>{task.priority}</span>
        )}
        {task.area_tag && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#f0ece4] text-[#5a6a72]">{task.area_tag}</span>}
        {task.tags.map((tg) => (
          <span key={tg} className="text-[10px] px-1.5 py-0.5 rounded bg-[#e7eef0] text-[#3a5560]">#{tg}</span>
        ))}
        {task.roadmap_title && <span className="text-[10px] text-[#5a6a72]" title="Part of roadmap rock">▸ {task.roadmap_title}</span>}
        {task.due_date && (
          <span className={`text-[10px] font-medium ${overdue ? "text-rose-600" : "text-[#5a6a72]"}`}>
            {new Date(task.due_date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
          </span>
        )}
        {isNew && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-300">new · {task.added_by}</span>}
      </div>
    </div>
  );
}

function TaskModal({ task, onClose, onSave, onDelete }: {
  task: WorkTask;
  onClose: () => void;
  onSave: (id: string, patch: TaskPatch) => Promise<{ ok: boolean; error?: string }>;
  onDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [category, setCategory] = useState(task.area_tag ?? "");
  const [priority, setPriority] = useState<WorkTask["priority"]>(task.priority);
  const [tags, setTags] = useState<string[]>(task.tags);
  const [tagInput, setTagInput] = useState("");
  const [due, setDue] = useState(task.due_date ?? "");
  const [blocked, setBlocked] = useState(task.blocked);
  const [blockedReason, setBlockedReason] = useState(task.blocked_reason ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function addTag(raw: string) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, "-");
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput("");
  }

  async function save() {
    setSaving(true); setErr(null);
    const patch: TaskPatch = {
      title: title.trim() || task.title,
      notes: notes.trim() || null,
      area_tag: category || null,
      priority,
      tags,
      due_date: due || null,
      blocked,
      blocked_reason: blocked ? (blockedReason.trim() || null) : null,
    };
    const r = await onSave(task.id, patch);
    setSaving(false);
    if (!r.ok) setErr(r.error ?? "Save failed"); else onClose();
  }

  const field = "w-full text-sm border border-[#dad4cb] rounded-lg bg-white px-3 py-2 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]";
  const label = "block text-[11px] font-bold uppercase tracking-[1px] text-[#5a6a72] mb-1";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-8 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-4">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="text-lg font-semibold text-[#11242e] flex-1 border-b border-transparent hover:border-[#dad4cb] focus:border-[#cd8b76] focus:outline-none" />
          <button onClick={onClose} className="text-[#5a6a72] hover:text-[#11242e] text-xl leading-none">×</button>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <span className={label}>Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={field}>
              <option value="">—</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <span className={label}>Priority</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value as WorkTask["priority"])} className={field}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>

        <div className="mb-3">
          <span className={label}>Tags</span>
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {tags.map((t) => (
              <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-[#e7eef0] text-[#3a5560] flex items-center gap-1">
                #{t}<button onClick={() => setTags(tags.filter((x) => x !== t))} className="text-[#3a5560]/60 hover:text-rose-600">×</button>
              </span>
            ))}
          </div>
          <input value={tagInput} onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(tagInput); } }}
            placeholder="Add a tag, press Enter…" className={field} />
          <div className="flex flex-wrap gap-1 mt-1.5">
            {SUGGESTED_TAGS.filter((s) => !tags.includes(s)).map((s) => (
              <button key={s} onClick={() => addTag(s)} className="text-[10px] px-1.5 py-0.5 rounded bg-[#f0ece4] text-[#5a6a72] hover:bg-[#e7eef0]">+ {s}</button>
            ))}
          </div>
        </div>

        <div className="mb-3">
          <span className={label}>Due date</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={field} />
        </div>

        <div className="mb-3">
          <span className={label}>Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} className={field} />
        </div>

        <div className="mb-4">
          <label className="flex items-center gap-2 text-sm text-[#11242e]">
            <input type="checkbox" checked={blocked} onChange={(e) => setBlocked(e.target.checked)} /> Blocked
          </label>
          {blocked && (
            <input value={blockedReason} onChange={(e) => setBlockedReason(e.target.value)} placeholder="Why is it blocked?" className={`${field} mt-2`} />
          )}
        </div>

        {err && <p className="text-sm text-rose-600 mb-3">{err}</p>}

        <div className="flex items-center justify-between gap-3">
          <button onClick={() => onDelete(task.id)} className="text-sm text-rose-600 hover:text-rose-700">Delete</button>
          <div className="flex gap-2">
            <button onClick={onClose} className="h-9 px-4 text-sm rounded-lg border border-[#dad4cb] text-[#5a6a72]">Cancel</button>
            <button onClick={save} disabled={saving} className="h-9 px-4 text-sm font-semibold rounded-lg bg-[#11242e] text-white disabled:opacity-40">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
        <p className="text-[10px] text-[#5a6a72] mt-3">Added by {task.added_by} · {new Date(task.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</p>
      </div>
    </div>
  );
}
