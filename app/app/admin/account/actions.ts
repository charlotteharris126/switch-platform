"use server";

import { createClient } from "@/lib/supabase/server";

export interface ChangePasswordInput {
  newPassword: string;
  confirmPassword: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

const MIN_PASSWORD_LENGTH = 12;

export async function changePassword(input: ChangePasswordInput): Promise<ActionResult> {
  if (!input.newPassword || input.newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (input.newPassword !== input.confirmPassword) {
    return { ok: false, error: "Passwords don't match." };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: input.newPassword });
  if (error) return { ok: false, error: error.message };

  return { ok: true };
}
