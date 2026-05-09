// Layout shell shared across /provider/* pages: top nav with Leads / Sign out.
//
// Server Component. The sign-out form uses the same Server Action pattern as
// /provider/page.tsx — useFormStatus on the button gives a pending state.

import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "./sign-out-button";

type Active = "home" | "leads" | "account";

interface Props {
  active: Active;
  children: React.ReactNode;
}

export async function ProviderShell({ active, children }: Props) {
  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="bg-white border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/provider" className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-widest text-slate-500 font-semibold">SwitchLeads</span>
            <span className="text-sm font-semibold text-slate-900">Portal</span>
          </Link>
          <div className="flex items-center gap-1 text-sm">
            <NavLink href="/provider" label="Home" active={active === "home"} />
            <NavLink href="/provider/leads" label="Leads" active={active === "leads"} />
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

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
        active ? "bg-slate-100 text-slate-900 font-semibold" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
      }`}
    >
      {label}
    </Link>
  );
}

async function signOutAction() {
  "use server";
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/passkey-login");
}
