"use client";

import { createContext, useContext, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { markEnrolmentOutcomeBulk } from "./bulk-actions";
import type { EnrolmentStatus, LostReason } from "./[id]/actions";

// -----------------------------------------------------------------------------
// Context
// -----------------------------------------------------------------------------
//
// Selection state is held here so the table rows (server-rendered) can pop in
// a small client checkbox component each, the master checkbox in the header
// can read the page's row-id list, and the sticky action bar can read the
// selected set. Everything below renders inside <BulkSelectionProvider>.
// -----------------------------------------------------------------------------

interface SelectionContext {
  selected: Set<number>;
  rowIds: number[];
  toggle: (id: number) => void;
  toggleAll: () => void;
  clear: () => void;
}

const Ctx = createContext<SelectionContext | null>(null);

function useSelection(): SelectionContext {
  const c = useContext(Ctx);
  if (!c) throw new Error("BulkSelection components must render inside <BulkSelectionProvider>");
  return c;
}

interface ProviderProps {
  rowIds: number[];
  children: React.ReactNode;
}

export function BulkSelectionProvider({ rowIds, children }: ProviderProps) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set());

  const value = useMemo<SelectionContext>(() => ({
    selected,
    rowIds,
    toggle: (id: number) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    },
    toggleAll: () => {
      setSelected((prev) => {
        const allSelected = rowIds.every((id) => prev.has(id));
        if (allSelected) {
          // Deselect only the rows on this page; preserve any selections from
          // pre-pagination interactions if state ever survives navigation
          // (it doesn't today — kept for clarity).
          const next = new Set(prev);
          for (const id of rowIds) next.delete(id);
          return next;
        }
        const next = new Set(prev);
        for (const id of rowIds) next.add(id);
        return next;
      });
    },
    clear: () => setSelected(new Set()),
  }), [selected, rowIds]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// -----------------------------------------------------------------------------
// Master checkbox (header column)
// -----------------------------------------------------------------------------

export function BulkSelectionMasterCheckbox() {
  const { selected, rowIds, toggleAll } = useSelection();
  const allSelectedOnPage = rowIds.length > 0 && rowIds.every((id) => selected.has(id));
  const anySelectedOnPage = rowIds.some((id) => selected.has(id));

  return (
    <input
      type="checkbox"
      aria-label="Select all leads on this page"
      checked={allSelectedOnPage}
      ref={(el) => {
        if (el) el.indeterminate = !allSelectedOnPage && anySelectedOnPage;
      }}
      onChange={toggleAll}
      className="h-4 w-4 accent-[#cd8b76] cursor-pointer"
    />
  );
}

// -----------------------------------------------------------------------------
// Row checkbox
// -----------------------------------------------------------------------------

export function BulkSelectionRowCheckbox({ id }: { id: number }) {
  const { selected, toggle } = useSelection();
  return (
    <input
      type="checkbox"
      aria-label={`Select lead ${id}`}
      checked={selected.has(id)}
      onChange={() => toggle(id)}
      onClick={(e) => e.stopPropagation()}
      className="h-4 w-4 accent-[#cd8b76] cursor-pointer"
    />
  );
}

// -----------------------------------------------------------------------------
// Sticky action bar
// -----------------------------------------------------------------------------

const STATUSES: Array<{ value: EnrolmentStatus; label: string; description: string }> = [
  { value: "open",              label: "Open",              description: "No outcome yet." },
  { value: "enrolled",          label: "Enrolled",          description: "Learner started the course." },
  { value: "presumed_enrolled", label: "Presumed enrolled", description: "Provider hasn't confirmed after 14 days." },
  { value: "cannot_reach",      label: "Cannot reach",      description: "Provider tried but couldn't reach." },
  { value: "lost",              label: "Lost",              description: "Made contact but learner won't enrol. Pick a reason." },
];

const LOST_REASONS: Array<{ value: LostReason; label: string }> = [
  { value: "not_interested", label: "Not interested" },
  { value: "wrong_course",   label: "Wrong course" },
  { value: "funding_issue",  label: "Funding issue" },
  { value: "other",          label: "Other" },
];

