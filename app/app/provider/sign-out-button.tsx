"use client";

import { useFormStatus } from "react-dom";

export function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="text-sm text-slate-300 hover:text-white px-3 py-1.5 rounded-md hover:bg-slate-800 transition-colors cursor-pointer disabled:cursor-wait disabled:text-slate-500"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
