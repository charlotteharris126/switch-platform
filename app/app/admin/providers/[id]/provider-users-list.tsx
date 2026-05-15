"use client";

// Provider users list on /admin/providers/[id]. Shows everyone with a
// row in crm.provider_users for this provider — active, invited,
// suspended, or revoked — with their role, last login, and a
// "Resend invite" button for non-active states.
//
// Uses sendPortalInviteAction (the same one the new-user form uses);
// the underlying provider-invite-link Edge Function handles "user
// already exists" by re-issuing the token on the existing row.

import { useState, useTransition } from "react";
import { sendPortalInviteAction } from "./send-portal-invite-action";

export interface ProviderUserRow {
  id: number;
  contact_email: string;
  display_name: string | null;
  role: "provider_admin" | "provider_user" | string;
  status: "active" | "invited" | "suspended" | "revoked" | string;
  invited_at: string;
  enrolled_at: string | null;
  last_login_at: string | null;
  sla_accepted_at: string | null;
  sla_accepted_version: string | null;
  welcome_completed_at: string | null;
}

interface Props {
  providerId: string;
  users: ProviderUserRow[];
}

export function ProviderUsersList({ providerId, users }: Props) {
  if (users.length === 0) {
    return (
      <p className="text-xs text-[#5a6a72] italic py-2">
        No users on this account yet. Invite the first one with the form below.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-[#dde3e6]">
      {users.map((u) => (
        <UserRow key={u.id} providerId={providerId} user={u} />
      ))}
    </ul>
  );
}

function UserRow({ providerId, user }: { providerId: string; user: ProviderUserRow }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<
    | { kind: "ok"; expiresAt: string }
    | { kind: "error"; message: string }
    | null
  >(null);

  function resend() {
    setResult(null);
    startTransition(async () => {
      const r = await sendPortalInviteAction({
        provider_id: providerId,
        email: user.contact_email,
        role:
          user.role === "provider_admin" || user.role === "provider_user"
            ? user.role
            : "provider_user",
        display_name: user.display_name ?? undefined,
      });
      if (r.ok) setResult({ kind: "ok", expiresAt: r.expiresAt });
      else setResult({ kind: "error", message: r.error });
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
    <li className="py-3 flex items-start justify-between gap-3 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-[#0e1726]">
            {user.display_name || user.contact_email.split("@")[0]}
          </span>
          <StatusBadge status={user.status} />
          <RoleBadge role={user.role} />
        </div>
        <div className="text-[#5a6a72] mt-0.5">{user.contact_email}</div>
        <div className="text-[#5a6a72] mt-0.5 text-[11px]">
          {user.status === "active" && lastLogin
            ? `Last sign-in ${lastLogin}`
            : user.status === "active" && !lastLogin
              ? "Enrolled but not signed in yet"
              : user.status === "invited"
                ? `Invited ${new Date(user.invited_at).toLocaleDateString("en-GB")}, not yet enrolled`
                : user.status === "suspended"
                  ? `Suspended (was last seen ${lastLogin ?? "never"})`
                  : user.status === "revoked"
                    ? "Revoked"
                    : null}
        </div>
        {result?.kind === "ok" && (
          <div className="mt-2 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-2">
            Fresh invite sent. Link expires{" "}
            {new Date(result.expiresAt).toLocaleString("en-GB")}.
          </div>
        )}
        {result?.kind === "error" && (
          <div className="mt-2 text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">
            {result.message}
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {user.status !== "revoked" && (
          <button
            type="button"
            onClick={resend}
            disabled={pending}
            className="px-3 py-1.5 text-xs font-semibold text-[#11242e] bg-white border border-[#dde3e6] rounded-md hover:bg-[#f4f1ed] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
          >
            {pending
              ? "Sending..."
              : user.status === "active"
                ? "Re-issue invite"
                : "Resend invite"}
          </button>
        )}
      </div>
    </li>
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
