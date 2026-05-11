// SwitchLeads provider sheet appender - v2 (canonical, single deployment per sheet).
// Introduced in Session 5, 2026-04-21.
//
// 2026-05-07 update: added "update_by_submission_id" mode for the Fastrack
// form (lead-to-enrol uplift Phase 2). The existing append behaviour is the
// default (no payload change required for routing-confirm or auto-route);
// fastrack-receive sets `mode: "update_by_submission_id"` to find the
// parent lead's row by its `Submission ID` column and update specific
// columns in place (Fastrack Application Filled, Fastrack Details, plus
// Status + Lost Reason on a DQ outcome) instead of appending a new row.
// FIELD_MAP additions: `fastrackapplicationfilled`, `fastrackdetails`,
// `lostreason`. Sheets must be redeployed with this script (and add the
// two new column headers) for fastrack writes to land.
//
// 2026-05-11 update: added "read_all_status" mode for the daily sheet ↔ DB
// drift reconcile cron. Returns one row per data row in the sheet,
// keyed by Submission ID, carrying the cell values for Status, Lost
// Reason, Fastrack Application Filled, and Fastrack Details. The Edge
// Function `sheet-drift-reconcile-daily` calls this mode against every
// active provider's sheet, projects DB state through the same status
// label / lost-reason humaniser the appender writes with, and flags any
// disagreement to dead_letter. Read-only — no cells touched. Sheets
// must be redeployed with this script before they participate in drift
// detection; until redeploy, the cron logs "unknown mode" against that
// provider's sheet and skips comparison.
//
// What v2 does differently from v1:
//   v1: hardcoded column order (Lead ID | Submitted at | ... | Notes) matching
//   the EMS sheet's layout. Every new provider that wanted a different header
//   layout needed a bespoke script variant.
//
//   v2: reads the sheet's own header row (row 1) at append time. For each
//   header, looks up the payload key via FIELD_MAP (a table of header → key
//   aliases). Unknown headers become empty cells - owner fills them manually
//   (Notes, Enrolment date, Charge, etc). Adding a provider = creating a
//   sheet with whichever headers that provider wants, deploying this same
//   script, done. No code change per provider.
//
// Contract with routing-confirm (Session 5 payload):
//   The Edge Function POSTs a full-fat JSON payload - every canonical field
//   in `leads.submissions` plus computed fields (lead_id, course, provider,
//   status). Apps Script v2 picks only the fields whose headers exist in
//   the sheet. Extra payload keys are harmless (ignored). Missing keys for
//   headers that reference them → empty cell.
//
// Deployment steps per sheet (see platform/docs/provider-onboarding-playbook.md):
//   1. Paste this file into the sheet's Apps Script editor (Extensions →
//      Apps Script), replacing anything that's there.
//   2. Set TOKEN below to the current SHEETS_APPEND_TOKEN value.
//   3. Deploy → New deployment → Web app, Execute as: Me (owner), Who has
//      access: Anyone.
//   4. Copy the Web app URL and paste into crm.providers.sheet_webhook_url
//      (via data-ops/007 seed).
//   5. Confirm the sheet has a header row in row 1 covering whichever
//      fields the provider cares about. Any header not in FIELD_MAP is
//      treated as a manual column (left empty by the script - sheet user
//      fills it).
//
// Rotation:
//   SHEETS_APPEND_TOKEN rotates annually, or immediately on any leak.
//   On rotation: update TOKEN below in every deployed sheet AND the
//   Supabase secret in lockstep. Tracked in platform/docs/secrets-rotation.md.
//
// This repo copy has a placeholder token. Each deployed copy has the real
// token substituted before deploy; never commit a real token to the repo.

const TOKEN = 'PASTE_TOKEN_HERE';

