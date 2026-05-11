// /admin/data-ops — one-shot data backfills triggered from the admin UI.
//
// Each panel wraps a Supabase Edge Function. Brevo / DB credentials live
// on Supabase's side, so the operator never has to retrieve them locally.
//
// Panels with a server-checkable pending count auto-hide when complete
// (e.g. 025 → SQL count of funded leads still missing client_nonce).
// Panels whose state lives outside Postgres (e.g. 024 against Brevo)
// stay visible with a note to dry-run to verify current state.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createAdminClient } from "@/lib/supabase/admin";
import { Run024Panel } from "./run-024-panel";
import { RunClientNoncePanel } from "./run-client-nonce-panel";

export const dynamic = "force-dynamic";

interface ClientNoncePending {
  count: number;
}

async function getClientNoncePendingCount(): Promise<number> {
  // Mirrors the audience filter in backfill-client-nonce/index.ts.
  // count(*) only, so this is cheap on every page load.
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("count_client_nonce_pending");
  if (error || data == null) return -1; // -1 means "unknown, show panel anyway"
  return data as unknown as number;
}

export default async function DataOpsPage() {
  // Try the count RPC. If it doesn't exist yet (i.e. migration not applied),
  // we get -1 and fall back to showing the panel unconditionally — safe.
  const noncePending = await getClientNoncePendingCount();
  const showNoncePanel = noncePending !== 0;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-[28px] font-extrabold text-[#11242e] tracking-tight">
          Data ops
        </h1>
        <p className="text-sm text-[#5a6a72] mt-1">
          Manual backfills + one-shot data tasks. Each panel triggers a
          Supabase Edge Function. Dry-run first, review the spot-checks,
          then apply. Panels disappear when their fix is complete.
        </p>
      </div>

      {!showNoncePanel && (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="pt-4 text-xs text-emerald-900">
            <strong>Nothing pending.</strong> All known data-ops fixes are
            complete. New panels will appear here when a future fix is
            scaffolded.
          </CardContent>
        </Card>
      )}

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
              . No Brevo backfill ran. Same pass also backfills
              SW_FASTRACK_URL (introduced 2026-05-09).
            </p>
            <p>
              <span className="font-semibold text-[#11242e]">State:</span>{" "}
              Brevo-side; this panel doesn&apos;t auto-hide because the
              source of truth is Brevo. Run dry-run to verify current
              state. <span className="font-semibold text-[#11242e]">Last
              applied:</span> 2026-05-11 (174 audience / 160 mutated / 0
              errors). Re-run only if a fresh{" "}
              <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
                buildReferralUrl
              </code>{" "}
              / <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
                buildFastrackUrl
              </code>{" "}
              wiring change has shipped, or after running 025 below.
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
              . Idempotent — skips contacts already matching.
            </p>
          </div>
          <div className="border-t border-[#dde3e6] pt-4">
            <Run024Panel />
          </div>
        </CardContent>
      </Card>

      {showNoncePanel && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              025: Backfill client_nonce on funded in-funnel leads
              {noncePending > 0 && (
                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-200">
                  {noncePending} pending
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-xs text-[#5a6a72] space-y-2 leading-relaxed">
              <p>
                <span className="font-semibold text-[#11242e]">Why:</span>{" "}
                <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
                  leads.submissions.client_nonce
                </code>{" "}
                landed on 2026-05-07 (migration 0087). Funded leads submitted
                before that date have no nonce, so their per-lead fastrack URL
                on{" "}
                <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
                  /admin/leads/[id]
                </code>{" "}
                renders as &quot;not available&quot;. Backfill stamps a fresh
                UUID into each qualifying row.
              </p>
              <p>
                <span className="font-semibold text-[#11242e]">Audience:</span>{" "}
                funded (gov / loan), no nonce yet,{" "}
                <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
                  is_dq
                </code>{" "}
                not true, status not{" "}
                <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
                  enrolled
                </code>{" "}
                /{" "}
                <code className="text-[11px] bg-[#f4f1ed] px-1 py-0.5 rounded">
                  presumed_enrolled
                </code>
                . Idempotent — panel disappears when audience is empty.
              </p>
              <p>
                <span className="font-semibold text-[#11242e]">After apply:</span>{" "}
                re-run 024 above to push the new nonces into existing Brevo
                contacts&apos; SW_FASTRACK_URL attribute. Optional — the
                /admin/leads/[id] copy-paste workflow works straight away
                without that.
              </p>
            </div>
            <div className="border-t border-[#dde3e6] pt-4">
              <RunClientNoncePanel />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// Silence unused-type warning if the RPC return shape changes — defensive.
export type _Marker = ClientNoncePending;
