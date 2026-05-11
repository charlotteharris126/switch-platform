// Top header rendered on every /admin/preview/[provider_id]/* page.
//
// Replaces the provider's own nav (we're rendering inside the admin layout,
// not the provider shell). Carries the four things the operator needs while
// dogfooding:
//   - which provider's portal they're impersonating
//   - which sub-view (leads / account) they're on
//   - a clear "read-only" signal so they don't try to write
//   - an exit back to the admin record for that provider
//
// Read-only is the load-bearing part of this UI: every interaction surface
// on the previewed pages is gated on "we're inside this route tree" and
// renders as either disabled or absent. The banner is the explicit signal
// to the operator that this is the case.

import Link from "next/link";

type Active = "leads" | "account";

interface Props {
  providerId: string;
  companyName: string;
  isDemo: boolean;
  active: Active;
}

export function PreviewHeader({ providerId, companyName, isDemo, active }: Props) {
  const encoded = encodeURIComponent(providerId);
  return (
    <div className="bg-amber-50 border-b border-amber-300">
      <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-200 text-amber-900 border border-amber-300">
            Preview
          </span>
          <span className="text-sm text-amber-900">
            Viewing as <strong className="font-semibold">{companyName}</strong>
            {isDemo && (
              <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-violet-100 text-violet-800 border border-violet-200">
                Demo
              </span>
            )}
            <span className="ml-2 text-amber-800">· Read-only · They can&apos;t see this</span>
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <TabLink
            href={`/preview/${encoded}/leads`}
            label="Their leads"
            active={active === "leads"}
          />
          <TabLink
            href={`/preview/${encoded}/account`}
            label="Their account"
            active={active === "account"}
          />
          <Link
            href={`/providers/${encoded}`}
            className="ml-2 px-3 py-1.5 rounded-md text-amber-900 hover:bg-amber-100 transition-colors"
          >
            Exit preview
          </Link>
        </div>
      </div>
    </div>
  );
}

function TabLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded-md transition-colors ${
        active
          ? "bg-amber-900 text-white font-semibold"
          : "text-amber-900 hover:bg-amber-100"
      }`}
    >
      {label}
    </Link>
  );
}
