// Re-pose a rigged character onto the reference rest pose, and rebind it.
//
// Why this exists
// ---------------
// Every shipped clip carries translation, rotation AND scale channels on all 24
// joints, and a glTF animation channel REPLACES a node's local transform rather
// than composing with it. So a clip drives every character's skeleton to the
// same pose in the same units, which leaves the inverse bind as the only thing
// that can differ between characters. Skinning is
//
//     v' = Σ w · jointWorldAnimated · IBM · v
//
// so a character deforms correctly exactly when its REST pose already IS the
// pose the clips drive it to. Meshy gives neither half of that for free:
//
//  1. `pose_mode` does not do what it says. "t-pose" returns bent elbows with
//     the hands raised in front of the chest; "a-pose" returns straight arms
//     ~60° below horizontal. The reference rig is a T-pose, arms 13° from
//     horizontal.
//  2. It binds the Hips ~120° away from the reference on roughly half its rigs,
//     while every neighbouring joint lands within a few degrees.
//
// Both have shipped as bugs — (1) as "the hands always come out to the front",
// (2) as "the belly is broken". Note they need OPPOSITE treatments, and that is
// the entire subtlety of this file:
//
//   * A POSE difference has to be fixed by moving the mesh. Adopting the
//     reference skeleton while preserving the rest pose leaves the authored arm
//     angle baked in, riding through every clip.
//   * An ORIENTATION difference must NOT be fixed by moving the mesh. Rotating
//     belly vertices 120° while the vertices beside them move 3° tears the
//     torso open, permanently, in the shipped file.
//
// So the correction is split. Each joint is first re-expressed at its own
// position with the reference orientation — the bind absorbs that, no geometry
// moves. Only what remains, the genuine pose difference, is skinned into the
// mesh. Anything still needing a large rotation afterwards means a rig this
// tool cannot repair, and it refuses rather than wrecking the mesh quietly.
//
// The reference is taken from a CLIP, never from the canonical character model.
// The two express the same skeleton in different units — the model in metres
// with a 0.01 root scale, the clips in centimetres with scale 1 — and conforming
// to the model yields a rig that is correct at rest, reports 0.000 mm agreement,
// and detonates on the first animated frame.
//
// Fingers have no joints in the 24-joint rig, so splayed fingers stay splayed;
// that has to be fixed at generation time, not here.
//
// Costs nothing at runtime: no extra channels, no per-frame work, same size.
//
//   node realign.mjs <in.glb> <out.glb>

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { readFileSync, writeFileSync } from 'node:fs';
import { mat4, vec3, quat } from 'gl-matrix';
import { CDN, CANONICAL_JOINTS, needsFrameFix, normalizeFrame } from './lib.mjs';

/** Any shipped clip works — they all carry the same rest skeleton. */
const REFERENCE_CLIP = 'animations/idle/v1/anim.glb';

/** Guard thresholds for how far the mesh may be rotated at a joint.
 *
 *  These differ by joint because the risk does. A torso joint carries most of
 *  the body's weights and its neighbours barely move, so a large rotation there
 *  shears the mesh against them — that is the "belly is broken" failure. A limb
 *  tip is a small, nearly-rigid blob on a natural hinge: the wrist honestly
 *  needs ~85° to get from palms-in to palms-down, and handles it fine. */
const MAX_REPOSE_DEG = { torso: 45, other: 100 };
const TORSO_JOINTS = ['Hips', 'Spine', 'Spine01', 'Spine02', 'LeftUpLeg', 'RightUpLeg', 'neck', 'Head'];

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node realign.mjs <in.glb> <out.glb>');
  process.exit(2);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
});
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;

const read = async (bytes) => {
  const doc = await io.readBinary(new Uint8Array(bytes));
  if (needsFrameFix(doc.getRoot())) normalizeFrame(doc);
  return doc;
};

/** The reference rig, walked from its ROOT JOINT so the clip's own Armature is
 *  excluded — the character has one too, and counting both applies the unit
 *  conversion twice. */
function clipRig(root, rootJointName) {
  const local = new Map(), world = new Map();
  let start = null;
  (function find(nodes) {
    for (const n of nodes) {
      if (n.getName() === rootJointName) { start = n; return; }
      find(n.listChildren());
    }
  })(root.listScenes().flatMap((s) => s.listChildren()));
  if (!start) throw new Error(`reference clip has no "${rootJointName}" node`);
  (function walk(n, p) {
    const m = mat4.multiply(mat4.create(), p, n.getMatrix());
    local.set(n.getName(), n.getMatrix());
    world.set(n.getName(), m);
    for (const c of n.listChildren()) walk(c, m);
  })(start, mat4.create());
  return { local, world };
}

