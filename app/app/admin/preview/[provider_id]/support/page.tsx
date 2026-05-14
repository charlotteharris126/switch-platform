// /admin/preview/[provider_id]/support — admin impersonation of
// /provider/support. Mirrors the cards rendered there but stubs out
// the live support form so preview mode can't accidentally fire any
// Server Action.
//
// Audience-filtered FAQ pulls the same GUIDES array the provider page
// renders (single source of truth), filtered by the impersonated
// provider's funding_types.

import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminUser } from "@/lib/auth/require-admin";
import { PreviewHeader } from "../preview-header";
import { GUIDES } from "@/app/provider/support/page";

interface ProviderRow {
  provider_id: string;
  company_name: string;
  funding_types: string[] | null;
  is_demo: boolean;
}

interface Props {
  params: Promise<{ provider_id: string }>;
}

export default async function PreviewSupportPage({ params }: Props) {
  await requireAdminUser();
  const { provider_id: rawId } = await params;
  const providerId = decodeURIComponent(rawId);

  const admin = createAdminClient();
  const { data: provider } = await admin
    .schema("crm")
    .from("providers")
    .select("provider_id, company_name, funding_types, is_demo")
    .eq("provider_id", providerId)
    .maybeSingle<ProviderRow>();
  if (!provider) notFound();

  const isEmployer =
    Array.isArray(provider.funding_types) &&
    provider.funding_types.includes("apprenticeship");

  const visibleGuides = GUIDES.filter((g) => {
    if (g.for === "both") return true;
    return isEmployer ? g.for === "employer" : g.for === "learner";
  });

  const encoded = encodeURIComponent(providerId);

  return (
    <>
      <PreviewHeader
        providerId={providerId}
        companyName={provider.company_name}
        isDemo={provider.is_demo}
        active="support"
      />
      <div className="bg-slate-50 min-h-screen">
        <div className="max-w-3xl mx-auto p-6 space-y-8">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Support</h1>
            <p className="text-sm text-slate-500 mt-1">
              Showing the {isEmployer ? "employer" : "learner"} provider view of
              /provider/support. The contact form below is rendered read-only
              so preview mode can&apos;t fire a Server Action.
            </p>
          </div>

          {/* Get started card. Links to preview's own welcome route so
              the admin can walk the deck without leaving preview mode. */}
          <section className="bg-white border border-slate-200 rounded-xl p-5 flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
                Get started
              </p>
              <p className="text-sm text-slate-700">
                Walk back through the portal tour any time. Same one we show
                every new team member on their first sign-in.
              </p>
            </div>
            <a
              href={`/preview/${encoded}/welcome`}
              className="inline-flex items-center justify-center rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold px-4 py-2 transition-colors shrink-0"
            >
              Open the tour →
            </a>
          </section>

          <section className="text-xs text-slate-500">
            Share with a teammate before their invite lands:{" "}
            <a
              href="/help/getting-started"
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-slate-700 underline-offset-2 hover:underline"
            >
              /help/getting-started
            </a>
            . No sign-in required.
          </section>

          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
              Common questions
            </h2>
            <div className="space-y-3">
              {visibleGuides.map((g) => (
                <details
                  key={g.q}
                  className="group bg-white border border-slate-200 rounded-xl overflow-hidden"
                >
                  <summary className="cursor-pointer list-none px-5 py-4 flex items-center justify-between gap-3 hover:bg-slate-50 transition-colors">
                    <span className="text-sm font-semibold text-slate-900">{g.q}</span>
                    <span className="text-slate-400 text-lg group-open:rotate-45 transition-transform shrink-0">
                      +
                    </span>
                  </summary>
                  <div className="px-5 pb-4 text-sm text-slate-700 leading-relaxed border-t border-slate-100 pt-3">
                    {g.a}
                  </div>
                </details>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
              Still need help? Send us a message
            </h2>
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <div className="bg-slate-50 border border-slate-200 rounded-md p-3 text-xs text-slate-500">
                Read-only in preview. Providers submit messages from here; they land in
                <code className="text-[11px] bg-white px-1 py-0.5 rounded mx-1 border border-slate-200">crm.support_requests</code>
                and email support@switchleads.co.uk.
              </div>
              <div className="space-y-2 opacity-60 pointer-events-none">
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">Subject</label>
                  <input type="text" disabled className="w-full text-sm border border-slate-200 rounded-md px-3 py-2 bg-white" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-slate-700">Message</label>
                  <textarea disabled rows={4} className="w-full text-sm border border-slate-200 rounded-md px-3 py-2 bg-white resize-none" />
                </div>
                <button type="button" disabled className="text-sm font-semibold rounded-lg bg-slate-900 text-white px-4 py-2">
                  Send message
                </button>
              </div>
            </div>
          </section>

          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-slate-600">
            <p className="font-semibold text-slate-700 mb-1">Prefer email?</p>
            <p>
              Send your message direct to{" "}
              <a
                href="mailto:support@switchleads.co.uk"
                className="font-semibold text-slate-900 hover:underline"
              >
                support@switchleads.co.uk
              </a>
              . The form above does the same thing, just with your account context
              attached so we can find you faster.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
