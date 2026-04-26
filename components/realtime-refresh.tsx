"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Subscribes to Supabase Realtime for the listed tables and triggers
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
//
// Reliability layers (added 2026-04-26 after a real lead landed without the
// dashboard auto-refreshing):
//   1. Auth-token refresh propagation — when supabase-js rotates the JWT (≈ every
//      hour) we forward it to realtime via setAuth(). Without this, the channel
//      keeps an open socket but quietly stops delivering RLS-gated events once
//      the original token expires.
//   2. Tab-visibility safety net — when the tab becomes visible, force a
//      router.refresh(). Browsers (Chrome especially) suspend background tab
//      websockets; on return the data is stale even if the channel "looks" open.
//      This covers any silent failure mode we haven't enumerated.
//   3. Reconnect on channel error — if subscribe() reports CHANNEL_ERROR or
//      TIMED_OUT, we tear down and re-subscribe.

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

    const queueRefresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        router.refresh();
      }, 600);
    };

    let currentChannel: ReturnType<typeof supabase.channel> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const subscribe = () => {
      if (cancelled) return;
      const ch = supabase.channel(channelName);
      for (const t of tables) {
        ch.on(
          // Postgres changes is dynamically typed by the client lib — type assertion to placate TS.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "postgres_changes" as any,
          { event: "*", schema: t.schema, table: t.table },
          queueRefresh,
        );
      }
      ch.subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          if (cancelled) return;
          if (currentChannel) {
            supabase.removeChannel(currentChannel);
            currentChannel = null;
          }
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(subscribe, 2000);
        }
      });
      currentChannel = ch;
    };

    subscribe();

    // Forward token refreshes to realtime so RLS-gated events keep flowing
    // after the initial JWT expires.
    const { data: authSub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "TOKEN_REFRESHED" && session?.access_token) {
        supabase.realtime.setAuth(session.access_token);
      }
    });

    // Safety net: when the tab becomes visible, refresh server data. Covers
    // backgrounded-tab websocket suspension and any silent failure.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        queueRefresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);

    return () => {
      cancelled = true;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
      authSub.subscription.unsubscribe();
      if (currentChannel) supabase.removeChannel(currentChannel);
    };
    // We intentionally exclude `tables` and `channel` from deps — these are
    // expected to be stable per-page literals, and re-subscribing on every
    // render would thrash the connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
