// Shared helpers. Pure glTF surgery — no engine, no rendering.
import { quat, vec3, mat4 } from 'gl-matrix';

export const CDN = 'https://cdn.tofo.in';
/** The character every clip is authored against. Both compatibility gates
 *  measure against this file, so it is the definition of "correct". */
export const CANONICAL_MODEL = 'characters/male/v1/model.glb';

export const CANONICAL_JOINTS = [
  'Hips','LeftUpLeg','LeftLeg','LeftFoot','LeftToeBase',
  'RightUpLeg','RightLeg','RightFoot','RightToeBase',
  'Spine02','Spine01','Spine',
  'LeftShoulder','LeftArm','LeftForeArm','LeftHand',
  'RightShoulder','RightArm','RightForeArm','RightHand',
  'neck','Head','head_end','headfront',
];

/** Torso joints carry most of the body's vertex weights, so a bind mismatch
 *  HERE is what tears the mesh. Arms and head tips vary far more between Meshy
 *  exports and matter much less. */
export const CORE_JOINTS = ['Hips', 'Spine', 'Spine01', 'Spine02', 'LeftUpLeg', 'RightUpLeg'];
export const BIND_TOLERANCE_DEG = 25;

export const FIX_Q = quat.setAxisAngle(quat.create(), [1, 0, 0], Math.PI / 2);

/** Meshy's retarget exports land in a Z-up frame; normal exports do not.
 *  Detected from the rest pose, never the file name: whichever axis the Hips
 *  sits furthest along is the rig's "up". */
export function needsFrameFix(root) {
  const hips = root.listSkins()[0]?.listJoints().find((j) => j.getName() === 'Hips');
  if (!hips) return false;
  const [x, y, z] = hips.getTranslation();
  return Math.abs(z) > Math.abs(y) && Math.abs(z) > Math.abs(x);
}

/** Rotate a rigged asset into the Y-up frame, in place. Hips is the sole root
 *  joint, so only the mesh, the inverse bind matrices, the Hips rest pose and
 *  the Hips animation channels need touching — every other joint is expressed
 *  relative to its parent and is unaffected. */
export function normalizeFrame(doc, q = FIX_Q) {
  const root = doc.getRoot();
  const R = mat4.fromQuat(mat4.create(), q);
  const Rinv = mat4.invert(mat4.create(), R);
  const done = new Set();
  for (const mesh of root.listMeshes())
    for (const prim of mesh.listPrimitives())
      for (const name of ['POSITION', 'NORMAL']) {
        const acc = prim.getAttribute(name);
        if (!acc || done.has(acc)) continue;
        done.add(acc);
        const a = acc.getArray();
        for (let i = 0; i < a.length; i += 3) {
          const v = vec3.transformQuat(vec3.create(), [a[i], a[i+1], a[i+2]], q);
          a[i] = v[0]; a[i+1] = v[1]; a[i+2] = v[2];
        }
        acc.setArray(a);
      }
  for (const skin of root.listSkins()) {
    const acc = skin.getInverseBindMatrices();
    if (acc && !done.has(acc)) {
      done.add(acc);
      const a = acc.getArray();
      for (let i = 0; i < a.length; i += 16) {
        const m = mat4.multiply(mat4.create(), a.slice(i, i+16), Rinv);
        for (let k = 0; k < 16; k++) a[i+k] = m[k];
      }
      acc.setArray(a);
    }
    const hips = skin.listJoints().find((j) => j.getName() === 'Hips');
    if (hips) {
      hips.setTranslation([...vec3.transformQuat(vec3.create(), hips.getTranslation(), q)]);
      hips.setRotation([...quat.multiply(quat.create(), q, hips.getRotation())]);
    }
  }
  for (const anim of root.listAnimations())
    for (const ch of anim.listChannels()) {
      if (ch.getTargetNode()?.getName() !== 'Hips') continue;
      const out = ch.getSampler()?.getOutput();
      if (!out || done.has(out)) continue;
      const a = out.getArray();
      if (ch.getTargetPath() === 'translation') {
        done.add(out);
        for (let i = 0; i < a.length; i += 3) {
          const v = vec3.transformQuat(vec3.create(), [a[i], a[i+1], a[i+2]], q);
          a[i] = v[0]; a[i+1] = v[1]; a[i+2] = v[2];
        }
        out.setArray(a);
      } else if (ch.getTargetPath() === 'rotation') {
        done.add(out);
        for (let i = 0; i < a.length; i += 4) {
          const r = quat.multiply(quat.create(), q, [a[i], a[i+1], a[i+2], a[i+3]]);
          a[i]=r[0]; a[i+1]=r[1]; a[i+2]=r[2]; a[i+3]=r[3];
        }
        out.setArray(a);
      }
    }
}

/** Inverse bind matrices keyed by joint name. IBM = inverse of the joint's
 *  WORLD bind matrix, which is what decides whether a clip authored on one rig
 *  deforms another. */
export function inverseBinds(root) {
  const skin = root.listSkins()[0];
  const arr = skin.getInverseBindMatrices().getArray();
  const m = new Map();
  skin.listJoints().forEach((j, i) => m.set(j.getName(), mat4.clone(Array.from(arr.slice(i*16, i*16+16)))));
  return m;
}

export function angleBetweenDeg(A, B) {
  const d = mat4.multiply(mat4.create(), B, mat4.invert(mat4.create(), A));
  const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), d));
  return (2 * Math.acos(Math.min(1, Math.abs(q[3])))) * 180 / Math.PI;
}

export function duration(anim) {
  let d = 0;
  for (const s of anim.listSamplers()) {
    const a = s.getInput()?.getArray();
    if (a?.length) d = Math.max(d, a[a.length - 1]);
  }
  return +d.toFixed(2);
}

/** Strip to skeleton + animations only — what makes an emote ~25 kB. */
export function stripToAnimation(doc) {
  const root = doc.getRoot();
  for (const m of root.listMeshes()) m.dispose();
  for (const m of root.listMaterials()) m.dispose();
  for (const t of root.listTextures()) t.dispose();
  for (const s of root.listSkins()) s.dispose();
}
