"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  createTagAction,
  updateTagAction,
  deleteTagAction,
  listPostsForRetroactiveTagAction,
  applyTagToPostsAction,
  removeTagFromPostsAction,
  type TagWithUsage,
} from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type RetroactivePost = {
  id: number;
  slug: string;
  title: string;
  status: string;
  hasTag: boolean;
};

export function TagsClient({ initialTags }: { initialTags: TagWithUsage[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [tags, setTags] = useState(initialTags);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Create form state
  const [newSlug, setNewSlug] = useState("");
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  // Edit state per tag
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editSlug, setEditSlug] = useState("");
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");

  // Retroactive-apply state
  const [applyingTag, setApplyingTag] = useState<TagWithUsage | null>(null);
  const [retroactivePosts, setRetroactivePosts] = useState<RetroactivePost[]>([]);
  const [retroactiveLoading, setRetroactiveLoading] = useState(false);
  const [selectedPostIds, setSelectedPostIds] = useState<Set<number>>(new Set());

  function resetMessages() {
    setError(null);
    setSuccess(null);
  }

  function startCreate(e: React.FormEvent) {
    e.preventDefault();
    resetMessages();
    startTransition(async () => {
      const result = await createTagAction({ slug: newSlug, name: newName, description: newDesc });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSuccess(`Tag "${result.data.slug}" created`);
      setNewSlug("");
      setNewName("");
      setNewDesc("");
      router.refresh();
    });
  }

  function startEdit(tag: TagWithUsage) {
    resetMessages();
    setEditingId(tag.id);
    setEditSlug(tag.slug);
    setEditName(tag.name);
    setEditDesc(tag.description ?? "");
  }

  function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (editingId == null) return;
    resetMessages();
    startTransition(async () => {
      const result = await updateTagAction({
        id: editingId,
        slug: editSlug,
        name: editName,
        description: editDesc,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSuccess(`Tag updated`);
      setEditingId(null);
      router.refresh();
    });
  }

  function deleteTag(tag: TagWithUsage) {
    if (
      !confirm(
        `Delete tag "${tag.name}"? It is currently applied to ${tag.usage_count} post${tag.usage_count === 1 ? "" : "s"}. Those applications will be removed (posts not deleted).`,
      )
    ) {
      return;
    }
    resetMessages();
    startTransition(async () => {
      const result = await deleteTagAction(tag.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSuccess(`Tag "${tag.slug}" deleted`);
      router.refresh();
    });
  }

  async function openRetroactive(tag: TagWithUsage) {
    resetMessages();
    setApplyingTag(tag);
    setRetroactiveLoading(true);
    setSelectedPostIds(new Set());
    const result = await listPostsForRetroactiveTagAction(tag.id);
    setRetroactiveLoading(false);
    if (!result.ok) {
      setError(result.error);
      setApplyingTag(null);
      return;
    }
    setRetroactivePosts(result.data);
    // Pre-tick posts that already have the tag so it's a clear two-way toggle.
    setSelectedPostIds(new Set(result.data.filter((p) => p.hasTag).map((p) => p.id)));
  }

  function togglePost(id: number) {
    setSelectedPostIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function saveRetroactive() {
    if (!applyingTag) return;
    resetMessages();
    const currentlyTagged = new Set(retroactivePosts.filter((p) => p.hasTag).map((p) => p.id));
    const toAdd = [...selectedPostIds].filter((id) => !currentlyTagged.has(id));
    const toRemove = [...currentlyTagged].filter((id) => !selectedPostIds.has(id));

    startTransition(async () => {
      if (toAdd.length > 0) {
        const result = await applyTagToPostsAction(applyingTag.id, toAdd);
        if (!result.ok) {
          setError(result.error);
          return;
        }
      }
      if (toRemove.length > 0) {
        const result = await removeTagFromPostsAction(applyingTag.id, toRemove);
        if (!result.ok) {
          setError(result.error);
          return;
        }
      }
      setSuccess(
        `Applied to ${toAdd.length} post${toAdd.length === 1 ? "" : "s"}, removed from ${toRemove.length}`,
      );
      setApplyingTag(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-8">
      {error && (
        <div className="rounded-lg border border-[#e9b3a4] bg-[#f7d8d0] text-[#8a2e1a] px-4 py-3 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-[#bcdfd8] bg-[#dcefea] text-[#1f5f5e] px-4 py-3 text-sm">
          {success}
        </div>
      )}

      {/* Create */}
      <section className="rounded-2xl border border-[#e5dfd8] bg-white p-6 space-y-4">
        <h2 className="text-lg font-extrabold text-[#11242e]">New tag</h2>
        <form onSubmit={startCreate} className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          <div>
            <Label htmlFor="newSlug">Slug</Label>
            <Input
              id="newSlug"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              placeholder="early-retirement"
              required
              disabled={pending}
            />
          </div>
          <div>
            <Label htmlFor="newName">Display name</Label>
            <Input
              id="newName"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Early retirement"
              required
              disabled={pending}
            />
          </div>
          <div>
            <Label htmlFor="newDesc">Description (optional)</Label>
            <Input
              id="newDesc"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="One-line description"
              disabled={pending}
            />
          </div>
          <div className="md:col-span-3">
            <Button type="submit" disabled={pending}>
              Create tag
            </Button>
          </div>
        </form>
      </section>

      {/* List */}
      <section className="space-y-2">
        <h2 className="text-lg font-extrabold text-[#11242e]">{tags.length} tag{tags.length === 1 ? "" : "s"}</h2>
        <p className="text-xs text-[#5a6a72]">
          Click <strong>Apply to posts</strong> to retroactively tag older posts that should have carried this tag.
        </p>
        <div className="space-y-2">
          {tags.map((tag) => (
            <div
              key={tag.id}
              className="rounded-xl border border-[#e5dfd8] bg-white px-4 py-3"
            >
              {editingId === tag.id ? (
                <form onSubmit={saveEdit} className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                  <div>
                    <Label htmlFor={`editSlug-${tag.id}`} className="text-[10px]">Slug</Label>
                    <Input
                      id={`editSlug-${tag.id}`}
                      value={editSlug}
                      onChange={(e) => setEditSlug(e.target.value)}
                      disabled={pending}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`editName-${tag.id}`} className="text-[10px]">Name</Label>
                    <Input
                      id={`editName-${tag.id}`}
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      disabled={pending}
                    />
                  </div>
                  <div>
                    <Label htmlFor={`editDesc-${tag.id}`} className="text-[10px]">Description</Label>
                    <Input
                      id={`editDesc-${tag.id}`}
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      disabled={pending}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={pending}>
                      Save
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setEditingId(null)} disabled={pending}>
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-3">
                      <code className="font-mono text-xs bg-[#f0ebe5] px-1.5 py-0.5 rounded">
                        {tag.slug}
                      </code>
                      <span className="font-semibold text-sm">{tag.name}</span>
                      <span className="text-[11px] text-[#5a6a72]">
                        used by {tag.usage_count} post{tag.usage_count === 1 ? "" : "s"}
                      </span>
                    </div>
                    {tag.description && (
                      <div className="text-xs text-[#5a6a72] mt-1">{tag.description}</div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => openRetroactive(tag)}
                      disabled={pending}
                    >
                      Apply to posts
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => startEdit(tag)}
                      disabled={pending}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => deleteTag(tag)}
                      disabled={pending}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Retroactive-apply modal */}
      {applyingTag && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] flex flex-col">
            <div className="p-6 border-b border-[#e5dfd8]">
              <h3 className="text-lg font-extrabold text-[#11242e]">
                Apply tag: <code className="font-mono text-base">{applyingTag.slug}</code>
              </h3>
              <p className="text-xs text-[#5a6a72] mt-1">
                Tick posts to apply this tag. Untick to remove it. Drafts + scheduled + published posts shown; archived hidden.
              </p>
            </div>
            <div className="overflow-y-auto flex-1 p-6 space-y-1">
              {retroactiveLoading ? (
                <p className="text-sm text-[#5a6a72]">Loading posts…</p>
              ) : retroactivePosts.length === 0 ? (
                <p className="text-sm text-[#5a6a72]">No posts available.</p>
              ) : (
                retroactivePosts.map((p) => (
                  <label
                    key={p.id}
                    className="flex items-start gap-3 px-3 py-2 hover:bg-[#f4f4f2] rounded cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedPostIds.has(p.id)}
                      onChange={() => togglePost(p.id)}
                      disabled={pending}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm">{p.title}</div>
                      <div className="text-[11px] text-[#5a6a72]">
                        <code className="font-mono">{p.slug}</code> · status {p.status}
                        {p.hasTag && (
                          <span className="ml-2 text-[#1f5f5e]">currently tagged</span>
                        )}
                      </div>
                    </div>
                  </label>
                ))
              )}
            </div>
            <div className="p-6 border-t border-[#e5dfd8] flex justify-between gap-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setApplyingTag(null)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="button" onClick={saveRetroactive} disabled={pending || retroactiveLoading}>
                {pending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="text-xs text-[#5a6a72] pt-6 border-t border-[#e5dfd8]">
        <Link href="/admin/blog" className="text-[#287271] underline">
          ← Back to blog
        </Link>
      </div>
    </div>
  );
}
