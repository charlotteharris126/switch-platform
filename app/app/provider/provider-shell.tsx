// Layout shell shared across /provider/* pages: dark top nav with the
// SwitchLeads logo + Home / Leads / Account / Sign out.
//
// Server Component. The "new leads" count badge on the Leads link is
// streamed via Suspense so its DB query doesn't block the page response.
// The shell paints immediately, the badge fills in when the count
// resolves.

import { Suspense } from "react";
import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";

type Active = "home" | "leads" | "account" | "support";

interface Props {
  active: Active;
  children: React.ReactNode;
}

export async function ProviderShell({ active, children }: Props) {
  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="bg-slate-900 border-b border-slate-800">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/provider" className="flex items-center gap-3 cursor-pointer">
            <Image
              src="/brand/logo-dark.svg"
              alt="SwitchLeads"
              width={140}
              height={21}
              priority
              className="h-5 w-auto"
            />
          </Link>
          <div className="flex items-center gap-1 text-sm">
            <NavLink href="/provider" label="Home" active={active === "home"} />
            <Suspense fallback={<NavLink href="/provider/leads" label="Leads" active={active === "leads"} />}>
              <LeadsNavLink active={active === "leads"} />
            </Suspense>
            <NavLink href="/provider/support" label="Support" active={active === "support"} />
            <NavLink href="/provider/account" label="Account" active={active === "account"} />
            <form action={signOutAction} className="ml-2">
              <SignOutButton />
            </form>
          </div>
        </div>
      </nav>
      {children}
    </div>
  );
}

async function LeadsNavLink({ active }: { active: boolean }) {
  const supabase = await createClient();
  // The badge needs to match what the "Action needed" filter shows on click.
  // Action = (open) ∪ (callback_pending) ∪ (fastrack-ready, not settled) ∪
  // (attempt_X with status_updated_at >48h ago). Server-side, fastrack
  // membership and attempt-staleness need either a join or a derived
  // calculation, so we pull the minimum row data and compute client-side.
  // RLS scopes everything to this provider.
  const STALE_ATTEMPT_HOURS = 48;
  const cutoff = new Date(Date.now() - STALE_ATTEMPT_HOURS * 60 * 60 * 1000).toISOString();

  const [enrolmentsResult, fastrackResult] = await Promise.all([
    supabase
      .schema("crm")
      .from("enrolments")
      .select("submission_id, status, status_updated_at, callback_requested_at"),
    supabase
      .schema("leads")
      .from("fastrack_submissions")
      .select("parent_submission_id"),
  ]);

  const enrolments = (enrolmentsResult.data ?? []) as Array<{
    submission_id: number;
    status: string;
    status_updated_at: string;
    callback_requested_at: string | null;
  }>;
  const fastrackParents = new Set<number>(
    ((fastrackResult.data ?? []) as Array<{ parent_submission_id: number }>).map(
      (r) => r.parent_submission_id,
    ),
  );

  const SETTLED = new Set(["lost", "presumed_enrolled"]);
  const ATTEMPT = new Set([
    "attempt_1_no_answer",
    "attempt_2_no_answer",
    "attempt_3_no_answer",
  ]);
  let total = 0;
  for (const e of enrolments) {
    const callback = e.callback_requested_at != null;
    const fastrack = fastrackParents.has(e.submission_id) && !SETTLED.has(e.status);
    const open = e.status === "open";
    const staleAttempt =
      ATTEMPT.has(e.status) && new Date(e.status_updated_at).toISOString() < cutoff;
    if (callback || fastrack || open || staleAttempt) total += 1;
  }

  return (
    <NavLink
      href={total > 0 ? "/provider/leads?status=action" : "/provider/leads"}
      label="Leads"
      active={active}
      badge={total}
    />
  );
}

function NavLink({
  href,
  label,
  active,
  badge,
}: {
  href: string;
  label: string;
  active: boolean;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded-md text-sm transition-colors cursor-pointer flex items-center gap-1.5 ${
        active
          ? "bg-slate-800 text-white font-semibold"
          : "text-slate-300 hover:bg-slate-800 hover:text-white"
      }`}
    >
      {label}
      {badge != null && badge > 0 && (
        <span
          className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-[11px] font-semibold tabular-nums ${
            active ? "bg-white text-slate-900" : "bg-rose-500 text-white"
          }`}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}

async function signOutAction() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/passkey-login");
}
