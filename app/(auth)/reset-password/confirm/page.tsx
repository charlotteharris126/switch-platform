import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/server";
import { confirmResetAction } from "../actions";

const ERROR_MESSAGES: Record<string, string> = {
  password_too_short: "Password must be at least 12 characters.",
  passwords_do_not_match: "Passwords don't match.",
};

export default async function ConfirmResetPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const errorMessage = error ? (ERROR_MESSAGES[error] ?? error) : null;

  // User must be authenticated via the reset link's session.
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    redirect("/reset-password?error=link_expired");
  }

  return (
    <AuthCard title="Set a new password" description="Minimum 12 characters.">
      <form action={confirmResetAction} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm</Label>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </div>

        {errorMessage ? (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">
            {errorMessage}
          </p>
        ) : null}

        <Button type="submit" className="w-full">
          Save new password
        </Button>
      </form>
    </AuthCard>
  );
}
