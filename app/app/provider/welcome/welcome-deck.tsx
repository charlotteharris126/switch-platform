"use client";

// Swipe-through deck rendered by /provider/welcome. Pure client state,
// no persistence — providers can revisit anytime. Slide content is
// audience-conditional (learner vs employer apprenticeship).
//
// Navigation: keyboard arrow keys, prev/next buttons, click-the-dot,
// and touch swipe (left/right drag). The visuals on each slide are
// inline mini-replicas of the real portal UI built with the same
// Tailwind palette as home-view.tsx — no screenshots to maintain.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type Audience = "learner" | "employer";

interface Props {
  audience: Audience;
  greetingName: string;
  providerLabel: string;
}

export function WelcomeDeck({ audience, greetingName, providerLabel }: Props) {
  const slides = audience === "employer"
    ? employerSlides(greetingName, providerLabel)
    : learnerSlides(greetingName, providerLabel);

  const [index, setIndex] = useState(0);
  const total = slides.length;
  const touchStartX = useRef<number | null>(null);

  const goTo = useCallback(
    (i: number) => setIndex(Math.max(0, Math.min(total - 1, i))),
    [total],
  );
  const next = useCallback(() => goTo(index + 1), [index, goTo]);
  const prev = useCallback(() => goTo(index - 1), [index, goTo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev]);

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(dx) > 50) {
      if (dx < 0) next();
      else prev();
    }
    touchStartX.current = null;
  };

  const current = slides[index];
  const isLast = index === total - 1;

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white flex flex-col">
      <div className="max-w-3xl w-full mx-auto px-6 pt-8">
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">
            {providerLabel}
          </p>
          <Link
            href="/provider"
            className="text-xs font-semibold text-slate-500 hover:text-slate-900"
          >
            Skip &rarr;
          </Link>
        </div>

        <div className="mt-4 flex items-center gap-1.5" aria-label="Progress">
          {slides.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => goTo(i)}
              aria-label={`Slide ${i + 1} of ${total}`}
              className={`h-1.5 rounded-full transition-all ${
                i === index
                  ? "bg-slate-900 w-8"
                  : i < index
                    ? "bg-slate-400 w-4"
                    : "bg-slate-200 w-4 hover:bg-slate-300"
              }`}
            />
          ))}
        </div>
      </div>

      <main
        className="flex-1 flex items-center justify-center px-6 py-10"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className="max-w-3xl w-full">
          <div key={index} className="animate-slide-in">
            <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold mb-2">
              Step {index + 1} of {total}
            </p>
            <h1 className="text-3xl md:text-4xl font-semibold text-slate-900 leading-tight">
              {current.title}
            </h1>
            <p className="mt-4 text-base md:text-lg text-slate-700 leading-relaxed">
              {current.body}
            </p>
            {current.visual ? (
              <div className="mt-8">{current.visual}</div>
            ) : null}
          </div>
        </div>
      </main>

      <div className="max-w-3xl w-full mx-auto px-6 pb-10">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={prev}
            disabled={index === 0}
            className="text-sm font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            &larr; Back
          </button>
          {isLast ? (
            <Link
              href="/provider"
              className="inline-flex items-center justify-center rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold px-5 py-2.5 transition-colors"
            >
              Go to my portal &rarr;
            </Link>
          ) : (
            <button
              type="button"
              onClick={next}
              className="inline-flex items-center justify-center rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold px-5 py-2.5 transition-colors"
            >
              Next &rarr;
            </button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes welcome-slide-in {
          from { opacity: 0; transform: translateX(12px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .animate-slide-in {
          animation: welcome-slide-in 220ms ease-out;
        }
      `}</style>
    </div>
  );
}

interface Slide {
  title: string;
  body: string;
  visual?: React.ReactNode;
}

function learnerSlides(name: string, providerLabel: string): Slide[] {
  return [
    {
      title: `Welcome to your SwitchLeads portal, ${name}.`,
      body: `This is where your leads land, where you mark outcomes, and where we talk to you. Quick swipe through what's where. Takes about a minute.`,
      visual: <HeroVisual providerLabel={providerLabel} />,
    },
    {
      title: "Your home page tells you what needs you now.",
      body: "Four cards at the top: fastrack-ready, callback requests, open leads never called, stale attempts. A card only shows a count when there's something to do. Quiet means quiet.",
      visual: <LearnerActionCardsVisual />,
    },
    {
      title: "Every lead lives in one list.",
      body: "Filterable by status, sortable by routed-at. The Leads tab badge tells you how many need attention. Fastrack and callback leads pin to the top.",
      visual: <LearnerLeadsListVisual />,
    },
    {
      title: "Click any lead to see the full picture.",
      body: "Contact details, course, funding category, eligibility flags, fastrack confirmation if they've done it, plus a notes log on the right shared with your team and ours.",
      visual: <LeadDetailVisual audience="learner" />,
    },
    {
      title: "Move the lead forward.",
      body: "Use the stepper to advance through 1st no answer, 2nd, 3rd, Meeting booked, Enrolled. Forward only on the attempts counter, so once you're at 2nd you can't step back to 1st.",
      visual: <StepperVisual states={["1st", "2nd", "3rd", "Meeting", "Enrolled"]} active={1} />,
    },
    {
      title: "Or close it out.",
      body: "Cannot reach when three attempts go nowhere. Lost with a reason when it's gone cold. Both are reversible: tap a different state and the lead's back. The reasons feed back into how we qualify above you.",
      visual: <CloseOutVisual audience="learner" />,
    },
    {
      title: "Notes, callbacks, and the timers.",
      body: "Anything you type on a lead is visible to your team and to us, never to the learner. When we add a note in blue, that's us flagging something. Two timers run on every lead: in your queue (never resets) and at current status (resets each time you move it).",
      visual: <NotesVisual />,
    },
    {
      title: "Your first three enrolments are free.",
      body: "After that, £150 per funded enrolment, 15% (£75 to £150) for self-funded and loan-funded. One invoice a month by Direct Debit. Your free-three progress sits on your Account page.",
      visual: <FreeThreeVisual progress={1} />,
    },
    {
      title: "You're set.",
      body: "If anything looks off, the Support tab inside the portal has a contact form and short answers to the things we get asked most. Or email support@switchleads.co.uk. We aim to reply within one working day.",
      visual: <ReadyVisual />,
    },
  ];
}

function employerSlides(name: string, providerLabel: string): Slide[] {
  return [
    {
      title: `Welcome to your SwitchLeads portal, ${name}.`,
      body: "This is where your employer leads land, where you mark outcomes, and where we talk to you. Quick swipe through what's where. Takes about a minute.",
      visual: <HeroVisual providerLabel={providerLabel} />,
    },
    {
      title: "Your home page tells you what needs you now.",
      body: "Four cards at the top: open leads not yet engaged, engaged, in progress, and the 60-day clock approaching. A card only shows a count when there's something to do. Quiet means quiet.",
      visual: <EmployerActionCardsVisual />,
    },
    {
      title: "Every lead lives in one list.",
      body: "Filterable by status, sortable by routed-at. The Leads tab badge tells you how many need attention. Anything close to its 60-day clock pins to the top.",
      visual: <EmployerLeadsListVisual />,
    },
    {
      title: "Click any lead to see the full picture.",
      body: "Employer contact, company context, the role and standard they're looking for, and a notes log on the right shared with your team and ours.",
      visual: <LeadDetailVisual audience="employer" />,
    },
    {
      title: "Move the lead forward.",
      body: "Use the stepper to advance through Engaged, In progress, and Signed. Forward only on the main stepper, so once you're at In progress you can't step back to Engaged without going through Not signed first.",
      visual: <StepperVisual states={["Engaged", "In progress", "Signed"]} active={1} />,
    },
    {
      title: "The 60-day clock.",
      body: "Once a lead is Engaged or In progress, you have 60 days from your last status update to confirm a Signed outcome. At day 50 you'll see a clock-approaching flag. If nothing changes by day 60, the lead auto-flips to Presumed signed and you'll be billed unless you raise a dispute within 7 days. Updating status resets the clock.",
      visual: <SixtyDayClockVisual />,
    },
    {
      title: "Or close it out.",
      body: "Mark Not signed when an employer won't proceed. You'll be asked for a reason. It's reversible: from the Not signed screen you can move the lead back to Engaged, In progress, or Signed. Reasons feed back into how we qualify above you.",
      visual: <CloseOutVisual audience="employer" />,
    },
    {
      title: "Notes and the timers.",
      body: "Anything you type on a lead is visible to your team and to us, never to the employer. When we add a note in blue, that's us flagging something. Two timers run on every lead: in your queue (never resets) and at current status (resets each time you move it).",
      visual: <NotesVisual />,
    },
    {
      title: "Your first Employer Signed is free.",
      body: "After that, £400 flat per Employer Signed across all apprenticeship levels (L2 to L7). One invoice a month by Direct Debit. Fees are quoted ex VAT for now; VAT will be added once SwitchLeads is registered, with your pilot rate locked on net.",
      visual: <FreeOneVisual progress={0} />,
    },
    {
      title: "You're set.",
      body: "If anything looks off, the Support tab inside the portal has a contact form and short answers to the things we get asked most. Or email support@switchleads.co.uk. We aim to reply within one working day.",
      visual: <ReadyVisual />,
    },
  ];
}

// ---------- Mini-visuals ----------
// Inline replicas of the real portal palette. Tailwind tones mirror
// home-view.tsx so what users see in the deck matches what they see
// once they're in.

function HeroVisual({ providerLabel }: { providerLabel: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
            {providerLabel}
          </p>
          <p className="text-base font-semibold text-slate-900 mt-1">
            Welcome back
          </p>
        </div>
        <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-right">
          <p className="text-[9px] uppercase tracking-widest text-slate-500 font-semibold">
            Enrolments, 30d
          </p>
          <p className="text-2xl font-semibold tabular-nums text-slate-900 leading-none mt-0.5">
            0
          </p>
        </div>
      </div>
    </div>
  );
}

function LearnerActionCardsVisual() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
      <MiniActionCard tone="violet" count={2} label="fastrack" />
      <MiniActionCard tone="rose" count={1} label="callbacks" />
      <MiniActionCard tone="amber" count={4} label="never called" />
      <MiniActionCard tone="orange" count={0} label="stale" />
    </div>
  );
}

