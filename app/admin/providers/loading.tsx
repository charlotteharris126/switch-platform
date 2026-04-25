import { PageHeaderSkeleton, Skeleton, TableRowSkeleton } from "@/components/loading-skeleton";

export default function ProvidersLoading() {
  return (
    <div>
      <PageHeaderSkeleton />
      <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden">
        <table className="w-full">
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <TableRowSkeleton key={i} cells={8} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