// FIELD_MAP: human-friendly sheet header → payload key.
// Lookup is case-insensitive and whitespace-insensitive (see normaliseHeader).
// Multiple headers can map to the same payload key (aliases welcome).
// Keys on the right-hand side match the payload sent by routing-confirm.
//
// Ambiguity note: some headers (e.g. "readiness", "start when") map to
// `start_when`, a self-funded-shape field. For a funded lead that didn't
// collect `start_when`, the cell renders empty. A funded-specific header
// `start_date_checked` → `start_date_checked` (yes/no) is separate. Pick the
// header that matches the cluster of data the provider actually cares about
// so empty cells don't appear.
// If a header appears twice in a sheet (e.g. accidentally duplicated),
// both columns receive the same value - effectively a copy. Not an error,
// just surprising; audit the header row before deploy.
const FIELD_MAP = {
  // Identity / metadata
  'leadid':            'lead_id',
  'lead':              'lead_id',
  'submissionid':      'submission_id',
  'submittedat':       'submitted_at',
  'submitted':         'submitted_at',
  'datereceived':      'submitted_at',
  'received':          'submitted_at',

  'course':            'course',
  'coursetitle':       'course',
  'courseid':          'course_id',
  'courseslug':        'course_id',
  'fundingroute':      'funding_route',
  'funding':           'funding_route',
  'fundingcategory':   'funding_category',
  'category':          'funding_category',

  'provider':          'provider',
  'status':            'status',

  // Learner PII
  'name':              'name',
  'fullname':          'name',
  'firstname':         'first_name',
  'lastname':          'last_name',
  'email':             'email',
  'emailaddress':      'email',
  'phone':             'phone',
  'phonenumber':       'phone',
  'mobile':            'phone',

  // Funded-shape learner fields
  'la':                'la',
  'localauthority':    'la',
  'regionscheme':      'region_scheme',
  'scheme':            'region_scheme',
  'ageband':           'age_band',
  'age':               'age_band',
  'employment':        'employment',
  'employmentstatus':  'employment',
  'priorl3':           'prior_l3',
  'priorlevel3':       'prior_l3',
  'startdatechecked':  'start_date_checked',
  'canstart':          'start_date_checked',
  'readiness':         'start_when',
  'outcomeinterest':   'outcome_interest',
  'outcome':           'outcome_interest',
  'whythiscourse':     'why_this_course',
  'why':               'why_this_course',

  // Self-funded-shape learner fields (Session 5)
  'postcode':          'postcode',
  'region':            'region',
  'reason':            'reason',
  'interest':          'interest',
  'courseinterest':    'interest',
  'situation':         'situation',
  'qualification':     'qualification',
  'qualificationseeking': 'qualification',
  'startwhen':         'start_when',
  'budget':            'budget',
  'coursesselected':   'courses_selected',
  'courses':           'courses_selected',

  // Cohort intake fields (lead payload schema 1.2, migration 0041).
  // NULL on single-cohort / rolling-intake leads → empty cell.
  'preferredintake':   'preferred_intake_id',
  'acceptableintakes': 'acceptable_intake_ids',

  // Notes / comments column. Auto-populated by route-lead.ts for prior-
  // submission matches ("Previously applied for X on date") and for
  // re-applications ("Re-applied — see <parent-id> above"). Not a manual
  // column — the Edge Function owns this value. Bug fix 2026-04-30: these
  // entries were missing from v2, so cross-course duplicate notes have
  // been silently dropped on every provider's sheet since each migrated
  // off v1. Each bound script copy needs to be redeployed.
  'notes':             'notes',
  'note':              'notes',
  'comment':           'notes',
  'comments':          'notes',

  // Fastrack columns (lead-to-enrol uplift Phase 2, 2026-05-07).
  // Updated in place by fastrack-receive via "update_by_submission_id"
  // mode. Happy path writes `fastracked` ("yes") + `fastrack_notes`
  // (composed summary). DQ paths additionally write `lost_reason` and
  // flip `status` to "Lost".
  'fastrackapplicationfilled': 'fastracked',
  'fastracked':                'fastracked',
  'fastrackdetails':           'fastrack_notes',
  'fastracknotes':             'fastrack_notes',
  'lostreason':                'lost_reason',
};

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) {
      return json_({ok: false, error: 'unauthorized'});
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    const lastColumn = sheet.getLastColumn();
    if (lastColumn < 1) {
      return json_({ok: false, error: 'sheet has no columns; add a header row first'});
    }

    const headerRange = sheet.getRange(1, 1, 1, lastColumn);
    const headers = headerRange.getValues()[0];

    const mode = body.mode || 'append';

    if (mode === 'append') {
      return handleAppend_(sheet, headers, body);
    }
    if (mode === 'update_by_submission_id') {
      return handleUpdateBySubmissionId_(sheet, headers, lastColumn, body);
    }
    if (mode === 'read_all_status') {
      return handleReadAllStatus_(sheet, headers, lastColumn);
    }
    return json_({ok: false, error: 'unknown mode: ' + mode});
  } catch (err) {
    return json_({ok: false, error: String(err)});
  }
}

// Append mode: build a fresh row from each header by reading the matching
// payload key, leave unknown headers blank. Used by routing-confirm + the
// auto-route hook for new leads.
function handleAppend_(sheet, headers, body) {
  const rowValues = headers.map(function(header) {
    const key = FIELD_MAP[normaliseHeader_(header)];
    if (!key) return ''; // unknown header - leave blank for manual fill

    const raw = body[key];
    if (raw === null || raw === undefined) return '';

    // Default to 'open' if the header is 'status' and the payload omitted it.
    if (key === 'status' && raw === '') return 'open';

    return raw;
  });

  sheet.appendRow(rowValues);
  return json_({ok: true, mode: 'append', row: sheet.getLastRow()});
}

