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

type Active = "home" | "leads" | "agreement" | "account" | "support";

interface Props {
  active: Active;
  children: React.ReactNode;
  // Pre-computed "action needed" count. When provided, skips the
  // Suspense badge fetch — used by /provider where the page already
  // pulled the underlying enrolments + fastrack rows. Saves two DB
  // roundtrips on every home paint.
  actionCount?: number;
}

export async function ProviderShell({ active, children, actionCount }: Props) {
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
            {actionCount != null ? (
              <NavLink
                href={actionCount > 0 ? "/provider/leads?status=action" : "/provider/leads"}
                label="Leads"
                active={active === "leads"}
                badge={actionCount}
              />
            ) : (
              <Suspense fallback={<NavLink href="/provider/leads" label="Leads" active={active === "leads"} />}>
                <LeadsNavLink active={active === "leads"} />
              </Suspense>
            )}
            <NavLink href="/provider/agreement" label="Agreement" active={active === "agreement"} />
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
  // Action = (open) ∪ (callback_pending) ∪ (attempt_X with status_updated_at
  // >36h ago). Fastrack alone no longer gates action — once the provider
  // moves status off open, the fastrack signal is considered handled
  // (re-fires via the stale-attempt timer if the new state goes cold).
  // RLS scopes everything to this provider.
  const STALE_ATTEMPT_HOURS = 36;
  const cutoff = new Date(Date.now() - STALE_ATTEMPT_HOURS * 60 * 60 * 1000).toISOString();

  const { data: enrolmentsData } = await supabase
    .schema("crm")
    .from("enrolments")
    .select("status, status_updated_at, callback_requested_at");

  const enrolments = (enrolmentsData ?? []) as Array<{
    status: string;
    status_updated_at: string;
    callback_requested_at: string | null;
  }>;

  const ATTEMPT = new Set([
    "attempt_1_no_answer",
    "attempt_2_no_answer",
    "attempt_3_no_answer",
  ]);
  let total = 0;
  for (const e of enrolments) {
    const callback = e.callback_requested_at != null;
    const open = e.status === "open";
    const staleAttempt =
      ATTEMPT.has(e.status) && new Date(e.status_updated_at).toISOString() < cutoff;
    if (callback || open || staleAttempt) total += 1;
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
  redirect("/provider-login");
}
