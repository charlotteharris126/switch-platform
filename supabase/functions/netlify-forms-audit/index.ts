// Edge Function: netlify-forms-audit
//
// Verifies that every form declared in switchable.org.uk's allowlist
// (deploy/data/form-allowlist.json) is correctly wired in Netlify with the
// expected outgoing webhook. Any discrepancy (missing webhook, wrong URL,
// unexpected form name on Netlify) is written as a row into leads.dead_letter
// with source='netlify_audit' so Mira's Monday review surfaces it.
//
// This is the defence-in-depth layer against silent lead loss — complements
// the build-time allowlist check in switchable/site/deploy/scripts/audit-site.js
// (which prevents drift at creation) by catching anything that drifts after
// deploy (e.g., a webhook accidentally deleted in Netlify UI).
//
// Triggered: manually via HTTPS POST for ad-hoc checks, and daily via a
// scheduled cron job (set up separately in Supabase dashboard → Database → Cron).
//
// Auth: requires a shared secret in the x-audit-key header to prevent random
// public invocations. Both manual and scheduled calls pass the same header.
//
// Secrets required (set in Supabase dashboard → Edge Functions → Manage secrets):
//   - NETLIFY_API_TOKEN      Personal access token (Sites: read-only is enough)
//   - NETLIFY_SITE_ID        The site ID for switchable.org.uk
//   - AUDIT_SHARED_SECRET    Any long random string; used in the x-audit-key header
//   - SUPABASE_DB_URL        Auto-injected, no action needed
//
// Allowlist source of truth: https://switchable.org.uk/data/form-allowlist.json
// (deployed by the switchable/site project). The function fetches it live — no
// local copy to drift from.

import postgres from "npm:postgres@3";

const NETLIFY_API_TOKEN = Deno.env.get("NETLIFY_API_TOKEN");
const NETLIFY_SITE_ID = Deno.env.get("NETLIFY_SITE_ID");
const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
const ALLOWLIST_URL = "https://switchable.org.uk/data/form-allowlist.json";

if (!DATABASE_URL) {
  throw new Error("SUPABASE_DB_URL not set (should be auto-injected by Supabase)");
}

const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false });

// AUDIT_SHARED_SECRET lives in Supabase Vault as the single source of truth
// (migration 0019). Read via the public.get_shared_secret helper on each
// invocation so secret rotations propagate without redeploys. Cron-triggered
// only — one extra ~10ms SQL round-trip per call is negligible.
async function getAuditSharedSecret(): Promise<string> {
  const rows = await sql<Array<{ secret: string }>>`
    SELECT public.get_shared_secret('AUDIT_SHARED_SECRET') AS secret
  `;
  return rows[0].secret;
}

interface AllowlistEntry {
  form_name: string;
  webhook_url: string | null;
  purpose: string;
}

interface AllowlistFile {
  schema_version: string;
  purpose: string;
  allowlist: AllowlistEntry[];
}

interface NetlifyForm {
  id: string;
  name: string;
  site_id?: string;
}

interface NetlifyHook {
  id: string;
  site_id?: string;
  form_id?: string;
  event?: string;
  type?: string;
  data?: {
    url?: string;
    [k: string]: unknown;
  };
  disabled?: boolean;
}

