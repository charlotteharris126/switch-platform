// /admin/blog/content-plan — topic pipeline for Switchguides.
//
// Reads editorial.post_ideas, groups by status (queued / drafted /
// published / killed). Inline edit, approve, reject, restore.
// Tier badge (A/B/C). Add new idea via the form at top.

import { PageHeader } from "@/components/page-header";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  listPostIdeasAction,
  listCategoriesAction,
} from "../actions";
import { ContentPlanBoard } from "./board";

export const dynamic = "force-dynamic";

export default async function ContentPlanPage() {
  const [ideasResult, catsResult] = await Promise.all([
    listPostIdeasAction(),
    listCategoriesAction(),
  ]);

  if (!ideasResult.ok) {
    return (
      <div className="max-w-6xl space-y-4">
        <PageHeader eyebrow="Switchguides" title="Content plan" />
        <p className="text-[#b3412e]">Could not load post ideas: {ideasResult.error}</p>
      </div>
    );
  }
  const categories = catsResult.ok ? catsResult.data : [];

  const ideas = ideasResult.data;
  const queued = ideas.filter((i) => i.status === "queued");
  const drafted = ideas.filter((i) => i.status === "drafted");
  const published = ideas.filter((i) => i.status === "published");
  const killed = ideas.filter((i) => i.status === "killed");

  return (
    <div className="max-w-6xl space-y-8 py-6">
      <PageHeader
        eyebrow={<Link href="/admin/blog" className="text-[#287271] underline">← Blog</Link>}
        title="Content plan"
        subtitle="Topic pipeline for Switchguides. Mira drops ideas in via /blog-content-plan; you approve / edit / reject. The drafter EF picks the next queued row Mon/Wed/Fri at 09:00 UK."
        actions={
          <a href="#new-idea">
            <Button>+ New idea</Button>
          </a>
        }
      />

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Queued" value={String(queued.length)} accent={queued.length > 0 ? "good" : "muted"} />
        <Stat label="Drafted" value={String(drafted.length)} accent={drafted.length > 5 ? "warn" : "muted"} sub={drafted.length > 5 ? "proof backlog" : undefined} />
        <Stat label="Published" value={String(published.length)} accent="good" />
        <Stat label="Killed" value={String(killed.length)} accent="muted" />
      </section>

      <ContentPlanBoard
        initialIdeas={ideas}
        categories={categories.map((c) => ({ id: c.id, name: c.name }))}
      />
    </div>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent: "good" | "warn" | "muted" }) {
  const colours = {
    good: "bg-[#dcefea] text-[#1f5f5e] border-[#bcdfd8]",
    warn: "bg-[#fcefd6] text-[#92651c] border-[#f0d99c]",
    muted: "bg-white text-[#11242e] border-[#e5dfd8]",
  } as const;
  return (
    <div className={`rounded-2xl border p-4 ${colours[accent]}`}>
      <p className="text-[10px] font-bold uppercase tracking-wide opacity-80">{label}</p>
      <p className="text-2xl font-extrabold mt-1">{value}</p>
      {sub && <p className="text-[10px] mt-0.5 opacity-80">{sub}</p>}
    </div>
  );
}