function EmployerActionCardsVisual() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
      <MiniActionCard tone="amber" count={3} label="open" />
      <MiniActionCard tone="violet" count={2} label="engaged" />
      <MiniActionCard tone="rose" count={1} label="in progress" />
      <MiniActionCard tone="orange" count={0} label="60-day clock" />
    </div>
  );
}

function MiniActionCard({
  tone,
  count,
  label,
}: {
  tone: "violet" | "rose" | "amber" | "orange";
  count: number;
  label: string;
}) {
  const palette: Record<typeof tone, string> = {
    violet: "bg-violet-50 border-violet-200 text-violet-900",
    rose: "bg-rose-50 border-rose-200 text-rose-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    orange: "bg-orange-50 border-orange-200 text-orange-900",
  };
  return (
    <div className={`border rounded-lg p-3 ${palette[tone]}`}>
      <p className="text-2xl font-semibold tabular-nums leading-none">{count}</p>
      <p className="text-[11px] mt-1 font-medium leading-tight">{label}</p>
    </div>
  );
}

function LearnerLeadsListVisual() {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <MiniLeadRow name="Aaron P." badge="Fastrack" tone="violet" status="Open" pillTone="slate" />
      <MiniLeadRow name="Beth K." badge="Callback" tone="rose" status="Open" pillTone="slate" />
      <MiniLeadRow name="Chiara S." status="1st no answer" pillTone="amber" />
      <MiniLeadRow name="Dev N." status="Meeting booked" pillTone="blue" />
      <MiniLeadRow name="Eli W." status="Enrolled" pillTone="emerald" last />
    </div>
  );
}

