"use client";

// Live-ticking duration display.
//
// `since` is an ISO timestamp; the component renders a human-friendly
// duration ("3d 4h", "12m", "just now") and updates on a coarse interval
// to keep CPU load trivial. Granularity adapts to the size of the
// duration: under an hour ticks every second, under a day every minute,
// otherwise every 10 minutes.
//
// Used on /provider/leads (in-queue per row) and /provider/leads/[id]
// (in-queue + at-status).

import { useEffect, useState } from "react";

interface Props {
  since: string | null;
  variant?: "compact" | "full";
}

export function DurationTimer({ since, variant = "compact" }: Props) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!since) return;
    const startMs = new Date(since).getTime();
    function tick() {
      setNow(Date.now());
    }
    // First update immediately so SSR-rendered text is fresh client-side.
    tick();
    const elapsed = Date.now() - startMs;
    const intervalMs =
      elapsed < 60 * 60 * 1000 ? 1000 : elapsed < 24 * 60 * 60 * 1000 ? 60 * 1000 : 10 * 60 * 1000;
    const id = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(id);
  }, [since]);

  if (!since) return <span className="text-slate-400">—</span>;

  const ms = Math.max(0, now - new Date(since).getTime());
  return <>{format(ms, variant)}</>;
}

function format(ms: number, variant: "compact" | "full"): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return variant === "full" ? "just now" : "now";

  const min = Math.floor(sec / 60);
  if (min < 60) return variant === "full" ? `${min} minute${min === 1 ? "" : "s"}` : `${min}m`;

  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) {
    if (variant === "full") {
      const hStr = `${hr} hour${hr === 1 ? "" : "s"}`;
      const mStr = remMin > 0 ? ` ${remMin}m` : "";
      return hStr + mStr;
    }
    return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  }

  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  if (variant === "full") {
    const dStr = `${day} day${day === 1 ? "" : "s"}`;
    const hStr = remHr > 0 ? ` ${remHr}h` : "";
    return dStr + hStr;
  }
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`;
}
