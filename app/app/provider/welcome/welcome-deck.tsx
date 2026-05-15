"use client";

// Swipe-through deck rendered by /provider/welcome. Pure client state,
// no persistence — providers can revisit anytime. Slide content is
// audience-conditional (learner vs employer apprenticeship).
//
// Navigation: keyboard arrow keys, prev/next buttons, click-the-dot,
// and touch swipe (left/right drag). Each slide's visual is a faithful
// replica of the real portal UI (matching home-view.tsx ActionCard,
// the real lead-detail stepper, real status pills, real free-enrolment
// progress widget). Animations fire when a slide becomes active so the
// user sees state change every time they swipe forward.

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

type Audience = "learner" | "employer";

export interface SlaTerms {
  agreementVersion: "v1" | "v2";
  firstAttemptHours: number;
  attemptsRequired: number;
  attemptWindowDays: number;
  staleAttemptHours: number;
  presumedFlipDays: number;
}

interface Props {
  audience: Audience;
  greetingName: string;
  providerLabel: string;
  slaTerms: SlaTerms;
  // Server Action that flips crm.provider_users.welcome_completed_at
  // + sla_accepted_at + writes an audit row, then redirects to
  // /provider. Fired by the final-slide "I agree" button.
  onComplete: () => Promise<void>;
}

