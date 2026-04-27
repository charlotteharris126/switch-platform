import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { formatDateTime } from "@/lib/format";

// Channel connection management. Lists every (brand, channel) combination
// with current OAuth health. Connect / Reconnect button per row links to
// /api/auth/linkedin/connect (initiates the OAuth dance). After Charlotte
// approves on LinkedIn, the callback route lands here with ?status=connected.
//
// First ship covers (switchleads, linkedin_personal). Other channels show as
// "Not connected" placeholders — they activate as scopes/approvals land
// (Marketing Developer Platform for company pages; Meta + TikTok later).

interface SearchParams {
  status?: string;
  brand?: string;
  channel?: string;
  account?: string;
  error?: string;
  detail?: string;
  error_description?: string;
}

interface ChannelStatusRow {
  brand: string;
  channel: string;
  provider: string;
  external_account_id: string | null;
  expires_at: string | null;
  health_status: "healthy" | "expiring_soon" | "expired" | "no_expiry";
}

const CHANNELS_DEFINED: Array<{ brand: string; channel: string; label: string; description: string; available: boolean }> = [
  {
    brand: "switchleads",
    channel: "linkedin_personal",
    label: "SwitchLeads — LinkedIn personal",
    description: "Charlotte's personal LinkedIn profile, posting on behalf of SwitchLeads. Auto-granted scope, available now.",
    available: true,
  },
  {
    brand: "switchleads",
    channel: "linkedin_company",
    label: "SwitchLeads — LinkedIn company page",
    description: "Requires Marketing Developer Platform approval (2-8 week wait once submitted).",
    available: false,
  },
  {
    brand: "switchable",
    channel: "linkedin_personal",
    label: "Switchable — LinkedIn personal",
    description: "Charlotte's personal LinkedIn profile, posting for Switchable cross-brand. Activate when needed.",
    available: true,
  },
];

export default async function SocialSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: tokenData } = await supabase
    .schema("social")
    .from("vw_channel_status")
    .select("brand, channel, provider, external_account_id, expires_at, health_status");

  const tokens = (tokenData ?? []) as ChannelStatusRow[];
  const tokenByKey = new Map<string, ChannelStatusRow>();
  for (const t of tokens) tokenByKey.set(`${t.brand}/${t.channel}`, t);

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        eyebrow="Social"
        title="Channel connections"
        subtitle={
          <span>
            Connect each posting surface once. Tokens are encrypted and stored in Supabase Vault. Personal-profile tokens last ~60 days, then need a manual reconnect (LinkedIn doesn&apos;t issue refresh tokens for personal accounts).
          </span>
        }
      />

      {sp.status === "connected" && (
        <Card className="border-emerald-300 bg-emerald-50">
          <CardContent className="pt-4 text-sm text-emerald-900">
            <strong>Connected.</strong> {sp.account ? `Linked as ${sp.account}.` : null} {sp.brand} / {sp.channel} is now ready for posting.
          </CardContent>
        </Card>
      )}

      {sp.status === "error" && (
        <Card className="border-[#cd8b76] bg-[#fbf9f5]">
          <CardContent className="pt-4 text-sm text-[#11242e]">
            <strong className="text-[#b3412e]">Connection failed.</strong>{" "}
            <span className="font-mono text-xs">{sp.error}</span>
            {sp.error_description ? <> — {sp.error_description}</> : null}
            {sp.detail ? <div className="mt-1 text-xs text-[#5a6a72]">{sp.detail}</div> : null}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4">
        {CHANNELS_DEFINED.map((c) => {
          const key = `${c.brand}/${c.channel}`;
          const token = tokenByKey.get(key);
          return (
            <Card key={key}>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  {c.label}
                  {token ? <HealthBadge health={token.health_status} /> : <Badge variant="secondary" className="text-[10px]">Not connected</Badge>}
                </CardTitle>
                <p className="text-xs text-[#5a6a72] mt-1">{c.description}</p>
              </CardHeader>
              <CardContent className="text-xs space-y-3">
                {token ? (
                  <div className="space-y-1">
                    <div className="flex items-start gap-2">
                      <span className="text-[#5a6a72] min-w-32">Account</span>
                      <span className="font-mono text-[#11242e] break-all">{token.external_account_id ?? "—"}</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-[#5a6a72] min-w-32">Expires</span>
                      <span className="text-[#11242e]">{token.expires_at ? formatDateTime(token.expires_at) : "—"}</span>
                    </div>
                  </div>
                ) : null}

                {c.available ? (
                  <Link
                    href={`/api/auth/linkedin/connect?brand=${encodeURIComponent(c.brand)}&channel=${encodeURIComponent(c.channel)}`}
                    className="inline-flex items-center h-9 px-5 text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#143643] text-white hover:bg-[#11242e] transition-colors shadow-[0_2px_6px_rgba(17,36,46,0.15)]"
                  >
                    {token ? "Reconnect" : "Connect LinkedIn"}
                  </Link>
                ) : (
                  <p className="text-[11px] text-[#5a6a72] italic">Not yet available.</p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function HealthBadge({ health }: { health: ChannelStatusRow["health_status"] }) {
  switch (health) {
    case "healthy":
      return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 text-[10px]">Connected</Badge>;
    case "expiring_soon":
      return <Badge className="bg-[#cd8b76]/20 text-[#143643] hover:bg-[#cd8b76]/20 text-[10px]">Expiring soon</Badge>;
    case "expired":
      return <Badge className="bg-[#cd8b76] text-white hover:bg-[#cd8b76] text-[10px]">Expired — reconnect</Badge>;
    case "no_expiry":
      return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 text-[10px]">Connected</Badge>;
  }
}
