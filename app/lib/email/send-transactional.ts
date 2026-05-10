// Minimal Brevo transactional email helper for Server Actions.
//
// Mirrors the Deno-side helper in supabase/functions/_shared/brevo.ts but
// uses fetch directly (no Deno.env, no @std imports). Best-effort; failures
// log + return false but don't throw, so the Server Action that called it
// stays decoupled from Brevo availability.
//
// Dormancy: if BREVO_API_KEY is missing from the Netlify env, this no-ops
// silently. Same shape as the Edge Function templates that stay dormant
// until template ids are set.

interface SendArgs {
  to: { email: string; name?: string };
  templateId: number;
  params?: Record<string, string | number | boolean | null>;
}

export async function sendTransactional(args: SendArgs): Promise<boolean> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn("[sendTransactional] BREVO_API_KEY not set — skipping");
    return false;
  }
  if (!Number.isFinite(args.templateId) || args.templateId <= 0) {
    console.warn(`[sendTransactional] Invalid templateId=${args.templateId} — skipping`);
    return false;
  }

  try {
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        to: [{ email: args.to.email, name: args.to.name }],
        templateId: args.templateId,
        params: args.params ?? {},
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.error(
        `[sendTransactional] Brevo ${resp.status} for template ${args.templateId} → ${args.to.email}: ${body.slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[sendTransactional] fetch failed for template ${args.templateId}: ${String(err)}`);
    return false;
  }
}