export function WelcomeDeck({ audience, greetingName, providerLabel, slaTerms, onComplete }: Props) {
  const slides = audience === "employer"
    ? employerSlides(greetingName, providerLabel)
    : learnerSlides(greetingName, providerLabel);

  const [index, setIndex] = useState(0);
  const [completing, startCompleteTransition] = useTransition();
  const [agreed, setAgreed] = useState(false);
  // total = data slides (1..N-1) + 1 SLA terminator (index N-1).
  const total = slides.length + 1;
  const slaIndex = slides.length;
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

  const isSlaSlide = index === slaIndex;
  const isLast = isSlaSlide;
  const current = isSlaSlide ? null : slides[index];

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white flex flex-col">
      <div className="max-w-3xl w-full mx-auto px-6 pt-8">
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs uppercase tracking-widest text-slate-500 font-semibold">
            {providerLabel}
          </p>
          <p className="text-xs text-slate-400">
            {index + 1} of {total}
          </p>
        </div>

        <div className="mt-4 flex items-center gap-1.5" aria-label="Progress">
          {Array.from({ length: total }).map((_, i) => (
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
            {isSlaSlide ? (
              <SlaSlide
                audience={audience}
                slaTerms={slaTerms}
                agreed={agreed}
                onAgreedChange={setAgreed}
              />
            ) : (
              <>
                <h1 className="text-3xl md:text-4xl font-semibold text-slate-900 leading-tight">
                  {current!.title}
                </h1>
                <p className="mt-4 text-base md:text-lg text-slate-700 leading-relaxed">
                  {current!.body}
                </p>
                {current!.visual ? (
                  <div className="mt-8">{current!.visual}</div>
                ) : null}
              </>
            )}
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
            <button
              type="button"
              disabled={completing || !agreed}
              onClick={() => {
                startCompleteTransition(() => {
                  onComplete().catch(() => {});
                });
              }}
              className="inline-flex items-center justify-center rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold px-5 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {completing ? "Taking you in..." : "I agree, take me in →"}
            </button>
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
        .animate-slide-in { animation: welcome-slide-in 220ms ease-out; }
        @keyframes welcome-fade-up {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-up { animation: welcome-fade-up 380ms ease-out backwards; }
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
      title: `Welcome, ${name}!`,
      body: "This is a quick tour of the portal so you can find your way around.",
      visual: <HeroVisual providerLabel={providerLabel} />,
    },
    {
      title: "Your home page is built around what needs you now.",
      body: "Four cards sit at the top, and each one only shows a number when there's something for you to action. So if it's quiet, you really are on top of things. Each card shows how long the oldest item has been waiting, and an Overdue badge fires when something needs urgent attention, so the most pressing leads are always the first thing you see.",
      visual: <AnimatedActionCards audience="learner" />,
    },
    {
      title: "Every lead lives in one place.",
      body: "All your leads are filterable by status from the Leads tab. We pin anything we've flagged for you, like a fastrack-ready learner or a callback we've taken on your behalf, right at the top so it's the first thing you see.",
      visual: <AnimatedLeadsList audience="learner" />,
    },
    {
      title: "Open a lead to see the full picture.",
      body: "You'll see their contact details, what course they're after, which funding route they're eligible for, and anything they've told us on the fastrack form. The right-hand panel is where the notes live, and your team and ours both write in it.",
      visual: <LeadDetailVisual audience="learner" />,
    },
    {
      title: "Walk them through the stages as you go.",
      body: "The stepper runs from Open through three call-attempt states, into Meeting booked, and ends at Enrolled. You can jump forward whenever the learner moves, like straight to Enrolled if they sign up on the first call.",
      visual: <AnimatedStepper audience="learner" />,
    },
    {
      title: "And this part really matters.",
      body: "Every status you set kicks off something on our side. Nurture emails go out to the learner based on where you've got to, and the leads we send you next get smarter from how previous ones turned out. So keeping statuses up to date is the single most useful thing you can do in here.",
      visual: <AutomationsVisual audience="learner" />,
    },
    {
      title: "Closing one out is just as easy.",
      body: "Mark them Cannot reach after three solid attempts on different days, or Lost with a reason if it's gone cold. Both are fully reversible, so if you misclick or the learner comes back to you, you can pop them straight back into the flow.",
      visual: <CloseOutVisual audience="learner" />,
    },
    {
      title: "Notes are for your team and ours, never the learner.",
      body: "Anything you type on a lead stays inside your team and our support team. The learner never sees it. When we leave a note for you, like a callback request or anything time-sensitive, our note shows up in blue and we email you straight away so it doesn't get missed. Two timers sit at the top of every lead, one for total time in your queue, and one for how long it's been since you last updated their status.",
      visual: <AnimatedNotes audience="learner" />,
    },
    {
      title: "Got a question? Support is one click away.",
      body: "The Support tab inside the portal has shortcuts to the questions we get asked most, plus a quick form that comes straight to us. You can also email support@switchleads.co.uk if that's easier. Either way, we aim to come back to you within one working day.",
      visual: <SupportVisual />,
    },
  ];
}

function employerSlides(name: string, providerLabel: string): Slide[] {
  return [
    {
      title: `Welcome, ${name}!`,
      body: "This is a quick tour of the portal so you can find your way around.",
      visual: <HeroVisual providerLabel={providerLabel} />,
    },
    {
      title: "Your home page is built around what needs you now.",
      body: "Four cards sit at the top, and each one only shows a number when there's something for you to action. So if it's quiet, you really are on top of things. Each card shows how long the oldest item has been waiting, and an Overdue badge fires when something needs urgent attention, so the most pressing leads are always the first thing you see.",
      visual: <AnimatedActionCards audience="employer" />,
    },
    {
      title: "Every employer lead lives in one place.",
      body: "All your leads are filterable by status from the Leads tab. Anything close to its 60-day clock pins to the top, so the at-risk ones are always the first thing you see.",
      visual: <AnimatedLeadsList audience="employer" />,
    },
    {
      title: "Open a lead to see the full picture.",
      body: "You'll see the employer's contact, the company context, the standard they're after, and the levy and headcount details they've shared with us. The right-hand panel is where the notes live, and your team and ours both write in it.",
      visual: <LeadDetailVisual audience="employer" />,
    },
    {
      title: "Walk them through the stages as you go.",
      body: "The stepper moves from Engaged when you've made first contact, into In progress while the deal is moving, and ends at Signed once the apprenticeship agreement is executed. If a lead won't proceed, you can mark them Not signed at any point.",
      visual: <AnimatedStepper audience="employer" />,
    },
    {
      title: "And this part really matters.",
      body: "Every status you set kicks off something on our side. Follow-up emails go out to the employer based on where you've got to, and the leads we send you next get smarter from how previous ones turned out. So keeping statuses up to date is the single most useful thing you can do in here.",
      visual: <AutomationsVisual audience="employer" />,
    },
    {
      title: "Closing one out is just as easy.",
      body: "If an employer won't proceed, mark them Not signed and tell us why. It's fully reversible. You can flip them back to Engaged, In progress, or Signed from the Not signed screen if anything changes.",
      visual: <CloseOutVisual audience="employer" />,
    },
    {
      title: "Notes are for your team and ours, never the employer.",
      body: "Anything you type on a lead stays inside your team and our support team. The employer never sees it. When we leave a note for you, like a callback request or anything time-sensitive, our note shows up in blue and we email you straight away so it doesn't get missed. Two timers sit at the top of every lead, one for total time in your queue, and one for how long it's been since you last updated their status.",
      visual: <AnimatedNotes audience="employer" />,
    },
    {
      title: "Got a question? Support is one click away.",
      body: "The Support tab inside the portal has shortcuts to the questions we get asked most, plus a quick form that comes straight to us. You can also email support@switchleads.co.uk if that's easier. Either way, we aim to come back to you within one working day.",
      visual: <SupportVisual />,
    },
  ];
}

// ============================================================================
// Animation helpers
// ============================================================================

// Tick a number from 0 to target over `durationMs`. Replays whenever this
// component mounts (each slide re-mount triggers a fresh count-up).
function useCountUp(target: number, durationMs = 900): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (target === 0) {
      setValue(0);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(eased * target));
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}

function useStepWalker(totalSteps: number, msPerStep = 700): number {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (totalSteps <= 1) return;
    const timers: number[] = [];
    for (let i = 1; i < totalSteps; i++) {
      timers.push(
        window.setTimeout(() => setStep(i), i * msPerStep + 400),
      );
    }
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [totalSteps, msPerStep]);
  return step;
}

