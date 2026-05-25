"use client";

// Reusable AI suggest button. Triggers blog-ai-assist EF for the requested
// kind, renders the result inline beneath the button, lets the operator
// apply it via onApply (text surfaces) or pick from a list (headlines/tags).
//
// Cost + latency are surfaced on the result panel so Charlotte sees what
// each suggestion actually costs while she's deciding whether to use it.

import { useState, useTransition } from "react";
import { aiAssistAction, type AiAssistKind, type AiAssistInput, type AiAssistResult, type PostFormInput } from "./actions";

type SuggestionState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "result"; result: Extract<AiAssistResult, { ok: true }> }
  | { phase: "error"; error: string };

interface Props {
  kind: AiAssistKind;
  // Field-level label so the button is clear about what it'll suggest.
  // e.g. "Suggest 5 titles", "Improve excerpt", "Suggest meta description".
  label: string;
  input: PostFormInput;
  knownTags?: Array<{ slug: string; name: string }>;
  postId?: number | null;
  postSlug?: string | null;
  // Field-specific behaviour. For text surfaces (outline / meta_description /
  // excerpt), called with the suggested string. For headlines, called with
  // the picked variant. For tags, called with the toggle-merged tag list.
  onApply: (value: string) => void;
  // Optional: the current value of the field so the model can "improve this"
  // instead of writing from scratch.
  currentValue?: string;
}

export function AiSuggestButton({
  kind,
  label,
  input,
  knownTags,
  postId,
  postSlug,
  onApply,
  currentValue,
}: Props) {
  const [state, setState] = useState<SuggestionState>({ phase: "idle" });
  const [pending, startTransition] = useTransition();

  function fire() {
    setState({ phase: "loading" });
    startTransition(async () => {
      const payload: AiAssistInput = {
        kind,
        post: {
          title: input.title,
          dek: input.dek,
          excerpt: input.excerpt,
          body: input.body,
          category_id: input.category_id,
          target_keywords: input.target_keywords
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          current_value: currentValue,
        },
        post_id: postId ?? null,
        post_slug: postSlug ?? null,
        known_tags: knownTags,
      };
      try {
        const r = await aiAssistAction(payload);
        if (!r.ok) {
          setState({ phase: "error", error: r.error });
        } else {
          setState({ phase: "result", result: r });
        }
      } catch (err) {
        setState({ phase: "error", error: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  function dismiss() {
    setState({ phase: "idle" });
  }

  return (
    <div className="mt-1.5 space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={fire}
          disabled={pending}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#287271] text-white text-[11px] font-semibold hover:bg-[#1e5b5a] disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
          title={label}
        >
          {pending && state.phase === "loading" ? "Thinking…" : `✨ ${label}`}
        </button>
        {state.phase !== "idle" && state.phase !== "loading" && (
          <button
            type="button"
            onClick={dismiss}
            className="text-[10px] text-[#5a6a72] hover:text-[#11242e] cursor-pointer"
          >
            Dismiss
          </button>
        )}
      </div>

      {state.phase === "error" && (
        <div className="rounded-md border border-[#e9b3a4] bg-[#f7d8d0] text-[#8a2e1a] px-3 py-2 text-[11px]">
          {state.error}
        </div>
      )}

      {state.phase === "result" && (
        <div className="rounded-md border border-[#bcdfd8] bg-[#f5f9f8] p-3 space-y-2">
          <SuggestionDisplay
            kind={kind}
            suggestion={state.result.suggestion}
            onApply={onApply}
            currentValue={currentValue}
          />
          <UsageFooter result={state.result} />
        </div>
      )}
    </div>
  );
}

function SuggestionDisplay({
  kind,
  suggestion,
  onApply,
  currentValue,
}: {
  kind: AiAssistKind;
  suggestion: string | string[];
  onApply: (value: string) => void;
  currentValue?: string;
}) {
  if (kind === "headlines" && Array.isArray(suggestion)) {
    return (
      <div className="space-y-1.5">
        <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#5a6a72]">
          Pick one
        </p>
        {suggestion.map((title, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onApply(title)}
            className="block w-full text-left text-sm text-[#11242e] bg-white hover:bg-[#287271] hover:text-white border border-[#e5dfd8] rounded px-2.5 py-1.5 cursor-pointer transition-colors"
          >
            {title}
            <span className="float-right text-[10px] opacity-60">{title.length} ch</span>
          </button>
        ))}
      </div>
    );
  }

  if (kind === "tags" && Array.isArray(suggestion)) {
    const existing = (currentValue ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return (
      <div className="space-y-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#5a6a72]">
          Tap to toggle
        </p>
        <div className="flex flex-wrap gap-1.5">
          {suggestion.map((slug) => {
            const on = existing.includes(slug);
            return (
              <button
                key={slug}
                type="button"
                onClick={() => {
                  const next = on
                    ? existing.filter((s) => s !== slug)
                    : [...existing, slug];
                  onApply(next.join(", "));
                }}
                className={`text-[11px] px-2 py-0.5 rounded-full border cursor-pointer ${
                  on
                    ? "bg-[#287271] text-white border-[#287271]"
                    : "bg-white text-[#11242e] border-[#e5dfd8] hover:bg-[#f0e9d4]"
                }`}
              >
                {slug}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => {
            // Replace existing tags with the suggested set entirely.
            onApply((suggestion as string[]).join(", "));
          }}
          className="text-[10px] text-[#287271] underline cursor-pointer"
        >
          Replace existing tags with all suggested
        </button>
      </div>
    );
  }

  // Text surfaces — outline, meta_description, excerpt.
  const text = typeof suggestion === "string" ? suggestion : String(suggestion);
  return (
    <div className="space-y-2">
      <div className="text-sm text-[#11242e] whitespace-pre-wrap bg-white border border-[#e5dfd8] rounded p-2.5 font-mono">
        {text}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onApply(text)}
          className="px-3 py-1 bg-[#287271] text-white rounded text-[11px] font-semibold hover:bg-[#1e5b5a] cursor-pointer"
        >
          Use this
        </button>
        {currentValue && currentValue.trim() && (
          <span className="text-[10px] text-[#5a6a72] self-center italic">
            (replaces current value)
          </span>
        )}
      </div>
    </div>
  );
}

function UsageFooter({ result }: { result: Extract<AiAssistResult, { ok: true }> }) {
  const u = result.usage;
  const cents = (u.cost_usd * 100).toFixed(3);
  return (
    <p className="text-[10px] text-[#5a6a72] pt-1.5 border-t border-[#e5dfd8]">
      {u.model} · {u.input + u.output + u.cache_read + u.cache_creation} tokens · {u.cache_read > 0 ? `cache hit (${u.cache_read}t)` : "cache miss"} · ${cents}¢ · {u.latency_ms}ms
    </p>
  );
}
