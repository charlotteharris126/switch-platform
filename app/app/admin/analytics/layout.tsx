import { Suspense } from "react";
import { AnalyticsNav } from "./_components/analytics-nav";

export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <Suspense fallback={null}>
        <AnalyticsNav />
      </Suspense>
      {children}
    </div>
  );
}
