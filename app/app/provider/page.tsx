// /provider — gated home for authenticated provider users.
//
// Pulls the caller's provider_users + provider rows for context, then
// surfaces the four counter tiles (Open / In progress / Enrolled this
// month / Awaiting outcome > 7 days) and a recent-activity preview list.
//
// All lead reads run as the authenticated role so RLS from migration 0096
// scopes everything to this provider automatically.

import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ProviderShell } from "./provider-shell";
import { DurationTimer } from "./duration-timer";
import { STATUS_LABEL, type LeadStatus } from "@/lib/lead-status";

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

interface RecentLeadRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  course_id: string | null;
  routed_at: string | null;
}

interface RecentEnrolmentRow {
  submission_id: number;
  status: string;
  status_updated_at: string;
}

const STATUS_TONE: Record<LeadStatus, string> = {
  open: "bg-slate-100 text-slate-700 border-slate-200",
  attempt_1_no_answer: "bg-amber-50 text-amber-700 border-amber-200",
  attempt_2_no_answer: "bg-amber-100 text-amber-800 border-amber-300",
  attempt_3_no_answer: "bg-orange-100 text-orange-800 border-orange-300",
  enrolment_meeting_booked: "bg-blue-50 text-blue-700 border-blue-200",
  enrolled: "bg-emerald-50 text-emerald-700 border-emerald-200",
  presumed_enrolled: "bg-emerald-50 text-emerald-700 border-emerald-200",
  lost: "bg-rose-50 text-rose-700 border-rose-200",
  cannot_reach: "bg-rose-50 text-rose-700 border-rose-200",
};

export default async function ProviderHomePage() {
  const supabase = await createClient();
  // getSession reads the cookie locally — getUser would re-validate against
  // the Supabase Auth API (~100-200ms network call). The proxy already
  // re-validated on this request, and RLS gates every DB call we make
  // below, so the security boundary doesn't move.
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) redirect("/passkey-login");

  const admin = createAdminClient();

  // Fan out everything that doesn't depend on the provider lookup.
  const [puResult, enrolmentsResult, recentSubsResult] = await Promise.all([
    admin
      .schema("crm")
      .from("provider_users")
      .select("id, provider_id, contact_email, display_name, role, enrolled_at, status")
      .eq("auth_user_id", user.id)
      .eq("status", "active")
      .maybeSingle<ProviderUserRow>(),
    supabase
      .schema("crm")
      .from("enrolments")
      .select("status, status_updated_at"),
    supabase
      .schema("leads")
      .from("submissions")
      .select("id, first_name, last_name, email, course_id, routed_at")
      .not("routed_at", "is", null)
      .is("archived_at", null)
      .is("parent_submission_id", null)
      .order("routed_at", { ascending: false })
      .limit(5),
  ]);

  const pu = puResult.data;
  if (!pu) {
    await supabase.auth.signOut();
    redirect("/passkey-login?error=no_active_account");
  }

  const recentSubs = (recentSubsResult.data ?? []) as RecentLeadRow[];
  const recentIds = recentSubs.map((s) => s.id);

  // Second wave: provider lookup (depends on pu.provider_id) +
  // enrolment-status by recent submission ids (depends on recentIds).
  const [providerResult, recentEnrolsResult] = await Promise.all([
    admin
      .schema("crm")
      .from("providers")
      .select("company_name")
      .eq("provider_id", pu.provider_id)
      .maybeSingle<ProviderRow>(),
    recentIds.length
      ? supabase
          .schema("crm")
          .from("enrolments")
          .select("submission_id, status, status_updated_at")
          .in("submission_id", recentIds)
      : Promise.resolve({ data: [] as RecentEnrolmentRow[] }),
  ]);

  const provider = providerResult.data;
  const enrolments = (enrolmentsResult.data ?? []) as EnrolmentCountRow[];
  const counts = countByStatus(enrolments);
  const enrolledThisMonth = enrolledThisMonthCount(enrolments);

  const recentEnrolBySub = new Map<number, RecentEnrolmentRow>();
  for (const e of (recentEnrolsResult.data ?? []) as RecentEnrolmentRow[]) {
    recentEnrolBySub.set(e.submission_id, e);
  }

  return (
    <ProviderShell active="home">
      <div className="max-w-5xl mx-auto p-6">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">
            {provider?.company_name ?? pu.provider_id}
          </p>
          <h1 className="text-2xl font-semibold text-slate-900 mt-1">
            Welcome back, {pu.display_name ?? pu.contact_email}
          </h1>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Tile label="Open" value={counts.open} href="/provider/leads?status=open" tone="slate" />
          <Tile label="In progress" value={counts.in_progress} href="/provider/leads?status=in_progress" tone="amber" />
          <Tile label="Enrolled this month" value={enrolledThisMonth} href="/provider/leads?status=enrolled" tone="emerald" />
          <Tile label="Awaiting outcome" value={counts.awaiting_long} href="/provider/leads?status=open" tone="rose" subtitle="Open > 7 days" />
        </div>

        {/* Recent activity */}
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="flex items-baseline justify-between px-6 pt-5 pb-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Recently routed to you</h2>
              <p className="text-xs text-slate-500 mt-0.5">The last five leads. Click for full details.</p>
            </div>
            <Link
              href="/provider/leads"
              className="text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer"
            >
              See all &rarr;
            </Link>
          </div>
          {recentSubs.length === 0 ? (
            <p className="px-6 py-10 text-sm text-slate-500 text-center">
              No leads yet. New leads land here as they come in.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 border-t border-slate-100">
              {recentSubs.map((s) => {
                const enrol = recentEnrolBySub.get(s.id);
                const status = (enrol?.status ?? "open") as LeadStatus;
                const name = [s.first_name, s.last_name].filter(Boolean).join(" ") || s.email || `Lead ${s.id}`;
                return (
                  <li key={s.id} className="hover:bg-slate-50 transition-colors">
                    <Link href={`/provider/leads/${s.id}`} className="flex items-center justify-between px-6 py-3 gap-3 cursor-pointer">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-900 truncate">{name}</p>
                        <p className="text-xs text-slate-500 truncate">{s.course_id ?? "—"}</p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span className="text-xs text-slate-500 tabular-nums">
                          <DurationTimer since={s.routed_at} />
                        </span>
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${STATUS_TONE[status] ?? "bg-slate-100 text-slate-700 border-slate-200"}`}>
                          {STATUS_LABEL[status] ?? status}
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
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
    if (
      r.status === "attempt_1_no_answer" ||
      r.status === "attempt_2_no_answer" ||
      r.status === "attempt_3_no_answer" ||
      r.status === "enrolment_meeting_booked"
    ) {
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
      className={`block p-4 rounded-xl border ${TILE_TONE[tone]} hover:shadow-md hover:-translate-y-0.5 transition-all cursor-pointer`}
    >
      <p className="text-xs uppercase tracking-wide font-semibold text-slate-600">{label}</p>
      <p className="text-3xl font-semibold text-slate-900 mt-1 tabular-nums">{value}</p>
      {subtitle && <p className="text-xs text-slate-500 mt-1">{subtitle}</p>}
    </Link>
  );
}
