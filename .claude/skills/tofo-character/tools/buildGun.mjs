// Turns a raw Meshy export into a game-ready TOFO firearm.
//
//   node buildGun.mjs <input.glb> <id> "<Name>" [lengthMetres] [textureSize]
//        [--foregrip=0..1] [--tune=x,y,z,w] [--deep=0..1] [--crush=0..1]
//        [--version=v1] [--levels=1]
//
// WHY THIS IS NOT buildProp.mjs
//
// A sword is a stick: its long axis is the blade, the fattest slice on it is
// the crossguard, and the thin run below that is the handle. buildProp.mjs
// leans on all three, and a gun breaks every one of them — its long axis is
// the BARREL, which is perpendicular to the grip, and the fattest slice is the
// magazine. Run a rifle through buildProp and it pivots around its magwell,
// held sideways. So firearms get their own feature-finder, and everything
// downstream of it (the material trick, the writer, the manifest) is the same.
//
// WHAT IT BAKES — the same idea as a sword, one more landmark
//
//   * pivot at the RIGHT fist's centre on the pistol grip
//   * muzzle along +Z, receiver up along +Y, so the gun points where it looks
//     like it points and a stance can be reasoned about in plain words
//   * sized in METRES
//   * and it reports the LEFT hand's landmark on the handguard, because a
//     two-handed weapon has a second contract: the support hand has to be
//     posed onto a point that only this file knows where to find.
//
// The support hand is why the sidecar JSON exists. A sword's stance needs
// nothing from the model — the blade goes wherever the hand goes. A rifle's
// stance has to put a second hand on a specific spot on a specific part, so
// the numbers travel out of here as data rather than being re-eyeballed in the
// harness.
//
// --tune is the aim, solved backwards. The client holds ONE grip transform for
// every weapon (weapon.ts), which fixes how the model's axes sit in the fist;
// a rotation baked into the vertices here composes with it, so aiming the gun
// costs a constant in this file instead of a per-weapon branch on the client.
// Solve it in the harness against the fist's own tunnel, then bake it.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { execFileSync } from 'node:child_process';
import { mkdir, unlink, writeFile, readFile } from 'node:fs/promises';
import { statSync, existsSync } from 'node:fs';
import { vec3 } from 'gl-matrix';
import path from 'node:path';
import sharp from 'sharp';

const argv = process.argv.slice(2);
const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const positional = argv.filter((a) => !a.startsWith('--'));
const [src, gunId, gunName, lenArg, texArg] = positional;
if (!src || !gunId) {
  console.error('usage: node buildGun.mjs <input.glb> <id> ["Name"] [lengthMetres] [textureSize]');
  console.error('       [--foregrip=0..1] [--tune=x,y,z,w] [--deep=0..1] [--crush=0..1] [--version=v1] [--levels=1]');
  process.exit(1);
}
const OUT = path.resolve(import.meta.dirname, 'out');
const VERSION = flag('version') ?? 'v1';
const TARGET_LENGTH = Number(lenArg) || 0.8;
const TUNE = flag('tune')?.split(',').map(Number) ?? null;
if (TUNE && (TUNE.length !== 4 || TUNE.some((v) => !Number.isFinite(v)))) {
  console.error('✗ --tune wants four numbers: x,y,z,w');
  process.exit(1);
}
/** Where the support hand sits, as a fraction back from the FRONT of the
 *  handguard. Modern shooters (and Free Fire) hold it well forward; 0 would
 *  put the fist off the muzzle end and 1 would tuck it under the magwell. */
const FOREGRIP_FRACTION = Number(flag('foregrip')) || 0.35;
/** How high up the handguard's cross-section the support fist is centred.
 *  Low, so the hand wraps the bottom and the top rail comes out ABOVE the
 *  knuckles the way a real support grip looks — not skewered through it. */
const FOREGRIP_HEIGHT = 0.3;
/** Where the trigger hand sits along the pistol grip, 0 = base, 1 = top. */
const GRIP_BIAS = 0.5;
const BINS = 48;

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(path.resolve(src));
const root = doc.getRoot();

// ---- gather geometry -------------------------------------------------------
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

const P = [];
for (const prim of prims) {
  const a = prim.getAttribute('POSITION').getArray();
  for (let i = 0; i < a.length; i += 3) P.push([a[i], a[i + 1], a[i + 2]]);
}
const tris = prims.reduce((n, p) => n + (p.getIndices()?.getCount() ?? 0) / 3, 0);

