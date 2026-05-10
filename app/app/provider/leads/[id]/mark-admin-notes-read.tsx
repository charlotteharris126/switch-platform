"use client";

// Fires the markAdminNotesReadAction once on mount when the page renders
// with at least one unread admin note. Renders nothing visible. Lives as a
// client component because it has to fire an effect; Next.js Server
// Components can't run useEffect.

import { useEffect } from "react";

interface Props {
  submissionId: number;
  onMark: (args: { submissionId: number }) => Promise<{ ok: boolean; error?: string }>;
}

export function MarkAdminNotesRead({ submissionId, onMark }: Props) {
  useEffect(() => {
    let cancelled = false;
    void onMark({ submissionId }).catch(() => {
      // best-effort; the unread state just stays until the next visit
    });
    return () => {
      cancelled = true;
      void cancelled; // satisfy unused-var rule on rare React strict-mode double-mount
    };
  }, [submissionId, onMark]);
  return null;
}
