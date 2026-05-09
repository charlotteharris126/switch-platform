"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { startAuthentication } from "@simplewebauthn/browser";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setStatus("running");
    setError(null);
    try {
      const optionsRes = await fetch("/api/passkey/login-options", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const optionsBody = await optionsRes.json();
      if (!optionsRes.ok || !optionsBody.ok) {
        throw new Error(optionsBody.error ?? "Failed to start sign in");
      }

      const assResp = await startAuthentication({ optionsJSON: optionsBody.options });

      const verifyRes = await fetch("/api/passkey/login-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: assResp }),
      });
      const verifyBody = await verifyRes.json();
      if (!verifyRes.ok || !verifyBody.ok) {
        throw new Error(verifyBody.error ?? "Sign in failed");
      }

      router.push(verifyBody.redirect ?? "/");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(humaniseError(msg));
      setStatus("error");
    }
  }

  return (
    <form onSubmit={handleLogin} className="mt-6 space-y-3">
      <input
        type="email"
        required
        autoFocus
        autoComplete="email webauthn"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent"
      />
      <button
        type="submit"
        disabled={status === "running" || !email}
        className="w-full bg-slate-900 text-white py-3 rounded-lg font-semibold text-sm disabled:opacity-60 disabled:cursor-not-allowed hover:bg-slate-800"
      >
        {status === "running" ? "Signing in..." : "Sign in with passkey"}
      </button>
      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{error}</div>
      )}
    </form>
  );
}

function humaniseError(code: string): string {
  if (code.startsWith("NotAllowedError")) return "You cancelled the passkey prompt. Try again when ready.";
  switch (code) {
    case "passkey_not_found":
      return "No passkey found for that email. If this is your first time, look for the invite email from SwitchLeads.";
    case "challenge_missing_or_expired":
      return "Your browser session timed out. Try again.";
    case "auth_not_verified":
    case "auth_verification_failed":
      return "Your passkey didn't verify. Try again, or use a different device.";
    default:
      return `Something went wrong (${code}). Try again, or contact SwitchLeads if it keeps happening.`;
  }
}
