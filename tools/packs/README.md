# Game packs

A pack is everything a game downloads before a match: textures, models,
audio — listed in a `manifest.json` with sizes, under a content-hashed folder
on the CDN (`games/<gameId>/<version>/…`). Versions are immutable: any change
becomes a new folder, so a player mid-download is never handed a half-new pack,
and old versions can be deleted from R2 later at leisure.

    tools/packs/<gameId>/src/      the files exactly as they ship (relative paths = manifest paths)
    node tools/packs/build.mjs <gameId>     → out/games/<gameId>/<version>/…  + backend/src/games/<gameId>/pack.ts
    node tools/packs/upload.mjs <gameId> [--go]   → uploads out/ for that game (dry run without --go)

After uploading: wait ~20 s before fetching (a 404 cached at the edge against
an immutable path is forever), verify with curl, then restart the backend so
GET /api/games serves the new version.

Sources that are generated (procedural textures etc.) have their generator
next to them (`gen-*.py`); the generated file is committed so a build never
depends on the generator's toolchain.
