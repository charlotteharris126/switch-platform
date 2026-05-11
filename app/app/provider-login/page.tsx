// /provider-login — provider portal sign-in.
//
// Email + password is step 1. On success, a 6-digit code is emailed and
// the user is redirected to /provider-verify-code to complete sign-in.
// A signed-in session isn't established until that second step completes.

import { LoginForm } from "./login-form";

interface Props {
  searchParams: Promise<{ next?: string; just_set?: string; error?: string }>;
}

export default async function ProviderLoginPage({ searchParams }: Props) {
  const { next, just_set, error } = await searchParams;

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4 py-10">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-slate-200 p-8">
        <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">SwitchLeads</p>
        <h1 className="text-2xl font-semibold text-slate-900 mt-2">Sign in</h1>
        {just_set === "1" && (
          <div className="mt-3 bg-emerald-50 border border-emerald-200 rounded-md p-3 text-sm text-emerald-900">
            Password set. Sign in below.
          </div>
        )}
        {error === "session_expired" && (
          <div className="mt-3 bg-slate-50 border border-slate-200 rounded-md p-3 text-sm text-slate-700">
            Your session ran out. Sign in to carry on.
          </div>
        )}
        <p className="text-slate-600 mt-3 text-sm">
          Enter your email and password. We&apos;ll send you a 6-digit code to
          confirm it&apos;s you on this device.
        </p>
        <LoginForm next={next ?? null} />
        <div className="mt-6 pt-4 border-t border-slate-100 text-xs text-slate-500">
          <p>
            Trouble?{" "}
            <a
              href="mailto:support@switchleads.co.uk"
              className="font-semibold text-slate-700 underline-offset-2 hover:underline"
            >
              support@switchleads.co.uk
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
