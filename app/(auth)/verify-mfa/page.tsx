import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/server";
import { verifyMfaAction, signOutAction } from "./actions";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_code: "That code didn't work. Try again — codes refresh every 30 seconds.",
};

function describeError(error: string | undefined): string | null {
  if (!error) return null;
  return ERROR_MESSAGES[error] ?? error;
}

export default async function VerifyMfaPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const errorMessage = describeError(error);

  // Confirm the user is signed in (AAL1) before showing this step.
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    redirect("/login");
  }

  return (
    <AuthCard
      title="Two-factor code"
      description="Open your authenticator app and enter the 6-digit code."
    >
      <form action={verifyMfaAction} className="space-y-4">
        <input type="hidden" name="next" value={next ?? "/"} />

        <div className="space-y-2">
          <Label htmlFor="code">Authenticator code</Label>
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
          Verify and continue
        </Button>
      </form>

      <form action={signOutAction} className="mt-4">
        <Button type="submit" variant="ghost" className="w-full text-slate-500">
          Cancel and sign out
        </Button>
      </form>
    </AuthCard>
  );
}
