"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setProviderPasswordAction } from "./actions";

const MIN_PASSWORD_LENGTH = 12;

interface Props {
  token: string;
  email: string;
}

export function SetPasswordForm({ token, email }: Props) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const passwordTooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit =
    password.length >= MIN_PASSWORD_LENGTH &&
    confirm === password &&
    !pending;

  function submit() {
    if (!canSubmit) return;
    setError(null);
    startTransition(async () => {
      const r = await setProviderPasswordAction({ token, password });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.push("/provider-login?just_set=1");
    });
  }

  return (
    <div className="mt-5 space-y-4">
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
          Your email
        </label>
        <input
          type="email"
          value={email}
          readOnly
          className="w-full border border-slate-200 rounded-md px-3 py-2 text-sm bg-slate-50 text-slate-700"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
          New password
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <p className={`text-[11px] mt-1 ${passwordTooShort ? "text-rose-600" : "text-slate-500"}`}>
          {passwordTooShort
            ? `At least ${MIN_PASSWORD_LENGTH} characters please.`
            : `At least ${MIN_PASSWORD_LENGTH} characters. Mix of words is fine — long beats fancy.`}
        </p>
      </div>

      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
          Confirm password
        </label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        {mismatch && (
          <p className="text-[11px] mt-1 text-rose-600">Passwords don&apos;t match.</p>
        )}
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
        {pending ? "Saving…" : "Set password"}
      </button>
    </div>
  );
}