function useStaggeredReveal(count: number, msPerItem = 220): boolean[] {
  const [revealed, setRevealed] = useState<boolean[]>(() =>
    Array(count).fill(false),
  );
  useEffect(() => {
    const timers: number[] = [];
    for (let i = 0; i < count; i++) {
      timers.push(
        window.setTimeout(() => {
          setRevealed((prev) => {
            const next = [...prev];
            next[i] = true;
            return next;
          });
        }, i * msPerItem + 200),
      );
    }
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [count, msPerItem]);
  return revealed;
}

// ============================================================================
// Visuals — replicas of the real portal UI
// ============================================================================

function HeroVisual({ providerLabel }: { providerLabel: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
      <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
        {providerLabel}
      </p>
      <p className="text-base font-semibold text-slate-900 mt-1">
        Welcome back
      </p>
    </div>
  );
}

// ---------- Action cards (matches home-view.tsx ActionCard verbatim) ----------

function AnimatedActionCards({ audience }: { audience: Audience }) {
  const cards = audience === "employer"
    ? [
        { tone: "amber" as const, target: 3, label: "open leads not yet engaged", hint: "No contact yet" },
        { tone: "violet" as const, target: 2, label: "engaged leads", hint: "First contact made" },
        { tone: "rose" as const, target: 1, label: "leads in progress", hint: "Deal moving" },
        { tone: "orange" as const, target: 0, label: "60-day clock approaching", hint: "None approaching" },
      ]
    : [
        { tone: "violet" as const, target: 2, label: "fastrack leads", hint: "Cohort confirmed" },
        { tone: "rose" as const, target: 1, label: "callback requests", hint: "Switchable flagged for follow-up" },
        { tone: "amber" as const, target: 4, label: "open leads never called", hint: "No contact attempt yet" },
        { tone: "orange" as const, target: 0, label: "call attempts need retrying", hint: "Last call was 36h+ ago" },
      ];

  const reveal = useStaggeredReveal(cards.length, 150);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((c, i) => (
        <div
          key={c.label}
          className={`transition-all duration-500 ${
            reveal[i] ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
          }`}
        >
          <ReplicaActionCard tone={c.tone} target={c.target} label={c.label} hint={c.hint} />
        </div>
      ))}
    </div>
  );
}

