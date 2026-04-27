// SwitchLeads provider sheet appender — canonical reference copy.
//
// DEPLOYED COPY lives in each provider's Google Sheet, under
// Extensions -> Apps Script. Every deployment of this script is paired with
// a shared-secret token stored in Supabase Edge Function secrets as
// SHEETS_APPEND_TOKEN. Edge Function routing-confirm includes the token in
// the JSON body on every POST. Apps Script verifies, appends the row, done.
//
// Why this pattern (not Google Sheets API + service account):
//   - Provider sheets are a transitional surface. They retire when the
//     Phase 4 provider dashboard ships. An Apps Script deployment is ~5 min
//     per sheet; a Google Cloud project, service account, OAuth consent,
//     and IAM setup is an hour-plus of one-off infrastructure we'd tear
//     down. Apps Script is right-sized for the lifespan.
//   - No Google Cloud billing account, no service account rotation, no
//     extra MCP, no new secret-vault entry beyond the shared token.
//
// Why the token rides in the JSON body (not a header):
//   Apps Script web apps strip custom headers; only the body and query
//   string are preserved. The token must therefore go in one of those.
//   Body is cleaner than query string (doesn't end up in Google's access
//   logs alongside the URL).
//
// Rotation:
//   SHEETS_APPEND_TOKEN rotates annually, or immediately on any leak.
//   When rotated, update TOKEN below in every deployed sheet AND the
//   Supabase secret in lockstep. Tracked in platform/docs/secrets-rotation.md.
//
// Column order must match the sheet headers EMS and future providers use:
//   Lead ID | Submitted at | Course | Name | Email | Phone | LA |
//   Region scheme | Age band | Employment | Prior L3 | Start date checked |
//   Provider | Status | Enrolment date | Charge | Notes
//
// This repo copy carries a placeholder. Each deployed copy has the real
// token substituted before deploy; never commit a real token to the repo.

const TOKEN = 'PASTE_TOKEN_HERE';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) {
      return json_({ok: false, error: 'unauthorized'});
    }
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    sheet.appendRow([
      body.lead_id,
      body.submitted_at,
      body.course,
      body.name,
      body.email,
      body.phone,
      body.la,
      body.region_scheme,
      body.age_band,
      body.employment,
      body.prior_l3,
      body.start_date_checked,
      body.provider,
      body.status || 'open',
      body.enrolment_date || '',
      body.charge || '',
      body.notes || ''
    ]);
    return json_({ok: true, row: sheet.getLastRow()});
  } catch (err) {
    return json_({ok: false, error: String(err)});
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
