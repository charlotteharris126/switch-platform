// Server-side admin guard for pages on the admin surface that bypass RLS
// (i.e. anything that uses `createAdminClient`). Use this at the top of
// every such page as defence-in-depth in case the host-based gate in
// proxy.ts ever stops being load-bearing on its own.
//
// Uses `auth.getUser()` (re-verifies the JWT with the auth server),
// not `auth.getSession()` (cookie-only).

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "./allowlist";

export async function requireAdminUser(): Promise<{ id: string; email: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  const user = data?.user;
  if (error || !user || !user.email) {
    redirect("/login?next=/providers");
  }
  if (!isAdmin(user.email)) {
    redirect("/login?error=not_authorised");
  }
  return { id: user.id, email: user.email };
}