function ReplicaActionCard({
  tone,
  target,
  label,
  hint,
}: {
  tone: "rose" | "violet" | "amber" | "orange";
  target: number;
  label: string;
  hint: string;
}) {
  const count = useCountUp(target, 800);
  const isDone = count === 0 && target === 0;
  const palette: Record<string, string> = {
    rose: "bg-rose-50 border-rose-200 text-rose-900",
    violet: "bg-violet-50 border-violet-200 text-violet-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    orange: "bg-orange-50 border-orange-200 text-orange-900",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
  };
  const numTone: Record<string, string> = {
    rose: "text-rose-700",
    violet: "text-violet-700",
    amber: "text-amber-700",
    orange: "text-orange-700",
    emerald: "text-emerald-700",
  };
  const effectiveTone = isDone ? "emerald" : tone;

  return (
    <div className={`block p-4 rounded-xl border ${palette[effectiveTone]} relative`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className={`text-3xl font-semibold tabular-nums leading-none ${numTone[effectiveTone]}`}>
          {isDone ? "✓" : count}
        </p>
        <span className="text-xs font-semibold opacity-80">
          {isDone ? "All clear" : "Review →"}
        </span>
      </div>
      <p className="text-sm font-medium mt-2">{label}</p>
      <p className="text-xs opacity-75 mt-0.5">{hint}</p>
    </div>
  );
}

// ---------- Leads list (staggered slide-in rows with status pills) ----------

function AnimatedLeadsList({ audience }: { audience: Audience }) {
  const rows = audience === "employer"
    ? [
        { name: "Avon Joinery Ltd", badge: "60-day clock", badgeTone: "orange" as const, status: "In progress", pillTone: "amber" as const },
        { name: "Bishop & Sons", badge: null, status: "Engaged", pillTone: "blue" as const },
        { name: "Crowmark Civils", badge: null, status: "Open", pillTone: "slate" as const },
        { name: "Dearne Roofing", badge: null, status: "Signed", pillTone: "emerald" as const },
      ]
    : [
        { name: "Aaron P.", badge: "Fastrack", badgeTone: "violet" as const, status: "Open", pillTone: "slate" as const },
        { name: "Beth K.", badge: "Callback", badgeTone: "rose" as const, status: "Open", pillTone: "slate" as const },
        { name: "Chiara S.", badge: null, status: "1st no answer", pillTone: "amber" as const },
        { name: "Dev N.", badge: null, status: "Meeting booked", pillTone: "blue" as const },
        { name: "Eli W.", badge: null, status: "Enrolled", pillTone: "emerald" as const },
      ];

  const reveal = useStaggeredReveal(rows.length, 130);

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      {rows.map((r, i) => (
        <div
          key={r.name}
          className={`transition-all duration-500 ${
            reveal[i] ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-2"
          }`}
        >
          <LeadRow row={r} last={i === rows.length - 1} />
        </div>
      ))}
    </div>
  );
}

