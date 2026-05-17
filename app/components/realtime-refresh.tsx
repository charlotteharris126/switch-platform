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
//   2. Tab-visibility safety net. When the tab returns to visible after being
//      hidden for more than HIDDEN_REFRESH_THRESHOLD_MS, force a router.refresh().
//      Browsers (Chrome especially) suspend background tab websockets on long
//      backgrounding; on return the data is stale even if the channel "looks"
//      open. Brief refocuses (alt-tab for a few seconds) are skipped to avoid
//      thrashing the server tree on every tab switch.
//   3. Reconnect on channel error — if subscribe() reports CHANNEL_ERROR or
//      TIMED_OUT, we tear down and re-subscribe.

interface TableSpec {
  schema: "leads" | "crm" | "audit";
  table: string;
  // Optional Postgres-realtime filter applied to this subscription.
  // Format: "<column>=eq.<value>" (also supports neq/lt/lte/gt/gte/in).
  // When set, the broker only emits events whose NEW row (or OLD on
  // DELETE) matches the filter — server-side scoping that drops the
  // multi-tenant fan-out from O(providers × users) to O(users per provider).
  //
  // Each provider page passes a filter pinning the subscription to its
  // own provider's rows (e.g. provider_id=eq.<id> on crm.enrolments,
  // primary_routed_to=eq.<id> on leads.submissions). Admin surfaces leave
  // the filter unset so they receive every row (RLS still scopes to what
  // their session can read).
  filter?: string;
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

    // Debounce window: a single owner action (mark-enrolled, route-confirm)
    // typically produces 2-4 INSERT/UPDATE events on different tables in
    // quick succession. 600ms is long enough to coalesce them into one
    // router.refresh and short enough that the UI feels live.
    const REFRESH_DEBOUNCE_MS = 600;
    const queueRefresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        router.refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    let currentChannel: ReturnType<typeof supabase.channel> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const subscribe = () => {
      if (cancelled) return;
      const ch = supabase.channel(channelName);
      for (const t of tables) {
        const config: {
          event: "*";
          schema: string;
          table: string;
          filter?: string;
        } = { event: "*", schema: t.schema, table: t.table };
        if (t.filter) config.filter = t.filter;
        ch.on(
          // Postgres changes is dynamically typed by the client lib — type assertion to placate TS.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "postgres_changes" as any,
          config,
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

    // Safety net: refresh server data when the tab returns from a long-enough
    // background that the websocket may have been suspended. Brief refocuses
    // are skipped; they'd otherwise re-run the whole server tree (layout
    // queries + page fan-out) on every alt-tab, lagging the next click.
    const HIDDEN_REFRESH_THRESHOLD_MS = 5 * 60_000;
    let hiddenSinceMs: number | null =
      document.visibilityState === "hidden" ? Date.now() : null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenSinceMs = Date.now();
        return;
      }
      const wasHiddenAt = hiddenSinceMs;
      hiddenSinceMs = null;
      if (wasHiddenAt !== null && Date.now() - wasHiddenAt > HIDDEN_REFRESH_THRESHOLD_MS) {
        queueRefresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", onVisibility);
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
