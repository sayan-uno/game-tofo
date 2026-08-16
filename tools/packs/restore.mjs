#!/usr/bin/env node
// Pull a game's binaries back out of the CDN and onto this disk.
//
//   node tools/packs/restore.mjs <gameId> [version]
//
// A pack's models, textures and raw art are deliberately NOT in git: they are
// megabytes of derived binaries, and the identical bytes are already published
// on R2. That is only a safe trade if getting them back is one command — this
// is that command, and it is what a fresh clone runs before touching a pack.
//
// With no version it restores whatever backend/src/games/<id>/pack.ts is
// currently pointing at, which is by definition the pack in production.
//
// Reads over plain HTTPS from the public CDN, so it needs no credentials —
// anyone who can clone the repo can restore.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const CDN = process.env.CDN_BASE ?? "https://cdn.tofo.in";

const gameId = process.argv[2];
if (!gameId) {
  console.error("usage: node tools/packs/restore.mjs <gameId> [version]");
  process.exit(2);
}

let version = process.argv[3];
if (!version) {
  const packTs = path.join(root, "backend", "src", "games", gameId, "pack.ts");
  const text = await fs.readFile(packTs, "utf8").catch(() => null);
  const found = text?.match(/version:\s*"([^"]+)"/)?.[1];
  if (!found) {
    console.error(`could not read the current version from ${path.relative(root, packTs)} — pass one explicitly`);
    process.exit(1);
  }
  version = found;
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function write(dest, body) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, body);
}

// ---- the pack payload ------------------------------------------------------
console.log(`restoring ${gameId} ${version} from ${CDN}`);
const manifest = JSON.parse((await get(`${CDN}/games/${gameId}/${version}/manifest.json`)).toString());
let bytes = 0;
for (const f of manifest.files) {
  const body = await get(`${CDN}/games/${gameId}/${version}/${f.path}`);
  await write(path.join(here, gameId, "src", f.path), body);
  bytes += body.length;
  console.log(`  ✓ src/${f.path}  ${(body.length / 1024).toFixed(1)} KB`);
}

// ---- the raw art ---------------------------------------------------------
// Archived by sources.mjs. Optional: a pack can be rebuilt from src/ alone —
// the art is only needed to regenerate the sheets with different settings.
const artList = manifest.files.length ? await listArt(gameId) : [];
for (const name of artList) {
  try {
    const body = await get(`${CDN}/sources/${gameId}/art/${name}`);
    await write(path.join(here, gameId, "art", name), body);
    bytes += body.length;
    console.log(`  ✓ art/${name}  ${(body.length / 1024).toFixed(1)} KB`);
  } catch {
    console.log(`  – art/${name} not archived`);
  }
}

console.log(`\nrestored ${(bytes / 1e6).toFixed(2)} MB into tools/packs/${gameId}/`);

/** Which raw files to look for. The archive has no index, so this reads the
 *  names out of the build scripts that consume them — which keeps the two in
 *  step automatically when a new source image is added. */
async function listArt(id) {
  const dir = path.join(here, id, "art");
  const scripts = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith(".py"));
  const names = new Set();
  for (const s of scripts) {
    const text = await fs.readFile(path.join(dir, s), "utf8");
    for (const m of text.matchAll(/"([\w-]+\.(?:webp|png|jpg))"/g)) {
      if (m[1].includes("_raw") || m[1].startsWith("bld")) names.add(m[1]);
    }
  }
  return [...names].sort();
}
