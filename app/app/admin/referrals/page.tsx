import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MarkPaidRowAction, ManualReviewRowAction } from "./row-actions";

export const dynamic = "force-dynamic";

interface ReferralRow {
  id: number;
  referrer_lead_id: number;
  referred_lead_id: number;
  voucher_status: string;
  voucher_amount_pence: number;
  needs_manual_review: boolean;
  fraud_reason: string | null;
  notes: string | null;
  vendor: string | null;
  vendor_payment_id: string | null;
  eligible_at: string | null;
  voucher_paid_at: string | null;
  created_at: string;
}

interface SubmissionLite {
  id: number;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  course_id: string | null;
}

function gbpFromPence(p: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(p / 100);
}

function fullName(s: SubmissionLite | undefined): string {
  if (!s) return "—";
  const parts = [s.first_name, s.last_name].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : (s.email ?? `Lead #${s.id}`);
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function timeSince(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "<1h ago";
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default async function ReferralsPage() {
  const supabase = await createClient();

  // Three queries fan out in parallel: eligible queue, manual-review queue,
  // recent paid (last 30 days). All share the same row shape; rendering split
  // by section.
  const cutoff30d = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const [eligibleRes, reviewRes, paidRes] = await Promise.all([
    supabase
      .schema("leads")
      .from("referrals")
      .select(
        "id,referrer_lead_id,referred_lead_id,voucher_status,voucher_amount_pence,needs_manual_review,fraud_reason,notes,vendor,vendor_payment_id,eligible_at,voucher_paid_at,created_at",
      )
      .eq("voucher_status", "eligible")
      .eq("needs_manual_review", false)
      .is("voucher_paid_at", null)
      .order("eligible_at", { ascending: true }),
    supabase
      .schema("leads")
      .from("referrals")
      .select(
        "id,referrer_lead_id,referred_lead_id,voucher_status,voucher_amount_pence,needs_manual_review,fraud_reason,notes,vendor,vendor_payment_id,eligible_at,voucher_paid_at,created_at",
      )
      .eq("needs_manual_review", true)
      .not("voucher_status", "in", "(paid,fraud_rejected)")
      .order("eligible_at", { ascending: true, nullsFirst: false }),
    supabase
      .schema("leads")
      .from("referrals")
      .select(
        "id,referrer_lead_id,referred_lead_id,voucher_status,voucher_amount_pence,needs_manual_review,fraud_reason,notes,vendor,vendor_payment_id,eligible_at,voucher_paid_at,created_at",
      )
      .eq("voucher_status", "paid")
      .gte("voucher_paid_at", cutoff30d)
      .order("voucher_paid_at", { ascending: false })
      .limit(50),
  ]);

  const eligible = (eligibleRes.data ?? []) as ReferralRow[];
  const review = (reviewRes.data ?? []) as ReferralRow[];
  const paid = (paidRes.data ?? []) as ReferralRow[];

  // Pull every referrer + referred submission in one round-trip so we can
  // render names + emails without per-row queries.
  const submissionIds = new Set<number>();
  for (const r of [...eligible, ...review, ...paid]) {
    submissionIds.add(r.referrer_lead_id);
    submissionIds.add(r.referred_lead_id);
  }
  const subsRes = submissionIds.size
    ? await supabase
        .schema("leads")
        .from("submissions")
        .select("id,email,first_name,last_name,course_id")
        .in("id", Array.from(submissionIds))
    : { data: [] as SubmissionLite[] };
  const subsById = new Map<number, SubmissionLite>();
  for (const s of (subsRes.data ?? []) as SubmissionLite[]) subsById.set(s.id, s);

  const queryError =
    eligibleRes.error?.message ??
    reviewRes.error?.message ??
    paidRes.error?.message ??
    null;

  return (
    <div className="max-w-6xl space-y-8">
      <PageHeader
        eyebrow="Operations"
        title="Referrals"
        subtitle={
          queryError ? (
            <span className="text-[#b3412e]">Error loading referrals: {queryError}</span>
          ) : (
            <>
              Manual voucher fulfilment queue. Send the Amazon e-gift card via amazon.co.uk, then
              mark paid here so the referrer's row closes.
            </>
          )
        }
      />

      <Section
        title="Eligible, awaiting payout"
        count={eligible.length}
        emptyMessage="No referrals waiting for payout. Nothing to send right now."
        accent="primary"
      >
        {eligible.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Friend (referred)</TableHead>
                <TableHead>Referrer</TableHead>
                <TableHead className="text-right">Voucher</TableHead>
                <TableHead>Eligible since</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {eligible.map((r) => {
                const friend = subsById.get(r.referred_lead_id);
                const referrer = subsById.get(r.referrer_lead_id);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs">
                      <div className="font-semibold">{fullName(friend)}</div>
                      <div className="text-[#5a6a72]">{friend?.email ?? "—"}</div>
                      <div className="text-[10px] text-[#5a6a72]">
                        <Link href={`/leads/${r.referred_lead_id}`} className="text-[#cd8b76] hover:underline">
                          #{r.referred_lead_id}
                        </Link>
                        {friend?.course_id ? <span className="ml-2">{friend.course_id}</span> : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="font-semibold">{fullName(referrer)}</div>
                      <div className="text-[#5a6a72]">{referrer?.email ?? "—"}</div>
                      <div className="text-[10px] text-[#5a6a72]">
                        <Link href={`/leads/${r.referrer_lead_id}`} className="text-[#cd8b76] hover:underline">
                          #{r.referrer_lead_id}
                        </Link>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-right font-bold">
                      {gbpFromPence(r.voucher_amount_pence)}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div>{formatDateTime(r.eligible_at)}</div>
                      <div className="text-[10px] text-[#5a6a72]">
                        {r.eligible_at ? timeSince(r.eligible_at) : "—"}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <MarkPaidRowAction referralId={r.id} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
      </Section>

      <Section
        title="Awaiting manual review"
        count={review.length}
        emptyMessage="No referrals flagged for review. Soft cap is breathing easy."
        accent="warning"
      >
        {review.length > 0 ? (
          <>
            <p className="text-[11px] text-[#5a6a72] -mt-2 mb-3 italic">
              These referrers crossed the 10-in-90-days soft cap. Approve to release the voucher,
              reject to mark as fraud.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Friend (referred)</TableHead>
                  <TableHead>Referrer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {review.map((r) => {
                  const friend = subsById.get(r.referred_lead_id);
                  const referrer = subsById.get(r.referrer_lead_id);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs">
                        <div className="font-semibold">{fullName(friend)}</div>
                        <div className="text-[#5a6a72]">{friend?.email ?? "—"}</div>
                        <div className="text-[10px] text-[#5a6a72]">
                          <Link href={`/leads/${r.referred_lead_id}`} className="text-[#cd8b76] hover:underline">
                            #{r.referred_lead_id}
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="font-semibold">{fullName(referrer)}</div>
                        <div className="text-[#5a6a72]">{referrer?.email ?? "—"}</div>
                        <div className="text-[10px] text-[#5a6a72]">
                          <Link href={`/leads/${r.referrer_lead_id}`} className="text-[#cd8b76] hover:underline">
                            #{r.referrer_lead_id}
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="inline-flex px-2 py-0.5 bg-[#FBE5CB] text-[#b3412e] rounded text-[10px] font-bold uppercase tracking-wide">
                          {r.voucher_status}
                        </span>
                        <div className="text-[10px] text-[#5a6a72] mt-1">
                          Cap exceeded ({r.eligible_at ? `eligible ${timeSince(r.eligible_at)}` : `created ${timeSince(r.created_at)}`})
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <ManualReviewRowAction referralId={r.id} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </>
        ) : null}
      </Section>

      <Section
        title="Recent paid (last 30 days)"
        count={paid.length}
        emptyMessage="No vouchers sent in the last 30 days."
        accent="muted"
      >
        {paid.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Friend</TableHead>
                <TableHead>Referrer</TableHead>
                <TableHead className="text-right">Voucher</TableHead>
                <TableHead>Paid at</TableHead>
                <TableHead>Reference</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paid.map((r) => {
                const friend = subsById.get(r.referred_lead_id);
                const referrer = subsById.get(r.referrer_lead_id);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs">
                      <div className="font-semibold">{fullName(friend)}</div>
                      <div className="text-[10px] text-[#5a6a72]">
                        <Link href={`/leads/${r.referred_lead_id}`} className="text-[#cd8b76] hover:underline">
                          #{r.referred_lead_id}
                        </Link>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="font-semibold">{fullName(referrer)}</div>
                      <div className="text-[10px] text-[#5a6a72]">{referrer?.email ?? "—"}</div>
                    </TableCell>
                    <TableCell className="text-xs text-right font-bold">
                      {gbpFromPence(r.voucher_amount_pence)}
                    </TableCell>
                    <TableCell className="text-xs">{formatDateTime(r.voucher_paid_at)}</TableCell>
                    <TableCell className="text-xs text-[#5a6a72]">
                      <code className="text-[10px]">{r.vendor_payment_id ?? "—"}</code>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
      </Section>
    </div>
  );
}

function Section({
  title,
  count,
  emptyMessage,
  accent,
  children,
}: {
  title: string;
  count: number;
  emptyMessage: string;
  accent: "primary" | "warning" | "muted";
  children: React.ReactNode;
}) {
  const accentBg =
    accent === "primary"
      ? "bg-[#D8E5E2] text-[#287271]"
      : accent === "warning"
        ? "bg-[#FBE5CB] text-[#b3412e]"
        : "bg-[#F4F4F2] text-[#5a6a72]";

  return (
    <section>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-[10px] font-bold uppercase tracking-[2px] text-[#5a6a72]">{title}</h2>
        <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold ${accentBg}`}>
          {count}
        </span>
      </div>
      {count === 0 ? (
        <p className="text-xs text-[#5a6a72] italic">{emptyMessage}</p>
      ) : (
        <div className="bg-white border border-[#dad4cb] rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(17,36,46,0.04)]">
          {children}
        </div>
      )}
    </section>
  );
}
