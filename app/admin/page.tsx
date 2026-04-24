import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function AdminHomePage() {
  const supabase = await createClient();

  // Counts in parallel for a quick pulse.
  const [leadsRes, unroutedRes, errorsRes, providersRes] = await Promise.all([
    supabase.schema("leads").from("submissions").select("id", { count: "exact", head: true }),
    supabase
      .schema("leads")
      .from("submissions")
      .select("id", { count: "exact", head: true })
      .is("primary_routed_to", null)
      .eq("is_dq", false),
    supabase
      .schema("leads")
      .from("dead_letter")
      .select("id", { count: "exact", head: true })
      .is("replayed_at", null),
    supabase.schema("crm").from("providers").select("provider_id", { count: "exact", head: true }).eq("active", true),
  ]);

  const stats = [
    { label: "Total leads", value: leadsRes.count ?? 0, href: "/leads" },
    {
      label: "Unrouted (qualified)",
      value: unroutedRes.count ?? 0,
      href: "/leads?routed=no&dq=no",
    },
    { label: "Unresolved errors", value: errorsRes.count ?? 0, href: "/errors" },
    { label: "Active providers", value: providersRes.count ?? 0, href: "/providers" },
  ];

  return (
    <div className="max-w-5xl">
      <PageHeader
        eyebrow="Overview"
        title="Platform admin"
        subtitle="At-a-glance view of leads, providers, and system health."
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {stats.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className="block bg-white border border-[#dad4cb] rounded-xl p-5 hover:border-[#cd8b76]/60 hover:shadow-[0_4px_12px_rgba(17,36,46,0.08)] transition-all"
          >
            <p className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">
              {s.label}
            </p>
            <p className="text-3xl font-extrabold text-[#11242e] mt-2 tracking-tight">
              {s.value.toLocaleString()}
            </p>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What's here</CardTitle>
            <CardDescription>Sessions A + B shipped.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-[#5a6a72]">
            Login with MFA, leads list + detail, providers list + detail, error queue. All
            read-only, RLS-scoped to admin allowlist.
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">What's next</CardTitle>
            <CardDescription>Session C — schema additions, then Session D writes.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-[#5a6a72]">
            Lead routing UI, enrolment outcome management, provider edit, error replay, audit
            log. See <code className="px-1.5 py-0.5 bg-[#f4f1ed] rounded text-xs">platform/docs/admin-dashboard-scoping.md</code>.
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
