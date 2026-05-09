"use client";

import { useFormStatus } from "react-dom";

export function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="text-sm text-slate-600 hover:text-slate-900 underline disabled:no-underline disabled:text-slate-400 disabled:cursor-wait"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
