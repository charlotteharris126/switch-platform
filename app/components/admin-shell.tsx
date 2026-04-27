"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
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
  { href: "/actions", label: "Actions" },
  { href: "/leads", label: "Leads" },
  { href: "/providers", label: "Providers" },
  { href: "/errors", label: "Errors" },
];

export function AdminShell({
  user,
  children,
}: {
  user: { email?: string };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const initials = (user.email ?? "?").slice(0, 2).toUpperCase();

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <div className="min-h-screen flex bg-[#f4f1ed] text-[#11242e]">
      {/* Sidebar */}
      <aside
        className="w-60 flex flex-col text-[rgba(244,241,237,0.65)]"
        style={{
          background: "linear-gradient(180deg, #11242e 0%, #143643 100%)",
        }}
      >
        <div className="px-6 pt-7 pb-6 border-b border-white/10">
          <Link href="/" className="inline-flex items-center">
            <Image
              src="/brand/logo-dark.svg"
              alt="SwitchLeads"
              width={130}
              height={22}
              className="h-[22px] w-auto"
              priority
            />
          </Link>
          <p className="text-[10px] uppercase tracking-[2px] font-bold text-[#cd8b76] mt-4">
            Platform admin
          </p>
        </div>

        <nav className="flex-1 py-4">
          <ul className="space-y-0.5 px-3">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={[
                      "group flex items-center px-4 py-2.5 text-sm rounded-full transition-colors",
                      active
                        ? "bg-[#cd8b76]/15 text-[#f4f1ed] border border-[#cd8b76]/30"
                        : "text-[rgba(244,241,237,0.65)] hover:bg-white/5 hover:text-[#f4f1ed] border border-transparent",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "inline-block w-1.5 h-1.5 rounded-full mr-3 transition-colors",
                        active ? "bg-[#cd8b76]" : "bg-white/20 group-hover:bg-white/40",
                      ].join(" ")}
                    />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="p-4 border-t border-white/10 text-[10px] uppercase tracking-[2px] text-white/30 font-bold">
          v0.2.0 — Session B
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="h-16 bg-white border-b border-[#dad4cb] px-8 flex items-center justify-between">
          <HealthBar />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" className="h-10 px-3 gap-2 rounded-full">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="text-xs bg-[#143643] text-[#f4f1ed] font-semibold">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-sm text-[#11242e] font-medium">{user.email}</span>
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
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}

// Placeholder — Session E wires live counters here.
function HealthBar() {
  return (
    <div className="flex items-center gap-3 text-xs text-[#5a6a72]">
      <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#dad4cb] bg-[#f4f1ed]">
        <span className="w-1.5 h-1.5 rounded-full bg-[#cd8b76]" />
        <span className="font-semibold uppercase tracking-[1.5px] text-[10px] text-[#11242e]">
          Health
        </span>
        <span className="text-[#5a6a72]">live counters — Session E</span>
      </span>
    </div>
  );
}