// ---- the gun's own frame ---------------------------------------------------
// PCA, not the bounding box: a Meshy export lands roughly axis-aligned but
// never exactly, and a couple of degrees of tilt in the bore line is visible
// once the thing is 60 cm long and held at arm's length.
const centroid = [0, 0, 0];
for (const p of P) for (let i = 0; i < 3; i++) centroid[i] += p[i] / P.length;
const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
for (const p of P) {
  const d = [p[0] - centroid[0], p[1] - centroid[1], p[2] - centroid[2]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += (d[i] * d[j]) / P.length;
}
/** Dominant eigenvector of `m`, with `skip` directions projected out. */
function principal(m, skip = []) {
  let v = [0.31, 0.57, 0.76];
  for (let k = 0; k < 400; k++) {
    const n = [0, 0, 0];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) n[i] += m[i][j] * v[j];
    for (const s of skip) {
      const d = n[0] * s[0] + n[1] * s[1] + n[2] * s[2];
      for (let i = 0; i < 3; i++) n[i] -= d * s[i];
    }
    const L = Math.hypot(...n) || 1;
    v = n.map((x) => x / L);
  }
  return v;
}
let L = principal(cov);      // along the barrel
let U = principal(cov, [L]); // up/down — the grip and magazine hang off this

const proj = (p, a) => (p[0] - centroid[0]) * a[0] + (p[1] - centroid[1]) * a[1] + (p[2] - centroid[2]) * a[2];
const spanOf = (a) => { const v = P.map((p) => proj(p, a)); return [Math.min(...v), Math.max(...v)]; };
const orthonormal = () => {
  // Right-handed and in THIS order: x̂ = ŷ × ẑ, so (W, U, L) reads as
  // (across, up, forward). Building it the other way round mirrors the model —
  // the sight comes out on the wrong side and every triangle's winding
  // reverses, which with single-sided materials draws the gun inside out.
  const d = U[0] * L[0] + U[1] * L[1] + U[2] * L[2];
  U = U.map((v, i) => v - d * L[i]);
  const n = Math.hypot(...U) || 1;
  U = U.map((v) => v / n);
  return vec3.cross(vec3.create(), U, L);
};
let W = orthonormal();

// Which end is the muzzle: the thin one. Comparing mean distance from the bore
// line over the outer eighth of each end separates a barrel from a butt-stock
// by a factor of two or more on anything shaped like a gun.
{
  const [lo, hi] = spanOf(L);
  const cut = (hi - lo) * 0.12;
  const radius = (keep) => {
    const pts = P.filter(keep);
    if (!pts.length) return Infinity;
    return pts.reduce((s, p) => s + Math.hypot(proj(p, U), proj(p, W)), 0) / pts.length;
  };
  const front = radius((p) => proj(p, L) > hi - cut);
  const back = radius((p) => proj(p, L) < lo + cut);
  console.log(`· ends: mean radius ${front.toFixed(3)} vs ${back.toFixed(3)} -> muzzle is the ${front < back ? 'first' : 'second'}`);
  if (front > back) { L = L.map((v) => -v); W = orthonormal(); }
}
// The whole gun's principal axis IS the bore, near enough, and deliberately so.
// Re-fitting it on the forward half looks more principled and is worse: a
// handguard is a wedge with a rail on top, not a tube, so its own principal
// axis came out 6° off the barrel's and tipped the whole frame with it. The
// residual tilt here (the hanging magazine drags the axis a degree or two) is
// harmless, because every landmark below is measured IN this frame and baked
// in it, so a tilt moves nothing relative to the mesh — and the aim is solved
// against a real fist afterwards, which absorbs the rest.
//
// Which way is up. NOT by comparing heights along the gun: the bore is fitted,
// not exact, and a 2° residual tilt over a 1.9-unit weapon moves every height
// by more than the difference being measured — that test flipped this gun
// upside down while reporting agreement.
//
// What survives a tilt is how RAGGED each side is. A grip, a magazine and a
// trigger guard all hang off the underside, so the bottom profile swings
// wildly along the length; the top is a receiver and a small sight, and is
// nearly a straight line. Measured as the spread of the per-slice extreme, the
// two sides differ by a factor a residual tilt cannot manufacture.
{
  const bins = Array.from({ length: BINS }, () => ({ lo: Infinity, hi: -Infinity }));
  const [l0, l1] = spanOf(L);
  for (const p of P) {
    const b = bins[Math.min(BINS - 1, Math.max(0, Math.floor(((proj(p, L) - l0) / (l1 - l0)) * BINS)))];
    const u = proj(p, U);
    b.lo = Math.min(b.lo, u); b.hi = Math.max(b.hi, u);
  }
  const live = bins.filter((b) => b.hi > b.lo);
  const spread = (pick) => { const v = live.map(pick); return Math.max(...v) - Math.min(...v); };
  const minusSide = spread((b) => b.lo);
  const plusSide = spread((b) => b.hi);
  // Each vote names the direction that is UP: the ragged side is the one the
  // grip hangs off, so up is the OTHER one.
  const ragged = minusSide > plusSide ? 1 : -1;
  // Second opinion, and an independent one: a grip and a magazine are thin
  // FINGERS, while the receiver, handguard and stock are the body of the gun.
  // So most of the vertices sit toward the top, and the median lands on the
  // far side of the mid-range from the hanging parts. Also tilt-immune, and it
  // does not care how ragged either profile is.
  const us = P.map((p) => proj(p, U)).sort((a, b) => a - b);
  const median = us[Math.floor(us.length / 2)];
  const [ulo, uhi] = [us[0], us[us.length - 1]];
  const bulk = median > (ulo + uhi) / 2 ? 1 : -1;
  console.log(`· which way is up: -U profile varies ${minusSide.toFixed(3)} vs +U ${plusSide.toFixed(3)} (so ${ragged > 0 ? '+' : '-'}U is up);` +
    ` median ${median.toFixed(3)} vs mid-range ${((ulo + uhi) / 2).toFixed(3)} (so ${bulk > 0 ? '+' : '-'}U is up)`);
  if (ragged !== bulk) {
    console.error('✗ the two up-tests disagree — this is not shaped like a gun, or it is symmetric enough that guessing would be worse.');
    process.exit(1);
  }
  if (ragged < 0) { U = U.map((v) => -v); W = orthonormal(); }
}

