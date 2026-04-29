import Link from "next/link";

interface Props {
  providerId: string;
  active: "overview" | "catch-up" | "trust";
}

const TABS: Array<{ key: "overview" | "catch-up" | "trust"; label: string; hrefSuffix: string }> = [
  { key: "overview", label: "Overview", hrefSuffix: "" },
  { key: "catch-up", label: "Catch-up", hrefSuffix: "/catch-up" },
  { key: "trust", label: "Trust content", hrefSuffix: "/trust" },
];

export function ProviderTabs({ providerId, active }: Props) {
  const base = `/providers/${encodeURIComponent(providerId)}`;
  return (
    <div className="flex gap-2 border-b border-[#dad4cb]">
      {TABS.map((t) => {
        const isActive = active === t.key;
        return (
          <Link
            key={t.key}
            href={`${base}${t.hrefSuffix}`}
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
