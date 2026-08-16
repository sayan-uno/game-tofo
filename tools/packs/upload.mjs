#!/usr/bin/env node
// Upload a built pack to R2. Dry run by default; --go to write. Refuses to
// overwrite existing objects (paths are immutable and cached for a year).
//
//   node tools/packs/upload.mjs <gameId> [--go]
import { config } from "dotenv";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
config({ path: path.join(root, "backend", ".env") });

const gameId = process.argv[2];
const GO = process.argv.includes("--go");
if (!gameId) {
  console.error("usage: node tools/packs/upload.mjs <gameId> [--go]");
  process.exit(2);
}
const { R2_ACCOUNT_ID: ACC, R2_BUCKET: BUCKET = "tofo", R2_ACCESS_KEY_ID: KEY, R2_SECRET_ACCESS_KEY: SECRET } = process.env;
if (!ACC || !KEY || !SECRET) {
  console.error("missing R2_* credentials in backend/.env");
  process.exit(1);
}
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${ACC}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: KEY, secretAccessKey: SECRET },
});

const TYPES = {
  ".json": "application/json",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ktx2": "image/ktx2",
  ".glb": "model/gltf-binary",
  ".env": "application/octet-stream",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".bin": "application/octet-stream",
};

const gameOut = path.join(here, "out", "games", gameId);
const versions = await fs.readdir(gameOut).catch(() => []);
if (versions.length !== 1) {
  console.error(`expected exactly one built version under ${gameOut} — run build.mjs first`);
  process.exit(1);
}
const version = versions[0];
const dir = path.join(gameOut, version);
async function walk(d, base = d) {
  const out = [];
  for (const e of await fs.readdir(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}
const files = await walk(dir);
const exists = async (Key) => {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
    return true;
  } catch {
    return false;
  }
};

console.log(GO ? "UPLOADING" : "DRY RUN — nothing will be written (add --go)");
let done = 0;
let blocked = 0;
// manifest.json goes LAST so a client can never see a manifest whose files
// haven't landed yet.
const ordered = [...files.filter((f) => f !== "manifest.json"), "manifest.json"];
for (const rel of ordered) {
  const key = `games/${gameId}/${version}/${rel}`;
  const body = await fs.readFile(path.join(dir, rel));
  if (await exists(key)) {
    console.log(`  ⛔ ${key} already exists — left untouched`);
    blocked++;
    continue;
  }
  if (GO) {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: TYPES[path.extname(rel)] ?? "application/octet-stream",
        CacheControl: "public, max-age=31536000, immutable",
      })
    );
  }
  console.log(`  ${GO ? "✓" : "·"} ${key}  ${(body.length / 1024).toFixed(1)} KB`);
  done++;
}
console.log(`\n${GO ? "uploaded" : "would upload"}: ${done}${blocked ? `   skipped (exist): ${blocked}` : ""}`);
if (GO && done) console.log(`\nWait ~20 s, then verify:\n  curl -sSI https://cdn.tofo.in/games/${gameId}/${version}/manifest.json | head -1`);