function EmployerLeadsListVisual() {
  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <MiniLeadRow name="Avon Joinery Ltd" badge="60-day clock" tone="orange" status="In progress" pillTone="amber" />
      <MiniLeadRow name="Bishop & Sons" status="Engaged" pillTone="blue" />
      <MiniLeadRow name="Crowmark Civils" status="Open" pillTone="slate" />
      <MiniLeadRow name="Dearne Roofing" status="Signed" pillTone="emerald" last />
    </div>
  );
}

function MiniLeadRow({
  name,
  badge,
  tone,
  status,
  pillTone,
  last,
}: {
  name: string;
  badge?: string;
  tone?: "violet" | "rose" | "orange";
  status: string;
  pillTone: "slate" | "amber" | "blue" | "emerald";
  last?: boolean;
}) {
  const badgePalette: Record<NonNullable<typeof tone>, string> = {
    violet: "bg-violet-100 text-violet-800 border-violet-200",
    rose: "bg-rose-100 text-rose-800 border-rose-200",
    orange: "bg-orange-100 text-orange-800 border-orange-200",
  };
  const pillPalette: Record<typeof pillTone, string> = {
    slate: "bg-slate-100 text-slate-700 border-slate-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  };
  return (
    <div
      className={`px-4 py-2.5 flex items-center justify-between gap-3 ${
        last ? "" : "border-b border-slate-100"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <p className="text-sm font-medium text-slate-900 truncate">{name}</p>
        {badge && tone ? (
          <span
            className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${badgePalette[tone]}`}
          >
            {badge}
          </span>
        ) : null}
      </div>
      <span
        className={`text-[11px] font-medium px-2 py-0.5 rounded border ${pillPalette[pillTone]} shrink-0`}
      >
        {status}
      </span>
    </div>
  );
}