/** Gun-frame coordinates of a raw point: across, up, forward. */
const gun = (p) => [proj(p, W), proj(p, U), proj(p, L)];
const G = P.map(gun);
const ext = (i) => { const v = G.map((p) => p[i]); return [Math.min(...v), Math.max(...v)]; };
const [x0, x1] = ext(0), [y0, y1] = ext(1), [z0, z1] = ext(2);
const length = z1 - z0;
console.log(`· source ${(x1 - x0).toFixed(3)} wide x ${(y1 - y0).toFixed(3)} tall x ${length.toFixed(3)} long, ${tris} tris`);

// ---- the pistol grip -------------------------------------------------------
// Everything that hangs well below the bore line. On a rifle that is the
// magazine and the grip, and the cut has to be deep enough to leave out the
// underside of the stock — which is the REARMOST thing on the gun and would
// otherwise win the test below and get gripped instead.
const DEEP = y0 + (y1 - y0) * (Number(flag('deep')) || 0.32);
const low = G.filter((p) => p[1] < DEEP);
if (low.length < 50) {
  console.error('✗ nothing hangs below this gun — no pistol grip to pivot on.');
  process.exit(1);
}
const bin = (z) => Math.min(BINS - 1, Math.max(0, Math.floor(((z - z0) / length) * BINS)));
const filled = new Array(BINS).fill(0);
const deepest = new Array(BINS).fill(Infinity);
for (const p of low) { filled[bin(p[2])]++; deepest[bin(p[2])] = Math.min(deepest[bin(p[2])], p[1]); }
const runs = [];
for (let i = 0; i < BINS; i++) {
  if (!filled[i]) continue;
  const last = runs[runs.length - 1];
  if (last && last.to === i - 1) last.to = i;
  else runs.push({ from: i, to: i });
}
const binZ = (i) => z0 + (length * i) / BINS;
for (const r of runs) {
  r.floor = Math.min(...deepest.slice(r.from, r.to + 1));
  r.depth = y1 - r.floor;
  r.width = (r.to - r.from + 1) / BINS;
}
const deepestRun = Math.max(...runs.map((r) => r.depth));
console.log(`· ${runs.length} thing(s) hang below the bore:` + runs.map((r) =>
  ` [z ${binZ(r.from).toFixed(2)}..${binZ(r.to + 1).toFixed(2)}, ${(r.width * 100).toFixed(0)}% long, reaches ${((r.depth / deepestRun) * 100).toFixed(0)}% as deep as the deepest]`).join(''));
