import { PageHeaderSkeleton, Skeleton } from "@/components/loading-skeleton";

export default function HomeLoading() {
  return (
    <div className="max-w-6xl">
      <PageHeaderSkeleton />
      <div className="flex gap-2 mb-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-32 rounded-full" />
        ))}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="bg-white border border-[#dad4cb] rounded-xl p-5">
            <Skeleton className="h-2.5 w-24 mb-3" />
            <Skeleton className="h-9 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
