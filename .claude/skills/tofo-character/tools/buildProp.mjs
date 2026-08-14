// Turns a raw Meshy export into a game-ready TOFO held prop (weapon).
//
//   node buildProp.mjs <input.glb> <weaponId> "<Display Name>" [lengthMetres] [textureSize]
//
// A prop is NOT a character: no skeleton, no clips, no bind pose to agree with.
// What it has instead is a CONTRACT with the hand that holds it, and that
// contract is baked in here rather than carried as offsets in the catalog:
//
//   * pivot at the GRIP — the origin is where the fist closes, so the client
//     parents the model straight onto the hand joint with no per-weapon nudge
//   * blade along +Y, pommel along -Y
//   * sized in METRES, so it is in the same units as the 1.8 m character it is
//     held by and never needs a magic scale on the client
//
// Get that right once per model and a second weapon is one catalog line. Get it
// wrong and every weapon needs its own offsets in code — which is exactly the
// shape this repo keeps out of the render path (see aura.ts for the same idea).
//
// The neon is the base colour texture doing double duty as the emissive map:
// the albedo is already flat, saturated red / cyan / near-black, so the black
// guard emits nothing while the blade and grip light themselves and the
// scene's GlowLayer blooms them for free. Zero extra texture bytes, and it is
// the same "the object glows, not a light parked in front of it" rule the
// characters follow.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { execFileSync } from 'node:child_process';
import { mkdir, unlink, writeFile, readFile } from 'node:fs/promises';
import { statSync, existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const [src, propId, propName, lenArg, texArg] = process.argv.slice(2);
if (!src || !propId) {
  console.error('usage: node buildProp.mjs <input.glb> <id> ["Name"] [lengthMetres] [textureSize]');
  process.exit(1);
}
const OUT = path.resolve(import.meta.dirname, 'out');
const TARGET_LENGTH = Number(lenArg) || 1.0;
/** How far up the grip the fist closes. 0 = pommel end, 1 = against the guard.
 *  Biased high because a hand grips just under the crossguard, not in the
 *  middle of the handle. */
const GRIP_BIAS = 0.55;
const BINS = 48;

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(path.resolve(src));
const root = doc.getRoot();

// ---- gather geometry -------------------------------------------------------
// Node transforms are folded into the vertices first: everything below reasons
// about ONE space, and the client gets a model whose root node is identity, so
// parenting it to a hand can never pick up a stray rotation from the export.
const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
if (!prims.length) {
  console.error('✗ no geometry in this file');
  process.exit(1);
}
for (const node of root.listScenes().flatMap((s) => s.listChildren())) {
  const t = node.getTranslation();
  const r = node.getRotation();
  const s = node.getScale();
  const moved = t.some((v) => Math.abs(v) > 1e-6) || s.some((v) => Math.abs(v - 1) > 1e-6) ||
    Math.abs(r[0]) + Math.abs(r[1]) + Math.abs(r[2]) > 1e-6;
  if (moved || node.listChildren().length) {
    console.error('✗ this file nests or transforms its mesh nodes — flatten it before building.');
    process.exit(1);
  }
}

const positions = prims.map((p) => p.getAttribute('POSITION'));
const bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
for (const acc of positions) {
  const min = acc.getMin([]);
  const max = acc.getMax([]);
  for (let i = 0; i < 3; i++) {
    bbox.min[i] = Math.min(bbox.min[i], min[i]);
    bbox.max[i] = Math.max(bbox.max[i], max[i]);
  }
}
const size = [0, 1, 2].map((i) => bbox.max[i] - bbox.min[i]);
const longAxis = size.indexOf(Math.max(...size));
if (longAxis !== 1) {
  console.error(`✗ the long axis is ${'XYZ'[longAxis]}, not Y — the model must stand upright before building.`);
  process.exit(1);
}
console.log(`· source ${size.map((v) => v.toFixed(3)).join(' x ')} units, ${prims.reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0)} tris`);

// ---- profile along the length ---------------------------------------------
// Radius per slice is what tells guard from grip from blade without anyone
// having to eyeball the model: the crossguard is the fattest slice on the
// whole weapon, the grip is the thin run below it.
const bins = Array.from({ length: BINS }, () => 0);
for (const acc of positions) {
  const a = acc.getArray();
  for (let i = 0; i < a.length; i += 3) {
    const b = Math.min(BINS - 1, Math.floor(((a[i + 1] - bbox.min[1]) / size[1]) * BINS));
    bins[b] = Math.max(bins[b], Math.hypot(a[i], a[i + 2]));
  }
}
const binY = (i) => bbox.min[1] + (size[1] * i) / BINS;
const edge = Math.max(2, Math.round(BINS * 0.08));
const mean = (from, to) => bins.slice(from, to).reduce((s, v) => s + v, 0) / (to - from);
// The tip is the thinner end. Everything downstream assumes tip = +Y.
const tipAtTop = mean(BINS - edge, BINS) < mean(0, edge);

const guardBin = bins.indexOf(Math.max(...bins));
const guardR = bins[guardBin];
// Walk from the guard toward the pommel until the profile is clearly out of the
// guard; whatever is left between there and the end is the grip (the pommel
// bulge included — a fist can sit over it, and it keeps the pivot off the very
// end of the handle).
const step = tipAtTop ? -1 : 1;
let gripEnd = guardBin;
while (gripEnd + step >= 0 && gripEnd + step < BINS && bins[gripEnd + step] > guardR * 0.5) gripEnd += step;
const gripStart = tipAtTop ? 0 : BINS - 1;
const gripSpanBins = Math.abs(gripEnd - gripStart);
if (guardR <= 0 || gripSpanBins < 3) {
  console.error('✗ could not find a grip on this model — no crossguard, or the handle is too short to sit a hand on.');
  console.error(`  guard radius ${guardR.toFixed(3)} at y=${binY(guardBin).toFixed(3)}, grip spans ${gripSpanBins} slices.`);
  process.exit(1);
}
// GRIP_BIAS of the way from the pommel end of the grip up toward the guard.
const gripY = binY(gripStart + (gripEnd - gripStart) * GRIP_BIAS + 0.5);
console.log(
  `✓ tip at ${tipAtTop ? '+Y' : '-Y'}, guard r=${guardR.toFixed(3)} at y=${binY(guardBin).toFixed(3)}, ` +
    `grip y=${binY(gripStart).toFixed(3)}..${binY(gripEnd).toFixed(3)} -> pivot at y=${gripY.toFixed(3)}`
);

// ---- bake the contract into the vertices -----------------------------------
// Order matters: flip first (so "+Y is the tip" is true), then move the grip to
// the origin, then scale to metres.
const scale = TARGET_LENGTH / size[1];
const flip = tipAtTop ? 1 : -1; // 180 deg about X: (x,y,z) -> (x,-y,-z), still right-handed, winding intact
for (const prim of prims) {
  for (const semantic of ['POSITION', 'NORMAL']) {
    const acc = prim.getAttribute(semantic);
    if (!acc) continue;
    const a = acc.getArray();
    const isPosition = semantic === 'POSITION';
    for (let i = 0; i < a.length; i += 3) {
      const y = a[i + 1] * flip;
      const z = a[i + 2] * flip;
      if (isPosition) {
        a[i] *= scale;
        a[i + 1] = (y - gripY * flip) * scale;
        a[i + 2] = z * scale;
      } else {
        a[i + 1] = y;
        a[i + 2] = z;
      }
    }
    acc.setArray(a); // min/max are derived from the array on write, not stored
  }
}

const reach = { min: Infinity, max: -Infinity };
for (const acc of positions) {
  reach.min = Math.min(reach.min, acc.getMin([])[1]);
  reach.max = Math.max(reach.max, acc.getMax([])[1]);
}
console.log(
  `✓ ${TARGET_LENGTH}m long: ${reach.max.toFixed(3)}m of weapon above the fist, ` +
    `${Math.abs(reach.min).toFixed(3)}m of pommel below it`
);

// ---- material: the albedo lights itself ------------------------------------
let texSize = Number(texArg) || 1024;
let brightness = null;
let srcRes = null;
const tex0 = root.listTextures()[0];
if (tex0) {
  const buf = Buffer.from(tex0.getImage());
  const meta = await sharp(buf).metadata();
  srcRes = `${meta.width}x${meta.height}`;
  const st = await sharp(buf).stats();
  brightness = +((st.channels[0].mean + st.channels[1].mean + st.channels[2].mean) / 3).toFixed(1);
  // A neon prop is mostly black with a few blazing colours, so the character
  // rule ("dark means 2048") would misread it — the dark parts here carry no
  // detail worth protecting. Judge it on how much of the atlas is saturated
  // instead: hard colour boundaries in a fragmented UV atlas are what actually
  // needs the pixels.
  const { data, info } = await sharp(buf).resize(256, 256, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let hot = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const max = Math.max(data[i], data[i + 1], data[i + 2]);
    const min = Math.min(data[i], data[i + 1], data[i + 2]);
    if (max > 90 && max - min > 60) hot++;
  }
  const hotPct = +((hot / (info.width * info.height)) * 100).toFixed(1);
  if (!Number(texArg) && hotPct > 45) texSize = 2048;
  console.log(`· texture ${srcRes}, mean ${brightness}/255, ${hotPct}% saturated -> ${texSize}px`);
}

for (const mat of root.listMaterials()) {
  mat.setAlphaMode('OPAQUE');
  mat.setDoubleSided(false);
  mat.setRoughnessFactor(0.42);
  mat.setMetallicFactor(0.0);
  const base = mat.getBaseColorTexture();
  if (base) {
    // Same texture object in both slots — one upload, one sampler, no extra
    // bytes. Held below 1.0 so the blade still takes a little shading and
    // reads as a solid bevelled object rather than a flat cut-out.
    mat.setEmissiveTexture(base);
    // setEmissiveTexture builds a fresh TextureInfo, so the sampler settings
    // have to be carried across or the second slot silently samples with
    // different wrapping than the first.
    const from = mat.getBaseColorTextureInfo();
    const to = mat.getEmissiveTextureInfo();
    if (from && to) {
      to.setTexCoord(from.getTexCoord());
      to.setWrapS(from.getWrapS());
      to.setWrapT(from.getWrapT());
      to.setMagFilter(from.getMagFilter());
      to.setMinFilter(from.getMinFilter());
    }
    mat.setEmissiveFactor([0.85, 0.85, 0.85]);
  }
}
console.log('✓ albedo doubles as the emissive map (factor 0.85), OPAQUE, single-sided');

// ---- write -----------------------------------------------------------------
await doc.transform(dedup(), prune());
const dir = path.join(OUT, 'weapons', propId, 'v1');
await mkdir(dir, { recursive: true });
const raw = path.join(dir, 'model.raw.glb');
const out = path.join(dir, 'model.glb');
await io.write(raw, doc);
execFileSync(
  'npx',
  ['--yes', '@gltf-transform/cli@latest', 'optimize', raw, out,
    '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', String(texSize), '--simplify', 'false'],
  { stdio: 'inherit' }
);
await unlink(raw);

const tris = prims.reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0);
const entry = {
  id: propId,
  name: propName ?? propId,
  key: `weapons/${propId}/v1/model.glb`,
  rarity: 'legendary',
  lengthMetres: TARGET_LENGTH,
  aboveGrip: +reach.max.toFixed(3),
  belowGrip: +Math.abs(reach.min).toFixed(3),
  sourceTexture: srcRes,
  sourceBrightness: brightness,
  textureSize: texSize,
  triangles: tris,
  bytes: statSync(out).size,
};

const mPath = path.join(OUT, 'manifest.json');
const all = existsSync(mPath) ? JSON.parse(await readFile(mPath, 'utf8')) : { characters: [], newAnimations: [] };
all.weapons = (all.weapons ?? []).filter((w) => w.id !== propId).concat(entry);
await writeFile(mPath, JSON.stringify(all, null, 2));

console.log(`\n${entry.key}  ${(entry.bytes / 1024).toFixed(1)} KB  (${tris} tris, ${texSize}px from ${srcRes})`);
console.log('NEXT: render it in a hand before uploading. A prop that builds is not a prop that is held right.');
