import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { listPostsAction } from "../actions";
import { CalendarGrid } from "./calendar-grid";

export const dynamic = "force-dynamic";

export default async function BlogCalendarPage() {
  const result = await listPostsAction();

  if (!result.ok) {
    return (
      <div className="max-w-6xl space-y-4">
        <PageHeader eyebrow="Blog" title="Content calendar" />
        <p className="text-[#b3412e]">Failed to load posts: {result.error}</p>
      </div>
    );
  }

  // Pass the minimum fields the client needs — keeps the bundle small.
  const events = result.data
    .filter((p) => p.publish_date)
    .map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      status: p.status,
      publish_date: p.publish_date as string,
      category_id: p.category_id,
    }));

  return (
    <div className="max-w-6xl space-y-6">
      <PageHeader
        eyebrow={<Link href="/admin/blog" className="hover:text-[#287271]">← Blog</Link>}
        title="Content calendar"
        subtitle={
          <>
            {events.length} post{events.length === 1 ? "" : "s"} with a publish date. Drafts without a date don&apos;t appear — set one in the editor to surface here.
          </>
        }
        actions={
          <div className="flex gap-2">
            <Link href="/admin/blog">
              <Button variant="outline">List view</Button>
            </Link>
            <Link href="/admin/blog/new">
              <Button>+ New post</Button>
            </Link>
          </div>
        }
      />

      <CalendarGrid events={events} />
    </div>
  );
}
