#!/usr/bin/env node
// Archive a game's RAW ART to R2. Dry run by default; --go to write.
//
//   node tools/packs/sources.mjs <gameId> [--go]
//
// The pack payload (models, textures) is published immutably under
// games/<id>/<version>/ and can always be pulled back from there. The raw art
// it is generated FROM — the images the sheets are sampled out of — is not in
// any pack, so without this it would exist on exactly one disk. Regenerating
// it is not a fix: a generator returns a different picture every time, so a
// lost source means the street can never be tweaked again, only replaced.
//
// Unlike a pack, this prefix is MUTABLE and overwrites: there is one current
// set of sources, not a version history, and it is never fetched by a client.
import { config } from "dotenv";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
config({ path: path.join(root, "backend", ".env") });

const gameId = process.argv[2];
const GO = process.argv.includes("--go");
if (!gameId) {
  console.error("usage: node tools/packs/sources.mjs <gameId> [--go]");
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

const TYPES = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".glb": "model/gltf-binary" };

const artDir = path.join(here, gameId, "art");
const entries = await fs.readdir(artDir, { withFileTypes: true }).catch(() => []);
// Only the binaries. The scripts and the README are in git, where they belong.
const files = entries
  .filter((e) => e.isFile() && !e.name.endsWith(".py") && !e.name.endsWith(".md"))
  .map((e) => e.name)
  .sort();
if (files.length === 0) {
  console.error(`no raw art under ${artDir}`);
  process.exit(1);
}

console.log(GO ? "UPLOADING" : "DRY RUN — nothing will be written (add --go)");
let bytes = 0;
for (const name of files) {
  const body = await fs.readFile(path.join(artDir, name));
  const key = `sources/${gameId}/art/${name}`;
  if (GO) {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: TYPES[path.extname(name)] ?? "application/octet-stream",
        // Short cache: this prefix is overwritten in place, so a stale copy
        // here is a genuine wrong answer rather than a saving.
        CacheControl: "public, max-age=60",
      })
    );
  }
  bytes += body.length;
  console.log(`  ${GO ? "✓" : "·"} ${key}  ${(body.length / 1024).toFixed(1)} KB`);
}
console.log(`\n${GO ? "archived" : "would archive"}: ${files.length} files, ${(bytes / 1e6).toFixed(2)} MB`);
if (GO) console.log(`\nRestore with:\n  npm run pack:restore ${gameId}`);