const rotationOf = (m) => {
  const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), m));
  return 2 * Math.acos(Math.min(1, Math.abs(q[3]))) * 180 / Math.PI;
};

/** Angle of the upper arm from horizontal. 0° is a T-pose. */
const armAngle = (worldOf) => {
  const a = mat4.getTranslation(vec3.create(), worldOf('LeftArm'));
  const b = mat4.getTranslation(vec3.create(), worldOf('LeftForeArm'));
  const d = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), b, a));
  return 90 - Math.acos(Math.max(-1, Math.min(1, -d[1]))) * 180 / Math.PI;
};

const doc = await read(readFileSync(input));
const root = doc.getRoot();
const refDoc = await read(await (await fetch(`${CDN}/${REFERENCE_CLIP}`)).arrayBuffer());

const skin = root.listSkins()[0];
if (!skin) { console.error('✗ no skin — the model is not rigged'); process.exit(1); }
const joints = skin.listJoints();
const jointSet = new Set(joints);
const rootJoint = joints.find((j) => !jointSet.has(j.getParentNode()));

const ref = clipRig(refDoc.getRoot(), rootJoint.getName());
const missing = CANONICAL_JOINTS.filter((n) => !ref.world.has(n));
if (missing.length) { console.error(`✗ reference clip lacks: ${missing.join(', ')}`); process.exit(1); }

for (const j of joints)
  for (const c of j.listChildren())
    if (!jointSet.has(c)) {
      console.error(`✗ ${j.getName()} has a non-joint child (${c.getName() || 'unnamed'}); re-posing would move it.`);
      process.exit(1);
    }

// The character's own ancestors above the root joint carry its unit convention
// and stay untouched; only the joints are replaced.
const chain = [];
for (let q = rootJoint.getParentNode(); q; q = q.getParentNode()) chain.unshift(q);
const above = chain.reduce((m, n) => mat4.multiply(mat4.create(), m, n.getMatrix()), mat4.create());

const target = new Map();   // joint name -> where the clips will put it
for (const n of CANONICAL_JOINTS) target.set(n, mat4.multiply(mat4.create(), above, ref.world.get(n)));

// ---- 1. split the correction ------------------------------------------------
const ibmAcc = skin.getInverseBindMatrices();
const ibmArr = ibmAcc.getArray();
const ownIBM = joints.map((_, i) => mat4.clone(Array.from(ibmArr.slice(i * 16, i * 16 + 16))));
const ownWorld = ownIBM.map((m) => mat4.invert(mat4.create(), m));

// Only the ROOT joint gets its orientation absorbed. Everywhere else the
// orientation genuinely encodes which way the limb points, and rotating the mesh
// by it is exactly what straightens the arms — replace that with a translation
// and the limbs stretch instead of turning. The root is different: it has no
// limb to point along, Meshy varies its axis convention freely, and a rotation
// there spins the whole torso about the hips.
const staged = joints.map((j, i) => {
  const want = target.get(j.getName());
  if (!want || j !== rootJoint) return ownWorld[i];
  return mat4.fromRotationTranslationScale(mat4.create(),
    quat.normalize(quat.create(), mat4.getRotation(quat.create(), want)),
    mat4.getTranslation(vec3.create(), ownWorld[i]),
    mat4.getScaling(vec3.create(), ownWorld[i]));
});

// What is left is the real pose difference, and only this touches the mesh.
const skinMat = joints.map((j, i) => {
  const dst = target.get(j.getName());
  if (!dst) return mat4.create();
  return mat4.multiply(mat4.create(), dst, mat4.invert(mat4.create(), staged[i]));
});

const violent = joints
  .map((j, i) => {
    const name = j.getName();
    const torso = TORSO_JOINTS.includes(name);
    return { name, torso, deg: rotationOf(skinMat[i]), limit: torso ? MAX_REPOSE_DEG.torso : MAX_REPOSE_DEG.other };
  })
  .filter((r) => r.deg > r.limit)
  .sort((a, b) => b.deg - a.deg);
