"use client";

// Checkbox-gated accept button for the SLA agreement page. The provider
// admin has to tick the confirmation before the submit button enables,
// matching the standard legal-style acceptance pattern. Wraps the
// acceptSlaAction server action.

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { acceptSlaAction } from "./actions";

export function AcceptForm() {
  const [agreed, setAgreed] = useState(false);
  return (
    <form action={acceptSlaAction} className="space-y-4">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-slate-900 cursor-pointer"
        />
        <span className="text-sm text-slate-800">
          I&apos;ve read the working agreement above and I&apos;m happy to confirm
          it on behalf of my company. (Logged with timestamp and my
          account so we&apos;ve both got a record.)
        </span>
      </label>
      <SubmitButton disabled={!agreed} />
    </form>
  );
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="w-full md:w-auto px-6 py-3 text-sm font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-slate-900"
    >
      {pending ? "Saving…" : "Got it, take me to the portal"}
    </button>
  );
}
