import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function AdminHomePage() {
  return (
    <div className="max-w-4xl">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-900">Welcome</h1>
        <p className="text-sm text-slate-500 mt-1">
          The admin dashboard is alive. Foundation shipped in Session A.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What's here</CardTitle>
            <CardDescription>Login, MFA, sidebar, topbar, allowlist.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-slate-600">
            Empty shell. Real features land in Sessions B-F per
            <code className="mx-1 px-1.5 py-0.5 bg-slate-100 rounded text-xs">
              platform/docs/admin-dashboard-scoping.md
            </code>
            in the workspace.
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">What's next</CardTitle>
            <CardDescription>Session B — read-only data surfaces.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-slate-600">
            Leads list + detail, providers list, dead letter list. All read from Supabase, all
            RLS-scoped, all behind this auth wall.
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
