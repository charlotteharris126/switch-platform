"use client";

// Token-input replacement for the comma-separated tags Input. Each selected
// tag renders as a removable chip; typing shows suggestions from the registry
// below the field. State stays as a comma-separated string (PostFormInput.tags)
// so the form / save action / SEO checklist don't need to change.
//
// Out-of-scope for v1: inline create-new-tag (Charlotte creates new tags via
// /admin/blog/tags). Unknown slugs typed manually still land in the CSV but
// are flagged in red so she sees them before save.

import { useMemo, useRef, useState } from "react";

interface Props {
  value: string;                                     // comma-separated CSV
  onChange: (next: string) => void;
  allTags: Array<{ slug: string; name: string }>;
  disabled?: boolean;
}

function parseCsv(s: string): string[] {
  return s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function toCsv(slugs: string[]): string {
  // De-dup while preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of slugs) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out.join(", ");
}

export function TagInput({ value, onChange, allTags, disabled }: Props) {
  const selected = useMemo(() => parseCsv(value), [value]);
  const knownSlugs = useMemo(() => new Set(allTags.map((t) => t.slug)), [allTags]);
  const tagByName = useMemo(() => {
    const m = new Map<string, { slug: string; name: string }>();
    for (const t of allTags) m.set(t.slug, t);
    return m;
  }, [allTags]);

  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    if (!q) {
      // Empty query: show top 8 unselected tags
      return allTags.filter((t) => !selected.includes(t.slug)).slice(0, 8);
    }
    return allTags
      .filter((t) => !selected.includes(t.slug))
      .filter((t) => t.slug.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [input, allTags, selected]);

  function addTag(slug: string) {
    if (!slug) return;
    const trimmed = slug.trim();
    if (!trimmed || selected.includes(trimmed)) return;
    onChange(toCsv([...selected, trimmed]));
    setInput("");
    setHighlightIdx(0);
    inputRef.current?.focus();
  }

  function removeTag(slug: string) {
    onChange(toCsv(selected.filter((s) => s !== slug)));
    inputRef.current?.focus();
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (suggestions[highlightIdx]) {
        addTag(suggestions[highlightIdx].slug);
      } else if (input.trim()) {
        // No matching suggestion — add as raw text (may be an unknown slug).
        addTag(input.trim());
      }
    } else if (e.key === "Tab" && suggestions[highlightIdx]) {
      e.preventDefault();
      addTag(suggestions[highlightIdx].slug);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Backspace" && !input && selected.length > 0) {
      // Backspace on empty input removes the last chip.
      removeTag(selected[selected.length - 1]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    } else if (e.key === "," || e.key === ";") {
      // Type a comma to commit the current input as a chip.
      e.preventDefault();
      if (input.trim()) addTag(input.trim());
    }
  }

  return (
    <div className="relative">
      <div
        className="flex flex-wrap items-center gap-1.5 min-h-9 px-2 py-1.5 rounded-lg border border-input bg-white focus-within:border-[#287271] focus-within:ring-2 focus-within:ring-[#287271]/30 transition-all cursor-text"
        onClick={() => inputRef.current?.focus()}
      >
        {selected.map((slug) => {
          const tag = tagByName.get(slug);
          const known = knownSlugs.has(slug);
          return (
            <span
              key={slug}
              className={`inline-flex items-center gap-1 text-[11px] font-semibold rounded-full pl-2 pr-1 py-0.5 border ${
                known
                  ? "bg-[#dcefea] text-[#1f5f5e] border-[#bcdfd8]"
                  : "bg-[#f7d8d0] text-[#8a2e1a] border-[#e9b3a4]"
              }`}
              title={tag?.name ?? `Unknown slug: ${slug}`}
            >
              {slug}
              {!known && <span className="text-[9px]">⚠</span>}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeTag(slug);
                }}
                disabled={disabled}
                className="ml-0.5 hover:bg-black/10 rounded-full w-4 h-4 inline-flex items-center justify-center"
                aria-label={`Remove ${slug}`}
              >
                ×
              </button>
            </span>
          );
        })}

        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setHighlightIdx(0);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => {
            // Defer hiding so click on a suggestion fires first.
            setTimeout(() => setShowSuggestions(false), 150);
          }}
          onKeyDown={onKey}
          disabled={disabled}
          placeholder={selected.length === 0 ? "Type to search tags…" : ""}
          className="flex-1 min-w-[120px] outline-none border-none bg-transparent text-sm py-0.5"
        />
      </div>

      {showSuggestions && suggestions.length > 0 && (
        <div className="absolute z-20 mt-1 w-full max-h-60 overflow-y-auto bg-white border border-[#d4ccc0] rounded-lg shadow-lg">
          {suggestions.map((tag, i) => (
            <button
              key={tag.slug}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                addTag(tag.slug);
              }}
              onMouseEnter={() => setHighlightIdx(i)}
              className={`block w-full text-left px-3 py-1.5 text-sm cursor-pointer ${
                i === highlightIdx
                  ? "bg-[#287271] text-white"
                  : "hover:bg-[#f5f2eb] text-[#11242e]"
              }`}
            >
              <span className="font-mono text-[11px] opacity-70">{tag.slug}</span>
              <span className="ml-2">{tag.name}</span>
            </button>
          ))}
        </div>
      )}

      {input.trim() && !suggestions.some((s) => s.slug === input.trim()) && (
        <p className="text-[10px] text-[#5a6a72] mt-1">
          Press Enter to add &quot;{input.trim()}&quot; as a raw slug
          {!knownSlugs.has(input.trim()) && " (will be flagged unknown until created in /admin/blog/tags)"}
          .
        </p>
      )}
    </div>
  );
}
