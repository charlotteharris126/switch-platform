# Billing state across all providers , for the /admin/billing build

For Sasha, from Clara. 2026-06-08. Charlotte + Sasha working this tonight.
Companion to the build brief: `platform/docs/billing-section-brief-2026-06-04.md` (ticket 869djrtgk). This doc is the **authoritative current billing ledger** so the Phase 0 backfill starts truthful.

## Why this is urgent (the near-miss)

While preparing EMS's May invoice tonight, Charlotte had **the six April enrolments queued again by mistake** (subs 108/119/122/163/225/227) , they'd already been charged and paid on the April invoice. Caught it by eye only. The DB has no record of what's been billed, so nothing systemic stops a double-charge. That is exactly what `/admin/billing` has to prevent: the invoice worklist must show only what has **not** already been billed.

## The ledger (reconciled against live `crm.enrolments`, 2026-06-08)

Billing lives in FreeAgent; the DB has no billed/paid flags yet (the whole point of the build). "Billed to date" below is from the FreeAgent invoices; "outstanding" is enrolled rows not yet on any invoice.

| Provider | Billed to date (FreeAgent) | Outstanding to bill | Notes |
|---|---|---|---|
| **Enterprise Made Simple** | **INV-2026-1002** (April), £1,050 , 10 enrolments: 3 free (subs 25, 32, 45) + 7 × £150 (subs 48, 108, 119, 122, 163, 225, 227). Paid 26 May. | **INV-2026-1003** (May), £900 , 6 × £150, subs **194, 208, 302, 310, 374, 379**. Raised, sending 10 June. **Plus sub 247** (confirmed 2 June) → goes on the **June** invoice. | 3 `presumed_enrolled` exist but are **deliberately not billed** (owner policy , presumed is a signal, not an auto-invoice). Sub 45 was free-billed in April then later left `enrolled` status; the free slot is **not** reopened. |
| **WYK Digital** | **INV-2026-1001** (May), £150 , 4 enrolments: 3 free + 1 × £150. Paid 21 May. Covers all 4 enrolled (subs 77, 88, 95, 100). | **None.** All 4 enrolled are billed; provider paused, no new enrolments since 10 May. | Confirm which sub was the charged one from the FreeAgent invoice line items for the backfill. |
| **Courses Direct** | None | None , 0 enrolments to date | Pre-billable. Self-funded route (15% of fee, min £75 / max £150), not flat £150. |
| **Riverside Training** | None | None , 0 Employer Signed / 0 apprenticeship enrolments to date | First Employer Signed is free (pilot). Apprenticeship pricing, not £150. |
| demo-provider-ltd | , | , | Test data, exclude. |

## Rules the ledger/UI must encode (so it can't re-create the near-miss)

1. **An enrolment is billed once.** Once it's on an invoice it never appears on the "to bill" list again. This is the missing guard.
2. **Free allowance: consumed once, pinned to the enrolments that used it, never reopened.** EMS used its 3 on subs 25/32/45 (April). WYK used its 3 on 3 of {77,88,95,100}. A free-billed lead later churning does NOT free up a slot.
3. **`presumed_enrolled` / `presumed_employer_signed` are NOT auto-billed.** Owner reviews and confirms before anything presumed is invoiced. Show them as a separate "pending confirmation" state, not in the billable total.
4. **Pricing differs by provider/route**, don't hardcode £150: EMS/WYK funded flat £150; Courses Direct self-funded 15% (min £75/max £150); Riverside apprenticeship (£400 Employer Signed / £300 Learner Lead, first employer free). Drive off `crm.providers.pricing_model` + free cap.
5. **Monthly cadence:** one invoice per provider per calendar month, covering that month's confirmed enrolments, raised in FreeAgent and sent on the 10th of the following month. Line-ref format Charlotte uses: `SL-YY-MM-{submission_id}`.
6. **FreeAgent stays the system of record for the invoice document;** the DB becomes the operational ledger of what's billed/paid, linked by invoice reference. They must reconcile.

## Phase 0 backfill , exact inputs needed from FreeAgent

To seed the ledger truthfully, get the line items + paid dates for:
- **INV-2026-1001** (WYK) , which 4 subs, which 1 was charged, paid 21 May.
- **INV-2026-1002** (EMS April) , confirmed above (10 subs), paid 26 May.
- **INV-2026-1003** (EMS May) , once Charlotte raises it (6 subs, £900).

Then stamp `billed_at` / `billed_amount` / `invoice_reference` / `billing_period` on those enrolment rows + write the matching `crm.billing_events`, per the brief.

## Open data point
Confirm INV-2026-1003 is the next free invoice number in FreeAgent before EMS's May invoice sends.
