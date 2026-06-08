# Billing reconciliation + invoicing section — brief for Sasha

Author: Clara (accounts-legal), 2026-06-04. Raised by Charlotte.
Status: ready to build. Supersedes the parked note in `platform/docs/current-handoff.md` S64 Next steps #5 ("`crm.billing_events` empty despite confirmed pulls").

## The problem

Billing currently lives entirely in FreeAgent and is never written back to the DB. Consequences confirmed today against live data:

- `crm.billing_events` is empty (0 rows) despite two invoices issued and pulled (WYK INV-2026-1001, EMS INV-2026-1002 £1,050 pulled 26 May).
- `crm.enrolments` carries `billed_amount`, `billed_at`, `paid_at`, `gocardless_payment_id` columns — all NULL on every row, including the 10 EMS enrolments that were on the April invoice and paid.
- Result: the platform cannot answer "which leads have been billed?" or "which have been paid?". `vw_provider_billing_state` shows cumulative counts (billable_count etc.) but nothing per-lead and nothing about invoice/payment state.
- Knock-on: every monthly invoice has to be reconstructed by hand from enrolment dates because the DB doesn't record what each invoice covered. The EMS May invoice this session hit exactly this — the April invoice line count had to be taken from the changelog, not the DB, and the May-vs-June boundary had to be derived from `status_updated_at` (which gets overwritten by later status changes, so it is not a reliable billing ledger).

This brief makes the DB the billing ledger and surfaces it in admin. Two deliverables Charlotte asked for: (A) an internal per-lead billed/paid view, (B) an invoicing section on the platform.

## Source of truth decision

FreeAgent stays the system of record for the legal invoice document (PDF, sequential number, HMRC). The DB becomes the operational ledger of *what was billed and what was paid per enrolment*, linked to the FreeAgent invoice by reference. The two must reconcile; the DB is what the platform reads.

## Phase 0 — backfill historical state (do first)

Before any UI, get the existing two invoices into the ledger so the view is truthful from day one.

- EMS INV-2026-1002 (April Billing Period): 10 enrolments, 3 free + 7 charged £150 = £1,050 ex VAT, pulled 26 May, received. Set `billed_at` (12 May 2026 issue date), `billed_amount` (£0 on the 3 free, £150 on the 7 charged), `invoice` reference, and `paid_at` (settlement date ~26-29 May) + `gocardless_payment_id` on those 10 EMS enrolment rows. **The exact 10 must be confirmed against the FreeAgent invoice line items** — do not guess from `status_updated_at`. Clara/Charlotte will supply the FreeAgent line list.
- WYK INV-2026-1001: same treatment once Charlotte confirms its line items from FreeAgent.
- Write the matching `crm.billing_events` rows (one per chargeable enrolment, or one summary row per invoice — see schema below).

This is a data-ops job, not a migration. Mirror the `/admin/data-ops` panel pattern (per `feedback_data_ops_admin_panel_pattern`): an Edge Function that takes a list of `{enrolment_id, billed_amount, invoice_reference, billed_at, paid_at, gocardless_payment_id}` and writes them, behind a panel. Keeps it off local scripts (Brevo-key / IPv6 friction) and gives an audit trail.

## Phase A — the data layer