interface Discrepancy {
  kind:
    | "allowlist_fetch_failed"
    | "netlify_forms_fetch_failed"
    | "missing_netlify_form"
    | "missing_webhook"
    | "wrong_webhook_url"
    | "unexpected_netlify_form"
    | "netlify_notifications_fetch_failed";
  form_name?: string;
  details: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Auth: shared secret header required for all invocations. Source of truth
  // is Supabase Vault — see migration 0019.
  const providedKey = req.headers.get("x-audit-key");
  let expectedKey: string;
  try {
    expectedKey = await getAuditSharedSecret();
  } catch (err) {
    console.error("vault secret fetch failed:", err);
    return json({ error: "AUDIT_SHARED_SECRET not retrievable from vault" }, 500);
  }
  if (providedKey !== expectedKey) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!NETLIFY_API_TOKEN || !NETLIFY_SITE_ID) {
    return json(
      { error: "NETLIFY_API_TOKEN and NETLIFY_SITE_ID must be set as function secrets" },
      500,
    );
  }

  const discrepancies: Discrepancy[] = [];

  // --- 1. Fetch allowlist ---
  let allowlist: AllowlistEntry[];
  try {
    const res = await fetch(ALLOWLIST_URL, { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${ALLOWLIST_URL}`);
    }
    const parsed = (await res.json()) as AllowlistFile;
    if (!Array.isArray(parsed.allowlist)) {
      throw new Error("allowlist field is not an array");
    }
    allowlist = parsed.allowlist;
  } catch (err) {
    discrepancies.push({
      kind: "allowlist_fetch_failed",
      details: describeError(err),
    });
    await persistDiscrepancies(discrepancies);
    return json({ status: "error", stage: "allowlist_fetch", discrepancies }, 200);
  }

  // --- 2. Fetch Netlify forms for the site ---
  let netlifyForms: NetlifyForm[];
  try {
    const res = await fetch(
      `https://api.netlify.com/api/v1/sites/${NETLIFY_SITE_ID}/forms`,
      { headers: { authorization: `Bearer ${NETLIFY_API_TOKEN}` } },
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from Netlify forms list`);
    }
    netlifyForms = (await res.json()) as NetlifyForm[];
  } catch (err) {
    discrepancies.push({
      kind: "netlify_forms_fetch_failed",
      details: describeError(err),
    });
    await persistDiscrepancies(discrepancies);
    return json({ status: "error", stage: "netlify_forms_fetch", discrepancies }, 200);
  }

  // --- 2b. Fetch all hooks for the site in one call (Netlify's "notifications"
  // are called "hooks" in the API). Filter client-side by form_id. ---
  let netlifyHooks: NetlifyHook[];
  try {
    const res = await fetch(
      `https://api.netlify.com/api/v1/hooks?site_id=${NETLIFY_SITE_ID}`,
      { headers: { authorization: `Bearer ${NETLIFY_API_TOKEN}` } },
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from Netlify hooks list`);
    }
    netlifyHooks = (await res.json()) as NetlifyHook[];
  } catch (err) {
    discrepancies.push({
      kind: "netlify_notifications_fetch_failed",
      details: describeError(err),
    });
    await persistDiscrepancies(discrepancies);
    return json({ status: "error", stage: "netlify_hooks_fetch", discrepancies }, 200);
  }

  // --- 3. Cross-check each allowlist entry has a correctly-wired Netlify form ---
  //
  // A submission reaches the function if EITHER:
  //   (a) a per-form active outgoing webhook exists pointing at the expected URL, OR
  //   (b) a site-wide active outgoing webhook (form_id === null, Netlify UI shows
  //       "Any form") exists pointing at the expected URL — Netlify fires
  //       site-wide hooks on every form's submission regardless of form_id.
  //
  // Site-wide hooks are the simpler ops pattern: one notification captures every
  // form including future ones. The Edge Function branches on form_name in the
  // payload. If Charlotte has configured "Any form" in Netlify, that single hook
  // satisfies all allowlist entries expecting the same URL.
  const siteWideWebhookUrls = new Set(
    netlifyHooks
      .filter(
        (h) =>
          (h.form_id === null || h.form_id === undefined) &&
          h.type === "url" &&
          h.event === "submission_created" &&
          h.disabled !== true &&
          typeof h.data?.url === "string",
      )
      .map((h) => h.data!.url as string),
  );

  for (const expected of allowlist) {
    if (expected.webhook_url === null) {
      // Contact-modal-style entries: no webhook expected, nothing to verify.
      continue;
    }

    // Site-wide webhook at the expected URL covers this allowlist entry.
    if (siteWideWebhookUrls.has(expected.webhook_url)) {
      continue;
    }

    const matchingNetlifyForm = netlifyForms.find((f) => f.name === expected.form_name);
    if (!matchingNetlifyForm) {
      discrepancies.push({
        kind: "missing_netlify_form",
        form_name: expected.form_name,
        details:
          `Allowlist expects form "${expected.form_name}" with webhook ${expected.webhook_url}, ` +
          `but no form with that name exists on Netlify site ${NETLIFY_SITE_ID} ` +
          `and no site-wide ("Any form") webhook points at ${expected.webhook_url}. ` +
          `Either the form has not been submitted yet (Netlify creates form records on first submission), ` +
          `or the form name in HTML does not match the allowlist, or the webhook was never set up.`,
      });
      continue;
    }

    // Per-form webhooks pointing at this form.
    const perFormWebhooks = netlifyHooks.filter(
      (h) =>
        h.form_id === matchingNetlifyForm.id &&
        h.type === "url" &&
        h.event === "submission_created" &&
        h.disabled !== true,
    );
    const hasExpectedWebhook = perFormWebhooks.some((h) => h.data?.url === expected.webhook_url);

    if (!hasExpectedWebhook) {
      const found =
        perFormWebhooks.map((h) => h.data?.url ?? "(no url)").join(", ") || "none";
      discrepancies.push({
        kind: perFormWebhooks.length === 0 ? "missing_webhook" : "wrong_webhook_url",
        form_name: expected.form_name,
        details:
          `Form "${expected.form_name}" on Netlify has no per-form active outgoing webhook to ` +
          `${expected.webhook_url}, and no site-wide ("Any form") webhook at that URL was found either. ` +
          `Per-form active webhook URLs found: ${found}.`,
      });
    }
  }

  // --- 4. Flag unexpected Netlify forms not in the allowlist ---
  const allowedNames = new Set(allowlist.map((a) => a.form_name));
  for (const netlifyForm of netlifyForms) {
    if (!allowedNames.has(netlifyForm.name)) {
      discrepancies.push({
        kind: "unexpected_netlify_form",
        form_name: netlifyForm.name,
        details:
          `Netlify site ${NETLIFY_SITE_ID} has a form named "${netlifyForm.name}" ` +
          `(id ${netlifyForm.id}) that is NOT in the allowlist at ${ALLOWLIST_URL}. ` +
          `Either add it to the allowlist, or remove the form from the site HTML.`,
      });
    }
  }

  // --- 5. Persist + respond ---
  if (discrepancies.length > 0) {
    await persistDiscrepancies(discrepancies);
  }

  return json(
    {
      status: discrepancies.length === 0 ? "clean" : "discrepancies_found",
      count: discrepancies.length,
      discrepancies,
      ran_at: new Date().toISOString(),
    },
    200,
  );
});

async function persistDiscrepancies(discrepancies: Discrepancy[]): Promise<void> {
  if (discrepancies.length === 0) return;
  try {
    await sql.begin(async (trx) => {
      await trx`SET LOCAL ROLE functions_writer`;
      for (const d of discrepancies) {
        await trx`
          INSERT INTO leads.dead_letter (source, raw_payload, error_context)
          VALUES (
            'netlify_audit',
            ${sql.json(d as unknown as Record<string, unknown>)},
            ${`${d.kind}: ${d.details}`}
          )
        `;
      }
    });
  } catch (err) {
    // If we can't write to dead_letter, log and continue. Response still reports discrepancies.
    console.error("persistDiscrepancies failed:", describeError(err));
  }
}

function describeError(err: unknown): string {
  if (!err) return "unknown error (falsy)";
  if (err instanceof Error) {
    const pgErr = err as Error & { code?: string; detail?: string; hint?: string };
    const parts: string[] = [];
    if (pgErr.code) parts.push(`code=${pgErr.code}`);
    if (err.message) parts.push(`message=${err.message}`);
    if (pgErr.detail) parts.push(`detail=${pgErr.detail}`);
    if (pgErr.hint) parts.push(`hint=${pgErr.hint}`);
    if (parts.length === 0) parts.push(`name=${err.name}`);
    return parts.join(" | ");
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
