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
  // When true, always ticks once per second and renders seconds in the
  // output (e.g. "3d 5h 12m 04s") so the provider sees the timer
  // visibly moving. Used on the home "Needs your attention" cards.
  // Default false: ticks adapt to elapsed time and seconds aren't shown
  // (used in lead-row in-queue durations where seconds would be noise).
  withSeconds?: boolean;
}

export function DurationTimer({ since, variant = "compact", withSeconds = false }: Props) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!since) return;
    const startMs = new Date(since).getTime();
    function tick() {
      setNow(Date.now());
    }
    // First update immediately so SSR-rendered text is fresh client-side.
    tick();
    let intervalMs: number;
    if (withSeconds) {
      // 1 Hz always — every card on the home page shows seconds ticking.
      intervalMs = 1000;
    } else {
      const elapsed = Date.now() - startMs;
      intervalMs =
        elapsed < 60 * 60 * 1000 ? 1000 : elapsed < 24 * 60 * 60 * 1000 ? 60 * 1000 : 10 * 60 * 1000;
    }
    const id = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(id);
  }, [since, withSeconds]);

  if (!since) return <span className="text-slate-400">-</span>;

  const ms = Math.max(0, now - new Date(since).getTime());
  return <>{format(ms, variant, withSeconds)}</>;
}

function format(ms: number, variant: "compact" | "full", withSeconds: boolean): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) {
    if (withSeconds) return `${sec}s`;
    return variant === "full" ? "just now" : "now";
  }

  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) {
    if (withSeconds) return `${min}m ${pad(remSec)}s`;
    return variant === "full" ? `${min} minute${min === 1 ? "" : "s"}` : `${min}m`;
  }

  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) {
    if (withSeconds) return `${hr}h ${pad(remMin)}m ${pad(remSec)}s`;
    if (variant === "full") {
      const hStr = `${hr} hour${hr === 1 ? "" : "s"}`;
      const mStr = remMin > 0 ? ` ${remMin}m` : "";
      return hStr + mStr;
    }
    return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  }

  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  if (withSeconds) return `${day}d ${pad(remHr)}h ${pad(remMin)}m ${pad(remSec)}s`;
  if (variant === "full") {
    const dStr = `${day} day${day === 1 ? "" : "s"}`;
    const hStr = remHr > 0 ? ` ${remHr}h` : "";
    return dStr + hStr;
  }
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
