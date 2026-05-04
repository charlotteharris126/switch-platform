// Shared owner-notification helpers. Single source of truth for the
// "where do owner-facing emails go" + "what's the dashboard URL" questions.
//
// Before this module: each Edge Function repeated the
// `OWNER_NOTIFICATION_EMAIL ?? BREVO_SENDER_EMAIL` fallback inline
// (10+ duplications across 5 functions), and the admin dashboard URL
// was hardcoded as `https://admin.switchleads.co.uk` in 3+ places. If
// the canonical email or dashboard host changes, every function had to
// be hunted down and edited. Centralised here.
//
// Env vars (set on the function deploy environment):
//   OWNER_NOTIFICATION_EMAIL   Where owner-facing notifications go.
//                              Falls back to BREVO_SENDER_EMAIL if unset.
//   BREVO_SENDER_EMAIL         Verified sender used by all Brevo sends.
//                              Used as the fallback owner email.
//   ADMIN_DASHBOARD_URL        Base URL of the admin dashboard. Defaults
//                              to https://admin.switchleads.co.uk for
//                              prod parity if unset; staging deploys
//                              should set this explicitly.

const ADMIN_DASHBOARD_URL_DEFAULT = "https://admin.switchleads.co.uk";

// Returns the owner notification email, or null if neither env var is set.
// Callers should null-check and `console.error` + skip the send if missing
// (rather than crashing the function for a misconfigured email channel).
export function getOwnerEmail(): string | null {
  return (
    Deno.env.get("OWNER_NOTIFICATION_EMAIL") ??
    Deno.env.get("BREVO_SENDER_EMAIL") ??
    null
  );
}

// Returns the admin dashboard base URL with no trailing slash. Callers
// concatenate route paths (`/leads/123`) onto the result.
export function getAdminDashboardUrl(): string {
  const raw = Deno.env.get("ADMIN_DASHBOARD_URL") ?? ADMIN_DASHBOARD_URL_DEFAULT;
  return raw.replace(/\/$/, "");
}

// Convenience builder for `${dashboard}/leads/${submissionId}` links sent
// in owner notification emails. Matches the existing /leads/[id] route.
export function adminLeadUrl(submissionId: number): string {
  return `${getAdminDashboardUrl()}/leads/${submissionId}`;
}