function LeadRow({
  row,
  last,
}: {
  row: {
    name: string;
    badge: string | null;
    badgeTone?: "violet" | "rose" | "orange";
    status: string;
    pillTone: "slate" | "amber" | "blue" | "emerald";
  };
  last: boolean;
}) {
  const badgePalette = {
    violet: "bg-violet-100 text-violet-800 border-violet-200",
    rose: "bg-rose-100 text-rose-800 border-rose-200",
    orange: "bg-orange-100 text-orange-800 border-orange-200",
  };
  const pillPalette = {
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
        <p className="text-sm font-medium text-slate-900 truncate">{row.name}</p>
        {row.badge && row.badgeTone ? (
          <span
            className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${badgePalette[row.badgeTone]}`}
          >
            {row.badge}
          </span>
        ) : null}
      </div>
      <span
        className={`text-[11px] font-medium px-2 py-0.5 rounded border ${pillPalette[row.pillTone]} shrink-0`}
      >
        {row.status}
      </span>
    </div>
  );
}

// ---------- Lead detail (split-pane sketch) ----------

function LeadDetailVisual({ audience }: { audience: Audience }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-5 gap-4">
      <div className="md:col-span-3 space-y-2 animate-fade-up" style={{ animationDelay: "100ms" }}>
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
      <div className="md:col-span-2 bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2 animate-fade-up" style={{ animationDelay: "300ms" }}>
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

// ---------- Stepper (matches outcome-buttons.tsx circular-step shape) -----

function AnimatedStepper({ audience }: { audience: Audience }) {
  const steps = audience === "employer"
    ? ["Open", "Engaged", "In progress", "Signed"]
    : ["Open", "1st", "2nd", "3rd", "Meeting", "Enrolled"];
  const currentIndex = useStepWalker(steps.length, 700);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-4">
        Move this lead forward
      </p>
      <div className="flex items-stretch gap-0">
        {steps.map((step, idx) => {
          const isCurrent = idx === currentIndex;
          const isPast = idx < currentIndex;
          return (
            <div key={step} className="flex-1 flex flex-col items-center min-w-0 relative">
              {idx < steps.length - 1 ? (
                <div
                  className={`absolute top-4 left-1/2 h-0.5 transition-colors duration-500 ${
                    isPast ? "bg-slate-900" : "bg-slate-200"
                  }`}
                  style={{ width: "100%" }}
                />
              ) : null}
              <div
                aria-label={`Mark ${step}`}
                className={`relative z-10 w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-all duration-300 ${
                  isCurrent
                    ? "bg-slate-900 border-slate-900 text-white scale-110"
                    : isPast
                      ? "bg-slate-300 border-slate-300 text-slate-500"
                      : "bg-white border-slate-300 text-slate-400"
                }`}
              >
                {isPast ? "✓" : idx + 1}
              </div>
              <p
                className={`text-[10px] mt-2 font-medium text-center leading-tight transition-colors duration-300 ${
                  isCurrent ? "text-slate-900" : isPast ? "text-slate-500" : "text-slate-400"
                }`}
              >
                {step}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Close-out buttons ----------

function CloseOutVisual({ audience }: { audience: Audience }) {
  const buttons = audience === "employer"
    ? [{ label: "Not signed" }]
    : [{ label: "Cannot reach" }, { label: "Lost" }];
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 animate-fade-up">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
        Or close this out
      </p>
      <div className="flex flex-wrap gap-2">
        {buttons.map((b) => (
          <button
            key={b.label}
            type="button"
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border bg-rose-50 text-rose-800 border-rose-200 hover:bg-rose-100 cursor-default transition-colors"
            tabIndex={-1}
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- Notes panel (staggered fade-in messages + ticking timers) ----

function AnimatedNotes({ audience }: { audience: Audience }) {
  const notes = [
    {
      author: "Switchable",
      time: "10:14",
      body: audience === "employer"
        ? "Owner mentioned the apprenticeship levy reset arrives in August."
        : "Asked us to call back after 5pm.",
      tone: "blue" as const,
    },
    {
      author: "You",
      time: "14:20",
      body: audience === "employer"
        ? "Sent intro pack and proposed a call Thursday."
        : "Voicemail left. Will retry tomorrow AM.",
      tone: "slate" as const,
    },
  ];
  const reveal = useStaggeredReveal(notes.length, 380);
  const queueDays = useCountUp(2, 800);
  const statusHours = useCountUp(4, 800);

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Activity
        </p>
        <div className="flex items-center gap-2 text-[10px] text-slate-500 tabular-nums">
          <span>In queue: {queueDays}d</span>
          <span className="w-px h-3 bg-slate-300" />
          <span>At status: {statusHours}h</span>
        </div>
      </div>
      <div className="space-y-2">
        {notes.map((n, i) => (
          <div
            key={i}
            className={`transition-all duration-500 ${
              reveal[i] ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
            } ${
              n.tone === "blue"
                ? "bg-blue-50 border border-blue-100"
                : "bg-slate-50 border border-slate-200"
            } rounded p-2.5 text-xs`}
          >
            <div className="flex items-center justify-between gap-2 text-[10px] mb-0.5">
              <p className={`font-semibold ${n.tone === "blue" ? "text-blue-900" : "text-slate-900"}`}>
                {n.author}
              </p>
              <p className="opacity-70">{n.time}</p>
            </div>
            <p className={`leading-snug ${n.tone === "blue" ? "text-blue-900" : "text-slate-700"}`}>
              {n.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Automations chain (status → what fires) ----------

function AutomationsVisual({ audience }: { audience: Audience }) {
  const rows = audience === "employer"
    ? [
        { status: "Engaged", pillTone: "blue" as const, fires: "Follow-up email to the employer" },
        { status: "Signed", pillTone: "emerald" as const, fires: "Confirmation email + your enrolment is logged" },
      ]
    : [
        { status: "1st no answer", pillTone: "amber" as const, fires: "Nudge email to the learner" },
        { status: "Meeting booked", pillTone: "blue" as const, fires: "Chaser emails pause" },
        { status: "Enrolled", pillTone: "emerald" as const, fires: "Success email sends to the learner" },
      ];
  const reveal = useStaggeredReveal(rows.length, 380);
  const pillPalette = {
    amber: "bg-amber-50 text-amber-800 border-amber-200",
    blue: "bg-blue-50 text-blue-800 border-blue-200",
    emerald: "bg-emerald-50 text-emerald-800 border-emerald-200",
  };
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        You mark this → we do this
      </p>
      <div className="space-y-2.5">
        {rows.map((r, i) => (
          <div
            key={r.status}
            className={`flex items-center gap-3 transition-all duration-500 ${
              reveal[i] ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-2"
            }`}
          >
            <span
              className={`text-[11px] font-semibold px-2 py-1 rounded border whitespace-nowrap ${pillPalette[r.pillTone]}`}
            >
              {r.status}
            </span>
            <span className="text-slate-300 text-sm shrink-0">→</span>
            <span className="text-xs text-slate-700 leading-snug">{r.fires}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Support area (FAQ + send-message preview) ----------

function SupportVisual() {
  const reveal = useStaggeredReveal(3, 220);
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
      <div
        className={`bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 transition-all duration-500 ${
          reveal[0] ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
        }`}
      >
        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
          Common questions
        </p>
        <div className="mt-2 space-y-1.5 text-xs text-slate-700">
          <p>• How do I mark an outcome on a lead?</p>
          <p>• What does the Fastrack badge mean?</p>
          <p>• Where do my notes go?</p>
        </div>
      </div>
      <div
        className={`border border-slate-200 rounded-lg p-3 transition-all duration-500 ${
          reveal[1] ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
        }`}
      >
        <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">
          Send us a message
        </p>
        <div className="space-y-1.5">
          <div className="h-7 rounded border border-slate-200 bg-slate-50 px-2 flex items-center text-[11px] text-slate-400">
            Subject
          </div>
          <div className="h-12 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-400">
            How can we help?
          </div>
        </div>
        <button
          type="button"
          tabIndex={-1}
          className="mt-2 inline-flex items-center justify-center rounded-md bg-slate-900 text-white text-[11px] font-semibold px-3 py-1.5 cursor-default"
        >
          Send message
        </button>
      </div>
      <p
        className={`text-[11px] text-slate-500 transition-all duration-500 ${
          reveal[2] ? "opacity-100" : "opacity-0"
        }`}
      >
        Or email <span className="font-semibold text-slate-700">support@switchleads.co.uk</span> — one working day max.
      </p>
    </div>
  );
}

// ---------- SLA terminator slide (final step of the deck) ----------

function SlaSlide({
  audience,
  slaTerms,
  agreed,
  onAgreedChange,
}: {
  audience: Audience;
  slaTerms: SlaTerms;
  agreed: boolean;
  onAgreedChange: (next: boolean) => void;
}) {
  const presumedLabel = audience === "employer" ? "Presumed signed" : "Presumed enrolled";
  const closeoutLabel = audience === "employer" ? "signed" : "enrolled";
  return (
    <>
      <h1 className="text-3xl md:text-4xl font-semibold text-slate-900 leading-tight">
        One last thing &mdash; your SLA.
      </h1>
      <p className="mt-4 text-base md:text-lg text-slate-700 leading-relaxed">
        This is the day-to-day version of the PPA. Tick to confirm
        you&apos;ve read it and you&apos;re happy to work to this shape.
      </p>

      <div className="mt-8 bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
        <SlaBlock title="Your side">
          <SlaBullet>
            First contact with every routed lead within{" "}
            <strong>{slaTerms.firstAttemptHours} hours</strong> of arrival.
          </SlaBullet>
          <SlaBullet>
            Up to{" "}
            <strong>
              {slaTerms.attemptsRequired} attempts over {slaTerms.attemptWindowDays} days
            </strong>
            {" "}before marking <em>Cannot reach</em>. The portal nudges you when an attempt
            has been sitting more than <strong>{slaTerms.staleAttemptHours} hours</strong>.
          </SlaBullet>
          <SlaBullet>
            Keep statuses up to date in the portal as you work each lead.
          </SlaBullet>
        </SlaBlock>
        <SlaBlock title="Our side">
          <SlaBullet>
            Every routed lead is pre-screened to match your eligibility criteria.
            We only bill on confirmed enrolments.
          </SlaBullet>
          <SlaBullet>
            We surface stale leads on your home page with an Overdue badge.
          </SlaBullet>
          <SlaBullet>
            We&apos;re reachable on{" "}
            <a href="mailto:support@switchleads.co.uk" className="font-semibold text-slate-900 underline-offset-2 hover:underline">
              support@switchleads.co.uk
            </a>{" "}
            for anything that doesn&apos;t look right.
          </SlaBullet>
        </SlaBlock>
        <SlaBlock title={`The ${slaTerms.presumedFlipDays}-day rule`}>
          <p className="text-sm text-slate-700 leading-relaxed">
            If a lead stays at <strong>Open</strong> with no outcome for{" "}
            <strong>{slaTerms.presumedFlipDays} days</strong>, the system marks it{" "}
            <strong>{presumedLabel}</strong> and triggers billing for that {closeoutLabel}.
            You&apos;ve got a 7-day window after that to raise a dispute. Updating the
            status as you work a lead resets the clock and keeps things clean.
          </p>
        </SlaBlock>
      </div>

      <label className="mt-6 flex items-start gap-3 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => onAgreedChange(e.target.checked)}
          className="mt-0.5 w-5 h-5 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
        />
        <span className="text-sm text-slate-800 leading-snug">
          I&apos;ve read the above and agree to work to this SLA. I&apos;ll
          keep lead statuses up to date in the portal.
        </span>
      </label>
    </>
  );
}

function SlaBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
        {title}
      </p>
      <div className="space-y-2 text-sm text-slate-800">{children}</div>
    </div>
  );
}

function SlaBullet({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 leading-snug">
      <span className="text-slate-400 select-none mt-0.5">•</span>
      <span>{children}</span>
    </p>
  );
}
