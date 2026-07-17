# TOFO Games

A browser 3D game platform built with **Babylon.js**. Current milestone: the lobby —
Google sign-in, unique player UIDs, friends (search / request / accept), squad lobbies
with invites, and LiveKit voice chat.

## Architecture — frontend and backend are fully separate

```
game-tofo/
├── frontend/   Vite + TypeScript + Babylon.js  (pure static site when built)
└── backend/    Node + Express + Socket.IO + PostgreSQL (Drizzle ORM) + Redis + LiveKit tokens
```

They talk **only** over HTTP + WebSocket. There is exactly **one coupling point**:

- `frontend/.env` → `VITE_API_URL` — where the backend lives.

And one on the backend side for CORS:

- `backend/.env` → `FRONTEND_URL` — which origin is allowed to call it.

No imports cross the boundary, no shared build, no cookies/sessions (auth is a JWT
in the `Authorization` header), so the two can be hosted anywhere independently.

## Setup

1. **Install** (already done if `node_modules` exists):
   ```bash
   npm run install:all
   ```

2. **Fill in `backend/.env`** — Postgres URL, Redis URL, Google OAuth Client ID,
   JWT secret, LiveKit keys. Each variable has instructions in the file.

3. **Fill in `frontend/.env`** — the same Google Client ID.

4. **Create/update the database tables.** The schema lives in `backend/src/db/schema.ts`
   (single source of truth); every change to it becomes a versioned SQL file in
   `backend/drizzle/` that is committed to git and applied in order:
   ```bash
   npm run db:migrate     # applies any pending migrations (all of them on a fresh DB)
   ```
   When you **change the schema** later:
   ```bash
   npm run db:generate    # writes a new migration file into backend/drizzle/ — review it, commit it
   npm run db:migrate     # applies it to the database
   ```
   Bonus: `npm --prefix backend run db:studio` opens a visual database browser.

5. **Run both dev servers:**
   ```bash
   npm run dev
   ```
   Frontend: http://localhost:5173 · Backend: http://localhost:4000

### Google OAuth setup
In [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials),
create an **OAuth 2.0 Client ID** (type: *Web application*) and add your frontend URL(s)
to **Authorized JavaScript origins**: `http://localhost:5173` for dev, plus your
production frontend URL later. Put the Client ID in **both** `.env` files.

## How to host frontend and backend separately (later)

**Backend** (Render / Railway / Fly.io / a VPS — anything that runs Node):
1. Deploy the `backend/` folder. Build: `npm install && npm run build`, start: `npm start`.
2. Run migrations on every deploy, **before** the new version starts:
   `npm run db:migrate` (most hosts have a "pre-deploy" / "release command" slot for this).
3. Set the same env vars from `backend/.env` on the host, with
   `FRONTEND_URL=https://your-frontend-domain.com`.

**Frontend** (Vercel / Netlify / Cloudflare Pages — it's just static files):
1. Deploy the `frontend/` folder. Build: `npm run build`, output dir: `dist`.
2. Set **one** env var: `VITE_API_URL=https://your-backend-domain.com`.

**Connect them** — that's already it:
- `VITE_API_URL` (frontend) → points at the backend. **This is the one line.**
- `FRONTEND_URL` (backend) → allows the frontend's origin through CORS.
- Add the production frontend URL to the Google OAuth client's authorized origins.

No code changes needed, ever — only those env values.

## Performance practices already in place

- **Tree-shaken Babylon imports** — only used modules ship in the bundle.
- **Lazy loading** — Babylon loads only after login; LiveKit (~500 kB) loads only
  when a squad actually forms. The login screen itself is ~5 kB gzipped.
- **Chunk splitting** — Babylon / LiveKit / Socket.IO are separate long-term-cached chunks.
- **Capped hardware scaling** — high-DPI phones don't render 3–4× the pixels.
- **Frozen materials & world matrices** for static scenery, instanced meshes for
  repeated geometry, pointer-move picking disabled.
- **Render loop pauses** when the tab is hidden (battery + CPU).
- **Redis** for all hot state (presence, lobby membership); Postgres only for
  durable data (accounts, friendships).

## What's next (planned)

- Real character models (GLB) — the lobby scene has a `createCharacter` seam to swap
  primitives for loaded models without touching anything else.
- Game modes, matchmaking, in-game state sync.
