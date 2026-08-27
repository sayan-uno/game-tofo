// Turns a hand over — rotates it about the forearm, in the bind pose, so its
// palm faces the way every other character's does.
//
//   node pronate.mjs <in.glb> <out.glb> <degrees> [RightHand]
//
// WHY THIS EXISTS
//
// Meshy does not build every hand the same way round. Five of six characters
// in one batch came back with the hand rotated ~180 degrees about its own
// finger axis, so the palm faced the opposite way from the characters already
// shipped. Nothing upstream catches it: realign.mjs conforms the hand JOINT's
// axes to the canonical rig, and it does, to within a degree — it is the mesh
// hanging off that joint which is turned over.
//
// It shows up as "the palm is turned the wrong way when they hold the gun",
// and it cannot be fixed on the weapon. Rotating the WEAPON to match a turned
// hand does put it back in the palm, and swings the barrel through 180 degrees
// while it is there, so the character ends up aiming behind itself. The hand
// is what is wrong, so the hand is what gets fixed.
//
// The turn is spread from the elbow to the wrist rather than applied to the
// hand alone, because that is what a forearm does — pronation twists along its
// whole length. Dumping 180 degrees at the wrist instead wrings the sleeve
// into a pinch right where the two meet.
//
// Run it AFTER gripHand: the fist is already closed around this character's
// own palm, and turning the whole hand carries the fist with it.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { execFileSync } from 'node:child_process';
import { unlink, mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { mat4, vec3 } from 'gl-matrix';
import path from 'node:path';

const [src, dst, degArg, handArg] = process.argv.slice(2);
if (!src || !dst || degArg === undefined) {
  console.error('usage: node pronate.mjs <in.glb> <out.glb> <degrees> [RightHand]');
  process.exit(1);
}
const HAND = handArg ?? 'RightHand';
const ANGLE = (Number(degArg) * Math.PI) / 180;
if (!Number.isFinite(ANGLE)) { console.error('✗ degrees must be a number'); process.exit(1); }

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
const foreIdx = joints.indexOf(HAND.replace('Hand', 'ForeArm'));
if (handIdx < 0 || foreIdx < 0) { console.error(`✗ no "${HAND}" / forearm joint`); process.exit(1); }
const ibm = skin.getInverseBindMatrices().getArray();
const originOf = (i) => {
  const m = mat4.invert(mat4.create(), mat4.clone(Array.from(ibm.slice(i * 16, i * 16 + 16))));
  return [m[12], m[13], m[14]];
};
const wrist = originOf(handIdx);
const elbow = originOf(foreIdx);
const axis = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), wrist, elbow));
const armLen = vec3.distance(wrist, elbow);

const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
const heights = [];
for (const prim of prims) {
  const a = prim.getAttribute('POSITION').getArray();
  for (let i = 1; i < a.length; i += 3) heights.push(a[i]);
}
const cm = (Math.max(...heights) - Math.min(...heights)) / 180;

const weightOf = (prim, v, idx) => {
  const j = prim.getAttribute('JOINTS_0')?.getArray();
  const w = prim.getAttribute('WEIGHTS_0')?.getArray();
  if (!j || !w) return 0;
  let total = 0;
  for (let k = 0; k < 4; k++) if (j[v * 4 + k] === idx) total += w[v * 4 + k];
  return total;
};

/** Rodrigues: turn d about unit axis k by theta. */
function spin(d, k, theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  const cross = vec3.cross(vec3.create(), k, d);
  const out = vec3.scale(vec3.create(), d, c);
  vec3.scaleAndAdd(out, out, cross, s);
  vec3.scaleAndAdd(out, out, k, vec3.dot(k, d) * (1 - c));
  return out;
}

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
    const hw = weightOf(prim, v, handIdx);
    const fw = weightOf(prim, v, foreIdx);
    if (hw + fw <= 0) continue;
    const p = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
    // How far along the forearm this vertex sits: 0 at the elbow, 1 at the
    // wrist. The hand's share turns fully; the forearm's share ramps, which is
    // what spreads the twist instead of pinching it at the wrist.
    const along = armLen > 1e-9
      ? Math.max(0, Math.min(1, vec3.dot(vec3.subtract(vec3.create(), p, elbow), axis) / armLen))
      : 1;
    const blend = Math.max(0, Math.min(1, hw + fw * along * along));
    if (blend <= 0.001) continue;
    const theta = ANGLE * blend;
    maxTurn = Math.max(maxTurn, Math.abs(theta));
    const d = vec3.subtract(vec3.create(), p, elbow);
    const turned = vec3.add(vec3.create(), elbow, spin(d, axis, theta));
    pos[v * 3] = turned[0]; pos[v * 3 + 1] = turned[1]; pos[v * 3 + 2] = turned[2];
    moved++;
    const rot = (arr, stride) => {
      const n = spin([arr[v * stride], arr[v * stride + 1], arr[v * stride + 2]], axis, theta);
      arr[v * stride] = n[0]; arr[v * stride + 1] = n[1]; arr[v * stride + 2] = n[2];
    };
    if (norm) rot(norm, 3);
    if (tan) rot(tan, 4);
  }
  posAcc.setArray(pos);
  if (norm) normAcc.setArray(norm);
  if (tan) tanAcc.setArray(tan);
}
console.log(`✓ turned ${HAND} by ${Number(degArg)}° about the forearm: ${moved} vertices, up to ${((maxTurn * 180) / Math.PI).toFixed(0)}°`);
console.log(`  spread over ${(armLen / cm).toFixed(1)}cm of forearm, so nothing is wrung at the wrist`);

const out = path.resolve(dst);
await mkdir(path.dirname(out), { recursive: true });
const raw = out.replace(/\.glb$/, '.raw.glb');
await io.write(raw, doc);
// meshopt only, no texture pass: the textures are already what the pipeline
// produced and re-encoding would lose a generation for nothing.
execFileSync('npx', ['--yes', '@gltf-transform/cli@latest', 'meshopt', raw, out], { stdio: 'inherit' });
await unlink(raw);
console.log(`\n${path.basename(out)}  ${(statSync(out).size / 1024).toFixed(1)} KB`);
console.log('NEXT: re-measure with fistOffset.mjs — the palm turn should now read near 0.');
