// SwitchLeads provider sheet appender - v2 (canonical, single deployment per sheet).
// Introduced in Session 5, 2026-04-21.
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

    // Build the row by looking up each header in FIELD_MAP and reading the
    // matching payload key. A header not in FIELD_MAP yields an empty cell
    // (NOT an error - that's a manual column the provider fills in later,
    // e.g. Notes, Enrolment date, Charge).
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
    return json_({ok: true, row: sheet.getLastRow()});
  } catch (err) {
    return json_({ok: false, error: String(err)});
  }
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
