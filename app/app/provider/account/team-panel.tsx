"use client";

// Provider-side team management on /provider/account.
//
// Visible to every team member (read-only list). Invite + re-issue actions
// only enabled for provider_admin callers — gated server-side too via
// inviteProviderUserAction.

import { useState, useTransition } from "react";

export interface TeamUserRow {
  id: number;
  contact_email: string;
  display_name: string | null;
  role: "provider_admin" | "provider_user" | string;
  status: "active" | "invited" | "suspended" | "revoked" | string;
  invited_at: string;
  last_login_at: string | null;
  is_self: boolean;
}

interface Props {
  callerIsAdmin: boolean;
  users: TeamUserRow[];
  onInvite: (args: {
    email: string;
    role: "provider_admin" | "provider_user";
    display_name?: string;
  }) => Promise<{ ok: boolean; expiresAt?: string; error?: string }>;
  onRemove: (args: { provider_user_id: number }) => Promise<{
    ok: boolean;
    removedEmail?: string;
    error?: string;
  }>;
}

export function TeamPanel({ callerIsAdmin, users, onInvite, onRemove }: Props) {
  const [showInvite, setShowInvite] = useState(false);

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-slate-100">
        {users.map((u) => (
          <UserRow
            key={u.id}
            user={u}
            callerIsAdmin={callerIsAdmin}
            onResend={onInvite}
            onRemove={onRemove}
          />
        ))}
      </ul>

      {callerIsAdmin && (
        <div className="border-t border-slate-200 pt-4">
          {!showInvite ? (
            <button
              type="button"
              onClick={() => setShowInvite(true)}
              className="px-4 py-2 bg-slate-900 text-white rounded-md text-sm font-semibold hover:bg-slate-800 cursor-pointer transition-colors"
            >
              + Invite someone to your account
            </button>
          ) : (
            <InviteForm
              onCancel={() => setShowInvite(false)}
              onSubmit={onInvite}
            />
          )}
        </div>
      )}

      {!callerIsAdmin && (
        <p className="text-xs text-slate-500 italic border-t border-slate-100 pt-3">
          Only account admins can invite new users. Ask your admin, or email{" "}
          <a
            href="mailto:support@switchleads.co.uk"
            className="font-semibold text-slate-700 hover:underline"
          >
            support@switchleads.co.uk
          </a>{" "}
          if you don&apos;t know who that is.
        </p>
      )}
    </div>
  );
}

