"use client";

// Content-plan pipeline board. 4 sections (Queued / Drafted / Published /
// Killed). Each idea row shows tier badge, working title, category,
// keyword, target date + inline actions (Edit, Kill / Restore). Inline
// edit opens a small drawer below the row.

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  createPostIdeaAction,
  updatePostIdeaAction,
  killPostIdeaAction,
  restorePostIdeaAction,
  type PostIdea,
  type PostIdeaInput,
  type PostIdeaTier,
} from "../actions";

type Category = { id: string; name: string };

const TIER_LABELS: Record<PostIdeaTier, { label: string; tone: string }> = {
  A: { label: "A · Single", tone: "bg-[#dcefea] text-[#1f5f5e] border-[#bcdfd8]" },
  B: { label: "B · Cluster", tone: "bg-[#fcefd6] text-[#92651c] border-[#f0d99c]" },
  C: { label: "C · Service page", tone: "bg-[#eee9e0] text-[#5a6a72] border-[#d4ccc0]" },
};

export function ContentPlanBoard({
  initialIdeas,
  categories,
}: {
  initialIdeas: PostIdea[];
  categories: Category[];
}) {
  const [ideas, setIdeas] = useState(initialIdeas);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function refresh(updated: PostIdea | { id: number; status?: PostIdea["status"] }) {
    setIdeas((current) =>
      current.map((i) => (i.id === updated.id ? { ...i, ...updated } : i))
    );
  }

  function commitUpdate(id: number, patch: Partial<PostIdeaInput>) {
    setError(null);
    startTransition(async () => {
      const r = await updatePostIdeaAction(id, patch);
      if (!r.ok) { setError(r.error); return; }
      // Best-effort local refresh — server is source of truth on next reload.
      refresh({ id, ...patch } as unknown as PostIdea);
    });
  }

  function commitKill(id: number, reason: string) {
    setError(null);
    startTransition(async () => {
      const r = await killPostIdeaAction(id, reason);
      if (!r.ok) { setError(r.error); return; }
      refresh({ id, status: "killed" });
    });
  }

  function commitRestore(id: number) {
    setError(null);
    startTransition(async () => {
      const r = await restorePostIdeaAction(id);
      if (!r.ok) { setError(r.error); return; }
      refresh({ id, status: "queued" });
    });
  }

  function commitCreate(input: PostIdeaInput) {
    setError(null);
    startTransition(async () => {
      const r = await createPostIdeaAction(input);
      if (!r.ok) { setError(r.error); return; }
      // Reload from server to pick up the full row with id + defaults.
      window.location.reload();
    });
  }

  const queued = ideas.filter((i) => i.status === "queued");
  const drafted = ideas.filter((i) => i.status === "drafted");
  const published = ideas.filter((i) => i.status === "published");
  const killed = ideas.filter((i) => i.status === "killed");

  return (
    <div className="space-y-8">
      {error && (
        <p className="text-sm text-[#b3412e] bg-white border border-[#e9b3a4] rounded-md p-3">{error}</p>
      )}

      <Section title="Queued" subtitle="Approved topics waiting for the drafter." ideas={queued} categories={categories} pending={pending} commitUpdate={commitUpdate} commitKill={commitKill} commitRestore={commitRestore} />
      <Section title="Drafted" subtitle="Drafts in the CMS awaiting your proof. Click through to edit." ideas={drafted} categories={categories} pending={pending} commitUpdate={commitUpdate} commitKill={commitKill} commitRestore={commitRestore} showDraftLink />
      <Section title="Published" subtitle="Live on Switchguides." ideas={published} categories={categories} pending={pending} commitUpdate={commitUpdate} commitKill={commitKill} commitRestore={commitRestore} showDraftLink />
      <Section title="Killed" subtitle="Rejected topics kept for audit so Mira doesn't regenerate them." ideas={killed} categories={categories} pending={pending} commitUpdate={commitUpdate} commitKill={commitKill} commitRestore={commitRestore} showRestore />

      <section id="new-idea" className="bg-white rounded-xl border border-[#e5dfd8] p-5 space-y-3">
        <h3 className="text-base font-extrabold text-[#11242e]">+ Add a new idea</h3>
        <NewIdeaForm categories={categories} pending={pending} onSubmit={commitCreate} />
      </section>
    </div>
  );
}

