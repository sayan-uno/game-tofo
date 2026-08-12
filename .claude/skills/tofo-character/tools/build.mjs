// Turns a raw Meshy export into a game-ready TOFO character.
//
//   node build.mjs <input.glb> <characterId> "<Display Name>" [textureSize]
//
// Two hard gates run BEFORE anything is produced. Both exist because a
// character passed the obvious checks, shipped, and had to be withdrawn.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, cloneDocument } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { execFileSync } from 'node:child_process';
import { mkdir, unlink, writeFile, readFile } from 'node:fs/promises';
import { statSync, existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  CDN, CANONICAL_MODEL, CANONICAL_JOINTS, CORE_JOINTS, BIND_TOLERANCE_DEG,
  needsFrameFix, normalizeFrame, inverseBinds, angleBetweenDeg, duration, stripToAnimation,
} from './lib.mjs';

const [src, charId, charName, texArg] = process.argv.slice(2);
if (!src || !charId) { console.error('usage: node build.mjs <input.glb> <id> ["Name"] [textureSize]'); process.exit(1); }
const OUT = path.resolve(import.meta.dirname, 'out');

/** Clips already on the CDN — never re-shipped. Add a slug here when you
 *  publish a new emote, or the next character will ship a duplicate of it. */
const ALREADY_SHIPPED = new Set([
  '019fbd76-8a1f-73ec-aebf-8c3ebb1ad29a', 'Walking', 'Running',
  'run_fast_2', 'run_fast_3', 'Fall1', 'Parkour_Vault_2',
  'Roll_Dodge_1', 'Shake_It_Off_Dance', 'All_Night_Dance',
]);

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const read = async () => {
  const doc = await io.read(path.resolve(src));
  const fixed = needsFrameFix(doc.getRoot());
  if (fixed) normalizeFrame(doc);
  return { doc, fixed };
};

// ---- GATE 1: joint names ---------------------------------------------------
{
  const skin = (await io.read(path.resolve(src))).getRoot().listSkins()[0];
  if (!skin) { console.error('✗ no skin/skeleton — is this file rigged?'); process.exit(1); }
  const joints = skin.listJoints().map((j) => j.getName());
  const missing = CANONICAL_JOINTS.filter((j) => !joints.includes(j));
  const extra = joints.filter((j) => !CANONICAL_JOINTS.includes(j));
  if (missing.length || extra.length) {
    console.error('✗ RIG MISMATCH — the shared animation library cannot drive this character.');
    if (missing.length) console.error(`  missing: ${missing.join(', ')}`);
    if (extra.length) console.error(`  extra:   ${extra.join(', ')}`);
    process.exit(1);
  }
  console.log(`✓ rig matches canonical skeleton (${joints.length} joints)`);
}

// ---- GATE 2: bind pose -----------------------------------------------------
// Matching joint NAMES is not enough. Meshy does not guarantee the same bind
// pose between exports. A joint bound far from canonical looks fine at rest and
// tears the mesh the moment a clip plays — the "bent belly" failure.
{
  const canon = inverseBinds((await io.readBinary(new Uint8Array(
    await (await fetch(`${CDN}/${CANONICAL_MODEL}`)).arrayBuffer()))).getRoot());
  const { doc } = await read();
  const mine = inverseBinds(doc.getRoot());
  const worst = CORE_JOINTS
    .map((n) => ({ n, a: +angleBetweenDeg(canon.get(n), mine.get(n)).toFixed(1) }))
    .sort((x, y) => y.a - x.a)[0];
  if (worst.a > BIND_TOLERANCE_DEG) {
    console.error(`✗ BIND-POSE MISMATCH: ${worst.n} is ${worst.a}° from the canonical rig.`);
    console.error('  The shipped clips will deform this character. Re-export it from Meshy;');
    console.error('  this is export-to-export variance, not something to fix in code.');
    console.error(`  (Known-good characters sit under ~15°.)`);
    process.exit(1);
  }
  console.log(`✓ bind pose within tolerance (worst core joint: ${worst.n} at ${worst.a}°)`);
}

const manifest = { character: null, newAnimations: [] };

