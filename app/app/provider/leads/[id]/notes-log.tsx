"use client";

// Append-only notes log. Compose form at top, list of notes below
// (newest first). Each note shows author display name + relative time.

import { useState, useTransition } from "react";

export interface NoteRow {
  id: number;
  body: string;
  created_at: string;
  author: string;
  author_role: "provider" | "admin" | "system";
}

interface Props {
  submissionId: number;
  notes: NoteRow[];
  // Optional. Omit to render the log read-only (compose box hidden) — used by
  // the admin "View as provider" preview, which must never fire a write.
  onAdd?: (args: { submissionId: number; body: string }) => Promise<{ ok: boolean; error?: string }>;
}

export function NotesLog({ submissionId, notes, onAdd }: Props) {
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const canSubmit = draft.trim().length > 0 && !pending && onAdd != null;

  function fire() {
    if (!canSubmit || !onAdd) return;
    setError(null);
    startTransition(async () => {
      const result = await onAdd({ submissionId, body: draft });
      if (!result.ok) {
        setError(result.error ?? "Failed to save");
        return;
      }
      setDraft("");
    });
  }

  return (
    <div className="flex flex-col h-full">
      {/* Compose. hidden in read-only mode. */}
      {onAdd && (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            placeholder="Add a note: what they said, what's next, anything to remember."
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                fire();
              }
            }}
            className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-slate-400 resize-none"
          />
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-slate-400">
              <kbd className="px-1 py-0.5 border border-slate-200 rounded bg-slate-50">⌘</kbd>{" "}
              <kbd className="px-1 py-0.5 border border-slate-200 rounded bg-slate-50">Enter</kbd>{" "}
              to save
            </p>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={fire}
              className="px-4 py-1.5 bg-slate-900 text-white rounded-md text-sm font-semibold hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              {pending ? "Saving…" : "Add note"}
            </button>
          </div>
          {error && (
            <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">
              {error}
            </div>
          )}
        </div>
      )}

      {/* Log */}
      <div className={`${onAdd ? "mt-5 border-t border-slate-100 pt-4" : ""} flex-1 overflow-y-auto`}>
        {notes.length === 0 ? (
          <p className="text-sm text-slate-400 italic">
            No notes yet. Your first note will appear here.
          </p>
        ) : (
          <ul className="space-y-3">
            {notes.map((n) => {
              const isAdmin = n.author_role === "admin";
              const palette = isAdmin
                ? "bg-blue-50 border-blue-200 text-blue-900"
                : "bg-amber-50 border-amber-200 text-amber-900";
              const headerPalette = isAdmin ? "text-blue-800" : "text-amber-800";
              const stampPalette = isAdmin ? "text-blue-600" : "text-amber-600";
              return (
                <li key={n.id} className={`border rounded-md p-3 ${palette}`}>
                  <div className={`flex items-baseline justify-between gap-2 text-xs ${headerPalette} mb-1`}>
                    <span className="font-semibold flex items-center gap-1.5">
                      {n.author}
                      {isAdmin && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-blue-100 text-blue-800 border border-blue-300">
                          Switchable
                        </span>
                      )}
                    </span>
                    <span className={`tabular-nums ${stampPalette}`}>{formatWhen(n.created_at)}</span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap break-words">{n.body}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function formatWhen(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  if (sec < 60 * 60) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 24 * 60 * 60) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 7 * 24 * 60 * 60) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
