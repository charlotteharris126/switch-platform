# switch-platform

The admin dashboard (and eventually provider portal) for Switchable Ltd.

- `admin.switchleads.co.uk` → internal admin UI (Charlotte, Sasha)
- `app.switchleads.co.uk` → provider portal (Phase 4)

Single codebase, hostname-based routing in `proxy.ts`.

Full architecture, MVP scope, and build sequence live in the workspace at
`Switch-Claude/platform/docs/admin-dashboard-scoping.md`.

## Stack

- Next.js 15 (App Router, Turbopack, Server Actions)
- TypeScript
- Tailwind CSS v4
- shadcn/ui
- Supabase (Postgres + Auth + SSR)
- Deployed on Netlify

## Local dev

```bash
cp .env.local.example .env.local
# fill in Supabase URL, anon key, ADMIN_ALLOWLIST
npm install
npm run dev
```

Dev server runs at `http://localhost:3000`. Defaults to the admin surface. To
test the provider surface locally, visit `http://app.localhost:3000` (most OSes
resolve `.localhost` subdomains automatically).

## Auth flow

1. User lands on any admin path → proxy redirects unauthenticated users to `/login`
2. `/login` → email + password (Server Action)
3. Server Action checks MFA factor state:
   - No factor enrolled → redirect to `/enrol-mfa` (QR code setup)
   - Factor enrolled → redirect to `/verify-mfa` (TOTP challenge)
4. After AAL2 step-up → redirect to admin home
5. Admin layout double-checks allowlist + AAL2 before rendering any protected content

Proxy and layout both enforce auth — defence in depth.

## Environment variables (production, set in Netlify)

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon key (RLS-protected) |
| `ADMIN_ALLOWLIST` | Comma-separated list of admin emails |

## Never in this repo

- Service role key (set only in Supabase dashboard, never here)
- Any secret not flagged `NEXT_PUBLIC_*`

Per `.claude/rules/data-infrastructure.md` in the workspace.
