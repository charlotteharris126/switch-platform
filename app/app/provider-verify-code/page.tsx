// /provider-verify-code?email=<email>&next=<path>
//
// Step 2 of provider sign-in. User enters the 6-digit code emailed by
// the OTP step. Verification mints the session and redirects to /provider
// (or the original `next` path).

import { redirect } from "next/navigation";
import { VerifyForm } from "./verify-form";

interface Props {
  searchParams: Promise<{ email?: string; next?: string }>;
}

export default async function VerifyCodePage({ searchParams }: Props) {
  const { email, next } = await searchParams;
  if (!email) {
    redirect("/provider-login");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4 py-10">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-slate-200 p-8">
        <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">SwitchLeads</p>
        <h1 className="text-2xl font-semibold text-slate-900 mt-2">Enter your code</h1>
        <p className="text-slate-600 mt-3 text-sm">
          We&apos;ve emailed a 6-digit code to{" "}
          <strong className="text-slate-900">{email}</strong>. It expires in a few
          minutes.
        </p>
        <VerifyForm email={email} next={next ?? null} />
        <div className="mt-6 pt-4 border-t border-slate-100 text-xs text-slate-500">
          <p>
            Didn&apos;t get the email? Check spam, then{" "}
            <a
              href="/provider-login"
              className="font-semibold text-slate-700 underline-offset-2 hover:underline"
            >
              start again
            </a>{" "}
            and we&apos;ll send a fresh code.
          </p>
        </div>
      </div>
    </div>
  );
}
