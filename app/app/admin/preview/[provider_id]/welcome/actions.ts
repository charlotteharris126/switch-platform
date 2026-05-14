"use server";

// Preview-only no-op for the WelcomeDeck final-slide CTA. Admin
// impersonation must NEVER flip the impersonated provider's
// welcome_completed_at column, so this just redirects the operator
// back to the admin record for that provider.
//
// providerId is bound at render time in page.tsx via .bind().

import { redirect } from "next/navigation";

export async function previewWelcomeComplete(providerId: string): Promise<void> {
  redirect(`/providers/${encodeURIComponent(providerId)}`);
}
