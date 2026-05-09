"use client";

import { useState, useTransition } from "react";

interface Props {
  initialValue: string;
  onSave: (args: { displayName: string }) => Promise<{ ok: boolean; error?: string }>;
}

export function DisplayNameForm({ initialValue, onSave }: Props) {
  const [value, setValue] = useState(initialValue);
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!editing) {
    return (
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-slate-500">Display name</span>
        <span className="text-slate-900 text-right flex items-center gap-3">
          {value || <span className="text-slate-400 italic">Not set</span>}
          <button
            type="button"
            onClick={() => {
              setSaved(false);
              setEditing(true);
            }}
            className="text-xs font-medium text-slate-600 hover:text-slate-900 underline-offset-2 hover:underline"
          >
            Edit
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="text-sm">
      <label className="block text-xs uppercase tracking-wide font-semibold text-slate-500 mb-1">
        Display name
      </label>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={80}
          autoFocus
          className="flex-1 border border-slate-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              const r = await onSave({ displayName: value });
              if (r.ok) {
                setEditing(false);
                setSaved(true);
              } else {
                setError(r.error ?? "Failed to save");
              }
            });
          }}
          className="px-3 py-1.5 bg-slate-900 text-white rounded-md text-xs font-semibold hover:bg-slate-800 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setEditing(false);
            setValue(initialValue);
            setError(null);
          }}
          className="px-3 py-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>
      {error && (
        <p className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">{error}</p>
      )}
      {saved && (
        <p className="mt-1 text-xs text-emerald-700">Saved.</p>
      )}
    </div>
  );
}
