"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { providerLoginStartAction } from "./actions";

interface Props {
  next: string | null;
}

export function LoginForm({ next }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !pending;

  function submit() {
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      const r = await providerLoginStartAction({
        email: email.trim().toLowerCase(),
        password,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const params = new URLSearchParams({ email: email.trim().toLowerCase() });
      if (next) params.set("next", next);
      router.push(`/provider-verify-code?${params.toString()}`);
    });
  }

  return (
    <div className="mt-5 space-y-4">
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
          Email
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
          Password
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
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
        {pending ? "Checking…" : "Continue"}
      </button>
    </div>
  );
}