export function BulkActionBar() {
  const { selected, clear } = useSelection();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<EnrolmentStatus | null>(null);
  const [lostReason, setLostReason] = useState<LostReason | null>(null);
  const [notes, setNotes] = useState("");

  const count = selected.size;
  if (count === 0) return null;

  const showLostReason = status === "lost";

  function handleApply() {
    if (!status) {
      toast.warning("Pick a status before applying.");
      return;
    }
    if (status === "lost" && !lostReason) {
      toast.warning("Pick a lost reason before applying.");
      return;
    }

    const submissionIds = Array.from(selected);

    startTransition(async () => {
      const result = await markEnrolmentOutcomeBulk({
        submissionIds,
        status,
        notes: notes.trim() || null,
        lostReason: status === "lost" ? lostReason : null,
      });

      if (result.ok) {
        toast.success(`${result.succeeded} updated`, {
          description: `Marked as ${status.replace(/_/g, " ")}.`,
        });
        clear();
        setStatus(null);
        setLostReason(null);
        setNotes("");
      } else if (result.succeeded > 0) {
        toast.warning(`${result.succeeded} updated, ${result.failed} failed`, {
          description: result.errors[0]?.error ?? "See server logs for details.",
        });
      } else {
        toast.error("All updates failed", {
          description: result.errors[0]?.error ?? "See server logs for details.",
        });
      }
    });
  }

  return (
    <div
      role="region"
      aria-label="Bulk update selected leads"
      className="fixed bottom-0 inset-x-0 z-40 border-t border-[#dad4cb] bg-white shadow-[0_-4px_16px_rgba(17,36,46,0.08)]"
    >
      <div className="max-w-[1400px] mx-auto px-6 py-4">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex-shrink-0">
            <p className="text-xs font-bold uppercase tracking-[0.08em] text-[#143643]">
              {count} selected
            </p>
            <button
              type="button"
              onClick={clear}
              disabled={pending}
              className="text-[11px] text-[#5a6a72] hover:text-[#cd8b76] underline mt-1"
            >
              Clear
            </button>
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72] mb-2">Set status</p>
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((s) => {
                const sel = status === s.value;
                return (
                  <button
                    key={s.value}
                    type="button"
                    onClick={() => setStatus(s.value)}
                    disabled={pending}
                    title={s.description}
                    className={
                      "px-4 h-9 text-xs font-bold uppercase tracking-[0.08em] rounded-full border transition-all duration-150 active:scale-[0.97] " +
                      (sel
                        ? "bg-[#cd8b76] text-white border-[#cd8b76] shadow-[0_2px_6px_rgba(205,139,118,0.35)]"
                        : "bg-white text-[#143643] border-[#dad4cb] hover:border-[#cd8b76]/60 hover:bg-[#fbf9f5]")
                    }
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>

            {showLostReason && (
              <div className="mt-3 pl-3 border-l-2 border-[#cd8b76]">
                <p className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72] mb-2">Lost reason (applies to all)</p>
                <div className="flex flex-wrap gap-2">
                  {LOST_REASONS.map((r) => {
                    const sel = lostReason === r.value;
                    return (
                      <button
                        key={r.value}
                        type="button"
                        onClick={() => setLostReason(r.value)}
                        disabled={pending}
                        className={
                          "px-3 h-8 text-[11px] font-bold uppercase tracking-[0.06em] rounded-full border transition-all duration-150 active:scale-[0.97] " +
                          (sel
                            ? "bg-[#143643] text-white border-[#143643]"
                            : "bg-white text-[#143643] border-[#dad4cb] hover:border-[#143643]/60")
                        }
                      >
                        {r.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <label className="block mt-3">
              <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72] block mb-1">Notes (optional, applies to all)</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. provider report 30 Apr"
                rows={2}
                disabled={pending}
                className="w-full text-xs border border-[#dad4cb] rounded-lg bg-white px-3 py-2 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76] resize-y"
              />
            </label>
          </div>

          <div className="flex-shrink-0 self-end">
            <button
              type="button"
              onClick={handleApply}
              disabled={pending || !status}
              className="h-10 px-6 text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#143643] text-white hover:bg-[#11242e] active:scale-[0.97] transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[#143643] shadow-[0_2px_6px_rgba(17,36,46,0.15)]"
            >
              {pending ? "Applying..." : `Apply to ${count}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
