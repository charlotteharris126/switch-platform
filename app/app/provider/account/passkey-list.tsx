"use client";

import { useState, useTransition } from "react";

interface Passkey {
  id: number;
  nickname: string | null;
  device_type: string | null;
  created_at: string;
  last_used_at: string | null;
  is_current: boolean;
}

interface Props {
  passkeys: Passkey[];
  onRemove: (args: { passkeyId: number }) => Promise<{ ok: boolean; error?: string }>;
}

export function PasskeyList({ passkeys, onRemove }: Props) {
  const [pending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  function fireRemove(id: number) {
    setError(null);
    setPendingId(id);
    startTransition(async () => {
      const result = await onRemove({ passkeyId: id });
      if (!result.ok) setError(result.error ?? "Failed to remove");
      setPendingId(null);
      setConfirmingId(null);
    });
  }

  if (passkeys.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No registered passkeys. (That shouldn&apos;t happen, email support@switchleads.co.uk.)
      </p>
    );
  }

  return (
    <div>
      <ul className="divide-y divide-slate-100">
        {passkeys.map((pk) => {
          const label = pk.nickname || (pk.device_type === "multiDevice" ? "Synced passkey" : "Passkey");
          const created = new Date(pk.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
          const lastUsed = pk.last_used_at
            ? new Date(pk.last_used_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
            : "Never";
          const isConfirming = confirmingId === pk.id;
          const isPending = pending && pendingId === pk.id;

          return (
            <li key={pk.id} className="py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900">
                  {label}
                  {pk.is_current && (
                    <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-emerald-100 text-emerald-800 border border-emerald-200">
                      This device
                    </span>
                  )}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  Added {created} · Last used {lastUsed}
                </p>
              </div>
              <div className="shrink-0">
                {isConfirming ? (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => fireRemove(pk.id)}
                      disabled={pending}
                      className="px-3 py-1 text-xs font-semibold text-white bg-rose-600 rounded-md hover:bg-rose-700 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
                    >
                      {isPending ? "Removing…" : "Confirm remove"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      disabled={pending}
                      className="px-3 py-1 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer disabled:cursor-not-allowed"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setConfirmingId(pk.id);
                    }}
                    className="px-3 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 rounded-md border border-transparent hover:border-rose-200 cursor-pointer transition-colors"
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {error && (
        <div className="mt-3 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">
          {error}
        </div>
      )}
    </div>
  );
}
