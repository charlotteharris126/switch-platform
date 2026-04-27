import Link from "next/link";

// Brand filter pill bar for /social/* pages (except Settings, which is brand-
// agnostic — connection settings list every (brand, channel) together).
//
// URL query param: ?brand=switchleads | ?brand=switchable | (omitted for "all")
// Shareable filtered views work via the URL.

export type BrandFilterValue = "all" | "switchleads" | "switchable";

const BRANDS: Array<{ value: BrandFilterValue; label: string }> = [
  { value: "all",         label: "All brands" },
  { value: "switchleads", label: "SwitchLeads" },
  { value: "switchable",  label: "Switchable" },
];

interface Props {
  active: BrandFilterValue;
  // Path to apply the filter to — defaults to current URL but caller passes
  // explicitly so it's clear which surface the filter applies to.
  basePath: string;
}

export function BrandFilter({ active, basePath }: Props) {
  return (
    <div className="flex flex-wrap gap-2 mt-4">
      {BRANDS.map((b) => {
        const isActive = active === b.value;
        const href = b.value === "all" ? basePath : `${basePath}?brand=${b.value}`;
        return (
          <Link
            key={b.value}
            href={href}
            className={
              "px-4 h-9 inline-flex items-center text-[11px] font-bold uppercase tracking-[0.08em] rounded-full transition-colors " +
              (isActive
                ? "bg-[#cd8b76] text-white border border-[#cd8b76]"
                : "bg-white text-[#143643] border border-[#dad4cb] hover:border-[#cd8b76]/60")
            }
          >
            {b.label}
          </Link>
        );
      })}
    </div>
  );
}

export function normaliseBrand(value: string | undefined): BrandFilterValue {
  if (value === "switchleads" || value === "switchable") return value;
  return "all";
}
