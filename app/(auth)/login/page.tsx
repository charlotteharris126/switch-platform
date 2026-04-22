import Link from "next/link";
import { AuthCard } from "@/components/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loginAction } from "./actions";

const ERROR_MESSAGES: Record<string, string> = {
  missing_credentials: "Email and password are required.",
  not_authorised: "This email is not authorised to access the admin dashboard.",
  auth_callback_failed: "We couldn't complete the sign-in. Try again.",
  invalid_credentials: "Email or password is wrong.",
};

function describeError(error: string | undefined): string | null {
  if (!error) return null;
  return ERROR_MESSAGES[error] ?? error;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const errorMessage = describeError(error);

  return (
    <AuthCard title="Sign in" description="Use your admin email and password.">
      <form action={loginAction} className="space-y-4">
        <input type="hidden" name="next" value={next ?? "/"} />

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link href="/reset-password" className="text-xs text-slate-500 hover:underline">
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>

        {errorMessage ? (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-3">
            {errorMessage}
          </p>
        ) : null}

        <Button type="submit" className="w-full">
          Sign in
        </Button>
      </form>

      <p className="text-xs text-slate-500 text-center mt-6">
        Two-factor authentication required.
      </p>
    </AuthCard>
  );
}
