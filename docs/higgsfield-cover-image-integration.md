# Spec — Higgsfield cover image generation in the Switchguides drafter

**Status:** spec, not built. Backlog raised by Charlotte 2026-05-29 reviewing the agentified drafter. Pickup next platform session.

## Why this exists

Every published Switchguides post needs a cover image (1200×630, OG/Twitter card standard). The drafter currently leaves `cover_image_url` and `cover_image_alt` empty, which is the **only** unfixable SEO warn — "Cover image: Missing" — that survives every draft. Charlotte has to upload one by hand for every post.

Higgsfield (higgsfield.ai) offers image generation. They expose three integration paths:

| Path | Use case | Fits our drafter? |
|---|---|---|
| CLI (`@higgsfield/cli` npm) | Interactive — device-code OAuth in browser | No — drafter runs unattended |
| MCP server (`https://mcp.higgsfield.ai/mcp`) | Agent integration — auth via Higgsfield account | No — drafter is a Deno EF, not an agent session |
| **REST API** (`/v1/generations`) | Server-side, API-key auth | **Yes** — this is what we need |

So this spec covers REST integration.

## Architecture

```
blog-draft-from-queue EF
  ├── Draft body via Anthropic (existing)
  ├── INSERT into editorial.posts (existing)
  └── NEW: generateCoverImage(idea, draft)
        ├── Build hero-image prompt from post title + dek + entity
        ├── POST /v1/generations (Higgsfield REST)
        ├── Poll GET /v1/generations/{id} until ready
        ├── Fetch image bytes
        ├── Upload to Supabase storage 'blog-media/covers/<slug>.png'
        ├── UPDATE editorial.posts SET cover_image_url, cover_image_alt
        └── Return — non-blocking on failure
```

**Failure mode:** if Higgsfield is down, key missing, polling times out, or the generated image fails a basic validity check — log the error, leave cover empty, return. Drafter still ships the post. Charlotte uploads cover by hand as fallback.

## What needs confirming before code can ship

Charlotte to confirm from her Higgsfield dashboard once signed up:

1. **REST API base URL** — third-party blogs hint at `https://platform.higgsfield.ai` but I have not found this in Higgsfield's own docs. She needs to grab the exact base from her dashboard's "API" or "developer" section.
2. **Authentication header shape** — likely `Authorization: Bearer <key>` per the apidog write-up, but worth confirming.
3. **Exact body schema for text-to-image** — apidog showed `{task, model, prompt, width, height, steps}` but the model catalog + parameter names should come from `higgsfield model list` (CLI) or the dashboard's model picker.
4. **Polling vs webhook** — is async-with-poll the only path, or can we register a webhook to skip the polling loop?
5. **Pricing** — per-image cost matters for the M/W/F cron + Tier B variants (one Tier B cluster of 30 town variants = 30 images at $X each).

## Schema impact

None. `editorial.posts` already has `cover_image_url TEXT` and `cover_image_alt TEXT`. Supabase storage already has the `blog-media` bucket (migration 0170).

## EF impact

`blog-draft-from-queue/index.ts`:

```ts
const HIGGSFIELD_API_BASE = Deno.env.get("HIGGSFIELD_API_BASE") ?? "TBD";

async function generateCoverImage(
  post: { slug: string; title: string; dek: string | null; primary_keyword: string | null },
): Promise<{ url: string; alt: string } | null> {
  const key = await getVaultSecret("HIGGSFIELD_API_KEY");
  if (!key) {
    console.log("HIGGSFIELD_API_KEY not in vault — cover generation skipped");
    return null;
  }
  try {
    const prompt = buildCoverPrompt(post);
    // 1. POST /v1/generations  → returns { id }
    // 2. Poll GET /v1/generations/{id} until status = "succeeded" or timeout
    // 3. Fetch image bytes from response.url
    // 4. Upload to Supabase storage at `blog-media/covers/${post.slug}.png`
    // 5. Build public URL
    // 6. Return { url, alt }
    return null; // TODO: implement once base URL confirmed
  } catch (err) {
    console.error("cover generation failed:", err);
    return null; // non-blocking
  }
}

function buildCoverPrompt(post: { title: string; dek: string | null; primary_keyword: string | null }): string {
  // Editorial brand: warm, optimistic, NOT stock-photo-of-laptop. Brand
  // palette (Deep Teal, Coral, Gold, Cream) per
  // switchable/site/deploy/brand/reference.html.
  return [
    `Editorial hero image for a UK adult-learning publication.`,
    `Topic: ${post.title}`,
    post.dek ? `Subhead: ${post.dek}` : "",
    `Primary entity: ${post.primary_keyword ?? "career change in the UK"}`,
    `Style: warm editorial illustration (NOT photographic), flat or semi-flat,`,
    `palette of deep teal #287271, coral #E76F51, gold #E9C46A, cream #F4F4F2.`,
    `No people's faces (avoids stock-photo cliché + likeness consent issues).`,
    `Avoid: laptops, lightbulbs, gears, abstract speed lines, generic business clip-art.`,
    `Aspect ratio: 1200×630. Composition should leave clear left or upper-third space for overlay text.`,
  ].filter(Boolean).join(" ");
}
```

Wire after `insertDraft`:

```ts
const cover = await generateCoverImage({
  slug: inserted.slug,
  title: idea.working_title,
  dek: draft.dek,
  primary_keyword: idea.primary_keyword,
});
if (cover) {
  await sql`
    UPDATE editorial.posts
    SET cover_image_url = ${cover.url}, cover_image_alt = ${cover.alt}
    WHERE id = ${inserted.id}
  `;
}
```

## Supabase vault setup (Charlotte)

Once Higgsfield API key in hand:

```sql
SELECT public.set_shared_secret('HIGGSFIELD_API_KEY', '<paste-key>');
SELECT public.set_shared_secret('HIGGSFIELD_API_BASE', 'https://<confirmed-base-url>');
```

## Storage URL pattern

Bucket: `blog-media` (already exists).
Path: `covers/<post-slug>.png`.
Public URL: `https://igvlngouxcirqhlsrhga.supabase.co/storage/v1/object/public/blog-media/covers/<slug>.png`.

Set `cover_image_url` to the public URL above. The site build script reads `cover_image_url` and renders it directly.

## Alt text

Drafter EF should output an `cover_image_alt` field in its JSON response (one more JSON key, describing the image for screen readers + image SEO). Don't reuse the visual prompt — that's wrong shape for alt. Alt should be a plain-English description of what the image shows.

Add to the EF's JSON output schema:

```ts
"cover_image_prompt": "<the visual brief for Higgsfield — what the image should LOOK like>",
"cover_image_alt": "<plain-English alt for screen readers, ~12 words>",
```

Then generateCoverImage uses `cover_image_prompt` as the Higgsfield prompt and persists `cover_image_alt` to the post.

## Effort estimate

~2-3 hours once Higgsfield base URL + auth confirmed:
- generateCoverImage implementation (~60 min)
- Polling loop with timeout (~20 min)
- Supabase storage upload (~20 min)
- Drafter EF JSON schema additions (cover_image_prompt + cover_image_alt) (~15 min)
- Test with 1-2 ideas (~30 min)
- Brevo email thumbnail update (~15 min)

## Rollback

The whole feature gates on `HIGGSFIELD_API_KEY` presence. Remove the secret from vault → drafter skips cover gen on next run. No schema migration to roll back.

## Tier B (cluster) consideration

A Tier B cluster (e.g. "Skills Bootcamps in [town]" × 30 towns) currently generates 1 master + 29 variants in one EF call. With cover gen, that's 30 images. Cost matters:

- If per-image cost is high, ONE cover for the master + variants share it.
- If low, generate per-variant with the town name in the prompt (better visual differentiation).

Decision deferred until pricing confirmed.
