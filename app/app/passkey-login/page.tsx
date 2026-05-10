// /provider/login — passkey sign-in entry point.

import { LoginForm } from "./login-form";

export default function ProviderLoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4 py-10">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-slate-200 p-8">
        <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">SwitchLeads</p>
        <h1 className="text-2xl font-semibold text-slate-900 mt-2">Sign in</h1>
        <p className="text-slate-600 mt-3 text-sm">
          Enter your email and your browser will sign you in with your passkey.
        </p>
        <LoginForm />
        <div className="mt-6 pt-4 border-t border-slate-100 text-xs text-slate-500 space-y-2">
          <p>
            New here?{" "}
            <a
              href="/help/getting-started"
              className="font-semibold text-slate-700 underline-offset-2 hover:underline"
            >
              Read the first-time-access guide
            </a>
            . You should have an invite email with a setup link; sign-in only
            works after you&apos;ve registered a passkey on this device.
          </p>
          <p>
            Lost your device or can&apos;t sign in? Email{" "}
            <a
              href="mailto:support@switchleads.co.uk"
              className="font-semibold text-slate-700 underline-offset-2 hover:underline"
            >
              support@switchleads.co.uk
            </a>{" "}
            and we&apos;ll send a fresh invite link.
          </p>
        </div>
      </div>
    </div>
  );
}
