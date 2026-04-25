import { CardSkeleton, PageHeaderSkeleton } from "@/components/loading-skeleton";

export default function ActionsLoading() {
  return (
    <div className="max-w-6xl space-y-6">
      <PageHeaderSkeleton />
      <CardSkeleton rows={3} />
      <CardSkeleton rows={3} />
      <CardSkeleton rows={3} />
    </div>
  );
}