function Section({
  title, subtitle, ideas, categories, pending, commitUpdate, commitKill, commitRestore, showDraftLink, showRestore,
}: {
  title: string;
  subtitle: string;
  ideas: PostIdea[];
  categories: Category[];
  pending: boolean;
  commitUpdate: (id: number, patch: Partial<PostIdeaInput>) => void;
  commitKill: (id: number, reason: string) => void;
  commitRestore: (id: number) => void;
  showDraftLink?: boolean;
  showRestore?: boolean;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-3">
        <h3 className="text-lg font-extrabold text-[#11242e]">{title}</h3>
        <span className="text-xs text-[#5a6a72]">{ideas.length}</span>
      </div>
      <p className="text-xs text-[#5a6a72]">{subtitle}</p>
      {ideas.length === 0 ? (
        <p className="text-sm text-[#5a6a72] italic py-2">None.</p>
      ) : (
        <div className="space-y-2">
          {ideas.map((idea) => (
            <IdeaRow
              key={idea.id}
              idea={idea}
              categories={categories}
              pending={pending}
              commitUpdate={commitUpdate}
              commitKill={commitKill}
              commitRestore={commitRestore}
              showDraftLink={showDraftLink}
              showRestore={showRestore}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function IdeaRow({
  idea, categories, pending, commitUpdate, commitKill, commitRestore, showDraftLink, showRestore,
}: {
  idea: PostIdea;
  categories: Category[];
  pending: boolean;
  commitUpdate: (id: number, patch: Partial<PostIdeaInput>) => void;
  commitKill: (id: number, reason: string) => void;
  commitRestore: (id: number) => void;
  showDraftLink?: boolean;
  showRestore?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const tier = TIER_LABELS[idea.tier];
  return (
    <div className="bg-white rounded-xl border border-[#e5dfd8] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1.5">
            <span className={`inline-block text-[9px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full border ${tier.tone}`}>
              {tier.label}
            </span>
            {idea.tier === "B" && (
              <span className="text-[10px] font-bold text-[#5a6a72]">
                {idea.variants.length} {idea.variant_axis || "variants"}
              </span>
            )}
            {idea.proposed_publish_date && (
              <span className="text-[10px] font-mono text-[#5a6a72]">{idea.proposed_publish_date}</span>
            )}
          </div>
          <p className="font-bold text-[#11242e] truncate">{idea.working_title}</p>
          <div className="flex flex-wrap gap-2 mt-1 text-[11px] text-[#5a6a72]">
            <span>cat: <strong>{idea.category_id || "—"}</strong></span>
            <span>kw: <strong>{idea.primary_keyword || "—"}</strong></span>
            {idea.notes && <span className="italic truncate max-w-[400px]">{idea.notes}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {showDraftLink && idea.slug && (
            <Link href={`/admin/blog/${idea.slug}/edit`} className="text-[11px] font-bold text-[#287271] underline">
              Open draft →
            </Link>
          )}
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            disabled={pending}
            className="text-[11px] font-bold text-[#287271] underline disabled:opacity-50"
          >
            {editing ? "Close" : "Edit"}
          </button>
          {showRestore ? (
            <button
              type="button"
              onClick={() => commitRestore(idea.id)}
              disabled={pending}
              className="text-[11px] font-bold text-[#287271] underline disabled:opacity-50"
            >
              Restore
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                const reason = window.prompt("Reason for killing this topic (kept for audit):", "");
                if (reason !== null) commitKill(idea.id, reason);
              }}
              disabled={pending}
              className="text-[11px] font-bold text-[#8a2e1a] underline disabled:opacity-50"
            >
              Kill
            </button>
          )}
        </div>
      </div>

      {editing && (
        <EditDrawer
          idea={idea}
          categories={categories}
          pending={pending}
          onSave={(patch) => { commitUpdate(idea.id, patch); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function EditDrawer({
  idea, categories, pending, onSave, onCancel,
}: {
  idea: PostIdea;
  categories: Category[];
  pending: boolean;
  onSave: (patch: Partial<PostIdeaInput>) => void;
  onCancel: () => void;
}) {
  const [state, setState] = useState({
    working_title: idea.working_title,
    category_id: idea.category_id ?? "",
    primary_keyword: idea.primary_keyword ?? "",
    target_keywords: idea.target_keywords.join(", "),
    proposed_publish_date: idea.proposed_publish_date ?? "",
    notes: idea.notes ?? "",
    tier: idea.tier,
    variant_axis: idea.variant_axis ?? "",
    variants: idea.variants.join(", "),
    series_id: idea.series_id ?? "",
  });

  function setField<K extends keyof typeof state>(k: K, v: (typeof state)[K]) {
    setState((s) => ({ ...s, [k]: v }));
  }

  return (
    <div className="mt-3 pt-3 border-t border-[#e5dfd8] grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
      <Field label="Working title">
        <input type="text" value={state.working_title} onChange={(e) => setField("working_title", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending} />
      </Field>
      <Field label="Tier">
        <select value={state.tier} onChange={(e) => setField("tier", e.target.value as PostIdeaTier)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending}>
          <option value="A">A · Single bespoke</option>
          <option value="B">B · Cluster of variants</option>
          <option value="C">C · Service page (programmatic)</option>
        </select>
      </Field>
      <Field label="Category">
        <select value={state.category_id} onChange={(e) => setField("category_id", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending}>
          <option value="">— pick —</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Primary keyword">
        <input type="text" value={state.primary_keyword} onChange={(e) => setField("primary_keyword", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending} />
      </Field>
      <Field label="Target date">
        <input type="date" value={state.proposed_publish_date} onChange={(e) => setField("proposed_publish_date", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending} />
      </Field>
      <Field label="Series id (optional)">
        <input type="text" value={state.series_id} onChange={(e) => setField("series_id", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending} placeholder="career-switch-at-40" />
      </Field>
      {state.tier === "B" && (
        <>
          <Field label="Variant axis (Tier B only)">
            <input type="text" value={state.variant_axis} onChange={(e) => setField("variant_axis", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending} placeholder="town / demographic / job" />
          </Field>
          <Field label="Variants (CSV — fans out as N posts)">
            <input type="text" value={state.variants} onChange={(e) => setField("variants", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending} placeholder="middlesbrough, hartlepool, stockton" />
          </Field>
        </>
      )}
      <Field label="Target keywords (CSV)" wide>
        <input type="text" value={state.target_keywords} onChange={(e) => setField("target_keywords", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending} />
      </Field>
      <Field label="Notes for the drafter" wide>
        <textarea value={state.notes} onChange={(e) => setField("notes", e.target.value)} className="w-full min-h-[80px] px-3 py-2 rounded-md border border-input bg-white text-sm" disabled={pending} />
      </Field>
      <div className="md:col-span-2 flex gap-2 pt-2">
        <button type="button" onClick={() => onSave(state)} disabled={pending} className="bg-[#287271] hover:bg-[#246564] text-white font-bold text-sm px-4 py-2 rounded-md disabled:opacity-50">
          {pending ? "Saving..." : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={pending} className="text-sm font-bold text-[#5a6a72] px-4 py-2 disabled:opacity-50">
          Cancel
        </button>
      </div>
    </div>
  );
}

function NewIdeaForm({ categories, pending, onSubmit }: { categories: Category[]; pending: boolean; onSubmit: (input: PostIdeaInput) => void }) {
  const [state, setState] = useState<PostIdeaInput>({
    working_title: "",
    category_id: "",
    primary_keyword: "",
    target_keywords: "",
    proposed_publish_date: "",
    series_id: "",
    notes: "",
    tier: "A",
    variant_axis: "",
    variants: "",
  });
  function setField<K extends keyof PostIdeaInput>(k: K, v: PostIdeaInput[K]) {
    setState((s) => ({ ...s, [k]: v }));
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
      <Field label="Working title">
        <input type="text" value={state.working_title} onChange={(e) => setField("working_title", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending} />
      </Field>
      <Field label="Tier">
        <select value={state.tier} onChange={(e) => setField("tier", e.target.value as PostIdeaTier)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending}>
          <option value="A">A · Single bespoke</option>
          <option value="B">B · Cluster of variants</option>
          <option value="C">C · Service page (programmatic)</option>
        </select>
      </Field>
      <Field label="Category">
        <select value={state.category_id} onChange={(e) => setField("category_id", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending}>
          <option value="">— pick —</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Primary keyword">
        <input type="text" value={state.primary_keyword} onChange={(e) => setField("primary_keyword", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending} />
      </Field>
      <Field label="Target date">
        <input type="date" value={state.proposed_publish_date} onChange={(e) => setField("proposed_publish_date", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending} />
      </Field>
      <Field label="Series id (optional)">
        <input type="text" value={state.series_id} onChange={(e) => setField("series_id", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending} />
      </Field>
      {state.tier === "B" && (
        <>
          <Field label="Variant axis">
            <input type="text" value={state.variant_axis} onChange={(e) => setField("variant_axis", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending} placeholder="town" />
          </Field>
          <Field label="Variants (CSV)">
            <input type="text" value={state.variants} onChange={(e) => setField("variants", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending} placeholder="middlesbrough, hartlepool" />
          </Field>
        </>
      )}
      <Field label="Target keywords (CSV)" wide>
        <input type="text" value={state.target_keywords} onChange={(e) => setField("target_keywords", e.target.value)} className="w-full h-9 px-3 rounded-md border border-input bg-white text-sm" disabled={pending} />
      </Field>
      <Field label="Notes for the drafter" wide>
        <textarea value={state.notes} onChange={(e) => setField("notes", e.target.value)} className="w-full min-h-[80px] px-3 py-2 rounded-md border border-input bg-white text-sm" disabled={pending} />
      </Field>
      <div className="md:col-span-2 flex gap-2 pt-2">
        <button
          type="button"
          onClick={() => onSubmit(state)}
          disabled={pending || !state.working_title.trim()}
          className="bg-[#287271] hover:bg-[#246564] text-white font-bold text-sm px-4 py-2 rounded-md disabled:opacity-50"
        >
          {pending ? "Adding..." : "Add to queue"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={wide ? "md:col-span-2" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-[#5a6a72] mb-1">{label}</label>
      {children}
    </div>
  );
}
