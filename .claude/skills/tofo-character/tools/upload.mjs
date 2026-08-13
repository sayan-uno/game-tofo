// Uploads built assets to R2 at their manifest paths.
//
//   node upload.mjs                 # dry run — lists what WOULD be uploaded
//   node upload.mjs --go            # actually upload
//
// Refuses to overwrite an existing object. Every path is versioned (/v1/) and
// served with a one-year immutable cache header, so overwriting in place would
// strand players on a stale file with no way to purge it. New content goes to
// a new version folder.
import { config } from 'dotenv';
// Resolved from this file's own location, not the repo's absolute path, so the
// script keeps working after a move to a different machine or checkout dir.
config({ path: path.resolve(import.meta.dirname, '../../../../backend/.env') });
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const GO = process.argv.includes('--go');
const OUT = path.resolve(import.meta.dirname, 'out');
const { R2_ACCOUNT_ID: ACC, R2_BUCKET: BUCKET = 'tofo', R2_ACCESS_KEY_ID: KEY, R2_SECRET_ACCESS_KEY: SECRET } = process.env;
if (!ACC || !KEY || !SECRET) { console.error('missing R2_* credentials in backend/.env'); process.exit(1); }

const s3 = new S3Client({ region: 'auto', endpoint: `https://${ACC}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: KEY, secretAccessKey: SECRET } });

const manifest = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'));
const items = [...manifest.characters.map((c) => c.key), ...manifest.newAnimations.map((a) => a.key)];
if (!items.length) { console.log('nothing in out/manifest.json to upload'); process.exit(0); }

const exists = async (Key) => {
  try { await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key })); return true; }
  catch { return false; }
};

console.log(GO ? 'UPLOADING' : 'DRY RUN — nothing will be written (add --go)');
let done = 0, blocked = 0;
for (const key of items) {
  const local = path.join(OUT, key);
  const body = await readFile(local);
  if (await exists(key)) {
    console.log(`  ⛔ ${key}  ALREADY EXISTS — refusing to overwrite (publish /v2/ instead)`);
    blocked++;
    continue;
  }
  if (GO) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: body,
      ContentType: 'model/gltf-binary',
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  }
  console.log(`  ${GO ? '✓' : '·'} ${key}  ${(body.length / 1024).toFixed(1)} KB`);
  done++;
}
console.log(`\n${GO ? 'uploaded' : 'would upload'}: ${done}${blocked ? `   blocked (already exist): ${blocked}` : ''}`);
if (GO && done) {
  console.log('\nVerify:');
  for (const key of items) console.log(`  curl -sSI https://cdn.tofo.in/${key} | head -1`);
}
