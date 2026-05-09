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
  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="bg-slate-900 border-b border-slate-800">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
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
            <NavLink href="/provider/leads" label="Leads" active={active === "leads"} />
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

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded-md text-sm transition-colors cursor-pointer ${
        active
          ? "bg-slate-800 text-white font-semibold"
          : "text-slate-300 hover:bg-slate-800 hover:text-white"
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