// ---- character -------------------------------------------------------------
{
  const { doc, fixed } = await read();
  const root = doc.getRoot();
  console.log(fixed ? '✓ rotated Z-up → Y-up' : '· already Y-up');

  const tex0 = root.listTextures()[0];
  let nonOpaquePct = 0, brightness = null, srcRes = null;
  if (tex0) {
    const buf = Buffer.from(tex0.getImage());
    const meta = await sharp(buf).metadata();
    srcRes = `${meta.width}x${meta.height}`;
    const { data, info } = await sharp(buf).resize(256, 256, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 250) n++;
    nonOpaquePct = +((n / (info.width * info.height)) * 100).toFixed(2);
    const st = await sharp(buf).stats();
    brightness = +(((st.channels[0].mean + st.channels[1].mean + st.channels[2].mean) / 3)).toFixed(1);
  }

  // Texture budget. A near-black character carries all its form in dark
  // gradients, which is exactly what lossy compression discards — one shipped
  // that way and looked like mush. Dark or highly detailed => 2048.
  const texSize = Number(texArg) || (brightness !== null && brightness < 70 ? 2048 : 1024);
  if (brightness !== null && brightness < 45)
    console.log(`! very dark texture (mean ${brightness}/255) — using ${texSize}px; check the render closely`);

  const alphaMode = nonOpaquePct < 1 ? 'OPAQUE' : 'BLEND';
  const mean = async (t) => {
    const s = await sharp(Buffer.from(t.getImage())).stats();
    return (s.channels[0].mean + s.channels[1].mean + s.channels[2].mean) / 3;
  };
  let emissiveDropped = false;
  for (const mat of root.listMaterials()) {
    mat.setAlphaMode(alphaMode);
    mat.setDoubleSided(false);
    // Meshy re-exports the base colour as an emissive map at factor [1,1,1],
    // which makes the character ignore all scene lighting and costs a second
    // full-size texture.
    const em = mat.getEmissiveTexture(), base = mat.getBaseColorTexture();
    if (em && base && mat.getEmissiveFactor().some((v) => v > 0)) {
      if (Math.abs((await mean(em)) - (await mean(base))) < 1) {
        mat.setEmissiveTexture(null); mat.setEmissiveFactor([0, 0, 0]); emissiveDropped = true;
      }
    }
  }
  console.log(`✓ alphaMode=${alphaMode} (${nonOpaquePct}% non-opaque), doubleSided=false` + (emissiveDropped ? ', dropped duplicate emissive' : ''));

  const clips = root.listAnimations().map((a) => a.getName());
  for (const a of root.listAnimations()) a.dispose();
  if (clips.length) console.log(`✓ removed ${clips.length} baked clip(s) from the model`);
  const tris = (root.listMeshes()[0]?.listPrimitives()[0]?.getIndices()?.getCount() ?? 0) / 3;

  await doc.transform(dedup(), prune());
  const dir = path.join(OUT, 'characters', charId, 'v1');
  await mkdir(dir, { recursive: true });
  const raw = path.join(dir, 'model.raw.glb'), out = path.join(dir, 'model.glb');
  await io.write(raw, doc);
  execFileSync('npx', ['--yes', '@gltf-transform/cli@latest', 'optimize', raw, out,
    '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', String(texSize), '--simplify', 'false'],
    { stdio: 'inherit' });
  await unlink(raw);

  manifest.character = {
    id: charId, name: charName ?? charId, key: `characters/${charId}/v1/model.glb`,
    rarity: 'starter', frameFixed: fixed, alphaMode, emissiveDropped,
    sourceTexture: srcRes, sourceBrightness: brightness, textureSize: texSize,
    triangles: tris, bytes: statSync(out).size,
  };
  if (tris > 40000) console.log(`! ${tris} triangles — the live characters are ~10k. Fine for a lobby, heavy for a crowded match.`);
}

// ---- clips unique to this character ----------------------------------------
{
  const { doc } = await read();
  stripToAnimation(doc);
  await doc.transform(prune());
  const root = doc.getRoot();
  const names = root.listAnimations().map((a) => a.getName());
  const fresh = names.filter((n) => !ALREADY_SHIPPED.has(n));
  const skipped = names.filter((n) => ALREADY_SHIPPED.has(n));
  if (skipped.length) console.log(`· skipped ${skipped.length} clip(s) already on the CDN: ${skipped.join(', ')}`);
  for (const srcName of fresh) {
    const slug = srcName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const one = cloneDocument(doc);
    for (const a of one.getRoot().listAnimations()) if (a.getName() !== srcName) a.dispose();
    const anim = one.getRoot().listAnimations()[0];
    await one.transform(prune());
    const dir = path.join(OUT, 'animations', slug, 'v1');
    await mkdir(dir, { recursive: true });
    const raw = path.join(dir, 'anim.raw.glb'), out = path.join(dir, 'anim.glb');
    await io.write(raw, one);
    execFileSync('npx', ['--yes', '@gltf-transform/cli@latest', 'meshopt', raw, out], { stdio: 'inherit' });
    await unlink(raw);
    manifest.newAnimations.push({ id: slug, sourceName: srcName, key: `animations/${slug}/v1/anim.glb`,
      duration: duration(anim), bytes: statSync(out).size });
    console.log(`✓ extracted "${srcName}" -> ${slug} (${duration(anim)}s)`);
  }
  if (!fresh.length) console.log('· no clips unique to this character');
}

const mPath = path.join(OUT, 'manifest.json');
const all = existsSync(mPath) ? JSON.parse(await readFile(mPath, 'utf8')) : { characters: [], newAnimations: [] };
all.characters = all.characters.filter((c) => c.id !== charId).concat(manifest.character);
for (const a of manifest.newAnimations) if (!all.newAnimations.some((x) => x.id === a.id)) all.newAnimations.push(a);
await writeFile(mPath, JSON.stringify(all, null, 2));

const c = manifest.character;
console.log(`\n${c.key}  ${(c.bytes/1024).toFixed(1)} KB  (${c.triangles} tris, ${c.textureSize}px from ${c.sourceTexture})`);
console.log('NEXT: render it before uploading. A file that builds is not a file that looks right.');
