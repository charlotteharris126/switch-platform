# Feature request — status-driven Brevo sync from admin dashboard

**Raised:** 30 April 2026 (switchable/email session)
**Owner pain:** owner currently has to open Brevo, search the contact, and manually add them to the right list every time a provider reports "couldn't reach the learner". This becomes high-friction at volume — daily, across every provider, every cannot-contact lead.
**Goal:** status changes in the admin dashboard should drive the corresponding Brevo automation directly, with no second tool to open.

---

## Current operational gap

The platform recently shipped `SW_ENROL_STATUS` as a Brevo Category attribute, mirroring `crm.enrolments.status`. New leads and backfilled contacts both carry the right value. But there is no automatic write path from a status update to a Brevo list change. Every chase email today requires the owner to:

1. Update status in the dashboard
2. Open Brevo
3. Search by email
4. Add the contact to `Switchable - Provider tried no answer`
5. (Brevo automation then fires SF2 funded / SF2 self based on the existing filter)

Steps 2-4 are what this feature removes.

## Proposed shape

When the dashboard saves a status change in `crm.enrolments`, the same handler also:

1. Calls the existing `_shared/brevo.ts` upsert helper to push `SW_ENROL_STATUS = <new value>` to the Brevo contact (idempotent on email).
2. Adds the Brevo contact to the appropriate list based on the new status:

| New status | Brevo list to add to | Triggers |
|---|---|---|
| `cannot_contact` | `Switchable - Provider tried no answer` | SF2 funded or SF2 self (existing automations) |
| `enrolled` | (future) `Switchable - Newly enrolled` | U4 enrol celebration (template not built yet) |
| `presumed_enrolled` | (future) `Switchable - Presumed enrolled confirm` | Confirmation email (template not built yet) |
| `lost` | none | nothing — just DB update |
| `open` | none | nothing — back to default state |

The owner never has to touch Brevo for routine status work. The dashboard becomes the single operational hub. Brevo becomes a notification target, not a place to manage state.

## Implementation hints

- Existing pattern: `routing-confirm` and `netlify-lead-router` already call `upsertLearnerInBrevo` (which adds to lists). Same helper composition can be reused — the only new piece is conditional list selection by status.
- Existing automation triggers stay the same. SF2 funded + SF2 self are already wired to the `Switchable - Provider tried no answer` list. No Brevo dashboard changes needed for the current cannot_contact case.
- Future statuses (enrolled, presumed_enrolled) need the corresponding Brevo lists + automations to be built first. The platform side of this feature can ship in stages: cannot_contact first (existing automation), then the others as their templates land.
- Bulk: dashboard should support bulk-select-and-set-status. The handler then loops the same single-contact logic per row, or batches via a single Edge Function call. Either is fine.
- Best-effort posture: a Brevo failure should not block the DB write. Log to `leads.dead_letter` (source = `dashboard_status_brevo_sync`) so Sasha catches recurring failures.

## Acceptance criteria

- Owner can bulk-select rows in the admin dashboard, change status to `cannot_contact`, save, and SF2 fires for every selected learner without further action.
- DB row in `crm.enrolments` updated.
- Brevo contact's `SW_ENROL_STATUS` attribute reflects the new value within seconds.
- Brevo contact has been added to the right list (auto-removed at end of automation, same as today's pattern).
- Failure paths log to `leads.dead_letter`, do not block the DB update.
- Audit row written for the status change.

## Phased delivery

1. **Phase 1 (immediate value):** wire the cannot_contact path. Existing SF2 automations already handle the rest. Single status, single list, immediate operational win.
2. **Phase 2 (when U4 ships):** wire the enrolled path.
3. **Phase 3 (when presumed-enrolled confirmation ships):** wire that path.
4. **Phase 4 (lost / re-engagement):** evaluate whether `lost` should also drive a "we'd love to know why" survey email later.

## Why this matters

- Owner workflow: removes a recurring per-day friction point. Compounds as volume grows.
- Single source of truth: status decisions are made and recorded in one place (DB), and downstream comms follow automatically.
- Scales: every future status that needs a corresponding email can be plumbed by adding one row to the status→list mapping.
- Reduces manual error: less chance of forgetting to fire a chase, or firing it for the wrong learner.

## Out of scope

- This does not replace the manual single-contact path in Brevo for one-off ad-hoc operations. The list-add trigger stays open in case the owner wants to fire a chase for someone outside the dashboard's view.
- This does not change SF2 template content, SW_FUNDING_CATEGORY filter logic, or any automation entry condition.
