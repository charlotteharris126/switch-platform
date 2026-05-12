// SLA version pinned here (not in actions.ts) because Server Action files
// can only export async functions. Bumped when SLA copy changes
// materially — providers who last accepted an earlier version then get
// redirected to /provider/sla-agreement to re-confirm.
//
// Format: "v<major>-<YYYY-MM-DD>". Compare as a string — non-equal means
// re-acceptance required.

export const SLA_VERSION = "v1-2026-05-12";
