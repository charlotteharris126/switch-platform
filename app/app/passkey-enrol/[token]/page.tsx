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
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4 py-10">
      <div className="max-w-md w-full bg-white rounded-xl shadow-sm border border-slate-200 p-8">
        <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">SwitchLeads</p>
        <h1 className="text-2xl font-semibold text-slate-900 mt-2">Set up your portal access</h1>
        <p className="text-slate-600 mt-3 text-sm">
          Click the button below. Your browser or phone will pop up asking you
          to save a passkey. Confirm with whatever you usually use to unlock
          this device (Face ID, fingerprint, Windows Hello, your account
          password, or a security key). From then on, that&apos;s your sign-in.
          No passwords, no codes.
        </p>
        <p className="text-slate-500 mt-3 text-xs">
          First time?{" "}
          <a
            href="/help/getting-started"
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-slate-700 underline-offset-2 hover:underline"
          >
            Read the 4-minute walkthrough
          </a>
          {" "}before you click, or jump straight in below.
        </p>
        <EnrolForm token={token} />
        <div className="mt-6 pt-4 border-t border-slate-100 text-xs text-slate-500">
          <p className="font-semibold text-slate-700 mb-1">Want us on the call?</p>
          <p>
            Email{" "}
            <a
              href="mailto:support@switchleads.co.uk"
              className="font-semibold text-slate-700 underline-offset-2 hover:underline"
            >
              support@switchleads.co.uk
            </a>{" "}
            and we&apos;ll walk you through this on a 5-minute screen-share.
            Pilot-provider standard, no charge.
          </p>
        </div>
      </div>
    </div>
  );
}
