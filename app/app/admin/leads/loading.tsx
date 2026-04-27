import { PageHeaderSkeleton, Skeleton, TableRowSkeleton } from "@/components/loading-skeleton";

export default function LeadsLoading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <div className="bg-white border border-[#dad4cb] rounded-xl p-4 mb-6 flex flex-wrap gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-32" />
        ))}
      </div>
      <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden">
        <table className="w-full">
          <tbody>
            {Array.from({ length: 8 }).map((_, i) => (
              <TableRowSkeleton key={i} cells={9} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