// The grip is the REARMOST of them — a magazine always sits forward of the
// hand that pulls the trigger. Two guards, because both have been earned: a
// stock skirt that dips below the cut is much LONGER than a grip, and a
// trigger guard is much SHALLOWER than one.
const gripRun = runs.find((r) => r.width < 0.16 && r.depth > deepestRun * 0.7);
if (!gripRun) {
  console.error('✗ nothing under the rear of this gun is the right shape for a pistol grip.');
  console.error('  Pass --deep=<0..1> to move the cut, or check the render — it may be held the wrong way up.');
  process.exit(1);
}
const zLo = binZ(gripRun.from) - length / BINS;
const zHi = binZ(gripRun.to + 1) + length / BINS;
// The grip's CENTRELINE, level by level from the base upward — not a principal
// axis through a cloud. The cloud approach needs a ceiling to cut the receiver
// off, and there is no good height for it: too low leaves a flat slab whose
// principal axis is horizontal (this reported a grip "raked 69° off vertical"),
// and too high swallows the receiver and tilts the answer along the gun.
// Stacked sections have neither problem, and the level where the section
// suddenly widens IS the top of the grip — that is the receiver starting.
const LEVELS = 32;
const column = G.filter((p) => p[2] > zLo && p[2] < zHi);
const floorY = Math.min(...column.map((p) => p[1]));
const roofY = Math.min(y1, floorY + (y1 - y0) * 0.7);
const levels = [];
for (let i = 0; i < LEVELS; i++) {
  const a = floorY + ((roofY - floorY) * i) / LEVELS;
  const b = floorY + ((roofY - floorY) * (i + 1)) / LEVELS;
  const pts = column.filter((p) => p[1] >= a && p[1] < b);
  if (pts.length < 8) { levels.push(null); continue; }
  const zs = pts.map((p) => p[2]);
  levels.push({
    y: (a + b) / 2,
    z: (Math.min(...zs) + Math.max(...zs)) / 2,
    width: Math.max(...zs) - Math.min(...zs),
  });
}
// --levels prints the stacked sections. Worth a look whenever the grip comes
// out the wrong height: the profile shows the handle, then the trigger-guard
// neck, then the receiver, and which one the walk below stopped at.
if (flag('levels')) for (const l of levels) console.log('   level', l ? `y=${l.y.toFixed(3)} z=${l.z.toFixed(3)} width=${l.width.toFixed(3)}` : 'empty');
// Walk up until the grip stops. It ends in a NECK, not a bulge: above the
// grip is the trigger-guard gap, which is nearly empty, and the receiver only
// widens out above that. A "stop when it gets fat" test walks straight through
// the gap and takes the receiver with it — which is how the fist first came
// out three-quarters of the way up the handle, right under the trigger.
const stack = [];
let widest = 0;
for (const l of levels) {
  if (!l) break;
  const seen = stack.length;
  if (seen >= 3 && (l.width < widest * 0.5 || l.width > widest * 2)) break;
  widest = Math.max(widest, l.width);
  stack.push(l);
}
if (stack.length < 6) {
  console.error('✗ could not follow the grip up from its base — it ends immediately.');
  process.exit(1);
}
// Least squares through the section centres: z as a function of height. Fitted
// over the upper three quarters only, because the flared butt at the bottom of
// a grip swings its centre around and halves the rake if it is included — and
// the rake is exactly what decides which way the gun leaves the fist.
const fit = stack.slice(Math.floor(stack.length * 0.25));
const my = fit.reduce((s, l) => s + l.y, 0) / fit.length;
const mz = fit.reduce((s, l) => s + l.z, 0) / fit.length;
const slope = fit.reduce((s, l) => s + (l.y - my) * (l.z - mz), 0) /
  (fit.reduce((s, l) => s + (l.y - my) ** 2, 0) || 1);
const gripAxis = (() => { const n = Math.hypot(1, slope); return [0, 1 / n, slope / n]; })();
const gripTop = stack[stack.length - 1].y;
const t = floorY + (gripTop - floorY) * GRIP_BIAS;
const pivot = [0, t, mz + slope * (t - my)]; // a grip is on the centreline
const rakeDeg = (Math.atan(Math.abs(slope)) * 180) / Math.PI;
console.log(`· pistol grip: ${(gripTop - floorY).toFixed(3)} tall, raked ${rakeDeg.toFixed(0)}° ${slope > 0 ? 'forward' : 'back'} of vertical, fist at z=${pivot[2].toFixed(3)} y=${pivot[1].toFixed(3)}`);

