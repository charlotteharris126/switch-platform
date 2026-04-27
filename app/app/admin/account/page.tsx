import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { formatDateTime } from "@/lib/format";
import { ChangePasswordForm } from "./change-password-form";

export default async function AccountPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        eyebrow="Account"
        title="Your account"
        subtitle={<span>Sign-in identity, password, and session details.</span>}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Identity</CardTitle>
        </CardHeader>
        <CardContent className="text-xs space-y-2">
          <FieldRow label="Email"           value={user?.email ?? "—"} />
          <FieldRow label="User ID"         value={user?.id ?? "—"} mono />
          <FieldRow label="Created"         value={formatDateTime(user?.created_at)} />
          <FieldRow label="Last sign-in"    value={formatDateTime(user?.last_sign_in_at)} />
        </CardContent>
      </Card>

      <ChangePasswordForm />

      <Card className="border-dashed">
        <CardContent className="pt-4 text-xs text-[#5a6a72]">
          <p className="font-bold uppercase tracking-wide text-[10px] text-[#143643] mb-1">Coming soon</p>
          <p>MFA recovery codes view, session revocation, theme + notification preferences. For now: change password here, sign out via the menu in the top right.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function FieldRow({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-[#5a6a72] min-w-32">{label}</span>
      <span className={"text-[#11242e] break-all " + (mono ? "font-mono" : "")}>{value || "—"}</span>
    </div>
  );
}
