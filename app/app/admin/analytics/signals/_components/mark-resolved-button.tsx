"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { markFlagResolved, markAllFlagsResolved } from "./actions";

export function MarkResolvedButton({ flagId, size = "sm" }: { flagId: number; size?: "sm" | "default" }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="inline-flex flex-col items-end gap-1">
      <Button
        type="button"
        size={size}
        variant="outline"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await markFlagResolved({ flagId });
            if (!result.ok) setError(result.error ?? "Failed");
          });
        }}
        className="border-[#dad4cb] hover:bg-[#f4f1ed] text-[11px]"
      >
        {pending ? "Resolving..." : "Mark resolved"}
      </Button>
      {error ? <p className="text-[10px] text-[#b3412e]">{error}</p> : null}
    </div>
  );
}

export function ResolveAllButton({ count }: { count: number }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (count === 0) return null;

  if (!confirming) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setConfirming(true)}
        className="text-[11px] text-[#5a6a72] hover:text-[#11242e]"
      >
        Resolve all ({count})
      </Button>
    );
  }

  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-[11px] text-[#5a6a72]">Resolve all {count}?</span>
      <Button
        type="button"
        size="sm"
        disabled={pending}
        className="bg-[#287271] hover:bg-[#206462] text-white text-[11px]"
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await markAllFlagsResolved();
            if (!result.ok) {
              setError(result.error ?? "Failed");
              setConfirming(false);
            }
          });
        }}
      >
        {pending ? "Resolving..." : "Yes"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          setConfirming(false);
          setError(null);
        }}
        className="text-[11px]"
      >
        Cancel
      </Button>
      {error ? <p className="text-[10px] text-[#b3412e]">{error}</p> : null}
    </div>
  );
}