function LeadDetailVisual({ audience }: { audience: Audience }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-5 gap-4">
      <div className="md:col-span-3 space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
          {audience === "employer" ? "Employer" : "Learner"} details
        </p>
        <div className="space-y-1.5">
          <MiniField label="Name" value={audience === "employer" ? "Avon Joinery Ltd" : "Aaron Patel"} />
          <MiniField label={audience === "employer" ? "Contact" : "Email"} value={audience === "employer" ? "rachel@avon.co.uk" : "aaron@example.com"} />
          <MiniField label={audience === "employer" ? "Standard" : "Course"} value={audience === "employer" ? "Project Manager L4" : "Digital Marketing L3"} />
          <MiniField label={audience === "employer" ? "Team size" : "Funding"} value={audience === "employer" ? "120 staff, levy-paying" : "Skills Bootcamp"} />
        </div>
      </div>
      <div className="md:col-span-2 bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
          Notes
        </p>
        <div className="space-y-1.5">
          <div className="bg-blue-50 border border-blue-100 rounded p-2 text-[11px] text-blue-900">
            <p className="font-semibold">Switchable</p>
            <p className="leading-snug mt-0.5">
              {audience === "employer"
                ? "Owner already has one apprentice in flight."
                : "Confirmed available evenings."}
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded p-2 text-[11px] text-slate-700">
            <p className="font-semibold text-slate-900">Your team</p>
            <p className="leading-snug mt-0.5">Left voicemail 14:20.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <p className="text-slate-500 w-16 shrink-0">{label}</p>
      <p className="text-slate-900 font-medium truncate">{value}</p>
    </div>
  );
}

