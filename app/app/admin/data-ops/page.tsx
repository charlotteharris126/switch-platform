// /admin/data-ops — one-shot data backfills triggered from the admin UI.
//
// Each panel wraps a Supabase Edge Function. Brevo / DB credentials live
// on Supabase's side, so the operator never has to retrieve them locally.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Run024Panel } from "./run-024-panel";

export default function DataOpsPage() {
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-[28px] font-extrabold text-[#11242e] tracking-tight">
          Data ops
        </h1>
        <p className="text-sm text-[#5a6a72] mt-1">
          Manual backfills + one-shot data tasks. Each panel triggers a
          Supabase Edge Function. Dry-run first, review the spot-checks,
          then apply.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            024: Backfill SW_REFERRAL_URL + SW_FASTRACK_URL on Brevo
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-xs text-[#5a6a72] space-y-2 leading-relaxed">
            <p>
              <span className="font-semibold text-[#11242e]">Why:</span>{" "}
              <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
                buildReferralUrl()
              </code>{" "}
              was rewired on 2026-05-04 (commits aadf5ad → 30e62e0) from
              per-funding-category referral paths to a single{" "}
              <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
                /refer/?ref=
              </code>
              . No Brevo backfill ran. Existing contacts hold stale URLs;
              tonight&apos;s referral broadcast went out with broken links
              (site redirect on switchable-site is rescuing clicks).
            </p>
            <p>
              <span className="font-semibold text-[#11242e]">Same pass:</span>{" "}
              backfills SW_FASTRACK_URL too. Introduced 2026-05-09;
              pre-cutover contacts have no value set, U1 funded template +
              future marketing both depend on it.
            </p>
            <p>
              <span className="font-semibold text-[#11242e]">Audience:</span>{" "}
              every Brevo contact whose latest{" "}
              <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
                leads.submissions
              </code>{" "}
              row has{" "}
              <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
                marketing_opt_in=true
              </code>
              .
            </p>
            <p>
              <span className="font-semibold text-[#11242e]">Idempotent.</span>{" "}
              Skips contacts whose attribute values already match the desired
              output of the current{" "}
              <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
                buildReferralUrl
              </code>{" "}
              /{" "}
              <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
                buildFastrackUrl
              </code>{" "}
              wiring. Safe to re-run.
            </p>
          </div>
          <div className="border-t border-[#dde3e6] pt-4">
            <Run024Panel />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
