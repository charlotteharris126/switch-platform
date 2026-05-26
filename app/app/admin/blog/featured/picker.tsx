"use client";

// Featured slots picker. Three numbered slot cards; each can be filled
// from a list of published posts via a small typeahead dropdown. Clearing
// a slot is a click. Each change fires setFeaturedSlotAction which both
// updates the DB and triggers a Netlify rebuild.

import { useState, useTransition } from "react";
import Link from "next/link";
import type { FeaturedSlot } from "../actions";
import { setFeaturedSlotAction } from "../actions";

type AvailablePost = {
  id: number;
  slug: string;
  title: string;
  publish_date: string | null;
  featured_position: number | null;
};

export function FeaturedSlotsPicker({
  initialSlots,
  availablePosts,
}: {
  initialSlots: FeaturedSlot[];
  availablePosts: AvailablePost[];
}) {
  const [slots, setSlots] = useState(initialSlots);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function commit(position: 1 | 2 | 3, postId: number | null) {
    setError(null);
    startTransition(async () => {
      const r = await setFeaturedSlotAction(position, postId);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      // Optimistic local update — refresh from action result.
      setSlots((current) => {
        // Clear any slot that previously held this post (post can't be in two slots).
        const cleared = current.map((s) =>
          s.post && postId !== null && s.post.id === postId ? { ...s, post: null } : s
        );
        // Set the named slot.
        return cleared.map((s) => {
          if (s.position !== position) return s;
          if (postId === null) return { ...s, post: null };
          const picked = availablePosts.find((p) => p.id === postId);
          return picked
            ? { ...s, post: { id: picked.id, slug: picked.slug, title: picked.title, status: "published", category_id: null, cover_image_url: null, publish_date: picked.publish_date } }
            : s;
        });
      });
    });
  }

  return (
    <div className="space-y-4">
      {error && (
        <p className="text-sm text-[#b3412e] bg-white border border-[#e9b3a4] rounded-md p-3">{error}</p>
      )}

      <div className="space-y-3">
        {slots.map((slot) => (
          <SlotCard
            key={slot.position}
            slot={slot}
            availablePosts={availablePosts}
            pending={pending}
            onPick={(postId) => commit(slot.position, postId)}
            onClear={() => commit(slot.position, null)}
          />
        ))}
      </div>

      <p className="text-[11px] text-[#5a6a72]">
        Featured slots are managed here, not from each post&apos;s edit form. Removing a post from a slot leaves the slot empty (no auto-promote of slot 3 → slot 2 etc) — refill manually when you&apos;re ready.
      </p>
    </div>
  );
}

function SlotCard({
  slot, availablePosts, pending, onPick, onClear,
}: {
  slot: FeaturedSlot;
  availablePosts: AvailablePost[];
  pending: boolean;
  onPick: (postId: number) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = availablePosts
    .filter((p) => slot.post?.id !== p.id)
    .filter((p) => {
      if (!query.trim()) return true;
      const q = query.toLowerCase();
      return p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q);
    })
    .slice(0, 12);

  return (
    <div className="bg-white rounded-xl border border-[#e5dfd8] p-4">
      <div className="flex items-center gap-3 mb-3">
        <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-[#287271] text-white font-extrabold text-sm">
          {slot.position}
        </span>
        <div className="flex-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a6a72]">
            {slot.position === 1 ? "Lead hero card" : `Secondary card ${slot.position}`}
          </p>
        </div>
      </div>

      {slot.post ? (
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <p className="font-extrabold text-[#11242e] truncate">{slot.post.title}</p>
            <p className="text-[11px] text-[#5a6a72] font-mono truncate">/switchguides/{slot.post.slug}/</p>
            {slot.post.publish_date && (
              <p className="text-[11px] text-[#5a6a72]">Published {slot.post.publish_date}</p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Link
              href={`/admin/blog/${slot.post.slug}/edit`}
              className="text-[11px] font-bold text-[#287271] underline"
            >
              Edit post
            </Link>
            <button
              type="button"
              onClick={onClear}
              disabled={pending}
              className="text-[11px] font-bold text-[#8a2e1a] underline disabled:opacity-50"
            >
              Clear slot
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-[#5a6a72] italic mb-3">Slot empty.</p>
      )}

      <div className="relative">
        <input
          type="search"
          value={query}
          placeholder={slot.post ? "Replace this slot..." : "Pick a published post..."}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          disabled={pending}
          className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm"
        />
        {open && filtered.length > 0 && (
          <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto bg-white border border-[#d4ccc0] rounded-lg shadow-lg">
            {filtered.map((p) => (
              <button
                key={p.id}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); onPick(p.id); setQuery(""); setOpen(false); }}
                className="block w-full text-left px-3 py-2 text-sm hover:bg-[#f5f2eb] border-b border-[#f5f2eb] last:border-b-0"
              >
                <span className="block font-bold text-[#11242e] truncate">{p.title}</span>
                <span className="block text-[10px] font-mono text-[#5a6a72] truncate">
                  /switchguides/{p.slug}/
                  {p.featured_position && p.featured_position !== slot.position
                    ? ` · currently in slot ${p.featured_position}`
                    : ""}
                </span>
              </button>
            ))}
          </div>
        )}
        {open && filtered.length === 0 && (
          <div className="absolute z-20 mt-1 w-full bg-white border border-[#d4ccc0] rounded-lg shadow-lg px-3 py-2 text-sm text-[#5a6a72]">
            {availablePosts.length === 0 ? "No published posts yet." : "No matches."}
          </div>
        )}
      </div>
    </div>
  );
}
