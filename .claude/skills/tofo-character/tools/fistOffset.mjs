// Where a character's fist sits in its own hand joint — the number weapon.ts
// needs to put a weapon IN the hand rather than beside it.
//
//   node fistOffset.mjs <character.glb> [RightHand] [--json]
//
// WHY THIS EXISTS
//
// weapon.ts used to carry ONE grip offset for every character, on the stated
// grounds that all four shipped characters "produced the same numbers to five
// decimals". Measured, they do not: the constant is the value for `male`, it
// happens to fit seraph, it is 2-3 cm out on female and zenith, and it was
// 6-7 cm out on every character generated later. A hand is about 10 cm across,
// so 6 cm out is a weapon held beside the fist with the fingers splayed past
// it — which is exactly what shipped.
//
// The offset is the centroid of the CURLED FINGER MASS, in the hand joint's
// own frame, in metres. Every finger vertex is rigidly weighted to that one
// joint (the rig has no finger joints), so this is a constant of the model —
// readable straight out of the GLB, and the same number whatever the character
// is doing. Feed it into the catalog as `grip` and the weapon lands in the
// fist on any character, whatever proportions Meshy gave it.
//
// The hand joint's bind AXES are already conformed by realign.mjs, so only the
// position varies between characters; the grip ROTATION stays one constant.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { mat4, vec3 } from 'gl-matrix';
import path from 'node:path';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const [src, handArg] = argv.filter((a) => !a.startsWith('--'));
if (!src) {
  console.error('usage: node fistOffset.mjs <character.glb> [RightHand] [--json]');
  process.exit(1);
}
const HAND = handArg ?? 'RightHand';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(path.resolve(src));
await doc.transform(dequantize());
const root = doc.getRoot();
const skin = root.listSkins()[0];
if (!skin) { console.error('✗ no skin — this is not a rigged character'); process.exit(1); }
const handIdx = skin.listJoints().map((j) => j.getName()).indexOf(HAND);
if (handIdx < 0) { console.error(`✗ no "${HAND}" joint`); process.exit(1); }
const ibm = skin.getInverseBindMatrices().getArray();
const inv = mat4.clone(Array.from(ibm.slice(handIdx * 16, handIdx * 16 + 16)));

const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
const heights = [];
for (const prim of prims) {
  const a = prim.getAttribute('POSITION').getArray();
  for (let i = 1; i < a.length; i += 3) heights.push(a[i]);
}
// Joint-local units are not metres: the inverse bind carries the skeleton
// root's 0.01 scale, and the model is drawn at CHARACTER_HEIGHT.
const span = Math.max(...heights) - Math.min(...heights);
const toMetres = (1.8 / span) / Math.hypot(inv[0], inv[1], inv[2]);

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
    local.push([...vec3.transformMat4(vec3.create(), [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]], inv)].map((x) => x * toMetres));
  }
}
if (local.length < 30) { console.error('✗ almost nothing is weighted to this hand'); process.exit(1); }

// +Y in this frame runs down the fingers, so the far part of the cloud is the
// curled fist and the near part is the palm and wrist.
const reach = Math.max(...local.map((p) => p[1]));
const fingers = local.filter((p) => p[1] > reach * 0.45);
const c = [0, 1, 2].map((k) => +(fingers.reduce((s, p) => s + p[k], 0) / fingers.length).toFixed(4));

// WHICH WAY THE PALM FACES, as a direction rather than a sign.
//
// A curled fist's fingers bend TOWARD the palm, so the drift from the knuckles
// to the fingertips points palmward. Measured per character this is not a
// constant either: four of the ten characters have it pointing the opposite
// way, because Meshy builds some hands rotated about their own finger axis.
// The joint's bind AXES are identical on all of them — realign sees to that —
// so nothing upstream notices, but a weapon placed with one shared rotation
// then lands against the BACK of those hands with the fingers wrapping the
// wrong way round.
const near = local.filter((p) => p[1] < reach * 0.45);
const knuckle = [0, 1, 2].map((k) => near.reduce((s, p) => s + p[k], 0) / near.length);
const drift = [c[0] - knuckle[0], 0, c[2] - knuckle[2]]; // perpendicular to the fingers
const dn = Math.hypot(drift[0], drift[2]) || 1;
const palm = [+(drift[0] / dn).toFixed(4), 0, +(drift[2] / dn).toFixed(4)];

if (JSON_OUT) {
  console.log(JSON.stringify({ grip: c, palm }));
} else {
  const DEFAULT = [-0.0314, 0.0973, 0.0347];
  const off = Math.hypot(c[0] - DEFAULT[0], c[1] - DEFAULT[1], c[2] - DEFAULT[2]) * 100;
  console.log(`${path.basename(path.dirname(path.dirname(path.resolve(src))))} ${HAND}`);
  console.log(`  hand ${(reach * 100).toFixed(0)} cm from the wrist, ${fingers.length} vertices past the knuckle`);
  console.log(`  grip: [${c.join(', ')}]`);
  console.log(`  ${off.toFixed(1)} cm from weapon.ts's built-in default` + (off > 2 ? '  <-- NEEDS ITS OWN grip IN THE CATALOG' : ''));
  // male's palm, the orientation the shared grip rotation was solved against.
  const REF = [-0.3182, 0, 0.9480];
  const dotp = palm[0] * REF[0] + palm[2] * REF[2];
  const turn = (Math.acos(Math.max(-1, Math.min(1, dotp))) * 180) / Math.PI;
  console.log(`  palm faces [${palm[0]}, ${palm[2]}] — ${turn.toFixed(0)}° from male's` + (turn > 90 ? '  <-- HAND IS TURNED OVER' : ''));
}
