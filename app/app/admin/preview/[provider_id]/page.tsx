// /admin/preview/[provider_id] — bare URL redirects to the leads view,
// which is the default entry point operators want when previewing a
// provider's portal experience.

import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ provider_id: string }>;
}

export default async function PreviewIndexPage({ params }: Props) {
  const { provider_id: rawId } = await params;
  // User-facing URL (no /admin prefix); the proxy in proxy.ts rewrites
  // this back into /admin/preview/... for Next.js routing.
  redirect(`/preview/${encodeURIComponent(rawId)}/leads`);
}