1. **Decide `billing_events` vs enrolment columns.** Recommend: `crm.enrolments` columns are the per-enrolment billing state (one enrolment = one billable unit, simplest for the funded per-enrolment model). `crm.billing_events` is the immutable event log (invoiced / paid / disputed / credited), one row per state change, FK to enrolment + invoice reference. Don't duplicate the truth — the enrolment columns are a denormalised "current state" maintained from the latest billing_event. Document which is authoritative in `data-architecture.md`.
2. **`invoice_reference` consistency.** `crm.billing_events.invoice_reference` already exists; `crm.enrolments` has no invoice column — add `invoice_reference text` to enrolments (additive, schema_version bump per `.claude/rules/schema-versioning.md`).
3. **Billing-period stamping.** Add an explicit `billing_period` (e.g. `date` truncated to month, or `text` '2026-05') to the billing_event so a period is a recorded fact, not derived from mutable `status_updated_at`. This is what fixes the reconstruction problem.
4. **Per-lead billed/paid view** (Charlotte's ask A). New view `crm.vw_enrolment_billing` (or extend an existing leads admin view): one row per enrolment with provider, course, status, billable (y/n after free allowance), `invoice_reference`, `billed_at`, `billed_amount`, `paid_at`, `gocardless_payment_id`, derived `billing_state` ∈ {not_billable, free, billable_unbilled, invoiced_unpaid, paid, disputed}.
   - **PII rule (§6a `data-infrastructure.md`):** billing reconciliation needs no direct identifiers. Build the view identifier-free (no email/name/phone — use submission_id + course + provider). The `readonly_analytics` agent role reads this id-free view. If Charlotte's logged-in admin UI wants the learner name next to a row, join it in the Server Component under the owner/service role, not in the shared view.

## Phase B — the invoicing section (Charlotte's ask B)

New admin section `/admin/billing` (admin.switchleads.co.uk — note admin., not app.). Sits alongside `/admin/providers`. Suggested shape:

1. **Per-provider billing summary** (top): pull from `vw_provider_billing_state` — billable_count, free used/cap — plus new totals from the ledger: invoiced-unpaid £, paid £, outstanding £.
2. **"Billable now" list per provider**: enrolments in a billable status (`enrolled`, `presumed_enrolled`, `signed`, `presumed_employer_signed`), DQ excluded, free allowance applied, **not yet invoiced**, grouped by billing period. This is the "what do I invoice this month" worklist. Show the running £ and the count, so the next EMS/WYK/Riverside invoice is a read, not a reconstruction.
3. **Mark-as-invoiced action**: select the billable rows for a period → enter FreeAgent invoice reference + issue date → writes `billed_at`/`billed_amount`/`invoice_reference` on the enrolments and a `billing_event` per row with `billing_period`. (Charlotte raises the actual invoice in FreeAgent; this records it.)
4. **Mark-as-paid**: ideally automatic. GoCardless sends payment-confirmed webhooks; a `gocardless-payment-webhook` EF can match by invoice reference / mandate and stamp `paid_at` + `gocardless_payment_id` on the enrolments tied to that invoice. Manual "mark paid" fallback for BACS settlements (some providers pay by bank transfer, not DD). Decide webhook-now vs manual-now with Charlotte; manual is fine for v1 given 3-4 providers.
5. **Invoice history**: list of issued invoices (from `billing_events` grouped by `invoice_reference`) with provider, period, amount, paid/unpaid, link out to FreeAgent.

## Phase notes / guardrails

- **Pricing rules live in the PPA** (`accounts-legal/CLAUDE.md` → "what it must cover"): funded £150/enrolment (15% self-funded/loan, min £75 max £150); apprenticeship £400 per Apprenticeship Enrolment (Learner Lead) / £400 per Employer Signed (Employer Lead), flat L2-L7; first 3 free funded, first 1 free per apprenticeship route. `pricing_model` on `crm.providers` already distinguishes `per_enrolment_flat` vs `per_enrolment_percent`. The mark-as-invoiced flow should pre-fill the amount from pricing_model but let Charlotte override (percent courses need the course fee).
- **Free allowance — consumed once, pinned, never reopened on churn.** `vw_provider_billing_state` currently computes free_used as `LEAST(cap 3, live enrolled count)` on the fly. That's recompute-based and fragile: if a free-billed lead later drops out of enrolled status and a new enrolment comes in, the live count still reads "3 free used" today, but the logic isn't pinned to the leads that actually took the free slots. **The billing ledger must consume the free allowance at invoice time and pin it to the specific enrolments that used it** (EMS: subs 25, 32, 45 on INV-2026-1002). A free-billed enrolment that later churns does NOT reopen a free slot to regift to a current lead — the free Enrolment event fired, the allowance is spent. (Distinguish from a successfully *disputed/invalid* lead, which was never a real Enrolment and arguably shouldn't have consumed the slot — flag that edge to Clara/Charlotte when building.) Don't drive billing off the live LEAST() count once the ledger exists. Real example today: EMS sub 45 was free-billed in April then left enrolled status; we are not regifting the freed slot.
- **Presumed enrolments**: billable but carry a 7-day dispute window after billing notification (PPA clause 6). The billing_state enum should distinguish presumed-not-yet-confirmed so Charlotte can hold them. Owner has been excluding presumed from invoices so far (none currently exist).
- **Infra-change rule**: additive columns + new view + new EF + new admin route. Migration files only (never UI edits). RLS — `/admin/billing` is owner-only (service role / admin allowlist), providers must not see it. Log every migration in `platform/docs/changelog.md`. Schema_version bump on the enrolments/billing_events shape change.

## Acceptance

- `/admin/billing` shows, per provider, what is billable this period and the £ outstanding/paid, with no hand reconstruction.
- Every enrolment row can answer billed? (ref + date + amount) and paid? (date + GC id).
- The two historical invoices are backfilled and reconcile to FreeAgent.
- The reporting agent role reads billing through a direct-identifier-free view.
