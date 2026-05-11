// Retired 2026-05-11. Invite flow moved to /provider-set-password/[token]
// (email + password instead of passkey). Any in-flight invite emails
// pointing at this path get redirected so the user lands on the new
// form with the same token.

import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ token: string }>;
}

export default async function RetiredPasskeyEnrolPage({ params }: Props) {
  const { token } = await params;
  redirect(`/provider-set-password/${encodeURIComponent(token)}`);
}
