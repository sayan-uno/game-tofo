// Closes a character's hand into a fist, so it can actually hold something.
//
//   node gripHand.mjs <in.glb> <out.glb> [radius_cm] [knuckle_cm] [hand]
//
// WHY THIS EXISTS
//
// The canonical rig has 24 joints and none of them are fingers — `RightHand`
// is a leaf. Meshy generates characters with an open, splayed hand ~21cm from
// wrist to fingertip (a fist is ~10cm), and with no finger joints that hand can
// never close. Hang a sword off it and the handle passes straight through a
// flat palm, which is exactly what it looks like.
//
// The fix is not a rig change. Every finger vertex is rigidly weighted to the
// single `RightHand` joint, so bending those vertices in the BIND POSE is
// indistinguishable from the hand having been modelled as a fist in the first
// place: the whole fist then rides the hand joint through every clip, no
// animation is touched, and the joint list is still the canonical 24 so
// build.mjs's first gate keeps passing.
//
// The cost is that the hand is closed for good — including when the character
// is carrying nothing. A relaxed fist at the side is a normal way for a game
// character to stand, which is why this is worth doing at all.
//
// The deformation is a constant-curvature bend of everything past the knuckle,
// around an axis across the palm, curling toward the palm side. Palm side is
// DETECTED, not assumed: a relaxed hand's fingers already drift that way, so
// the sign of the drift in the finger centreline gives it away.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { execFileSync } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { mat4, vec3 } from 'gl-matrix';
import path from 'node:path';

const [src, dst, radiusArg, knuckleArg, twistArg, handArg] = process.argv.slice(2);
if (!src || !dst) {
  console.error('usage: node gripHand.mjs <in.glb> <out.glb> [radius_cm] [knuckle_cm] [twist_deg] [RightHand]');
  process.exit(1);
}
const HAND = handArg ?? 'RightHand';
/** Forearm twist baked in before the curl, in degrees.
 *
 *  A fist's tunnel runs across the palm, so it is always roughly PERPENDICULAR
 *  to the forearm — which is what fixes where a held blade can point. With the
 *  arm hanging, that leaves the blade within ~30 deg of horizontal no matter
 *  what, and pointing across the body unless the wrist is turned. Pronation is
 *  the only joint that aims it, and the rig has no wrist joint to animate, so
 *  the turn is baked in with the fist. Keep it inside about +-70 deg; past that
 *  the forearm and hand visibly stop lining up. */
const TWIST = ((Number(twistArg) || 0) * Math.PI) / 180;
// Both of these default to a FRACTION of the hand's own measured length rather
// than to centimetres, so a smaller character's fist closes on its own knuckles
// instead of halfway down its fingers. Proportions of a human hand: the palm is
// about the first 40%, and a fist's hole is about 14% of hand length across.
const RADIUS_ARG = Number(radiusArg) || 0;
const KNUCKLE_ARG = Number(knuckleArg) || 0;
const KNUCKLE_FRACTION = 0.4;
const RADIUS_FRACTION = 0.143;

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(path.resolve(src));
// Shipped models are meshopt-quantised: POSITION is integers plus a node-level
// scale while the bind matrices are in real space. Skip this and the hand
// appears to sit half a metre from its own joint.
await doc.transform(dequantize());
const root = doc.getRoot();
// Having decompressed and dequantised, drop the extensions that say otherwise.
// Left on, the writer tries to re-encode meshopt with an encoder this script
// never registered (it only has the decoder) and dies at the last step.
for (const ext of root.listExtensionsUsed()) {
  if (ext.extensionName === 'EXT_meshopt_compression' || ext.extensionName === 'KHR_mesh_quantization') ext.dispose();
}

const skin = root.listSkins()[0];
if (!skin) {
  console.error('✗ no skin — this is not a rigged character');
  process.exit(1);
}
const joints = skin.listJoints().map((j) => j.getName());
const handIdx = joints.indexOf(HAND);
if (handIdx < 0) {
  console.error(`✗ no "${HAND}" joint on this character`);
  process.exit(1);
}
const ibmArr = skin.getInverseBindMatrices().getArray();
const bindWorld = mat4.invert(mat4.create(), mat4.clone(Array.from(ibmArr.slice(handIdx * 16, handIdx * 16 + 16))));
const origin = [bindWorld[12], bindWorld[13], bindWorld[14]];
const axis = (i) => vec3.normalize(vec3.create(), [bindWorld[i * 4], bindWorld[i * 4 + 1], bindWorld[i * 4 + 2]]);
const AX = axis(0); // across the palm — the axis the fingers bend around
const AY = axis(1); // down the fingers
const AZ = axis(2); // palm-to-back

/** Rodrigues: turn d about unit axis k by theta. */
function spin(d, k, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const cross = vec3.cross(vec3.create(), k, d);
  const out = vec3.scale(vec3.create(), d, c);
  vec3.scaleAndAdd(out, out, cross, s);
  vec3.scaleAndAdd(out, out, k, vec3.dot(k, d) * (1 - c));
  return out;
}

