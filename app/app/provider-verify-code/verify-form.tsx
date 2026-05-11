"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { providerLoginVerifyAction } from "./actions";

interface Props {
  email: string;
  next: string | null;
}

export function VerifyForm({ email, next }: Props) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Strip non-digits as the user types so paste-with-spaces "1 2 3 4 5 6"
  // resolves to "123456" cleanly. Supabase OTP length is project-configured
  // (default 8 for recent versions, 6 on older); accept the 6-8 range.
  function onCodeChange(raw: string) {
    setCode(raw.replace(/\D/g, "").slice(0, 8));
  }

  const canSubmit = code.length >= 6 && code.length <= 8 && !pending;

  function submit() {
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      const r = await providerLoginVerifyAction({ email, code });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push(next && next.startsWith("/") ? next : "/provider");
    });
  }

  return (
    <div className="mt-5 space-y-4">
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
          Sign-in code
        </label>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => onCodeChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          className="w-full border border-slate-300 rounded-md px-3 py-3 text-xl tracking-[0.5em] tabular-nums text-center font-semibold focus:outline-none focus:ring-2 focus:ring-slate-400"
          placeholder="••••••••"
        />
      </div>

      {error && (
        <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2">
          {error}
        </div>
      )}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={submit}
        className="w-full px-4 py-2 bg-slate-900 text-white rounded-md text-sm font-semibold hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
      >
        {pending ? "Verifying…" : "Sign in"}
      </button>
    </div>
  );
}
