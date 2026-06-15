// SINGLE SOURCE OF TRUTH for which leads a provider may see in the portal.
//
// Both the real provider portal (app/provider/*) and the admin preview
// (app/admin/preview/*) apply this, so the preview is an IDENTICAL match to the
// real thing by construction and cannot drift. Before this existed the
// predicate was hand-written in six files; widening it for private-pay leads
// (0210) was applied to the RLS policy + some copies but not others, so a
// private-pay lead showed in the real portal but not the preview.
//
// This mirrors — and is belt-and-braces with — the RLS policy
// provider_read_submissions (migration 0143, widened 0210). The real portal is
// additionally protected by RLS; the preview runs as admin (bypasses RLS) and
// relies solely on this. Keep the two definitions in lockstep: any change here
// must also change the RLS policy migration, and vice versa.
//
// Visible to a provider = routed to that provider, not archived, top-level (not
// a re-application child), and either a qualified lead OR a private-pay lead
// (is_dq=true but pay_route='private' — a paying enrolment routed to them).

// The single private-pay carve-out, also reused anywhere the raw filter string
// is needed (e.g. an `.or()` already in a chain).
export const PROVIDER_LEAD_VISIBILITY_OR = "is_dq.not.is.true,pay_route.eq.private";

// Generic over the caller's PostgREST builder type Q so the returned value keeps
// its exact type (callers chain .order/.limit/etc. with full typing). The
// internal cast is localized here; the supabase builder type is too deep to
// constrain structurally without TS2589.
export function applyProviderLeadVisibility<Q>(query: Q, providerId: string): Q {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return (query as any)
    .eq("primary_routed_to", providerId)
    .or(PROVIDER_LEAD_VISIBILITY_OR)
    .not("routed_at", "is", null)
    .is("archived_at", null)
    .is("parent_submission_id", null) as Q;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
