"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";

interface Props {
  token: string;
}

export function EnrolForm({ token }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "running" | "error" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleEnrol() {
    setStatus("running");
    setError(null);
    try {
      // 1. Get registration options from server
      const optionsRes = await fetch("/api/passkey/register-options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const optionsBody = await optionsRes.json();
      if (!optionsRes.ok || !optionsBody.ok) {
        throw new Error(optionsBody.error ?? "Failed to start enrolment");
      }

      // 2. Run the WebAuthn registration ceremony in the browser
      const attResp = await startRegistration({ optionsJSON: optionsBody.options });

      // 3. Send the result to the server for verification + session minting
      const verifyRes = await fetch("/api/passkey/register-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, response: attResp }),
      });
      const verifyBody = await verifyRes.json();
      if (!verifyRes.ok || !verifyBody.ok) {
        throw new Error(verifyBody.error ?? "Verification failed");
      }

      setStatus("done");
      router.push(verifyBody.redirect ?? "/provider");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(humaniseError(msg));
      setStatus("error");
    }
  }

  return (
    <div className="mt-6 space-y-3">
      <button
        type="button"
        onClick={handleEnrol}
        disabled={status === "running" || status === "done"}
        className="w-full bg-slate-900 text-white py-3 rounded-lg font-semibold text-sm disabled:opacity-60 disabled:cursor-not-allowed hover:bg-slate-800"
      >
        {status === "running" ? "Setting up..." : status === "done" ? "Done" : "Set up your passkey"}
      </button>
      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
          {error}
        </div>
      )}
      {status === "idle" && (
        <p className="text-xs text-slate-500 text-center">
          Doesn&apos;t work? The link expires 15 minutes after it was sent. Ask the SwitchLeads team for a fresh one.
        </p>
      )}
    </div>
  );
}

function humaniseError(code: string): string {
  switch (code) {
    case "token_expired":
    case "invite_expired":
      return "This invite link has expired. Ask the SwitchLeads team for a fresh one.";
    case "token_bad_signature":
    case "token_malformed":
      return "This invite link looks invalid. If you copied and pasted it, try clicking the link in the email instead.";
    case "invite_already_used":
      return "This invite link has already been used. If that wasn't you, contact SwitchLeads — your account may need attention.";
    case "user_revoked":
    case "user_suspended":
      return "Your account isn't currently active. Contact SwitchLeads.";
    case "challenge_missing_or_expired":
      return "Your browser session timed out. Try clicking the invite link again.";
    case "registration_verification_failed":
    case "registration_not_verified":
      return "Your browser didn't complete the passkey setup. Try again, or use a different device.";
    default:
      return code.startsWith("NotAllowedError")
        ? "You cancelled the passkey setup. Try the button again when ready."
        : `Something went wrong (${code}). Try again, or contact SwitchLeads if it keeps happening.`;
  }
}
