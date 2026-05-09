// /provider/enrol/[token]
//
// Provider clicks the invite link from their email, lands here. Server
// Component renders the shell; client component drives the WebAuthn
// registration ceremony via @simplewebauthn/browser.
//
// The token in the URL is opaque to this page — it's verified server-side
// at /api/passkey/register-options and /api/passkey/register-verify. We
// just hand it through.

import { EnrolForm } from "./enrol-form";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function EnrolPage({ params }: Props) {
  const { token } = await params;
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-slate-200 p-8">
        <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">SwitchLeads</p>
        <h1 className="text-2xl font-semibold text-slate-900 mt-2">Set up your portal access</h1>
        <p className="text-slate-600 mt-3 text-sm">
          Click the button below. Your browser will ask you to set up a passkey using Touch ID, Face ID,
          Windows Hello, or a security key. From now on that&apos;s how you&apos;ll log in &mdash; no passwords, no codes.
        </p>
        <EnrolForm token={token} />
      </div>
    </div>
  );
}