// ---- the handguard, and where the support hand goes ------------------------
// Cross-section area separates the handguard from the barrel by ~5x on
// anything with a handguard at all; the muzzle-most station that is still
// chunky is its front lip.
const area = new Array(BINS).fill(0).map(() => ({ ylo: Infinity, yhi: -Infinity, xlo: Infinity, xhi: -Infinity }));
for (const p of G) {
  const b = area[bin(p[2])];
  b.ylo = Math.min(b.ylo, p[1]); b.yhi = Math.max(b.yhi, p[1]);
  b.xlo = Math.min(b.xlo, p[0]); b.xhi = Math.max(b.xhi, p[0]);
}
const areaOf = (b) => (b.yhi > b.ylo ? (b.yhi - b.ylo) * (b.xhi - b.xlo) : 0);
const areas = area.map(areaOf);
const mid = [...areas].filter((a) => a > 0).sort((a, b) => a - b)[Math.floor(areas.filter((a) => a > 0).length / 2)];
const gripBin = bin(pivot[2]);
let frontBin = BINS - 1;
while (frontBin > 0 && areas[frontBin] < mid * 0.45) frontBin--;
// Walk back from the grip to find where the handguard begins (the magwell and
// receiver are bulkier still, but the front lip is all this needs).
const hgFront = binZ(frontBin + 1);
const hgBack = pivot[2] + (hgFront - pivot[2]) * 0.25;
const foreZ = hgFront - (hgFront - hgBack) * FOREGRIP_FRACTION;
const slice = G.filter((p) => Math.abs(p[2] - foreZ) < length * 0.03);
const sy0 = Math.min(...slice.map((p) => p[1])), sy1 = Math.max(...slice.map((p) => p[1]));
const foreGrip = [0, sy0 + (sy1 - sy0) * FOREGRIP_HEIGHT, foreZ];
console.log(`· handguard front at z=${hgFront.toFixed(3)}, support fist at z=${foreZ.toFixed(3)} y=${foreGrip[1].toFixed(3)} (section ${sy0.toFixed(3)}..${sy1.toFixed(3)})`);

// ---- bake ------------------------------------------------------------------
// Order: into the gun's frame, grip to the origin, scale to metres, then the
// solved aim. The aim goes LAST because it is expressed about the pivot.
const scale = TARGET_LENGTH / length;
const rotate = (q, v) => {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0] + (y * t[2] - z * t[1]),
    v[1] + w * t[1] + (z * t[0] - x * t[2]),
    v[2] + w * t[2] + (x * t[1] - y * t[0]),
  ];
};
const tuneQ = TUNE ? (() => { const n = Math.hypot(...TUNE); return TUNE.map((v) => v / n); })() : null;
const place = (p) => {
  const g = gun(p);
  const v = [(g[0] - pivot[0]) * scale, (g[1] - pivot[1]) * scale, (g[2] - pivot[2]) * scale];
  return tuneQ ? rotate(tuneQ, v) : v;
};
for (const prim of prims) {
  const posAcc = prim.getAttribute('POSITION');
  const pos = posAcc.getArray();
  for (let i = 0; i < pos.length; i += 3) {
    const v = place([pos[i], pos[i + 1], pos[i + 2]]);
    pos[i] = v[0]; pos[i + 1] = v[1]; pos[i + 2] = v[2];
  }
  posAcc.setArray(pos);
  const normAcc = prim.getAttribute('NORMAL');
  if (normAcc) {
    const n = normAcc.getArray();
    for (let i = 0; i < n.length; i += 3) {
      // Directions take the rotation only — no pivot, no scale.
      let v = [n[i] * W[0] + n[i + 1] * W[1] + n[i + 2] * W[2],
               n[i] * U[0] + n[i + 1] * U[1] + n[i + 2] * U[2],
               n[i] * L[0] + n[i + 1] * L[1] + n[i + 2] * L[2]];
      if (tuneQ) v = rotate(tuneQ, v);
      const len = Math.hypot(...v) || 1;
      n[i] = v[0] / len; n[i + 1] = v[1] / len; n[i + 2] = v[2] / len;
    }
    normAcc.setArray(n);
  }
}

/** A landmark that started life in gun-frame units, in the baked model's
 *  metres — the same journey the vertices just took. */
