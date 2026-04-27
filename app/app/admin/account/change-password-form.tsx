"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { changePassword } from "./actions";

export function ChangePasswordForm() {
  const [pending, startTransition] = useTransition();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  function handleSubmit() {
    if (!newPassword || !confirmPassword) {
      toast.warning("Fill both fields.");
      return;
    }
    startTransition(async () => {
      const result = await changePassword({ newPassword, confirmPassword });
      if (result.ok) {
        toast.success("Password updated.");
        setNewPassword("");
        setConfirmPassword("");
      } else {
        toast.error("Update failed", { description: result.error });
      }
    });
  }

  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-5 shadow-[0_1px_2px_rgba(17,36,46,0.04)] max-w-md">
      <h3 className="text-sm font-extrabold text-[#11242e] mb-1">Change password</h3>
      <p className="text-xs text-[#5a6a72] mb-4">Min 12 characters. Sign-out happens automatically on next session if needed.</p>

      <label className="flex flex-col gap-1 mb-3">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">New password</span>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          disabled={pending}
          autoComplete="new-password"
          minLength={12}
          className="text-sm border border-[#dad4cb] rounded-lg bg-white px-3 py-2 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]"
        />
      </label>

      <label className="flex flex-col gap-1 mb-4">
        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#5a6a72]">Confirm password</span>
        <input
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          disabled={pending}
          autoComplete="new-password"
          minLength={12}
          className="text-sm border border-[#dad4cb] rounded-lg bg-white px-3 py-2 text-[#11242e] focus:outline-none focus:ring-2 focus:ring-[#cd8b76]/40 focus:border-[#cd8b76]"
        />
      </label>

      <button
        type="button"
        onClick={handleSubmit}
        disabled={pending || !newPassword || !confirmPassword}
        className="h-9 px-5 text-[11px] font-bold uppercase tracking-[0.08em] rounded-full bg-[#143643] text-white hover:bg-[#11242e] active:scale-[0.97] transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_2px_6px_rgba(17,36,46,0.15)]"
      >
        {pending ? "Updating..." : "Update password"}
      </button>
    </div>
  );
}
