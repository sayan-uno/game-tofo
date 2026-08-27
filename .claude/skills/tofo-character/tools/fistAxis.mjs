// Measures the FIST a character carries: where its tunnel is, and which way it
// runs — in the hand joint's own frame, which is the frame weapon.ts holds a
// weapon in.
//
//   node fistAxis.mjs <character.glb> [RightHand|LeftHand]
//
// gripHand.mjs curls the fingers in the bind pose, so the fist is part of the
// mesh and every one of its vertices is rigidly weighted to one joint. That
// makes both numbers constants that can be read straight out of the GLB rather
// than derived through a transform — which matters, because deriving the last
// one through the hand's baked twist got its sense backwards (glTF is
// right-handed, Babylon is not) and put the handle 6 cm off the side of the
// fist for four rounds of stance tuning that were never the problem.
//
// The tunnel is measured as what it actually is: a HOLE. For a candidate line
// through the fist, the nearest hand vertex says how wide a handle could pass
// along it, and the tunnel is the line where that clearance is greatest — the
// largest empty cylinder through the hand. Both the line's direction and its
// position are solved, so nothing here assumes what twist was baked in.
//
// The obvious cheaper metric — "the finger mass sits at a constant radius
// about the true axis" — does not work, and looked like it did. Curled fingers
// are a C, not a ring, so the spread it minimises is dominated by the gap; it
// reported 25° of baked twist on a hand baked with none.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { mat4, vec3 } from 'gl-matrix';
import path from 'node:path';

const [src, handArg] = process.argv.slice(2);
if (!src) {
  console.error('usage: node fistAxis.mjs <character.glb> [RightHand]');
  process.exit(1);
}
const HAND = handArg ?? 'RightHand';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(path.resolve(src));
await doc.transform(dequantize());
const root = doc.getRoot();
const skin = root.listSkins()[0];
const joints = skin.listJoints().map((j) => j.getName());
const handIdx = joints.indexOf(HAND);
if (handIdx < 0) { console.error(`✗ no "${HAND}" joint`); process.exit(1); }
const ibm = skin.getInverseBindMatrices().getArray();
const inv = mat4.clone(Array.from(ibm.slice(handIdx * 16, handIdx * 16 + 16)));

const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
const heights = [];
for (const prim of prims) {
  const a = prim.getAttribute('POSITION').getArray();
  for (let i = 1; i < a.length; i += 3) heights.push(a[i]);
}
const cm = (Math.max(...heights) - Math.min(...heights)) / 180;

// Every vertex the hand owns outright, in the hand joint's own frame.
const local = [];
for (const prim of prims) {
  const pos = prim.getAttribute('POSITION').getArray();
  const jt = prim.getAttribute('JOINTS_0')?.getArray();
  const wt = prim.getAttribute('WEIGHTS_0')?.getArray();
  if (!jt || !wt) continue;
  for (let v = 0; v < pos.length / 3; v++) {
    let w = 0;
    for (let k = 0; k < 4; k++) if (jt[v * 4 + k] === handIdx) w += wt[v * 4 + k];
    if (w < 0.5) continue;
    local.push([...vec3.transformMat4(vec3.create(), [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]], inv)]);
  }
}
if (local.length < 30) { console.error('✗ almost nothing is weighted to this hand'); process.exit(1); }

// Joint-local units are not metres: the inverse bind matrix carries the
// skeleton root's 0.01 scale, so everything in this frame is ~100x life size
// (which is the same trap as reading a bone position off an unposed skeleton).
// The IBM's own scale converts back to mesh units, and the character's height
// converts those to metres — the units weapon.ts's grip constants are in.
const bindScale = Math.hypot(inv[0], inv[1], inv[2]);
const span = Math.max(...heights) - Math.min(...heights);
const toMetres = (1.8 / span) / bindScale;

// +Y in the joint's frame runs down the fingers (gripHand's AY), so the far
// half of the cloud is the curled fingers and the near half is the palm.
const reach = Math.max(...local.map((p) => p[1]));
const fingers = local.filter((p) => p[1] > reach * 0.4);

/** How wide a handle could pass along a line — the nearest hand vertex to it.
 *  Measured against the WHOLE hand, palm included: the palm is one wall of the
 *  tunnel, and leaving it out lets the "tunnel" slide off the fingertips. */
const clearance = (centre, axis) => {
  let min = Infinity;
  for (const p of local) {
    const d = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
    const a = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
    // Only where the hand actually surrounds the line — past the ends of the
    // fist the mesh has run out and the clearance is meaningless.
    if (Math.abs(a) > reach * 0.28) continue;
    min = Math.min(min, Math.hypot(d[0] - a * axis[0], d[1] - a * axis[1], d[2] - a * axis[2]));
  }
  return min === Infinity ? 0 : min;
};

const seed = [0, 0, 0];
for (const p of fingers) for (let i = 0; i < 3; i++) seed[i] += p[i] / fingers.length;
let best = { r: -1, centre: seed, axis: [1, 0, 0] };
for (let i = 0; i <= 90; i++) {
  for (let j = 0; j < 180; j++) {
    const theta = (i / 90) * (Math.PI / 2); // an axis has no sign, so a half sphere covers it
    const phi = (j / 180) * Math.PI * 2;
    const axis = [Math.cos(theta), Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi)];
    const r = clearance(best.centre, axis);
    if (r > best.r) best = { r, centre: best.centre, axis };
  }
}
// Now let the line move as well as turn: the widest cylinder is rarely centred
// on the finger centroid, and 2 cm off is a handle hovering past the knuckles.
for (let pass = 0; pass < 6; pass++) {
  const step = reach * 0.06 * 0.6 ** pass;
  let improved = true;
  while (improved) {
    improved = false;
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const c = best.centre.map((v, i) => v + d[i] * step);
      const r = clearance(c, best.axis);
      if (r > best.r) { best = { r, centre: c, axis: best.axis }; improved = true; }
    }
    for (let i = 0; i <= 24; i++) {
      for (let j = 0; j < 48; j++) {
        const theta = (i / 24) * (Math.PI / 2);
        const phi = (j / 48) * Math.PI * 2;
        const axis = [Math.cos(theta), Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi)];
        const r = clearance(best.centre, axis);
        if (r > best.r) { best = { r, centre: best.centre, axis }; improved = true; }
      }
    }
  }
}
// A handle leaves the fist on the thumb side; +X in this frame is across the
// palm, so keep the sign that agrees with the joint's own X.
const axis = best.axis[0] < 0 ? best.axis.map((v) => -v) : best.axis;
const deg = (a, b) => (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;

console.log(`${HAND}: ${local.length} vertices (${fingers.length} past the knuckle), hand ${(reach * toMetres * 100).toFixed(1)} cm long`);
console.log(`  fist centre   ${best.centre.map((v) => (v * toMetres).toFixed(4)).join(', ')}   metres, in the hand joint's frame`);
console.log(`  tunnel axis   ${axis.map((v) => v.toFixed(4)).join(', ')}`);
console.log(`  tunnel is ${(best.r * toMetres * 200).toFixed(1)} cm across, and runs ${deg(axis, [1, 0, 0]).toFixed(1)}° off the joint's own X (= the baked forearm twist)`);
