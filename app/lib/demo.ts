// Demo-data filtering helper.
//
// Demo providers (crm.providers.is_demo=true) exist for portal MVP P2-P4
// dogfooding and sales calls. They MUST NOT appear in real admin views,
// dashboard counts, billing calcs, or reconcile crons (per
// provider-portal-mvp-scoping.md).
//
// Single source of truth: the database flag. App code reads it at request
// time rather than hardcoding ids, so onboarding a second demo provider
// (e.g. one for sales-call screen-shares vs one for our internal testing)
// just needs a `crm.providers` row with is_demo=true.
//
// Usage:
//   const demoIds = await getDemoProviderIds(supabase);
//   const filter = demoIds.length > 0
//     ? q.not('primary_routed_to', 'in', `(${demoIds.join(',')})`)
//     : q;

import type { SupabaseClient } from "@supabase/supabase-js";

let cache: { ids: string[]; cachedAt: number } | null = null;
const CACHE_TTL_MS = 30_000; // 30s — admin renders don't need stricter freshness

export async function getDemoProviderIds(supabase: SupabaseClient): Promise<string[]> {
  if (cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return cache.ids;
  }
  const { data } = await supabase
    .schema("crm")
    .from("providers")
    .select("provider_id")
    .eq("is_demo", true);
  const ids = ((data ?? []) as Array<{ provider_id: string }>).map((r) => r.provider_id);
  cache = { ids, cachedAt: Date.now() };
  return ids;
}

// Format demo provider ids for use in a Supabase .not('col', 'in', ...) filter.
// Returns null when there are no demo providers (caller should skip the filter).
export function demoProviderInClause(ids: string[]): string | null {
  if (ids.length === 0) return null;
  return `(${ids.join(",")})`;
}
