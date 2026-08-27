// Shrinks an oversized thumb, in the BIND POSE, before the hand is closed.
//
//   node slimThumb.mjs <in.glb> <out.glb> <scale> [RightHand] [--report]
//
// WHY THIS EXISTS
//
// Meshy gave Zenith a thumb roughly half again the size it should be. Nothing
// downstream can hide that: the rig has no finger joints, so gripHand closes a
// hand by bending the mesh, and a thumb sits out on the PALM side further from
// the neutral surface than the bend radius — so it barely folds, and ends up
// lying across the front of the fist at close to full size. It reads as one
// enormous finger draped over the weapon, which is exactly what it was
// reported as. Curling harder makes it worse, not better.
//
// So the thumb is resized where the problem actually is: in the geometry.
// Every hand vertex is rigidly weighted to one joint, so scaling a lump of
// them in the bind pose is indistinguishable from the thumb having been
// modelled smaller — it then rides the hand through every clip, and gripHand
// closes around it afterwards knowing nothing about any of this.
//
// The scale is anchored at the thumb's BASE, so the knuckle stays put and only
// the part that sticks out comes down, and it falls off smoothly into the palm
// rather than stopping at a hard boundary — a hard one leaves a step in the
// surface exactly where the thumb meets the hand.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { execFileSync } from 'node:child_process';
import { unlink, mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { mat4, vec3 } from 'gl-matrix';
import path from 'node:path';

const argv = process.argv.slice(2);
const REPORT = argv.includes('--report');
const [src, dst, scaleArg, handArg] = argv.filter((a) => !a.startsWith('--'));
if (!src || !dst) {
  console.error('usage: node slimThumb.mjs <in.glb> <out.glb> <scale> [RightHand] [--report]');
  process.exit(1);
}
const HAND = handArg ?? 'RightHand';
const SCALE = Number(scaleArg) || 0.7;
/** How far out on the palm side, in bend radii, a lump has to sit before it is
 *  a thumb rather than the heel of the palm. */
const THUMB_OUT = 1.25;
/** Single-linkage distance that puts a thumb back together, in cm. */
const CLUSTER = 1.6;
/** Centimetres over which the shrink fades into the surrounding palm. */
const FEATHER = 1.8;

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(path.resolve(src));
await doc.transform(dequantize());
const root = doc.getRoot();
for (const ext of root.listExtensionsUsed()) {
  if (ext.extensionName === 'EXT_meshopt_compression' || ext.extensionName === 'KHR_mesh_quantization') ext.dispose();
}

const skin = root.listSkins()[0];
if (!skin) { console.error('✗ no skin — this is not a rigged character'); process.exit(1); }
const joints = skin.listJoints().map((j) => j.getName());
const handIdx = joints.indexOf(HAND);
if (handIdx < 0) { console.error(`✗ no "${HAND}" joint`); process.exit(1); }
const ibm = skin.getInverseBindMatrices().getArray();
const bind = mat4.invert(mat4.create(), mat4.clone(Array.from(ibm.slice(handIdx * 16, handIdx * 16 + 16))));
const origin = [bind[12], bind[13], bind[14]];
const axis = (i) => vec3.normalize(vec3.create(), [bind[i * 4], bind[i * 4 + 1], bind[i * 4 + 2]]);
const AX = axis(0), AY = axis(1), AZ = axis(2);

const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
const heights = [];
for (const prim of prims) {
  const a = prim.getAttribute('POSITION').getArray();
  for (let i = 1; i < a.length; i += 3) heights.push(a[i]);
}
const cm = (Math.max(...heights) - Math.min(...heights)) / 180;

const handWeight = (prim, v) => {
  const j = prim.getAttribute('JOINTS_0')?.getArray();
  const w = prim.getAttribute('WEIGHTS_0')?.getArray();
  if (!j || !w) return 0;
  let total = 0;
  for (let k = 0; k < 4; k++) if (j[v * 4 + k] === handIdx) total += w[v * 4 + k];
  return total;
};
const toLocal = (p) => {
  const d = vec3.subtract(vec3.create(), p, origin);
  return [vec3.dot(d, AX), vec3.dot(d, AY), vec3.dot(d, AZ)];
};

// Same frame gripHand works in, so "the palm side" means the same thing here.
const owned = [];
prims.forEach((prim, pi) => {
  const pos = prim.getAttribute('POSITION').getArray();
  for (let v = 0; v < pos.length / 3; v++) {
    const w = handWeight(prim, v);
    if (w <= 0) continue;
    const p = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
    owned.push({ pi, v, w, p, l: toLocal(p) });
  }
});
const strong = owned.filter((o) => o.w >= 0.5);
const reach = Math.max(...strong.map((o) => o.l[1]));
const KNUCKLE = reach * 0.4;
const R = reach * 0.143;
const past = strong.filter((o) => o.l[1] > KNUCKLE);
const neutral = past.reduce((s, o) => s + o.l[2], 0) / past.length;
// Palm side detected the way gripHand detects it: relaxed fingers already
// drift that way.
let nearSum = 0, nearN = 0, farSum = 0, farN = 0;
for (const o of strong) {
  if (o.l[1] < KNUCKLE * 0.5) { nearSum += o.l[2]; nearN++; }
  else if (o.l[1] > KNUCKLE * 1.6) { farSum += o.l[2]; farN++; }
}
const palmSign = Math.sign(farSum / farN - nearSum / nearN) || 1;
console.log(`· ${HAND}: reach ${(reach / cm).toFixed(1)}cm, radius ${(R / cm).toFixed(2)}cm, palm side ${palmSign > 0 ? '+Z' : '-Z'}`);

// ---- find the thumb --------------------------------------------------------
const out = (o) => ((o.l[2] - neutral) * palmSign) / R; // how far out on the palm side, in radii
const candidates = strong.filter((o) => o.l[1] > reach * 0.2 && out(o) > THUMB_OUT);
if (candidates.length < 8) {
  console.error(`✗ nothing sticks out on the palm side of this hand — no thumb to slim (${candidates.length} candidate verts).`);
  process.exit(1);
}
const par = candidates.map((_, i) => i);
const find = (a) => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
for (let i = 0; i < candidates.length; i++) {
  for (let j = i + 1; j < candidates.length; j++) {
    const a = candidates[i].l, b = candidates[j].l;
    if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < CLUSTER * cm) {
      const x = find(i), y = find(j);
      if (x !== y) par[x] = y;
    }
  }
}
const lumps = new Map();
candidates.forEach((o, i) => {
  const r = find(i);
  if (!lumps.has(r)) lumps.set(r, []);
  lumps.get(r).push(o);
});
const thumb = [...lumps.values()].sort((a, b) => b.length - a.length)[0];
const span = (arr, k) => `${(Math.min(...arr.map((o) => o.l[k])) / cm).toFixed(1)}..${(Math.max(...arr.map((o) => o.l[k])) / cm).toFixed(1)}`;
console.log(`· thumb: ${thumb.length} verts of ${candidates.length} candidates in ${lumps.size} lump(s)` +
  `   along ${span(thumb, 1)}cm   palmward ${span(thumb, 2)}cm`);

