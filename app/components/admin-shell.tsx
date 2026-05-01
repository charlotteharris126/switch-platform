"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { signOutAction } from "@/app/(auth)/verify-mfa/actions";

// Sidebar nav is split into sections.
//   "Operations" — the lead/provider lifecycle surfaces. Day-to-day work lives here.
//   "Tools"      — operational tooling that supports the business but isn't the
//                  core lifecycle. Social was the first; bulk operations,
//                  reports, engagement queue, etc. land here as they ship.
const NAV_SECTIONS: Array<{
  label?: string;
  items: Array<{ href: string; label: string }>;
}> = [
  {
    items: [
      { href: "/", label: "Overview" },
      { href: "/actions", label: "Actions" },
      { href: "/leads", label: "Leads" },
      { href: "/sheet-activity", label: "Sheet activity" },
      { href: "/providers", label: "Providers" },
    ],
  },
  {
    label: "Tools",
    items: [
      { href: "/analytics", label: "Analytics" },
      { href: "/social/drafts", label: "Social" },
      { href: "/ads", label: "Ad spend" },
      { href: "/agents", label: "Agents" },
      { href: "/errors", label: "Data health" },
    ],
  },
];

interface Health {
  leads_last_7d: number;
  unrouted_over_48h: number;
  errors_over_7d: number;
  errors_unresolved_total: number;
  needs_status_update_count: number;
}

export function AdminShell({
  user,
  health,
  children,
}: {
  user: { email?: string };
  health: Health | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const initials = (user.email ?? "?").slice(0, 2).toUpperCase();

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    // Social tab sub-routes (/social/drafts, /social/settings) all activate the
    // single sidebar Social link.
    if (href === "/social/drafts") return pathname.startsWith("/social");
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
          {NAV_SECTIONS.map((section, sectionIdx) => (
            <div key={section.label ?? `section-${sectionIdx}`} className={sectionIdx > 0 ? "mt-6" : ""}>
              {section.label && (
                <p className="px-7 mb-2 text-[10px] font-bold uppercase tracking-[2px] text-white/40">
                  {section.label}
                </p>
              )}
              <ul className="space-y-0.5 px-3">
                {section.items.map((item) => {
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
            </div>
          ))}
        </nav>

        <div className="p-4 border-t border-white/10 text-[10px] uppercase tracking-[2px] text-white/30 font-bold">
          v0.2.0 — Session B
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="h-16 bg-white border-b border-[#dad4cb] px-8 flex items-center justify-between">
          <HealthBar health={health} />
          <UserMenu email={user.email} initials={initials} />
        </header>

        {/* Content */}
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}

// Self-contained user menu. Built with plain primitives instead of the
// shadcn DropdownMenu render-prop pattern because the previous version
// had click-handling issues (clicking the avatar opened the menu but
// inner items didn't always fire, Base UI render-prop interaction with
// nested forms / Link components). Plain button + click-outside handler
// is more predictable.
function UserMenu({ email, initials }: { email?: string; initials: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="h-10 px-3 inline-flex items-center gap-2 rounded-full hover:bg-[#f4f1ed] transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Avatar className="h-8 w-8">
          <AvatarFallback className="text-xs bg-[#143643] text-[#f4f1ed] font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
        <span className="text-sm text-[#11242e] font-medium hidden md:inline max-w-[180px] truncate">{email ?? ""}</span>
      </button>

      {open ? (
        <div className="absolute right-0 mt-1 w-60 z-50 bg-white border border-[#dad4cb] rounded-xl shadow-[0_4px_12px_rgba(17,36,46,0.15)] py-2">
          <div className="px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-[#5a6a72] font-bold">Signed in as</p>
            <p className="text-xs font-bold text-[#11242e] truncate">{email ?? "—"}</p>
          </div>
          <div className="border-t border-[#dad4cb] my-1" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              router.push("/account");
            }}
            className="w-full text-left px-3 py-2 text-sm text-[#11242e] hover:bg-[#f4f1ed] cursor-pointer"
          >
            Account settings
          </button>
          <div className="border-t border-[#dad4cb] my-1" />
          <form action={signOutAction}>
            <button
              type="submit"
              className="w-full text-left px-3 py-2 text-sm text-[#11242e] hover:bg-[#f4f1ed] cursor-pointer"
            >
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

// Live counters from public.vw_admin_health (one row, refreshed each
// navigation). Pill colour = worst severity across the four watched
// signals: red if any "over" threshold is non-zero, amber if anything
// needs attention, green otherwise.
function HealthBar({ health }: { health: Health | null }) {
  if (!health) {
    return (
      <div className="flex items-center gap-3 text-xs text-[#5a6a72]">
        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#dad4cb] bg-[#f4f1ed]">
          <span className="w-1.5 h-1.5 rounded-full bg-[#cd8b76]" />
          <span className="font-semibold uppercase tracking-[1.5px] text-[10px] text-[#11242e]">Health</span>
          <span className="text-[#5a6a72]">unavailable</span>
        </span>
      </div>
    );
  }

  const stale = health.errors_over_7d > 0 || health.unrouted_over_48h > 0;
  const warn = stale || health.needs_status_update_count > 0 || health.errors_unresolved_total > 0;
  const dotColour = stale ? "bg-[#b3412e]" : warn ? "bg-[#cd8b76]" : "bg-emerald-600";

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#dad4cb] bg-[#f4f1ed]">
        <span className={`w-1.5 h-1.5 rounded-full ${dotColour}`} />
        <span className="font-semibold uppercase tracking-[1.5px] text-[10px] text-[#11242e]">Health</span>
      </span>
      <Stat label="Leads 7d" value={health.leads_last_7d} href="/leads" tone={health.leads_last_7d > 0 ? "good" : "neutral"} />
      <Stat
        label="Unrouted >48h"
        value={health.unrouted_over_48h}
        href="/actions"
        tone={health.unrouted_over_48h > 0 ? "bad" : "good"}
      />
      <Stat
        label="Stale errors"
        value={health.errors_over_7d}
        href="/errors"
        tone={health.errors_over_7d > 0 ? "bad" : "good"}
      />
      <Stat
        label="Open errors"
        value={health.errors_unresolved_total}
        href="/errors"
        tone={health.errors_unresolved_total > 0 ? "warn" : "good"}
      />
      <Stat
        label="Needs update"
        value={health.needs_status_update_count}
        href="/actions"
        tone={health.needs_status_update_count > 0 ? "warn" : "good"}
      />
    </div>
  );
}

function Stat({ label, value, href, tone }: { label: string; value: number; href: string; tone: "good" | "warn" | "bad" | "neutral" }) {
  const colour =
    tone === "bad"
      ? "text-[#b3412e]"
      : tone === "warn"
        ? "text-[#cd8b76]"
        : tone === "good"
          ? "text-emerald-700"
          : "text-[#11242e]";
  return (
    <Link
      href={href}
      className="inline-flex items-baseline gap-1 px-2 py-1 rounded hover:bg-[#f4f1ed] transition-colors"
    >
      <span className={`font-bold tabular-nums ${colour}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-[1.5px] text-[#5a6a72]">{label}</span>
    </Link>
  );
}
