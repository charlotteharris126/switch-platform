// Layout shell shared across /provider/* pages: dark top nav with the
// SwitchLeads logo + Home / Leads / Account / Sign out.
//
// Server Component. The sign-out form uses the same Server Action pattern
// as /provider/page.tsx — useFormStatus on the button gives a pending state.

import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";

type Active = "home" | "leads" | "account";

interface Props {
  active: Active;
  children: React.ReactNode;
}

export async function ProviderShell({ active, children }: Props) {
  // Count of "new" leads — never had a contact attempt yet (status='open').
  // RLS-scoped to the caller's provider. Cheap COUNT, head:true so no rows
  // come back over the wire. Auth-checked indirectly: if no session,
  // count is null and we render the Leads link without a badge.
  const supabase = await createClient();
  const { count: openCount } = await supabase
    .schema("crm")
    .from("enrolments")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");

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
            <NavLink
              href="/provider/leads"
              label="Leads"
              active={active === "leads"}
              badge={openCount ?? 0}
            />
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
