// /admin/blog/featured — manage the up-to-3 featured slots on The Switch
// homepage. Slot 1 = lead hero card; slots 2 + 3 = secondary cards.
// Read the current slots + the available published posts on the server,
// pass to the client picker for interactive slot management.

import { PageHeader } from "@/components/page-header";
import Link from "next/link";
import { listFeaturedSlotsAction, listPublishedPostsForFeaturedAction } from "../actions";
import { FeaturedSlotsPicker } from "./picker";

export const dynamic = "force-dynamic";

export default async function FeaturedPage() {
  const [slotsResult, postsResult] = await Promise.all([
    listFeaturedSlotsAction(),
    listPublishedPostsForFeaturedAction(),
  ]);

  if (!slotsResult.ok) {
    return (
      <div className="max-w-4xl space-y-4">
        <PageHeader eyebrow="The Switch" title="Featured posts" />
        <p className="text-[#b3412e]">Could not load featured slots: {slotsResult.error}</p>
      </div>
    );
  }
  if (!postsResult.ok) {
    return (
      <div className="max-w-4xl space-y-4">
        <PageHeader eyebrow="The Switch" title="Featured posts" />
        <p className="text-[#b3412e]">Could not load published posts: {postsResult.error}</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6 py-6">
      <PageHeader
        eyebrow={<Link href="/admin/blog" className="text-[#287271] underline">← Blog</Link>}
        title="Featured posts"
        subtitle="Up to 3 ranked slots on The Switch homepage. Slot 1 = lead hero card, slots 2 + 3 = secondary cards beneath. Changing a slot fires a Netlify rebuild so the live page updates within ~2 min."
      />

      <FeaturedSlotsPicker
        initialSlots={slotsResult.data.slots}
        availablePosts={postsResult.data}
      />
    </div>
  );
}
