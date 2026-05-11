// Public help section. No auth required — these pages need to be
// reachable from invite emails before the recipient has a passkey.
//
// Kept deliberately separate from the provider portal shell so a
// new user lands on a calm, signed-out page rather than something
// that looks like it expects them to already be logged in.

import Link from "next/link";
import Image from "next/image";

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-full bg-slate-50">
      <header className="bg-slate-900 text-white">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/help/getting-started" className="flex items-center gap-2">
            <Image
              src="/brand/logo-dark.svg"
              alt="SwitchLeads"
              width={140}
              height={28}
              priority
            />
          </Link>
          <Link
            href="/provider-login"
            className="text-xs font-semibold text-slate-200 hover:text-white underline-offset-2 hover:underline"
          >
            Sign in
          </Link>
        </div>
      </header>
      <main>{children}</main>
      <footer className="border-t border-slate-200 mt-12">
        <div className="max-w-3xl mx-auto px-6 py-6 text-xs text-slate-500 flex items-center justify-between gap-3 flex-wrap">
          <span>SwitchLeads, part of Switchable Ltd.</span>
          <a
            href="mailto:support@switchleads.co.uk"
            className="font-medium text-slate-700 hover:text-slate-900 underline-offset-2 hover:underline"
          >
            support@switchleads.co.uk
          </a>
        </div>
      </footer>
    </div>
  );
}