function StepperVisual({
  states,
  active,
}: {
  states: string[];
  active: number;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-3">
        Move this lead forward
      </p>
      <div className="flex items-center gap-1.5 overflow-x-auto">
        {states.map((s, i) => (
          <div key={s} className="flex items-center gap-1.5">
            <div
              className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border whitespace-nowrap ${
                i < active
                  ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                  : i === active
                    ? "bg-slate-900 text-white border-slate-900"
                    : "bg-white text-slate-500 border-slate-200"
              }`}
            >
              {s}
            </div>
            {i < states.length - 1 ? (
              <div className="w-3 h-px bg-slate-300" />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function CloseOutVisual({ audience }: { audience: Audience }) {
  const buttons = audience === "employer"
    ? [{ label: "Not signed", tone: "rose" as const }]
    : [
        { label: "Cannot reach", tone: "rose" as const },
        { label: "Lost", tone: "rose" as const },
      ];
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-3">
        Or close this out
      </p>
      <div className="flex flex-wrap gap-2">
        {buttons.map((b) => (
          <button
            key={b.label}
            type="button"
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border bg-rose-50 text-rose-800 border-rose-200 cursor-default"
            tabIndex={-1}
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function NotesVisual() {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
          Activity
        </p>
        <div className="flex items-center gap-2 text-[10px] text-slate-500">
          <span>In queue: 2d</span>
          <span className="w-px h-3 bg-slate-300" />
          <span>At status: 4h</span>
        </div>
      </div>
      <div className="space-y-2">
        <div className="bg-blue-50 border border-blue-100 rounded p-2 text-xs text-blue-900">
          <div className="flex items-center justify-between gap-2 text-[10px] mb-0.5">
            <p className="font-semibold">Switchable</p>
            <p className="opacity-70">10:14</p>
          </div>
          <p className="leading-snug">Asked us to call back after 5pm.</p>
        </div>
        <div className="bg-slate-50 border border-slate-200 rounded p-2 text-xs text-slate-700">
          <div className="flex items-center justify-between gap-2 text-[10px] mb-0.5">
            <p className="font-semibold text-slate-900">You</p>
            <p className="opacity-70">14:20</p>
          </div>
          <p className="leading-snug">Voicemail left. Will retry tomorrow AM.</p>
        </div>
      </div>
    </div>
  );
}

function SixtyDayClockVisual() {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-xs font-semibold text-slate-900">Engaged on 12 Mar</p>
        <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded border bg-orange-50 text-orange-800 border-orange-200">
          Day 52 of 60
        </span>
      </div>
      <div className="relative h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-amber-400" style={{ width: "83%" }} />
        <div className="absolute inset-y-0 right-[17%] w-px bg-rose-500" />
      </div>
      <div className="flex items-center justify-between mt-2 text-[10px] text-slate-500">
        <span>Engaged</span>
        <span>Day 50: clock-approaching flag</span>
        <span>Day 60: auto-flip</span>
      </div>
    </div>
  );
}

function FreeThreeVisual({ progress }: { progress: number }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-3">
        Your free three
      </p>
      <div className="flex items-center gap-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className={`flex-1 h-12 rounded-lg border flex items-center justify-center text-xs font-semibold ${
              i < progress
                ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                : "bg-slate-50 border-slate-200 text-slate-400"
            }`}
          >
            {i < progress ? "Enrolled" : `Free #${i + 1}`}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-slate-500 mt-2">
        Funded: £150 each after. Self-funded and loan-funded: 15%, capped £75 to £150.
      </p>
    </div>
  );
}

function FreeOneVisual({ progress }: { progress: number }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4">
      <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-3">
        Your first Signed
      </p>
      <div className="flex items-center gap-2">
        <div
          className={`flex-1 h-12 rounded-lg border flex items-center justify-center text-xs font-semibold ${
            progress > 0
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-slate-50 border-slate-200 text-slate-400"
          }`}
        >
          {progress > 0 ? "Employer signed" : "Free one"}
        </div>
        <div className="flex-1 h-12 rounded-lg border bg-white border-slate-200 flex items-center justify-center text-xs font-semibold text-slate-600">
          £400 flat after
        </div>
      </div>
      <p className="text-[11px] text-slate-500 mt-2">
        All apprenticeship levels (L2 to L7). Ex VAT pilot rate locked.
      </p>
    </div>
  );
}

function ReadyVisual() {
  return (
    <div className="bg-slate-900 text-white rounded-xl p-5">
      <p className="text-sm font-semibold mb-1">Need anything?</p>
      <p className="text-sm text-slate-200 leading-relaxed">
        Support tab inside the portal, or{" "}
        <span className="font-semibold text-white">
          support@switchleads.co.uk
        </span>
        . One working day max, usually faster.
      </p>
    </div>
  );
}