if (violent.length) {
  console.error('✗ re-posing would rotate the mesh too far at: ' +
    violent.map((v) => `${v.name} ${v.deg.toFixed(1)}° (limit ${v.limit}°)`).join(', '));
  console.error('  That tears the mesh at those joints. Re-rig or regenerate this character.');
  process.exit(1);
}

// ---- 2. skin the mesh into the reference pose -------------------------------
const seen = new Set();
let moved = 0, unskinned = 0;
for (const mesh of root.listMeshes())
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (!pos || seen.has(pos)) continue;
    seen.add(pos);
    const nrm = prim.getAttribute('NORMAL');
    const tan = prim.getAttribute('TANGENT');
    const sets = [0, 1]
      .map((i) => [prim.getAttribute(`JOINTS_${i}`), prim.getAttribute(`WEIGHTS_${i}`)])
      .filter(([j, w]) => j && w);
    if (!sets.length) continue;

    const J = [0, 0, 0, 0], W = [0, 0, 0, 0];
    const p = [0, 0, 0], nv = [0, 0, 0], tv = [0, 0, 0, 0];
    const M = new Float64Array(16);
    for (let i = 0; i < pos.getCount(); i++) {
      M.fill(0);
      let total = 0;
      for (const [ja, wa] of sets) {
        ja.getElement(i, J); wa.getElement(i, W);
        for (let k = 0; k < 4; k++) {
          const w = W[k];
          if (!w) continue;
          const m = skinMat[J[k]];
          if (!m) continue;
          for (let x = 0; x < 16; x++) M[x] += w * m[x];
          total += w;
        }
      }
      if (total < 1e-6) { unskinned++; continue; }
      if (Math.abs(total - 1) > 1e-4) for (let x = 0; x < 16; x++) M[x] /= total;

      pos.getElement(i, p);
      pos.setElement(i, vec3.transformMat4(vec3.create(), p, M));
      const origin = vec3.transformMat4(vec3.create(), [0, 0, 0], M);
      if (nrm) {
        nrm.getElement(i, nv);
        const d = vec3.transformMat4(vec3.create(), nv, M);
        nrm.setElement(i, vec3.normalize(d, vec3.sub(d, d, origin)));
      }
      if (tan) {
        tan.getElement(i, tv);
        const d = vec3.transformMat4(vec3.create(), [tv[0], tv[1], tv[2]], M);
        vec3.normalize(d, vec3.sub(d, d, origin));
        tan.setElement(i, [d[0], d[1], d[2], tv[3]]);
      }
      moved++;
    }
  }

// ---- 3. adopt the reference skeleton and rebind ------------------------------
for (const j of joints) {
  const l = ref.local.get(j.getName());
  if (l) j.setMatrix(l);
}
const arr = ibmAcc.getArray();
joints.forEach((j, i) => {
  const ibm = mat4.invert(mat4.create(), target.get(j.getName()) ?? ownWorld[i]);
  for (let x = 0; x < 16; x++) arr[i * 16 + x] = ibm[x];
});
ibmAcc.setArray(arr);

const dropped = root.listAnimations().map((a) => a.getName());
for (const a of root.listAnimations()) a.dispose();

// ---- report -----------------------------------------------------------------
const orientationFixed = joints
  .map((j, i) => rotationOf(mat4.multiply(mat4.create(), staged[i], mat4.invert(mat4.create(), ownWorld[i]))))
  .reduce((a, b) => Math.max(a, b), 0);
const biggestMove = joints
  .map((j, i) => ({ name: j.getName(), deg: rotationOf(skinMat[i]) }))
  .sort((a, b) => b.deg - a.deg)[0];

console.log(`absorbed into the bind (no geometry moved): up to ${orientationFixed.toFixed(1)}° of orientation error`);
console.log(`re-posed ${moved} vertices${unskinned ? ` (${unskinned} unskinned, left alone)` : ''}; largest mesh rotation ${biggestMove.deg.toFixed(1)}° at ${biggestMove.name}`);
console.log(`upper arm: ${armAngle((n) => ownWorld[joints.findIndex((j) => j.getName() === n)]).toFixed(1)}°` +
            ` → ${armAngle((n) => target.get(n)).toFixed(1)}° from horizontal`);
if (dropped.length) console.log(`dropped ${dropped.length} baked clip(s): ${dropped.join(', ')}`);

writeFileSync(output, Buffer.from(await io.writeBinary(doc)));
console.log(`\nwrote ${output}`);
