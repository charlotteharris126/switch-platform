// /provider — gated home for authenticated provider users.
//
// Pulls the caller's provider_users + provider rows for context, then
// surfaces a few quick counts (open / awaiting outcome / enrolled this
// month) and a deep link into the leads list.
//
// All reads run as the authenticated role so RLS from migration 0096
// scopes everything to this provider automatically.

import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ProviderShell } from "./provider-shell";

interface ProviderUserRow {
  id: number;
  provider_id: string;
  contact_email: string;
  display_name: string | null;
  role: string;
  enrolled_at: string | null;
  status: string;
}

interface ProviderRow {
  company_name: string;
}

interface EnrolmentCountRow {
  status: string;
  status_updated_at: string;
}

export default async function ProviderHomePage() {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;
  if (!user) redirect("/passkey-login");

  // provider_users + providers reads use service-role admin client (these
  // tables have admin-gated RLS that the provider's authenticated session
  // doesn't satisfy on its own — the helper crm.provider_user_provider_id()
  // gates the row policies for OTHER tables, not for self-lookup).
  const admin = createAdminClient();
  const { data: pu } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, provider_id, contact_email, display_name, role, enrolled_at, status")
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle<ProviderUserRow>();

  if (!pu) {
    await supabase.auth.signOut();
    redirect("/passkey-login?error=no_active_account");
  }

  const { data: provider } = await admin
    .schema("crm")
    .from("providers")
    .select("company_name")
    .eq("provider_id", pu.provider_id)
    .maybeSingle<ProviderRow>();

  // Counts come via the AUTHENTICATED client so RLS scopes to this provider.
  const { data: enrolmentRows } = await supabase
    .schema("crm")
    .from("enrolments")
    .select("status, status_updated_at");

  const enrolments = (enrolmentRows ?? []) as EnrolmentCountRow[];
  const counts = countByStatus(enrolments);
  const enrolledThisMonth = enrolledThisMonthCount(enrolments);

  return (
    <ProviderShell active="home">
      <div className="max-w-5xl mx-auto p-6">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">{provider?.company_name ?? pu.provider_id}</p>
          <h1 className="text-2xl font-semibold text-slate-900 mt-1">Welcome back, {pu.display_name ?? pu.contact_email}</h1>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Tile label="Open" value={counts.open} href="/provider/leads" tone="slate" />
          <Tile label="In progress" value={counts.in_progress} href="/provider/leads" tone="amber" />
          <Tile label="Enrolled this month" value={enrolledThisMonth} href="/provider/leads" tone="emerald" />
          <Tile label="Awaiting outcome" value={counts.awaiting_long} href="/provider/leads" tone="rose" subtitle="Open > 7 days" />
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-6">
          <h2 className="text-sm font-semibold text-slate-900">Your routed leads</h2>
          <p className="text-sm text-slate-500 mt-1">View the full list, filter by status, mark outcomes.</p>
          <Link
            href="/provider/leads"
            className="inline-block mt-4 bg-slate-900 text-white px-4 py-2 rounded-md text-sm font-semibold hover:bg-slate-800"
          >
            Open leads list
          </Link>
        </div>
      </div>
    </ProviderShell>
  );
}

function countByStatus(rows: EnrolmentCountRow[]) {
  let open = 0;
  let inProgress = 0;
  let awaitingLong = 0;
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const r of rows) {
    if (r.status === "open") {
      open += 1;
      if (new Date(r.status_updated_at).getTime() < sevenDaysAgo) awaitingLong += 1;
    }
    if (r.status === "attempt_1_no_answer" || r.status === "attempt_2_no_answer" || r.status === "attempt_3_no_answer" || r.status === "enrolment_meeting_booked") {
      inProgress += 1;
    }
  }
  return { open, in_progress: inProgress, awaiting_long: awaitingLong };
}

function enrolledThisMonthCount(rows: EnrolmentCountRow[]): number {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return rows.filter(
    (r) => (r.status === "enrolled" || r.status === "presumed_enrolled") && new Date(r.status_updated_at).getTime() >= monthStart,
  ).length;
}

const TILE_TONE: Record<string, string> = {
  slate: "border-slate-200 bg-white",
  amber: "border-amber-200 bg-amber-50",
  emerald: "border-emerald-200 bg-emerald-50",
  rose: "border-rose-200 bg-rose-50",
};

function Tile({ label, value, href, tone, subtitle }: { label: string; value: number; href: string; tone: keyof typeof TILE_TONE; subtitle?: string }) {
  return (
    <Link
      href={href}
      className={`block p-4 rounded-xl border ${TILE_TONE[tone]} hover:shadow-sm transition-shadow`}
    >
      <p className="text-xs uppercase tracking-wide font-semibold text-slate-600">{label}</p>
      <p className="text-3xl font-semibold text-slate-900 mt-1">{value}</p>
      {subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}
    </Link>
  );
}
