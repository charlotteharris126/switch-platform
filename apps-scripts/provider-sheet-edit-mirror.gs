// SwitchLeads provider sheet edit mirror — onEdit trigger.
// Sits alongside provider-sheet-appender-v2.gs on each provider sheet.
//
// What this does:
//   When a provider edits the Status or Updates cell on any row, this
//   trigger fires and POSTs the edit to the sheet-edit-mirror Edge
//   Function. The function applies the change to crm.enrolments
//   (Channel A: Status, deterministic) or queues an AI suggestion for
//   owner approval (Channel B: Updates, gated). Other column edits are
//   ignored.
//
// What this does NOT do:
//   Programmatic edits made by the appender (doPost) DO NOT fire this
//   trigger — Apps Script onEdit only fires for human edits in the UI.
//   This is intentional and matches the design.
//
// Deployment steps per sheet (also in platform/docs/provider-onboarding-playbook.md):
//   1. Open the provider's Google Sheet → Extensions → Apps Script.
//   2. Paste this file in alongside the existing provider-sheet-appender-v2
//      (each script is a separate file in the same Apps Script project).
//   3. Set MIRROR_TOKEN below to the current SHEETS_APPEND_TOKEN value (same as
//      the appender — they share auth).
//   4. Set PROVIDER_ID to the provider's slug (matches crm.providers.provider_id).
//   5. In the Apps Script editor: Triggers (clock icon) → Add Trigger →
//      Function: onEdit, Event source: From spreadsheet, Event type: On edit.
//      This creates an installable trigger that runs as the owner — required
//      because simple onEdit triggers can't make external UrlFetchApp calls
//      reliably.
//   6. Confirm the sheet's row 1 contains the headers: "Lead ID", "Status",
//      "Updates" (case- and whitespace-insensitive — matched via normaliseHeader).
//   7. Set up data validation on the Status column: dropdown with values
//      Open, Contacted, Enrolled, Not enrolled, Disputed.
//
// Token rotation:
//   When SHEETS_APPEND_TOKEN rotates, update MIRROR_TOKEN here on every deployed
//   sheet AND the Supabase secret in lockstep (same flow as the appender).
//   Tracked in platform/docs/secrets-rotation.md.

// Renamed from TOKEN to avoid colliding with the appender's TOKEN const
// (Apps Script files in one project share global scope).
const MIRROR_TOKEN = 'PASTE_TOKEN_HERE';
const PROVIDER_ID = 'PASTE_PROVIDER_ID_HERE'; // e.g. 'enterprise-made-simple'
const EDGE_FUNCTION_URL = 'https://igvlngouxcirqhlsrhga.supabase.co/functions/v1/sheet-edit-mirror';

// Columns we watch (by normalised header). Edits to other columns are ignored.
const WATCHED_COLUMNS = ['status', 'notes'];

// Normalised header -> canonical key. Mirrors the appender's FIELD_MAP for
// the lead ID and notes columns so all three pilot sheets work without
// per-provider configuration. Status column is the new addition; Notes
// column is the existing free-text column providers already use.
const HEADER_MAP = {
  'leadid':   'Lead ID',
  'lead':     'Lead ID',
  'id':       'Lead ID',
  'status':   'Status',
  'notes':    'Notes',
  'note':     'Notes',
  'comment':  'Notes',
  'comments': 'Notes'
};

function onEdit(e) {
  try {
    if (!e || !e.range) { console.log('skip: no event/range'); return; }

    const sheet = e.range.getSheet();
    const editedRow = e.range.getRow();
    const editedCol = e.range.getColumn();
    console.log('fired: row=' + editedRow + ' col=' + editedCol + ' sheet=' + sheet.getName() + ' index=' + sheet.getIndex());

    if (editedRow < 2) { console.log('skip: header row'); return; }
    if (sheet.getIndex() !== 1) { console.log('skip: sheet not first tab'); return; }

    const headerCell = sheet.getRange(1, editedCol).getValue();
    const headerNorm = normaliseHeader(headerCell);
    const canonicalCol = HEADER_MAP[headerNorm];
    console.log('header="' + headerCell + '" norm="' + headerNorm + '" canonical="' + canonicalCol + '"');

    if (!canonicalCol) { console.log('skip: no canonical mapping'); return; }
    // Match against canonical name, not raw norm — handles header aliases
    // like "Comments" → "Notes" cleanly.
    if (canonicalCol !== 'Status' && canonicalCol !== 'Notes') { console.log('skip: column not watched'); return; }

    const leadIdCol = findColumnByHeader_(sheet, 'leadid')
      || findColumnByHeader_(sheet, 'lead')
      || findColumnByHeader_(sheet, 'id');
    if (!leadIdCol) { console.warn('skip: Lead ID column not found'); return; }
    const leadId = sheet.getRange(editedRow, leadIdCol).getValue();
    console.log('leadId=' + leadId);
    if (!leadId) { console.log('skip: no leadId in row'); return; }

    const editorEmail = (e.user && typeof e.user.getEmail === 'function')
      ? e.user.getEmail()
      : null;

    const payload = {
      lead_id: String(leadId),
      provider_id: PROVIDER_ID,
      column: canonicalCol,
      old_value: e.oldValue == null ? null : String(e.oldValue),
      new_value: e.value == null ? null : String(e.value),
      editor_email: editorEmail,
      edited_at: new Date().toISOString()
    };

    const resp = UrlFetchApp.fetch(EDGE_FUNCTION_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + MIRROR_TOKEN },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    console.log('POST done: status=' + resp.getResponseCode() + ' body=' + resp.getContentText().substring(0, 300));
  } catch (err) {
    // Swallow — onEdit must not throw or it can disable the trigger.
    // Errors are visible in the Apps Script execution log.
    console.error('onEdit error:', err);
  }
}

function normaliseHeader(h) {
  if (h == null) return '';
  return String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findColumnByHeader_(sheet, normHeader) {
  const lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) return null;
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  for (let i = 0; i < headers.length; i++) {
    if (normaliseHeader(headers[i]) === normHeader) return i + 1;
  }
  return null;
}
