"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Subscribes to Supabase Realtime channels for the listed tables and triggers
// router.refresh() when an event fires. The trigger is debounced (~600ms) to
// coalesce bursts — e.g. a single routing action emits a routing_log INSERT
// and a submissions UPDATE within milliseconds; we only want one refresh.
//
// Mount this once per page from the Server Component, passing whatever tables
// matter for that page. Server data refetches on refresh; client state stays.
//
// RLS applies — admin users receive events for the rows they can SELECT.
// Non-admin authenticated users see nothing (and shouldn't be on these
// pages anyway thanks to the proxy + admin allowlist).

interface TableSpec {
  schema: "leads" | "crm" | "audit";
  table: string;
}

interface Props {
  tables: TableSpec[];
  // Optional: use a unique channel name to avoid sharing one channel across
  // unrelated pages. Defaults to a name derived from the tables list.
  channel?: string;
}

export function RealtimeRefresh({ tables, channel }: Props) {
  const router = useRouter();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const channelName = channel ?? "rt-" + tables.map((t) => `${t.schema}.${t.table}`).join("-");

    const ch = supabase.channel(channelName);

    for (const t of tables) {
      ch.on(
        // Postgres changes is dynamically typed by the client lib — type assertion to placate TS.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        { event: "*", schema: t.schema, table: t.table },
        () => {
          if (refreshTimer.current) clearTimeout(refreshTimer.current);
          refreshTimer.current = setTimeout(() => {
            router.refresh();
          }, 600);
        },
      );
    }

    ch.subscribe();

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      supabase.removeChannel(ch);
    };
    // We intentionally exclude `tables` and `channel` from deps — these are
    // expected to be stable per-page literals, and re-subscribing on every
    // render would thrash the connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