function UserRow({
  user,
  callerIsAdmin,
  onResend,
  onRemove,
}: {
  user: TeamUserRow;
  callerIsAdmin: boolean;
  onResend: Props["onInvite"];
  onRemove: Props["onRemove"];
}) {
  const [pending, startTransition] = useTransition();
  const [removePending, startRemoveTransition] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [result, setResult] = useState<
    | { kind: "ok"; expiresAt: string }
    | { kind: "removed"; email: string }
    | { kind: "error"; message: string }
    | null
  >(null);

  function fire() {
    setResult(null);
    startTransition(async () => {
      const r = await onResend({
        email: user.contact_email,
        role:
          user.role === "provider_admin" || user.role === "provider_user"
            ? user.role
            : "provider_user",
        display_name: user.display_name ?? undefined,
      });
      if (r.ok) setResult({ kind: "ok", expiresAt: r.expiresAt ?? "" });
      else setResult({ kind: "error", message: r.error ?? "Failed" });
    });
  }

  function fireRemove() {
    setResult(null);
    startRemoveTransition(async () => {
      const r = await onRemove({ provider_user_id: user.id });
      if (r.ok) {
        setResult({ kind: "removed", email: r.removedEmail ?? user.contact_email });
        setConfirmRemove(false);
      } else {
        setResult({ kind: "error", message: r.error ?? "Failed to remove" });
        setConfirmRemove(false);
      }
    });
  }

  const lastLogin = user.last_login_at
    ? new Date(user.last_login_at).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  return (
    <li className="py-3 flex items-start justify-between gap-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-slate-900">
            {user.display_name || user.contact_email.split("@")[0]}
          </span>
          {user.is_self && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-slate-100 text-slate-700 border border-slate-200">
              You
            </span>
          )}
          <StatusBadge status={user.status} />
          <RoleBadge role={user.role} />
        </div>
        <div className="text-xs text-slate-500 mt-0.5">{user.contact_email}</div>
        <div className="text-[11px] text-slate-500 mt-0.5">
          {user.status === "active" && lastLogin
            ? `Last sign-in ${lastLogin}`
            : user.status === "active" && !lastLogin
              ? "Enrolled but not signed in yet"
              : user.status === "invited"
                ? `Invited ${new Date(user.invited_at).toLocaleDateString("en-GB")}, not yet enrolled`
                : user.status === "suspended"
                  ? "Suspended"
                  : user.status === "revoked"
                    ? "Revoked"
                    : null}
        </div>
        {result?.kind === "ok" && (
          <div className="mt-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2">
            Fresh invite sent.
          </div>
        )}
        {result?.kind === "removed" && (
          <div className="mt-2 text-xs text-slate-700 bg-slate-100 border border-slate-200 rounded p-2">
            {result.email} removed from this account.
          </div>
        )}
        {result?.kind === "error" && (
          <div className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">
            {result.message}
          </div>
        )}
        {confirmRemove && (
          <div className="mt-2 p-2 bg-rose-50 border border-rose-200 rounded flex items-center gap-2 flex-wrap">
            <span className="text-xs text-rose-900 font-semibold">
              Remove {user.display_name || user.contact_email}? They&apos;ll lose access immediately.
            </span>
            <button
              type="button"
              onClick={fireRemove}
              disabled={removePending}
              className="px-2.5 py-1 bg-rose-700 text-white rounded text-xs font-semibold hover:bg-rose-800 disabled:opacity-60 cursor-pointer"
            >
              {removePending ? "Removing…" : "Yes, remove"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmRemove(false)}
              disabled={removePending}
              className="px-2.5 py-1 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
      {callerIsAdmin && user.status !== "revoked" && user.status !== "removed" && !user.is_self && !confirmRemove && (
        <div className="flex items-start gap-1.5 shrink-0">
          <button
            type="button"
            onClick={fire}
            disabled={pending || removePending}
            className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {pending
              ? "Sending..."
              : user.status === "active"
                ? "Re-issue invite"
                : "Resend invite"}
          </button>
          <button
            type="button"
            onClick={() => setConfirmRemove(true)}
            disabled={pending || removePending}
            className="px-3 py-1.5 text-xs font-semibold text-rose-700 bg-white border border-rose-200 rounded-md hover:bg-rose-50 hover:border-rose-300 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            Remove
          </button>
        </div>
      )}
    </li>
  );
}

function InviteForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: Props["onInvite"];
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"provider_admin" | "provider_user">("provider_user");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<
    | { kind: "ok"; expiresAt: string }
    | { kind: "error"; message: string }
    | null
  >(null);

  function fire() {
    setResult(null);
    startTransition(async () => {
      const r = await onSubmit({
        email,
        role,
        display_name: displayName || undefined,
      });
      if (r.ok) {
        setResult({ kind: "ok", expiresAt: r.expiresAt ?? "" });
        setEmail("");
        setDisplayName("");
        setRole("provider_user");
      } else {
        setResult({ kind: "error", message: r.error ?? "Failed" });
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={pending}
            placeholder="teammate@example.com"
            className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:cursor-not-allowed"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Display name (optional)</span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={pending}
            placeholder="What they like being called"
            className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 disabled:cursor-not-allowed"
          />
        </label>
      </div>
      <label className="block">
        <span className="text-xs font-medium text-slate-600">Role</span>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "provider_admin" | "provider_user")}
          disabled={pending}
          className="mt-1 w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white cursor-pointer disabled:cursor-not-allowed"
        >
          <option value="provider_user">User (mark outcomes, add notes)</option>
          <option value="provider_admin">
            Admin (everything above + invite + manage account)
          </option>
        </select>
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={fire}
          disabled={pending || !email}
          className="px-4 py-2 bg-slate-900 text-white rounded-md text-sm font-semibold hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {pending ? "Sending..." : "Send invite"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="px-3 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900 cursor-pointer disabled:cursor-not-allowed"
        >
          Cancel
        </button>
      </div>
      {result?.kind === "ok" && (
        <div className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2">
          Invite sent. They&apos;ll get an email with a passkey enrolment link.
        </div>
      )}
      {result?.kind === "error" && (
        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">
          {result.message}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const palette: Record<string, string> = {
    active: "bg-emerald-100 text-emerald-800 border-emerald-200",
    invited: "bg-amber-100 text-amber-800 border-amber-200",
    suspended: "bg-slate-100 text-slate-700 border-slate-200",
    revoked: "bg-rose-100 text-rose-800 border-rose-200",
  };
  const cls = palette[status] ?? palette.suspended;
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${cls}`}>
      {status}
    </span>
  );
}

function RoleBadge({ role }: { role: string }) {
  const label = role === "provider_admin" ? "Admin" : role === "provider_user" ? "User" : role;
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-blue-100 text-blue-800 border border-blue-200">
      {label}
    </span>
  );
}
