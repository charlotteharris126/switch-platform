// Lightweight skeleton primitives. Used by route loading.tsx files to avoid
// blank-flash during navigation. Animation is a subtle pulse — distinct from
// "saving" feedback (which uses toast) and from "form pending" (which uses
// the button label). Keep it visually quieter than real content.

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = "" }: SkeletonProps) {
  return <div className={`animate-pulse bg-[#e8e3da] rounded ${className}`} />;
}

export function PageHeaderSkeleton() {
  return (
    <div className="mb-6">
      <Skeleton className="h-3 w-16 mb-3" />
      <Skeleton className="h-8 w-72 mb-2" />
      <Skeleton className="h-4 w-96" />
    </div>
  );
}

export function TableRowSkeleton({ cells = 6 }: { cells?: number }) {
  return (
    <tr className="border-t border-[#dad4cb]">
      {Array.from({ length: cells }).map((_, i) => (
        <td key={i} className="p-3">
          <Skeleton className="h-4 w-full max-w-[140px]" />
        </td>
      ))}
    </tr>
  );
}

export function CardSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="bg-white border border-[#dad4cb] rounded-xl p-5 shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
      <Skeleton className="h-4 w-32 mb-4" />
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex justify-between">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}