// Update-by-submission-id mode: find the row whose `Submission ID` column
// matches body.submission_id, then write only the cells whose payload values
// are non-empty. Errors with no write if zero or multiple rows match.
//
// Used by fastrack-receive to set the fastrack columns (and on a DQ flip,
// status + lost_reason) on the parent lead's existing row, rather than
// appending a duplicate row.
function handleUpdateBySubmissionId_(sheet, headers, lastColumn, body) {
  const sid = body.submission_id;
  if (sid === null || sid === undefined || sid === '') {
    return json_({ok: false, error: 'submission_id required for update_by_submission_id mode'});
  }

  // Find the Submission ID column.
  let submissionIdCol = -1;
  for (let c = 0; c < headers.length; c++) {
    if (FIELD_MAP[normaliseHeader_(headers[c])] === 'submission_id') {
      submissionIdCol = c;
      break;
    }
  }
  if (submissionIdCol === -1) {
    return json_({ok: false, error: 'sheet has no Submission ID column for update mode'});
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return json_({ok: false, error: 'sheet has no data rows to update'});
  }

  // Read all data rows (row 2..lastRow) and locate the target by string
  // equality on the Submission ID cell. String comparison handles both
  // numeric (Sheets stores submission_id as Number) and string-typed cells.
  const data = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  const needle = String(sid);
  let target = -1;
  let matches = 0;
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][submissionIdCol]) === needle) {
      target = i;
      matches++;
    }
  }
  if (matches === 0) {
    return json_({ok: false, error: 'no row found with submission_id ' + needle});
  }
  if (matches > 1) {
    return json_({ok: false, error: matches + ' rows match submission_id ' + needle + '; expected exactly one'});
  }

  const sheetRow = target + 2; // +1 header, +1 to convert 0-indexed to 1-indexed

  let updates = 0;
  for (let col = 0; col < headers.length; col++) {
    const key = FIELD_MAP[normaliseHeader_(headers[col])];
    if (!key) continue;
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const v = body[key];
    if (v === null || v === undefined || v === '') continue;
    sheet.getRange(sheetRow, col + 1).setValue(v);
    updates++;
  }

  return json_({ok: true, mode: 'update_by_submission_id', row: sheetRow, updates: updates});
}

// Read-all-status mode: scan every data row (row 2..lastRow) and return
// one JSON object per row carrying the Submission ID and the cell values
// for the drift-relevant headers (status, lost_reason, fastracked,
// fastrack_notes). Used by sheet-drift-reconcile-daily once a day to
// confirm the sheet still agrees with the DB. Read-only — no cells
// touched.
//
// Rows without a Submission ID column value are skipped (the column may
// be blank for legacy rows added before Session 34's column rollout).
// Skipped rows are reported in the `skipped_no_submission_id` count so
// the operator knows whether the sheet still has uncovered drift surface.
function handleReadAllStatus_(sheet, headers, lastColumn) {
  // Map sheet column index → canonical payload key (or null if header
  // isn't in FIELD_MAP). Only payload keys we care about for drift are
  // emitted in the output rows; everything else is ignored.
  const READ_KEYS = ['submission_id', 'status', 'lost_reason', 'fastracked', 'fastrack_notes'];
  const keyByCol = headers.map(function(h) {
    const key = FIELD_MAP[normaliseHeader_(h)];
    return key && READ_KEYS.indexOf(key) !== -1 ? key : null;
  });

  // Sheet must have a Submission ID column for drift detection. Without
  // it we can't key DB rows back to sheet rows, so the cron caller logs
  // a one-off "no Submission ID column" alert and skips this provider.
  const hasSubmissionIdCol = keyByCol.indexOf('submission_id') !== -1;
  if (!hasSubmissionIdCol) {
    return json_({ok: false, error: 'sheet has no Submission ID column for read_all_status mode'});
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return json_({ok: true, mode: 'read_all_status', rows: [], skipped_no_submission_id: 0});
  }

  const data = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  const rows = [];
  let skippedNoSid = 0;
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const out = {};
    for (let c = 0; c < keyByCol.length; c++) {
      const key = keyByCol[c];
      if (!key) continue;
      const v = row[c];
      if (v === '' || v === null || v === undefined) continue;
      // submission_id is stored numerically in sheets; stringify so the
      // caller can compare against DB ids without worrying about types.
      out[key] = key === 'submission_id' ? String(v) : v;
    }
    if (!out.submission_id) {
      skippedNoSid++;
      continue;
    }
    rows.push(out);
  }

  return json_({
    ok: true,
    mode: 'read_all_status',
    rows: rows,
    skipped_no_submission_id: skippedNoSid
  });
}

// Normalise a header cell for FIELD_MAP lookup: lowercase, strip all
// whitespace and non-alphanumerics. Accepts "Lead ID", "lead id", "LEAD_ID",
// "Lead-id" all as the same header. Matches the FIELD_MAP keys, which are
// lowercase alphanumeric only.
function normaliseHeader_(header) {
  return String(header || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
