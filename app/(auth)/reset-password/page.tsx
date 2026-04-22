import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestResetAction } from "./actions";

const ERROR_MESSAGES: Record<string, string> = {
  missing_email: "Enter the email address you log in with.",
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const { error, sent } = await searchParams;
  const errorMessage = error ? (ERROR_MESSAGES[error] ?? error) : null;

  if (sent === "true") {
    return (
      <AuthCard
        title="Check your email"
        description="If your email is registered, we've sent a password reset link."
      >
        <p className="text-sm text-slate-600 mb-6">
          The link works once and expires after an hour.
        </p>
        <Link href="/login">
          <Button variant="ghost" className="w-full">
            Back to sign in
          </Button>
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Reset password" description="We'll email you a reset link.">
      <form action={requestResetAction} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>

        {errorMessage ? (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">
            {errorMessage}
          </p>
        ) : null}

        <Button type="submit" className="w-full">
          Send reset link
        </Button>
      </form>

      <Link href="/login" className="block text-xs text-slate-500 text-center mt-6 hover:underline">
        Back to sign in
      </Link>
    </AuthCard>
  );
}
