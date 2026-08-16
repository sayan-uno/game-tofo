# Game packs

A pack is everything a game downloads before a match: textures, models,
audio — listed in a `manifest.json` with sizes, under a content-hashed folder
on the CDN (`games/<gameId>/<version>/…`). Versions are immutable: any change
becomes a new folder, so a player mid-download is never handed a half-new pack,
and old versions can be deleted from R2 later at leisure.

    tools/packs/<gameId>/src/      the files exactly as they ship (relative paths = manifest paths)
    tools/packs/<gameId>/art/      the raw images the textures are generated FROM, + their generators

    npm run pack:build   <gameId>          → out/games/<gameId>/<version>/… + backend/src/games/<gameId>/pack.ts
    npm run pack:upload  <gameId> -- --go  → publishes out/ for that game   (dry run without --go)
    npm run pack:sources <gameId> -- --go  → archives art/ to sources/<gameId>/ on R2
    npm run pack:restore <gameId>          → pulls src/ and art/ back down from the CDN

After uploading: wait ~20 s before fetching (a 404 cached at the edge against
an immutable path is forever), verify with curl, then restart the backend so
GET /api/games serves the new version.

## None of a pack's binaries live in git

`src/` and `art/` are gitignored. Between them they are ~8 MB of binaries that
would roughly double the repository, and every one of those bytes is already on
R2 — the pack payload immutably under `games/<id>/<version>/`, the raw art
under `sources/<id>/`. Git keeps the code that builds them, which is the part
that actually merges and diffs. It is the same rule the character pipeline
follows.

So a fresh clone starts with no pack binaries at all. Before touching a pack:

```bash
npm run pack:restore trackline     # ~8 MB, no credentials needed
```

That restores whatever version `backend/src/games/<id>/pack.ts` points at —
by definition the pack currently in production. Pass a version to get an older
one. **`pack:sources` is not automatic:** after adding or re-generating a raw
image, run it, or that image exists on one disk only.

Sources that are generated (procedural textures etc.) have their generator
next to them (`build_*.py`), and the generated file is published in the pack,
so a build never depends on the generator's toolchain.

## Before you launch: the CDN's CORS allowlist

Pack files are fetched with `fetch()`, so the bucket must name the browser's
origin. As of 2026-08-16 the allowlist holds only:

```
http://localhost:5173
https://urban-system-jj7rwv5w69gwfq4qj-5173.app.github.dev   (this Codespace)
```

`https://tofo.in` is **not** on it. Deploying the frontend to its real domain
without adding it means every pack and character download fails with a CORS
error and no game can ever start — the START button simply never lights.

Check any origin before trusting it:

```bash
curl -sSI -H "Origin: https://tofo.in" \
  https://cdn.tofo.in/games/trackline/<version>/manifest.json | grep -i access-control
```

A missing `access-control-allow-origin` header in that response is the failure.