// Pronation, baked. Rotating the frame AND the vertices by the same turn
// leaves every local coordinate below untouched — the fist that gets built is
// the identical fist, just aimed somewhere else.
const foreName = HAND.replace('Hand', 'ForeArm');
const foreIdx = joints.indexOf(foreName);
let twistAxis = AY;
if (foreIdx >= 0) {
  const foreBind = mat4.invert(mat4.create(), mat4.clone(Array.from(ibmArr.slice(foreIdx * 16, foreIdx * 16 + 16))));
  const d = vec3.subtract(vec3.create(), origin, [foreBind[12], foreBind[13], foreBind[14]]);
  if (vec3.length(d) > 1e-9) twistAxis = vec3.normalize(vec3.create(), d);
}
if (TWIST) {
  for (const a of [AX, AY, AZ]) vec3.copy(a, spin(a, twistAxis, TWIST));
  console.log(`· twisting the wrist ${((TWIST * 180) / Math.PI).toFixed(0)}° about the forearm`);
}

// Model units -> cm, from the character's own height. Everything the user
// types is in cm, because 3cm of curl radius means something and 0.0004 units
// does not.
const heights = [];
for (const prim of root.listMeshes().flatMap((m) => m.listPrimitives())) {
  const a = prim.getAttribute('POSITION').getArray();
  for (let i = 1; i < a.length; i += 3) heights.push(a[i]);
}
const span = Math.max(...heights) - Math.min(...heights);
const cm = span / 180; // one cm, in model units

/** Hand-local coordinates of a mesh-space point: across, along, palmward. */
const toLocal = (p) => {
  const d = vec3.subtract(vec3.create(), p, origin);
  return [vec3.dot(d, AX), vec3.dot(d, AY), vec3.dot(d, AZ)];
};

// ---- which way is the palm? -------------------------------------------------
// A relaxed open hand already curves toward its palm, so the finger
// centreline's drift picks the side without anyone having to eyeball a render.
const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
const handWeight = (prim, v) => {
  const j = prim.getAttribute('JOINTS_0')?.getArray();
  const w = prim.getAttribute('WEIGHTS_0')?.getArray();
  if (!j || !w) return 0;
  let total = 0;
  for (let k = 0; k < 4; k++) if (j[v * 4 + k] === handIdx) total += w[v * 4 + k];
  return total;
};

// Apply the same turn to the mesh. Scaled by the vertex's own hand weight, so
// it fades out across the wrist instead of shearing the forearm off.
if (TWIST) {
  for (const prim of prims) {
    const posAcc = prim.getAttribute('POSITION');
    const normAcc = prim.getAttribute('NORMAL');
    const pos = posAcc.getArray();
    const norm = normAcc?.getArray();
    for (let v = 0; v < pos.length / 3; v++) {
      const w = handWeight(prim, v);
      if (w <= 0) continue;
      const theta = TWIST * w;
      const d = vec3.subtract(vec3.create(), [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]], origin);
      const turned = vec3.add(vec3.create(), origin, spin(d, twistAxis, theta));
      pos[v * 3] = turned[0];
      pos[v * 3 + 1] = turned[1];
      pos[v * 3 + 2] = turned[2];
      if (norm) {
        const n = spin([norm[v * 3], norm[v * 3 + 1], norm[v * 3 + 2]], twistAxis, theta);
        norm[v * 3] = n[0];
        norm[v * 3 + 1] = n[1];
        norm[v * 3 + 2] = n[2];
      }
    }
    posAcc.setArray(pos);
    if (norm) normAcc.setArray(norm);
  }
}

// How far the hand reaches decides everything else, so measure it first.
let reach = 0;
for (const prim of prims) {
  const pos = prim.getAttribute('POSITION').getArray();
  for (let v = 0; v < pos.length / 3; v++) {
    if (handWeight(prim, v) < 0.5) continue;
    reach = Math.max(reach, toLocal([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]])[1]);
  }
}
const KNUCKLE = KNUCKLE_ARG ? KNUCKLE_ARG * cm : reach * KNUCKLE_FRACTION;
const R = RADIUS_ARG ? RADIUS_ARG * cm : reach * RADIUS_FRACTION;
console.log(`· knuckle at ${(KNUCKLE / cm).toFixed(1)}cm, curl radius ${(R / cm).toFixed(1)}cm`);

