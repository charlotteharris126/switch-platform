"use server";

// Server Actions for /admin/data-ops. Each action wraps a one-shot Edge
// Function trigger. AUDIT_SHARED_SECRET is read from the vault on each
// call (single source of truth — same pattern as sendPortalInviteAction
// and inviteProviderUserAction).

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isAdmin } from "@/lib/auth/allowlist";

export interface BackfillSpotCheck {
  email: string;
  before_referral: string;
  before_fastrack: string;
  desired_referral: string;
  desired_fastrack: string;
  after_referral?: string;
  after_fastrack?: string;
}

export interface BackfillSummary {
  ok: true;
  mode: "dry_run" | "apply";
  audience_size: number;
  processed: number;
  mutated: number;
  skipped_no_submission: number;
  skipped_already_matching: number;
  errors: number;
  error_messages: string[];
  spot_checks: BackfillSpotCheck[];
}

export type BackfillResult = BackfillSummary | { ok: false; error: string };

export async function runBackfillAction(args: { apply: boolean }): Promise<BackfillResult> {
  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user || !isAdmin(userData.user.email)) {
    return { ok: false, error: "Not authorised" };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    return { ok: false, error: "Server misconfigured: NEXT_PUBLIC_SUPABASE_URL missing" };
  }

  const admin = createAdminClient();
  const { data: secretData, error: secretErr } = await admin.rpc("get_shared_secret", {
    p_name: "AUDIT_SHARED_SECRET",
  });
  if (secretErr || typeof secretData !== "string" || !secretData) {
    return {
      ok: false,
      error: `Could not read AUDIT_SHARED_SECRET from vault: ${secretErr?.message ?? "no value returned"}`,
    };
  }

  let resp: Response;
  try {
    resp = await fetch(`${supabaseUrl}/functions/v1/backfill-referral-fastrack-urls`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-audit-key": secretData,
      },
      body: JSON.stringify({ apply: args.apply }),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const body = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok || body.ok !== true) {
    return {
      ok: false,
      error: typeof body.error === "string"
        ? body.error
        : `Edge Function ${resp.status}`,
    };
  }

  return body as unknown as BackfillSummary;
}
