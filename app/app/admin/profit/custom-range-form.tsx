"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";

interface Props {
  currentFrom: string;
  currentTo: string;
  bucket: "week" | "month";
}

// Client-side custom-range form. Pushes to /profit?period=custom&... via
// router.push so we don't rely on a plain GET form (which had stale-DOM
// issues — defaultValue on uncontrolled inputs didn't always pick up the
// new URL on subsequent submits, so figures appeared not to change).
export function CustomRangeForm({ currentFrom, currentTo, bucket }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [from, setFrom] = useState(currentFrom);
  const [to, setTo] = useState(currentTo);

  function apply(e: React.FormEvent) {
    e.preventDefault();
    if (!from || !to) return;
    const usp = new URLSearchParams();
    usp.set("period", "custom");
    if (bucket !== "week") usp.set("bucket", bucket);
    usp.set("from", from);
    usp.set("to", to);
    startTransition(() => {
      router.push(`/profit?${usp.toString()}`);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <form onSubmit={apply} className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-[10px] uppercase tracking-wide text-[#5a6a72] font-bold">From</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              required
              className="block mt-1 px-3 py-1.5 border border-[#dad4cb] rounded text-sm"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wide text-[#5a6a72] font-bold">To</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
              className="block mt-1 px-3 py-1.5 border border-[#dad4cb] rounded text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={pending}
            className="bg-[#143643] text-white px-4 py-1.5 rounded text-sm font-semibold hover:bg-[#11242e] disabled:opacity-40"
          >
            {pending ? "Loading..." : "Apply"}
          </button>
        </form>
      </CardContent>
    </Card>
  );
}
