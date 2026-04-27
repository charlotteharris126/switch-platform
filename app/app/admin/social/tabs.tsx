import Link from "next/link";

interface Props {
  active: "drafts" | "analytics" | "settings";
}

const TABS: Array<{ key: Props["active"]; label: string; href: string }> = [
  { key: "drafts",    label: "Drafts",    href: "/social/drafts" },
  { key: "analytics", label: "Analytics", href: "/social/analytics" },
  { key: "settings",  label: "Settings",  href: "/social/settings" },
];

export function SocialTabs({ active }: Props) {
  return (
    <div className="flex gap-2 border-b border-[#dad4cb]">
      {TABS.map((t) => {
        const isActive = active === t.key;
        return (
          <Link
            key={t.key}
            href={t.href}
            className={
              "inline-flex items-center h-10 px-5 text-[11px] font-bold uppercase tracking-[0.08em] transition-colors " +
              (isActive
                ? "border-b-2 border-[#cd8b76] text-[#143643] -mb-px"
                : "text-[#5a6a72] hover:text-[#143643]")
            }
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
