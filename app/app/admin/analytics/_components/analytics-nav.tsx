"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

// Shared top-of-page nav for /admin/analytics/*. Brand selector is a tab
// row (Switchable | SwitchLeads dormant). View nav lists every analytics
// view nested under the current brand. Per the architecture decision: Ads
// and Signals are views inside Analytics, not standalone top-level pages.
export function AnalyticsNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const brand = searchParams.get("brand") === "switchleads" ? "switchleads" : "switchable";

  const views: Array<{ href: string; label: string; match: (p: string) => boolean }> = [
    {
      href: brand === "switchable" ? "/analytics" : "/analytics?brand=switchleads",
      label: "Overview",
      match: (p) => p === "/analytics",
    },
    {
      href: brand === "switchable" ? "/analytics/ads" : "/analytics/ads?brand=switchleads",
      label: "Ads",
      match: (p) => p.startsWith("/analytics/ads"),
    },
    {
      href: brand === "switchable" ? "/analytics/signals" : "/analytics/signals?brand=switchleads",
      label: "Signals",
      match: (p) => p === "/analytics/signals",
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(["switchable", "switchleads"] as const).map((b) => {
          const isActive = b === brand;
          // Preserve current view (pathname) when switching brand
          const usp = new URLSearchParams();
          if (b !== "switchable") usp.set("brand", b);
          const href = usp.toString() ? `${pathname}?${usp.toString()}` : pathname;
          const label = b === "switchable" ? "Switchable" : "SwitchLeads";
          return (
            <Link
              key={b}
              href={href}
              className={
                isActive
                  ? "px-4 py-1.5 text-xs font-bold uppercase tracking-wide rounded-full bg-[#143643] text-white border border-[#143643]"
                  : "px-4 py-1.5 text-xs font-bold uppercase tracking-wide rounded-full bg-white text-[#143643] border border-[#dad4cb] hover:border-[#143643]/40"
              }
            >
              {label}
              {b === "switchleads" ? <span className="ml-2 text-[9px] opacity-60">(no data)</span> : null}
            </Link>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-1 border-b border-[#dad4cb]">
        {views.map((v) => {
          const isActive = v.match(pathname);
          return (
            <Link
              key={v.label}
              href={v.href}
              className={
                isActive
                  ? "px-4 py-2 text-xs font-bold border-b-2 border-[#cd8b76] text-[#cd8b76] -mb-px"
                  : "px-4 py-2 text-xs font-bold text-[#5a6a72] hover:text-[#11242e] -mb-px"
              }
            >
              {v.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
