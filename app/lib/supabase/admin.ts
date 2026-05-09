// Service-role Supabase client.
//
// ONLY use from server-side code that needs to bypass RLS. Never expose this
// client (or its key) to the browser. Used by the passkey API routes which
// run before a Supabase auth session exists (registration) or are minting
// a session as an outcome of a passkey ceremony.
//
// Existing pattern: regular Server Component reads via `lib/supabase/server`
// (anon key + cookies). Use createClient from this file only when:
//   - the request has no auth context yet (passkey registration before
//     auth.users is created)
//   - the operation must cross RLS boundaries (e.g. functions_writer-style
//     writes from a Next.js API route, or admin user-management calls)
//
// Required env: SUPABASE_SERVICE_ROLE_KEY (server-only, never NEXT_PUBLIC_*).

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL not set");
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");

  return createSupabaseClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
