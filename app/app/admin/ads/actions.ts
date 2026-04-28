"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export interface PasteResult {
  ok: boolean;
  error?: string;
  date?: string;
  spend?: number;
}

// Marker that distinguishes manual paste rows from API-sourced rows. When the
// Meta Marketing API is wired up, real ingestion will use the actual
// `act_xxxxxxxx` IDs; manual rows stay as `manual_paste` so we never
// double-count and we can see which days were typed in vs pulled.
const MANUAL_AD_ACCOUNT = "manual_paste";

export async function upsertManualAdSpend(formData: FormData): Promise<PasteResult> {
  const dateRaw = String(formData.get("date") ?? "").trim();
  const spendRaw = String(formData.get("spend") ?? "").trim();
  const leadsRaw = String(formData.get("leads") ?? "").trim();
  const impressionsRaw = String(formData.get("impressions") ?? "").trim();
  const clicksRaw = String(formData.get("clicks") ?? "").trim();

  if (!dateRaw || !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    return { ok: false, error: "Pick a valid date." };
  }
  const spend = Number(spendRaw);
  if (!Number.isFinite(spend) || spend < 0) {
    return { ok: false, error: "Spend must be a number." };
  }
  const leads = leadsRaw === "" ? 0 : Number(leadsRaw);
  if (!Number.isFinite(leads) || leads < 0 || !Number.isInteger(leads)) {
    return { ok: false, error: "Leads must be a whole number." };
  }
  const impressions = impressionsRaw === "" ? null : Number(impressionsRaw);
  if (impressions !== null && (!Number.isFinite(impressions) || impressions < 0 || !Number.isInteger(impressions))) {
    return { ok: false, error: "Impressions must be a whole number." };
  }
  const clicks = clicksRaw === "" ? null : Number(clicksRaw);
  if (clicks !== null && (!Number.isFinite(clicks) || clicks < 0 || !Number.isInteger(clicks))) {
    return { ok: false, error: "Clicks must be a whole number." };
  }

  const cpl = leads > 0 ? spend / leads : null;

  const supabase = await createClient();

  // Soft upsert: delete any existing manual row for this date, then insert
  // fresh. Avoids dependence on a unique constraint we haven't added.
  const del = await supabase
    .schema("ads_switchable")
    .from("meta_daily")
    .delete()
    .eq("date", dateRaw)
    .eq("ad_account_id", MANUAL_AD_ACCOUNT);
  if (del.error) return { ok: false, error: del.error.message };

  const ins = await supabase.schema("ads_switchable").from("meta_daily").insert({
    date: dateRaw,
    ad_account_id: MANUAL_AD_ACCOUNT,
    spend,
    leads,
    impressions,
    clicks,
    cost_per_lead: cpl,
    fetched_at: new Date().toISOString(),
    raw_payload: { source: "manual_paste", entered_at: new Date().toISOString() },
  });
  if (ins.error) return { ok: false, error: ins.error.message };

  revalidatePath("/ads");
  revalidatePath("/");
  return { ok: true, date: dateRaw, spend };
}

export async function deleteManualAdSpend(date: string): Promise<PasteResult> {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "Invalid date." };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .schema("ads_switchable")
    .from("meta_daily")
    .delete()
    .eq("date", date)
    .eq("ad_account_id", MANUAL_AD_ACCOUNT);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/ads");
  revalidatePath("/");
  return { ok: true, date };
}