// The base is the end nearest the hand — anchoring there keeps the knuckle
// where it is and brings only the part that sticks out down.
const sorted = [...thumb].sort((a, b) => a.l[1] - b.l[1]);
const baseSet = sorted.slice(0, Math.max(3, Math.round(sorted.length * 0.25)));
const base = [0, 1, 2].map((k) => baseSet.reduce((s, o) => s + o.p[k], 0) / baseSet.length);
const tipDist = Math.max(...thumb.map((o) => vec3.distance(o.p, base))) / cm;
console.log(`· anchored at its base, ${tipDist.toFixed(1)}cm to the tip -> ${(tipDist * SCALE).toFixed(1)}cm at ${SCALE}x`);

if (REPORT) process.exit(0);

// ---- shrink ----------------------------------------------------------------
// Feathered by distance to the thumb, so the palm around it follows part of
// the way instead of stepping. Weighted by the vertex's own hand weight too,
// so anything shared with the forearm cannot be pulled off it.
let moved = 0, worst = 0;
prims.forEach((prim, pi) => {
  const posAcc = prim.getAttribute('POSITION');
  const pos = posAcc.getArray();
  const mine = owned.filter((o) => o.pi === pi);
  for (const o of mine) {
    let near = Infinity;
    for (const t of thumb) near = Math.min(near, vec3.distance(o.p, t.p));
    const feather = Math.max(0, Math.min(1, 1 - near / (FEATHER * cm)));
    const k = feather * o.w;
    if (k <= 0) continue;
    const target = [0, 1, 2].map((i) => base[i] + (o.p[i] - base[i]) * SCALE);
    const shift = [0, 1, 2].map((i) => (target[i] - o.p[i]) * k);
    pos[o.v * 3] += shift[0];
    pos[o.v * 3 + 1] += shift[1];
    pos[o.v * 3 + 2] += shift[2];
    worst = Math.max(worst, Math.hypot(...shift) / cm);
    moved++;
  }
  posAcc.setArray(pos);
});
console.log(`✓ slimmed the thumb to ${SCALE}x: ${moved} vertices moved, furthest by ${worst.toFixed(2)}cm`);

// ---- write -----------------------------------------------------------------
// meshopt only, no texture pass: the textures are already what the pipeline
// produced and re-encoding would lose a generation for nothing.
const outPath = path.resolve(dst);
await mkdir(path.dirname(outPath), { recursive: true });
const raw = outPath.replace(/\.glb$/, '.raw.glb');
await io.write(raw, doc);
execFileSync('npx', ['--yes', '@gltf-transform/cli@latest', 'meshopt', raw, outPath], { stdio: 'inherit' });
await unlink(raw);
console.log(`\n${path.basename(outPath)}  ${(statSync(outPath).size / 1024).toFixed(1)} KB`);
console.log('NEXT: gripHand it, then look at the fist.');
