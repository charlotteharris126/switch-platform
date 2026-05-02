import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/allowlist";
import { AdminShell } from "@/components/admin-shell";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  const user = userData.user;

  if (!user) {
    redirect("/login");
  }

  if (!isAdmin(user.email)) {
    redirect("/login?error=not_authorised");
  }

  // AAL2 enforcement: confirm the user has stepped up via MFA this session.
  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalData?.currentLevel !== "aal2") {
    if (aalData?.nextLevel === "aal2") {
      // User has MFA enrolled but hasn't stepped up yet → challenge.
      redirect("/verify-mfa");
    } else {
      // User has no MFA factor → enrol.
      redirect("/enrol-mfa");
    }
  }

  // Live counters for the topbar HealthBar (vw_admin_health, single row).
  const { data: healthRows } = await supabase
    .from("vw_admin_health")
    .select("leads_last_7d, unrouted_over_48h, errors_over_7d, errors_unresolved_total, needs_status_update_count");
  const health = (healthRows?.[0] as Health | undefined) ?? null;

  // Sidebar nav badges. Counts only sections owner can actually clear by
  // taking action — Awaiting your call, Presumed enrolled, Needs another
  // chase, Cannot reach (no chaser sent). Skips Unrouted (informational
  // for auto-routing) and Approaching auto-flip (chase is optional, the
  // cron handles the flip regardless).
  const fiveDaysAgoISO = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();

  const [
    presumedEnrolledCount,
    pendingAiCount,
    needsChasingCount,
    cannotReachNoChaserCount,
  ] = await Promise.all([
    supabase.schema("crm").from("enrolments")
      .select("id", { count: "exact", head: true })
      .eq("status", "presumed_enrolled"),
    supabase.schema("crm").from("pending_updates")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase.schema("crm").from("enrolments")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")
      .not("last_chaser_at", "is", null)
      .lt("last_chaser_at", fiveDaysAgoISO),
    supabase.schema("crm").from("enrolments")
      .select("id", { count: "exact", head: true })
      .eq("status", "cannot_reach")
      .is("last_chaser_at", null),
  ]);

  const actionsCount =
    (presumedEnrolledCount.count ?? 0) +
    (pendingAiCount.count ?? 0) +
    (needsChasingCount.count ?? 0) +
    (cannotReachNoChaserCount.count ?? 0);

  const navBadges = {
    "/actions": actionsCount,
    "/errors": health?.errors_unresolved_total ?? 0,
  };

  return (
    <AdminShell user={{ email: user.email }} health={health} navBadges={navBadges}>
      {children}
    </AdminShell>
  );
}

interface Health {
  leads_last_7d: number;
  unrouted_over_48h: number;
  errors_over_7d: number;
  errors_unresolved_total: number;
  needs_status_update_count: number;
}
