// Edge Function: routing-confirm
//
// One-click handler for the confirm links embedded in the owner notification
// email. Owner clicks the link, this function:
//   1. Verifies the HMAC-signed token in the query string
//   2. Calls the shared routeLead helper in 'owner_confirm' mode
//   3. Renders a branded HTML confirmation page based on the RouteOutcome
//
// All routing pipeline behaviour (DB writes, sheet append, provider
// notification, Brevo learner upsert, audit log, dead-letter rows) lives in
// _shared/route-lead.ts. This caller is just the token-verifier + page
// renderer. Auto-route (netlify-lead-router) and manual-confirm (this
// function) converge through routeLead so any new routing-time hook fires
// for both paths.
//
// Secrets expected in env:
//   SUPABASE_DB_URL                     (auto-injected)
//   ROUTING_CONFIRM_SHARED_SECRET       (HMAC key for confirm-link tokens)
//   SHEETS_APPEND_TOKEN                 (read by route-lead.ts)
//   BREVO_API_KEY                       (read by route-lead.ts)
//   BREVO_SENDER_EMAIL                  (read by route-lead.ts)
//   BREVO_LIST_ID_SWITCHABLE_UTILITY    (read by route-lead.ts; optional until
//                                        Brevo dashboard is wired)
//   BREVO_LIST_ID_SWITCHABLE_MARKETING  (read by route-lead.ts; optional)

import postgres from "npm:postgres@3";
import { verifyRoutingToken } from "../_shared/routing-token.ts";
import { formatLeadId, routeLead, type RouteOutcome } from "../_shared/route-lead.ts";

const DATABASE_URL = Deno.env.get("SUPABASE_DB_URL");
if (!DATABASE_URL) {
  throw new Error(
    "SUPABASE_DB_URL is not set. Auto-injected by Supabase; check Edge Functions → Manage secrets if missing.",
  );
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,
});

interface SubmittedAtRow {
  submitted_at: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "GET") {
    return htmlError("Method not allowed", 405);
  }

  const url = new URL(req.url);
  const token = url.searchParams.get("t");
  if (!token) {
    return htmlError("Missing confirm token. This link may be malformed.", 400);
  }

  const secret = Deno.env.get("ROUTING_CONFIRM_SHARED_SECRET");
  if (!secret) {
    console.error("ROUTING_CONFIRM_SHARED_SECRET not set");
    return htmlError("Server misconfigured - secret missing. Flagging to owner.", 500);
  }

  const verify = await verifyRoutingToken(token, secret);
  if (!verify.ok) {
    const reason = verify.error === "expired"
      ? "This confirm link has expired. Expire window is 14 days from the lead landing."
      : "This confirm link is invalid. It may have been tampered with, or the signing secret has been rotated.";
    return htmlError(reason, 400);
  }

  const { submission_id, provider_id } = verify.payload!;

  // Read submitted_at up front so we can format the lead-id label in HTML
  // responses, including the not-found case. Cheap read, no role switch.
  let submittedAt: string | null = null;
  try {
    const [row] = await sql<SubmittedAtRow[]>`
      SELECT submitted_at FROM leads.submissions WHERE id = ${submission_id}
    `;
    submittedAt = row?.submitted_at ?? null;
  } catch (err) {
    console.error("submitted_at lookup failed:", err);
  }

  const leadIdLabel = submittedAt ? formatLeadId(submission_id, submittedAt) : `submission ${submission_id}`;

  const outcome = await routeLead(sql, submission_id, provider_id, "owner_confirm");
  return renderOutcome(outcome, leadIdLabel, provider_id);
});

function renderOutcome(outcome: RouteOutcome, leadIdLabel: string, providerId: string): Response {
  switch (outcome.kind) {
    case "ok":
      if (!outcome.sheetAppended) {
        return htmlConfirmation({
          title: "Routed, but sheet append failed",
          headline: `Routing recorded for ${outcome.providerCompany}, but the sheet didn't update.`,
          body: `Lead ${leadIdLabel} is in the DB. You've been emailed a copy to paste into ${outcome.providerCompany}'s sheet. Provider has NOT been emailed yet — paste first, then message them manually this once.`,
        });
      }
      if (!outcome.providerNotified) {
        return htmlConfirmation({
          title: "Routed, sheet updated, email to provider failed",
          headline: `Lead is in ${outcome.providerCompany}'s sheet.`,
          body: `But we couldn't send the notification email to the provider. Message them manually: "New enquiry in your sheet." A dead_letter row has been written so Sasha's Monday scan will flag if this pattern repeats.`,
        });
      }
      return htmlConfirmation({
        title: "Routed",
        headline: `Lead sent to ${outcome.providerCompany}.`,
        body: `Lead ${leadIdLabel} is in ${outcome.providerCompany}'s sheet with status 'open'. The provider has been notified.`,
      });

    case "already_routed_same":
      return htmlConfirmation({
        title: "Already confirmed",
        headline: `This lead was already routed to ${outcome.providerCompany}.`,
        body: `Lead ${leadIdLabel}. No further action needed.`,
      });

    case "already_routed_different":
      return htmlError(
        `Lead ${leadIdLabel} was already routed to a different provider (${outcome.existingProvider}). To re-route, update the row manually in SQL.`,
        409,
      );

    case "submission_dq":
      return htmlError(
        `Lead ${leadIdLabel} is marked DQ — it should not have a confirm link. Flag to platform as a bug.`,
        400,
      );

    case "submission_archived":
      return htmlError(
        `Lead ${leadIdLabel} is archived (${outcome.archivedAt}) and cannot be routed. If this is wrong, clear archived_at on the submission first.`,
        400,
      );

    case "submission_not_found":
      return htmlError(`Submission ${outcome.submissionId} not found.`, 404);

    case "provider_not_found":
      return htmlError(`Provider '${providerId}' not found.`, 404);

    case "provider_inactive":
      return htmlError(`Provider '${providerId}' is inactive or archived.`, 404);

    case "db_error":
      return htmlError(`Database operation failed: ${outcome.error}`, 500);
  }
}

// ----- HTML pages -----

interface ConfirmationPage {
  title: string;
  headline: string;
  body: string;
}

function htmlConfirmation(page: ConfirmationPage): Response {
  const html = renderPage(page.title, page.headline, page.body);
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function htmlError(message: string, status: number): Response {
  const html = renderPage("Error", "Something's not right", escapeHtml(message));
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function renderPage(title: string, headline: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - SwitchLeads</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 560px; margin: 64px auto; padding: 0 24px; color: #111; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  p { margin: 0 0 12px; }
  .meta { color: #666; font-size: 14px; margin-top: 32px; }
  pre { background: #f5f5f5; padding: 12px; overflow-x: auto; font-size: 13px; }
  a { color: #0a6cff; }
</style>
</head>
<body>
<h1>${escapeHtml(headline)}</h1>
<p>${body}</p>
<p class="meta">SwitchLeads · routing-confirm</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
