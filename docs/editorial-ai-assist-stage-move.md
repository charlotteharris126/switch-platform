# Spec — move pre-draft AI assist from the post edit page to the idea-approval stage

**Status:** spec, not built. Backlog item raised 2026-05-28 by Charlotte while reviewing the Switchguides agentified drafter (Sasha). Spec author: Claude (this session). Pickup by: next platform session.

## Why this exists

The current AI Suggest buttons on `/admin/blog/[slug]/edit` (Suggest H2 outline, Suggest headlines, Suggest excerpt, Suggest meta description, Suggest tags) predate the agentified drafter. They were built when Charlotte drafted posts manually and AI gave scaffolding mid-draft.

Now that Sasha drafts the post from the queued idea, the editorial workflow has shifted:

1. **Mira** queues an idea in `editorial.post_ideas` via `/blog-content-plan` skill (working title, tier, primary keyword, target keywords, category, notes).
2. **Charlotte** approves / edits / kills queued ideas in `/admin/blog/content-plan`.
3. **Sasha** drafts the post via the `blog-draft-from-queue` EF (sets body + excerpt + meta_title + meta_description + dek + tags from the approved idea).
4. **Charlotte** proofs the draft in `/admin/blog/[slug]/edit` (mostly cover image + minor copy tweaks + scheduling).
5. **Build** publishes.

Steps 1-2 are the right place for "shape the post before it's drafted" AI assistance — refine working title, suggest the H2 outline that Sasha will follow, sharpen the primary keyword. Step 4 is the right place for "polish a specific field that came out weak" AI assistance.

Today, all the AI assist sits on step 4, which is the wrong stage for most of it.

## Decision (2026-05-28)

Charlotte picked option 1 (proper move) over option 2 (just hide the H2 outline button). The move ships as one coordinated change next session.

## Scope

### Move FROM edit page TO content-plan idea approval

These AI assist surfaces relocate to the idea-row edit drawer in `/admin/blog/content-plan` (currently `ContentPlanBoard` in `platform/app/app/admin/blog/content-plan/board.tsx`):

1. **Suggest H2 outline** — given the idea (working title, primary keyword, category, notes), suggest 5-8 H2 headings. Charlotte picks one set or edits. Stored on the post_idea (new column required — see Schema below) so Sasha's draft prompt reads the approved outline and follows it.
2. **Suggest title alternates** — given the working title + primary keyword, suggest 5 title variants under 60 chars. Charlotte picks one. Writes back to `working_title`.
3. **Suggest primary keyword refinement** — given the working title + intended outcome, suggest 3 alternative primary keywords with rough search volume estimates. Charlotte picks one. Writes back to `primary_keyword`.

### Keep on edit page (post-draft polish)

1. **Suggest excerpt** — for post-draft polish if Sasha's first pass reads flat.
2. **Suggest meta description** — same.
3. **Suggest headlines** (the existing one) — narrow use case but harmless to keep.

### Remove from edit page

1. **Suggest H2 outline** — moved to idea approval (above). The edit-page button has no role once Sasha has shipped the structure.
2. **Suggest tags** — already covered: the drafter outputs `suggested_tags` from the known-tag allowlist. If Charlotte wants different tags she just edits the field. The suggest button is redundant.

## Schema impact

Add one column to `editorial.post_ideas`:

```sql
ALTER TABLE editorial.post_ideas
  ADD COLUMN IF NOT EXISTS approved_outline TEXT[] DEFAULT '{}';

COMMENT ON COLUMN editorial.post_ideas.approved_outline IS
  'H2 headings Charlotte approved during idea review. Sasha''s drafter reads this and uses it as the body structure if non-empty; otherwise the drafter picks its own H2s per the post spine rules.';
```

Migration: `NNNN_post_ideas_approved_outline.sql`. Additive, no downstream breakage, no schema_version bump.

## EF impact

`blog-draft-from-queue/index.ts`:

- Read `approved_outline` from the picked idea.
- If non-empty, include it in the user prompt with a directive: "Build the body around these H2 headings in order. You may refine the wording (≤2 words changed per heading) but you may NOT reorder, drop, or add headings."
- If empty, fall back to current behaviour (drafter chooses its own H2s per the structure rules).

## UI impact

### `/admin/blog/content-plan` idea edit drawer

Add three new AI suggest buttons (use existing `AiSuggestButton` with new `AiAssistKind` values):

- `kind: "idea_outline"` → returns `string[]` of suggested H2s; on apply, writes to `approved_outline` field on the post_idea.
- `kind: "idea_title_alternates"` → returns `string[]` of working_title suggestions; on apply, replaces `working_title`.
- `kind: "idea_primary_keyword"` → returns `string[]` of primary keyword suggestions; on apply, replaces `primary_keyword`.

### `/admin/blog/[slug]/edit` post form

- Remove the H2 outline button (the block in `post-form.tsx` around the body field).
- Remove the tags suggest button.
- Keep excerpt + meta_description suggest buttons.

## Edge function impact

`blog-ai-assist/index.ts` needs three new `kind` handlers: `idea_outline`, `idea_title_alternates`, `idea_primary_keyword`. Each has its own system prompt + user prompt shape (the existing handlers can guide the structure).

## Test plan

1. Charlotte queues a test idea via `/blog-content-plan`.
2. Opens it in `/admin/blog/content-plan`, clicks "Suggest H2 outline", picks one set.
3. Confirms `approved_outline` populated in DB.
4. Fires the drafter manually.
5. Opens the drafted post, confirms the H2 set in the body matches what she approved (with minor wording tweaks allowed).
6. Repeats for title alternates and primary keyword refinement.

## Rollback

Each new column + new AI kind is additive. Rollback is per-piece: drop the column, remove the new EF handlers, restore the edit-page buttons.

## Effort estimate

~4-6 hours of platform work:
- 1 migration (10 min)
- 3 new EF handlers in `blog-ai-assist` (~2 hr)
- 3 new buttons + drawer wiring on content-plan board (~1.5 hr)
- Drafter EF approved_outline integration (~30 min)
- Edit-page button removals (~10 min)
- Manual test + screenshot (~30 min)