let nearSum = 0, nearN = 0, farSum = 0, farN = 0;
for (const prim of prims) {
  const pos = prim.getAttribute('POSITION').getArray();
  for (let v = 0; v < pos.length / 3; v++) {
    if (handWeight(prim, v) < 0.5) continue;
    const [, along, palmward] = toLocal([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
    if (along < KNUCKLE * 0.5) { nearSum += palmward; nearN++; }
    else if (along > KNUCKLE * 1.6) { farSum += palmward; farN++; }
  }
}
if (!nearN || !farN) {
  console.error('✗ could not find a hand to close — no vertices weighted to that joint.');
  process.exit(1);
}
const drift = farSum / farN - nearSum / nearN;
const palmSign = Math.sign(drift) || 1;
console.log(`· hand reaches ${(reach / cm).toFixed(1)}cm from the wrist (open ~18-21, fist ~10)`);
console.log(`· fingers drift ${(drift / cm).toFixed(2)}cm toward ${palmSign > 0 ? '+Z' : '-Z'} — that is the palm side`);
if (reach / cm < 13) {
  console.error('✗ this hand is already closed; curling it again would crush it.');
  process.exit(1);
}

// The bend's neutral surface: the middle of the fingers, so the curl thickens
// the outside and compresses the inside the way a real finger does.
let neutral = 0, neutralN = 0;
for (const prim of prims) {
  const pos = prim.getAttribute('POSITION').getArray();
  for (let v = 0; v < pos.length / 3; v++) {
    if (handWeight(prim, v) < 0.5) continue;
    const [, along, palmward] = toLocal([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
    if (along > KNUCKLE) { neutral += palmward; neutralN++; }
  }
}
neutral = neutralN ? neutral / neutralN : 0;

// ---- curl -------------------------------------------------------------------
let moved = 0;
let maxTurn = 0;
for (const prim of prims) {
  const posAcc = prim.getAttribute('POSITION');
  const normAcc = prim.getAttribute('NORMAL');
  const tanAcc = prim.getAttribute('TANGENT');
  const pos = posAcc.getArray();
  const norm = normAcc?.getArray();
  const tan = tanAcc?.getArray();

  for (let v = 0; v < pos.length / 3; v++) {
    const w = handWeight(prim, v);
    if (w <= 0) continue;
    const p = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
    const [across, along, palmward] = toLocal(p);
    const t = along - KNUCKLE;
    if (t <= 0) continue;

    // Constant-curvature bend in the (along, palmward) plane, toward the palm.
    // Weighted by w so a vertex shared with the forearm at the wrist can never
    // be torn away from it — though in practice the curl starts well past
    // there and those vertices are untouched anyway.
    const theta = (t / R) * w;
    maxTurn = Math.max(maxTurn, theta);
    const d = (palmward - neutral) * palmSign; // + is toward the palm
    const arm = R - d;
    const newAlong = KNUCKLE + arm * Math.sin(theta);
    const newPalmward = neutral + palmSign * (R - arm * Math.cos(theta));

    // Back to mesh space.
    const rebuilt = vec3.clone(origin);
    vec3.scaleAndAdd(rebuilt, rebuilt, AX, across);
    vec3.scaleAndAdd(rebuilt, rebuilt, AY, newAlong);
    vec3.scaleAndAdd(rebuilt, rebuilt, AZ, newPalmward);
    pos[v * 3] = rebuilt[0];
    pos[v * 3 + 1] = rebuilt[1];
    pos[v * 3 + 2] = rebuilt[2];
    moved++;

    // Normals (and tangents) turn with the surface, or the fingers keep the
    // shading of a flat hand and the fist reads as a smear.
    const turn = (dir, arr, stride) => {
      const l = [vec3.dot(dir, AX), vec3.dot(dir, AY), vec3.dot(dir, AZ)];
      const a = l[1];
      const b = (l[2] - 0) * palmSign;
      const na = a * Math.cos(theta) - b * Math.sin(theta);
      const nb = a * Math.sin(theta) + b * Math.cos(theta);
      const out = vec3.create();
      vec3.scaleAndAdd(out, out, AX, l[0]);
      vec3.scaleAndAdd(out, out, AY, na);
      vec3.scaleAndAdd(out, out, AZ, nb * palmSign);
      vec3.normalize(out, out);
      arr[v * stride] = out[0];
      arr[v * stride + 1] = out[1];
      arr[v * stride + 2] = out[2];
    };
    if (norm) turn([norm[v * 3], norm[v * 3 + 1], norm[v * 3 + 2]], norm, 3);
    if (tan) turn([tan[v * 4], tan[v * 4 + 1], tan[v * 4 + 2]], tan, 4);
  }
  posAcc.setArray(pos);
  if (norm) normAcc.setArray(norm);
  if (tan) tanAcc.setArray(tan);
}
console.log(`✓ curled ${moved} finger vertices, up to ${((maxTurn * 180) / Math.PI).toFixed(0)}° around a ${(R / cm).toFixed(1)}cm radius`);

// ---- write ------------------------------------------------------------------
// meshopt only, NO texture step: the textures are already the WebP the pipeline
// produced, and re-encoding them here would lose a generation for nothing.
const out = path.resolve(dst);
const raw = out.replace(/\.glb$/, '.raw.glb');
await io.write(raw, doc);
execFileSync('npx', ['--yes', '@gltf-transform/cli@latest', 'meshopt', raw, out], { stdio: 'inherit' });
await unlink(raw);
console.log(`\n${path.basename(out)}  ${(statSync(out).size / 1024).toFixed(1)} KB`);
console.log('NEXT: render it holding something before publishing it.');
