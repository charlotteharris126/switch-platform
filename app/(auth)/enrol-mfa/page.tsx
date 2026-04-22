import { redirect } from "next/navigation";
import Image from "next/image";
import { AuthCard } from "@/components/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { createClient } from "@/lib/supabase/server";
import { startEnrolmentAction, verifyEnrolmentAction } from "./actions";
import { signOutAction } from "../verify-mfa/actions";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_code: "Code didn't match. Codes refresh every 30 seconds.",
  enrolment_failed: "Enrolment failed. Try again or contact support.",
};

function describeError(error: string | undefined): string | null {
  if (!error) return null;
  return ERROR_MESSAGES[error] ?? error;
}

export default async function EnrolMfaPage({
  searchParams,
}: {
  searchParams: Promise<{ factor_id?: string; qr?: string; secret?: string; error?: string }>;
}) {
  const { factor_id, qr, secret, error } = await searchParams;
  const errorMessage = describeError(error);

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    redirect("/login");
  }

  // First visit (no factor_id): show "start" button which generates a factor.
  if (!factor_id || !qr || !secret) {
    return (
      <AuthCard
        title="Set up two-factor authentication"
        description="Required for every admin user. Takes about a minute."
      >
        <ol className="text-sm text-slate-600 space-y-2 mb-6 list-decimal list-inside">
          <li>Install an authenticator app (Google Authenticator, 1Password, Authy)</li>
          <li>Click below — we'll show a QR code</li>
          <li>Scan it with your app, then enter the 6-digit code it shows</li>
        </ol>

        {errorMessage ? (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3 mb-4">
            {errorMessage}
          </p>
        ) : null}

        <form action={startEnrolmentAction}>
          <Button type="submit" className="w-full">
            Start setup
          </Button>
        </form>

        <Separator className="my-6" />

        <form action={signOutAction}>
          <Button type="submit" variant="ghost" className="w-full text-slate-500">
            Sign out
          </Button>
        </form>
      </AuthCard>
    );
  }

  // Second visit: show QR + verification form.
  return (
    <AuthCard
      title="Scan and verify"
      description="Scan this code with your authenticator app, then enter the 6-digit code."
    >
      <div className="flex justify-center mb-4">
        <Image
          src={qr}
          alt="MFA QR code"
          width={200}
          height={200}
          className="border border-slate-200 rounded-md p-2 bg-white"
          unoptimized
        />
      </div>

      <details className="mb-4 text-xs text-slate-500">
        <summary className="cursor-pointer hover:text-slate-700">
          Can't scan? Show secret manually
        </summary>
        <p className="mt-2 font-mono break-all bg-slate-50 p-2 rounded border border-slate-200">
          {secret}
        </p>
      </details>

      <form action={verifyEnrolmentAction} className="space-y-4">
        <input type="hidden" name="factor_id" value={factor_id} />

        <div className="space-y-2">
          <Label htmlFor="code">6-digit code from your app</Label>
          <Input
            id="code"
            name="code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            autoComplete="one-time-code"
            maxLength={6}
            required
            autoFocus
            className="text-center text-2xl tracking-widest font-mono"
          />
        </div>

        {errorMessage ? (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">
            {errorMessage}
          </p>
        ) : null}

        <Button type="submit" className="w-full">
          Verify and finish setup
        </Button>
      </form>
    </AuthCard>
  );
}