const landmark = (g) => {
  const v = [(g[0] - pivot[0]) * scale, (g[1] - pivot[1]) * scale, (g[2] - pivot[2]) * scale];
  return (tuneQ ? rotate(tuneQ, v) : v).map((n) => +n.toFixed(4));
};
const landmarkDir = (d) => {
  const v = tuneQ ? rotate(tuneQ, d) : d;
  return v.map((n) => +n.toFixed(4));
};
const marks = {
  lengthMetres: +TARGET_LENGTH.toFixed(3),
  grip: landmark(pivot),
  gripAxis: landmarkDir(gripAxis),
  foreGrip: landmark(foreGrip),
  muzzle: landmark([0, foreGrip[1], z1]),
  butt: landmark([0, pivot[1], z0]),
  bore: landmarkDir([0, 0, 1]),
  up: landmarkDir([0, 1, 0]),
  tune: tuneQ ? tuneQ.map((v) => +v.toFixed(5)) : null,
};
const cm = (v) => v.map((n) => (n * 100).toFixed(1)).join(', ');
console.log(`✓ ${TARGET_LENGTH} m long. From the trigger fist, in cm: support hand (${cm(marks.foreGrip)}), muzzle (${cm(marks.muzzle)}), butt (${cm(marks.butt)})`);
console.log(`  hands are ${(Math.hypot(...marks.foreGrip) * 100).toFixed(1)} cm apart`);

// ---- material: the albedo lights itself ------------------------------------
let texSize = Number(texArg) || 1024;
let brightness = null;
let srcRes = null;
const tex0 = root.listTextures()[0];
if (tex0) {
  let buf = Buffer.from(tex0.getImage());
  const meta = await sharp(buf).metadata();
  srcRes = `${meta.width}x${meta.height}`;

  // CRUSH THE BODY TO BLACK before the albedo is asked to be the emissive map
  // as well. The sword gets that trick for free because its albedo really is
  // flat colour over near-black; a gun does not — Meshy paints the receiver a
  // mid grey, and at 0.85 emissive a mid grey is a LIT mid grey, so the whole
  // weapon glows white and the neon stops reading as neon. Nothing is wrong
  // with the texture at that point, which is what makes it so confusing to
  // look at: the material, the UVs and the mesh are all correct.
  //
  // Only the desaturated pixels are darkened, so the red strips and the
  // magazine come through untouched — and the result is closer to the concept
  // art (matte black body) than the raw bake was.
  const CRUSH = Number(flag('crush') ?? 0.42);
  if (CRUSH < 1) {
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let touched = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      const max = Math.max(data[i], data[i + 1], data[i + 2]);
      const min = Math.min(data[i], data[i + 1], data[i + 2]);
      const sat = max > 0 ? (max - min) / max : 0;
      // Ramp rather than a hard cut: a step would draw a visible edge right
      // through the middle of every panel that fades from red into black.
      const keep = Math.min(1, Math.max(0, (sat - 0.25) / 0.25));
      const k = CRUSH + (1 - CRUSH) * keep;
      if (k < 0.999) touched++;
      data[i] = Math.round(data[i] * k);
      data[i + 1] = Math.round(data[i + 1] * k);
      data[i + 2] = Math.round(data[i + 2] * k);
    }
    buf = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer();
    tex0.setImage(new Uint8Array(buf));
    tex0.setMimeType('image/png'); // re-encoded to webp by the optimize pass below
    console.log(`· crushed ${((touched / (info.width * info.height)) * 100).toFixed(0)}% of the atlas (the unsaturated part) to ${CRUSH}x`);
  }

  const st = await sharp(buf).stats();
  brightness = +((st.channels[0].mean + st.channels[1].mean + st.channels[2].mean) / 3).toFixed(1);
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
    mat.setEmissiveTexture(base);
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
const dir = path.join(OUT, 'weapons', gunId, VERSION);
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

const entry = {
  id: gunId,
  name: gunName ?? gunId,
  key: `weapons/${gunId}/${VERSION}/model.glb`,
  rarity: 'legendary',
  ...marks,
  sourceTexture: srcRes,
  sourceBrightness: brightness,
  textureSize: texSize,
  triangles: tris,
  bytes: statSync(out).size,
};
await writeFile(path.join(dir, 'marks.json'), JSON.stringify(entry, null, 2));

const mPath = path.join(OUT, 'manifest.json');
const all = existsSync(mPath) ? JSON.parse(await readFile(mPath, 'utf8')) : { characters: [], newAnimations: [] };
all.weapons = (all.weapons ?? []).filter((w) => w.id !== gunId).concat(entry);
await writeFile(mPath, JSON.stringify(all, null, 2));

console.log(`\n${entry.key}  ${(entry.bytes / 1024).toFixed(1)} KB  (${tris} tris, ${texSize}px from ${srcRes})`);
console.log('NEXT: solve the aim in the harness against a real fist, then re-run with --tune.');
