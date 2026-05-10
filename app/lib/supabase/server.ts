import { cache } from "react";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// React.cache memoises per-request (single render tree). Multiple callers
// in the same render — page + ProviderShell + Suspense children — share
// one client + one cookie read instead of doing the dance independently.
// Cuts auth-cookie parse cost on busy pages.
export const createClient = cache(async () => {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server Component invocations cannot set cookies — ignore.
            // Middleware refreshes the session, so this is safe.
          }
        },
      },
    }
  );
});
