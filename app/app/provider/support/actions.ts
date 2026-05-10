"use server";

// Server Action. provider submits the Support form.
//
// Flow:
//   1. Resolve caller → provider_user (admin client; provider_users RLS
//      doesn't permit a self-lookup as authenticated).
//   2. INSERT into crm.support_requests via the authenticated client so
//      RLS (provider_id = caller's helper result) is the gate.
//   3. POST to provider-support-notify Edge Function with x-audit-key
//      pulled from vault. Edge Function emails support@switchleads.co.uk
//      and stamps email_sent_at on the row.
//
// If the email dispatch fails, the row stays in the table with
// email_sent_at = NULL. so we don't lose the submission and a follow-up
// retry can dispatch later. Returns ok:true regardless once the row is
// inserted; the email warning is surfaced separately.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const SUBJECT_MAX = 200;
const MESSAGE_MAX = 5000;
const VALID_CATEGORIES = ["lead_query", "billing", "technical", "account", "other"] as const;
type Category = (typeof VALID_CATEGORIES)[number];

interface Args {
  category: string;
  subject: string;
  message: string;
}

type Result =
  | { ok: true; requestId: number; emailSent: boolean }
  | { ok: false; error: string };

export async function submitSupportRequestAction(args: Args): Promise<Result> {
  const subject = (args.subject ?? "").trim();
  const message = (args.message ?? "").trim();
  const category = args.category as Category;

  if (!VALID_CATEGORIES.includes(category)) {
    return { ok: false, error: "Pick a category." };
  }
  if (subject.length === 0) return { ok: false, error: "Subject can't be empty." };
  if (subject.length > SUBJECT_MAX) {
    return { ok: false, error: `Subject too long (max ${SUBJECT_MAX} chars).` };
  }
  if (message.length === 0) return { ok: false, error: "Message can't be empty." };
  if (message.length > MESSAGE_MAX) {
    return { ok: false, error: `Message too long (max ${MESSAGE_MAX} chars).` };
  }

  const supabase = await createClient();
  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user;
  if (!user) return { ok: false, error: "Not signed in" };

  const admin = createAdminClient();
  const { data: pu, error: puErr } = await admin
    .schema("crm")
    .from("provider_users")
    .select("id, provider_id, contact_email, display_name")
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle<{ id: number; provider_id: string; contact_email: string; display_name: string | null }>();
  if (puErr) return { ok: false, error: puErr.message };
  if (!pu) return { ok: false, error: "Active provider user not found" };

  // INSERT via authenticated client so RLS validates the WITH CHECK.
  const { data: inserted, error: insErr } = await supabase
    .schema("crm")
    .from("support_requests")
    .insert({
      provider_id: pu.provider_id,
      provider_user_id: pu.id,
      submitter_email: pu.contact_email,
      submitter_name: pu.display_name,
      category,
      subject,
      message,
    })
    .select("id")
    .maybeSingle<{ id: number }>();
  if (insErr) return { ok: false, error: insErr.message };
  if (!inserted) return { ok: false, error: "Insert returned no row (RLS may have rejected)" };

  // Fire the email via Edge Function. Failure leaves email_sent_at = NULL
  // on the row, so we don't lose context.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    console.warn("[submitSupportRequest] NEXT_PUBLIC_SUPABASE_URL missing");
    return { ok: true, requestId: inserted.id, emailSent: false };
  }
  const { data: secret, error: secretErr } = await admin.rpc("get_shared_secret", {
    p_name: "AUDIT_SHARED_SECRET",
  });
  if (secretErr || !secret) {
    console.error(`[submitSupportRequest] vault read failed: ${secretErr?.message ?? "no row"}`);
    return { ok: true, requestId: inserted.id, emailSent: false };
  }

  let emailSent = false;
  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/provider-support-notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-audit-key": String(secret),
      },
      body: JSON.stringify({ request_id: inserted.id }),
    });
    emailSent = resp.ok;
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error(
        `[submitSupportRequest] Edge Function ${resp.status}: ${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    console.error(`[submitSupportRequest] fetch failed: ${String(err)}`);
  }

  return { ok: true, requestId: inserted.id, emailSent };
}
