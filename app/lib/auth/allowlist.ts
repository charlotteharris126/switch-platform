/**
 * Admin email allowlist. Internal users only — every email here gets the admin
 * role on `admin.switchleads.co.uk`. Anyone not on this list is rejected at
 * middleware level even if they have a valid Supabase Auth account.
 *
 * Source: ADMIN_ALLOWLIST env var (comma-separated). Set in Netlify env vars.
 * Falls back to empty list (locks everyone out) if env var missing — fail closed.
 */
export function getAdminAllowlist(): string[] {
  const raw = process.env.ADMIN_ALLOWLIST ?? "";
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdmin(email: string | undefined | null): boolean {
  if (!email) return false;
  return getAdminAllowlist().includes(email.toLowerCase());
}
