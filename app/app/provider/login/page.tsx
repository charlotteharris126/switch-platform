// /provider/login — passkey sign-in entry point.

import { LoginForm } from "./login-form";

export default function ProviderLoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-slate-200 p-8">
        <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">SwitchLeads</p>
        <h1 className="text-2xl font-semibold text-slate-900 mt-2">Sign in</h1>
        <p className="text-slate-600 mt-3 text-sm">
          Enter your email and your browser will sign you in with your passkey.
        </p>
        <LoginForm />
      </div>
    </div>
  );
}
