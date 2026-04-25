import { CardSkeleton, Skeleton } from "@/components/loading-skeleton";

export default function LeadDetailLoading() {
  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <Skeleton className="h-3 w-24 mb-3" />
        <Skeleton className="h-8 w-80 mb-2" />
        <Skeleton className="h-5 w-48" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <CardSkeleton rows={6} />
        <CardSkeleton rows={6} />
        <CardSkeleton rows={6} />
      </div>
      <CardSkeleton rows={3} />
    </div>
  );
}
