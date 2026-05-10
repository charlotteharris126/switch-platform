"use client";

// Admin-side notes panel on /admin/leads/[id].
// Mirrors the provider's NotesLog (compose at top, list below newest-first)
// and additionally exposes a "Needs callback" toggle on the compose form.
// Toggling it ON raises crm.enrolments.callback_requested_at when the note
// saves, which pins the lead to the top of the provider's list, fires the
// utility email, and lights up the nav badge until they mark any new
// outcome.

import { useState, useTransition } from "react";

interface AdminNoteRow {
  id: number;
  body: string;
  created_at: string;
  author: string;
  author_role: "provider" | "admin" | "system";
}

interface Props {
  submissionId: number;
  notes: AdminNoteRow[];
  callbackPendingAt: string | null;
  isRouted: boolean;
  onAdd: (args: {
    submissionId: number;
    body: string;
    raiseCallback?: boolean;
  }) => Promise<{ ok: boolean; noteId?: number; callbackRaised?: boolean; error?: string }>;
  onClearCallback: (args: { submissionId: number }) => Promise<{ ok: boolean; error?: string }>;
}

export function AdminNotesPanel({
  submissionId,
  notes,
  callbackPendingAt,
  isRouted,
  onAdd,
  onClearCallback,
}: Props) {
  const [draft, setDraft] = useState("");
  const [raiseCallback, setRaiseCallback] = useState(false);
  const [pending, startTransition] = useTransition();
  const [clearPending, startClearTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  const canSubmit = draft.trim().length > 0 && !pending && isRouted;

  function fire() {
    if (!canSubmit) return;
    setError(null);
    setOkMessage(null);
    startTransition(async () => {
      const result = await onAdd({ submissionId, body: draft, raiseCallback });
      if (!result.ok) {
        setError(result.error ?? "Failed to save");
        return;
      }
      setDraft("");
      setOkMessage(
        result.callbackRaised
          ? "Note added and callback flag raised. Provider will see it next time they hit the portal."
          : "Note added.",
      );
      setRaiseCallback(false);
    });
  }

  function fireClear() {
    setError(null);
    setOkMessage(null);
    startClearTransition(async () => {
      const result = await onClearCallback({ submissionId });
      if (!result.ok) {
        setError(result.error ?? "Failed to clear");
        return;
      }
      setOkMessage("Callback flag cleared.");
    });
  }

  return (
    <div className="rounded-lg border border-[#dde3e6] bg-white p-4">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-[#0e1726]">
            Notes ({notes.length})
          </h2>
          <p className="text-xs text-[#5a6a72] mt-0.5">
            Visible to the provider. Tick &ldquo;Needs callback&rdquo; to flag this for
            their immediate attention.
          </p>
        </div>
        {callbackPendingAt && (
          <button
            type="button"
            onClick={fireClear}
            disabled={clearPending}
            className="text-xs font-semibold text-[#b3412e] hover:underline cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
          >
            {clearPending ? "Clearing…" : "Clear callback flag"}
          </button>
        )}
      </div>

      {callbackPendingAt && (
        <div className="mb-3 bg-rose-50 border border-rose-200 rounded-md p-2 text-xs text-rose-900">
          Callback flag is currently raised (since{" "}
          {new Date(callbackPendingAt).toLocaleString("en-GB", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
          ). Provider sees this lead pinned to the top of their list. It clears
          automatically when they mark any new outcome.
        </div>
      )}

      {/* Compose */}
      {isRouted ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Note for the provider. what came through, what to do."
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                fire();
              }
            }}
            className="w-full border border-[#dde3e6] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0e1726]/30 focus:border-[#0e1726]/50 resize-none"
          />
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs text-[#5a6a72] cursor-pointer">
              <input
                type="checkbox"
                checked={raiseCallback}
                onChange={(e) => setRaiseCallback(e.target.checked)}
                className="cursor-pointer"
              />
              <span>Needs callback (pins this lead, fires email)</span>
            </label>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={fire}
              className="px-4 py-1.5 bg-[#0e1726] text-white rounded-md text-xs font-semibold hover:bg-[#1a2638] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
            >
              {pending ? "Saving…" : raiseCallback ? "Add note + flag" : "Add note"}
            </button>
          </div>
          {error && (
            <div className="text-xs text-[#b3412e] bg-rose-50 border border-rose-200 rounded-md p-2">
              {error}
            </div>
          )}
          {okMessage && !error && (
            <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md p-2">
              {okMessage}
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-[#5a6a72] italic">
          This lead isn&apos;t routed to a provider yet, so admin notes can&apos;t be added until it routes.
        </p>
      )}

      {/* Log */}
      <div className="mt-4 border-t border-[#dde3e6] pt-4">
        {notes.length === 0 ? (
          <p className="text-xs text-[#5a6a72] italic">
            No notes yet. Provider notes will land here too.
          </p>
        ) : (
          <ul className="space-y-2">
            {notes.map((n) => {
              const isAdmin = n.author_role === "admin";
              const palette = isAdmin
                ? "bg-blue-50 border-blue-200 text-blue-900"
                : "bg-amber-50 border-amber-200 text-amber-900";
              const headerColor = isAdmin ? "text-blue-800" : "text-amber-800";
              return (
                <li key={n.id} className={`border rounded-md p-2 text-xs ${palette}`}>
                  <div className={`flex items-baseline justify-between gap-2 mb-1 ${headerColor}`}>
                    <span className="font-semibold flex items-center gap-1.5">
                      {n.author}
                      <span
                        className={`inline-flex items-center px-1 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide border ${
                          isAdmin
                            ? "bg-blue-100 text-blue-800 border-blue-300"
                            : "bg-amber-100 text-amber-800 border-amber-300"
                        }`}
                      >
                        {isAdmin ? "Admin" : "Provider"}
                      </span>
                    </span>
                    <span className="tabular-nums">
                      {new Date(n.created_at).toLocaleString("en-GB", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap break-words">{n.body}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
