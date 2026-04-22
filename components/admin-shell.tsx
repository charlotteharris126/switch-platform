import Link from "next/link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { signOutAction } from "@/app/(auth)/verify-mfa/actions";

const NAV_ITEMS = [
  { href: "/", label: "Overview" },
  { href: "/leads", label: "Leads" },
  { href: "/providers", label: "Providers" },
  { href: "/dead-letter", label: "Dead letter" },
  { href: "/audit", label: "Audit" },
];

export function AdminShell({
  user,
  children,
}: {
  user: { email?: string };
  children: React.ReactNode;
}) {
  const initials = (user.email ?? "?").slice(0, 2).toUpperCase();

  return (
    <div className="min-h-screen flex bg-slate-50">
      {/* Sidebar */}
      <aside className="w-56 bg-slate-900 text-slate-100 flex flex-col">
        <div className="px-6 py-6 border-b border-slate-800">
          <p className="text-xs uppercase tracking-widest font-semibold text-amber-300">
            Switchable
          </p>
          <p className="text-xs text-slate-400 mt-1">Platform admin</p>
        </div>

        <nav className="flex-1 py-4">
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="block px-6 py-2 text-sm text-slate-300 hover:bg-slate-800 hover:text-slate-100 transition-colors"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="p-4 border-t border-slate-800 text-xs text-slate-500">
          v0.1.0 (Session A)
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col">
        {/* Topbar */}
        <header className="h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between">
          <HealthBar />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" className="h-9 px-2 gap-2">
                  <Avatar className="h-7 w-7">
                    <AvatarFallback className="text-xs bg-slate-200">{initials}</AvatarFallback>
                  </Avatar>
                  <span className="text-sm text-slate-700">{user.email}</span>
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Signed in</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <form action={signOutAction}>
                <DropdownMenuItem
                  render={
                    <button type="submit" className="w-full text-left cursor-pointer">
                      Sign out
                    </button>
                  }
                />
              </form>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* Content */}
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

// Placeholder until Session E ships the live counters.
function HealthBar() {
  return (
    <div className="flex items-center gap-4 text-xs text-slate-500">
      <span className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
        Health bar — Session E
      </span>
    </div>
  );
}
