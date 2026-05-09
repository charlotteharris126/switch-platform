"use client";

import { useState, useTransition } from "react";
import { sendPortalInviteAction } from "./send-portal-invite-action";

interface Props {
  providerId: string;
  defaultEmail?: string;
  defaultName?: string;
  isDemo: boolean;
  portalEnabled: boolean;
}

type Result = { ok: true; expiresAt: string } | { ok: false; error: string };

export function SendPortalInvite({ providerId, defaultEmail, defaultName, isDemo, portalEnabled }: Props) {
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [displayName, setDisplayName] = useState(defaultName ?? "");
  const [role, setRole] = useState<"provider_admin" | "provider_user">("provider_admin");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Result | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const r = await sendPortalInviteAction({
        provider_id: providerId,
        email: email.trim().toLowerCase(),
        role,
        display_name: displayName.trim() || undefined,
      });
      setResult(r);
    });
  }

  if (!portalEnabled) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">Portal not enabled for this provider</p>
        <p className="mt-1">
          Set <code className="text-xs">portal_enabled = true</code> on this provider before issuing invites.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {isDemo && (
        <p className="text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded px-2 py-1 inline-block">
          DEMO PROVIDER &mdash; safe to test invite flow
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Display name (optional)</span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm"
          />
        </label>
      </div>
      <label className="block">
        <span className="text-xs font-medium text-slate-600">Role</span>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "provider_admin" | "provider_user")}
          className="mt-1 w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm"
        >
          <option value="provider_admin">provider_admin (full access)</option>
          <option value="provider_user">provider_user (outcome marking only)</option>
        </select>
      </label>
      <button
        type="submit"
        disabled={pending || !email}
        className="w-full bg-slate-900 text-white py-2 rounded-md text-sm font-semibold disabled:opacity-60 hover:bg-slate-800"
      >
        {pending ? "Sending..." : "Send portal invite"}
      </button>
      {result && result.ok && (
        <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-3">
          Invite sent. Link expires {new Date(result.expiresAt).toLocaleString("en-GB")}.
        </div>
      )}
      {result && !result.ok && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3">
          {result.error}
        </div>
      )}
    </form>
  );
}
