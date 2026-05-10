"use client";

// Provider Support form. Saves to crm.support_requests and fires an
// email to support@switchleads.co.uk via the provider-support-notify
// Edge Function.

import { useState, useTransition } from "react";

const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: "lead_query", label: "Lead query" },
  { value: "billing", label: "Billing" },
  { value: "technical", label: "Technical issue" },
  { value: "account", label: "Account / login" },
  { value: "other", label: "Other" },
];

interface Props {
  initialEmail: string;
  onSubmit: (args: {
    category: string;
    subject: string;
    message: string;
  }) => Promise<
    | { ok: true; requestId: number; emailSent: boolean }
    | { ok: false; error: string }
  >;
}

export function SupportForm({ initialEmail, onSubmit }: Props) {
  const [category, setCategory] = useState<string>("lead_query");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<
    | { kind: "ok"; requestId: number; emailSent: boolean }
    | { kind: "error"; message: string }
    | null
  >(null);

  const subjectTooLong = subject.length > 200;
  const messageTooLong = message.length > 5000;
  const canSubmit =
    !pending &&
    subject.trim().length > 0 &&
    message.trim().length > 0 &&
    !subjectTooLong &&
    !messageTooLong;

  function fire() {
    if (!canSubmit) return;
    setResult(null);
    startTransition(async () => {
      const r = await onSubmit({ category, subject, message });
      if (r.ok) {
        setResult({ kind: "ok", requestId: r.requestId, emailSent: r.emailSent });
        setSubject("");
        setMessage("");
        setCategory("lead_query");
      } else {
        setResult({ kind: "error", message: r.error });
      }
    });
  }

  if (result?.kind === "ok") {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-6">
        <p className="text-base font-semibold text-emerald-900">
          Thanks, we&apos;ve got your message.
        </p>
        <p className="text-sm text-emerald-800 mt-2">
          Reference: <span className="font-mono">#{result.requestId}</span>.{" "}
          {result.emailSent
            ? `We've notified the support inbox and you'll get a reply at ${initialEmail} within one working day.`
            : `Your message is saved. We had a hiccup sending the notification email — we'll spot it on our side and get back to you at ${initialEmail}.`}
        </p>
        <button
          type="button"
          onClick={() => setResult(null)}
          className="mt-4 px-3 py-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer transition-colors"
        >
          Send another
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
          What&apos;s it about?
        </label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          disabled={pending}
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm bg-white cursor-pointer focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-slate-400 disabled:cursor-not-allowed"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
          Subject
        </label>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={220}
          placeholder="One-liner — e.g. Question about lead #347"
          disabled={pending}
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-slate-400 disabled:cursor-not-allowed"
        />
        {subjectTooLong && (
          <p className="text-xs text-rose-700 mt-1">Subject too long (max 200 chars).</p>
        )}
      </div>

      <div>
        <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
          Message
        </label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={6}
          placeholder="What's going on? Include lead ids if relevant."
          disabled={pending}
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-slate-400 resize-y disabled:cursor-not-allowed"
        />
        <div className="flex justify-between items-baseline mt-1">
          <p className="text-xs text-slate-500">
            We&apos;ll reply to {initialEmail}.
          </p>
          <p
            className={`text-xs tabular-nums ${
              messageTooLong ? "text-rose-700" : "text-slate-400"
            }`}
          >
            {message.length} / 5000
          </p>
        </div>
      </div>

      {result?.kind === "error" && (
        <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-3">
          {result.message}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={fire}
          disabled={!canSubmit}
          className="px-5 py-2 bg-slate-900 text-white rounded-md text-sm font-semibold hover:bg-slate-800 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer transition-colors"
        >
          {pending ? "Sending…" : "Send message"}
        </button>
      </div>
    </div>
  );
}
