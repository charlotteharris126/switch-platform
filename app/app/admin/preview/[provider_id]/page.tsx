// /admin/preview/[provider_id] — bare URL redirects to the home view,
// which is the natural landing page (matches what a real provider sees
// when they log in).

import { redirect } from "next/navigation";
import { requireAdminUser } from "@/lib/auth/require-admin";

interface Props {
  params: Promise<{ provider_id: string }>;
}

export default async function PreviewIndexPage({ params }: Props) {
  await requireAdminUser();
  const { provider_id: rawId } = await params;
  // User-facing URL (no /admin prefix); the proxy in proxy.ts rewrites
  // this back into /admin/preview/... for Next.js routing.
  redirect(`/preview/${encodeURIComponent(rawId)}/home`);
}
