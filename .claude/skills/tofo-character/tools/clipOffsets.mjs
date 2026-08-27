// What offsets turn clip A into clip B?
//
//   node clipOffsets.mjs <from.glb> <to.glb>
//
// The inverse of poseClip.mjs. It post-multiplies a constant per joint, so the
// offsets that made a shipped stance are recoverable exactly from the stance
// and the clip it came from — no notes needed, and no guessing when the notes
// are gone.
//
// Worth doing before authoring a new stance: the sword's carry decomposes into
// nine degrees of feet-apart and sixty of forearm pronation, and starting the
// next weapon from those two numbers is a great deal better than starting from
// zero. The residual drift it prints is meshopt's int16 rotation quantisation
// (about a degree), not a real difference — if a joint reports more than a few
// degrees of drift, the two clips genuinely disagree there.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const read = async (f) => {
  const doc = await io.read(f);
  const anim = doc.getRoot().listAnimations()[0];
  const m = new Map();
  for (const ch of anim.listChannels()) {
    if (ch.getTargetPath() !== 'rotation') continue;
    const out = ch.getSampler().getOutput();
    const keys = [];
    const q = [0, 0, 0, 0];
    for (let i = 0; i < out.getCount(); i++) { out.getElement(i, q); keys.push([...q]); }
    m.set(ch.getTargetNode().getName(), keys);
  }
  // joints with no track still have a rest rotation
  for (const n of doc.getRoot().listNodes()) if (!m.has(n.getName())) m.set(n.getName(), [n.getRotation()]);
  return m;
};
const conj = (q) => [-q[0], -q[1], -q[2], q[3]];
const mul = (a, b) => [
  a[0]*b[3] + a[1]*b[2] - a[2]*b[1] + a[3]*b[0],
  -a[0]*b[2] + a[1]*b[3] + a[2]*b[0] + a[3]*b[1],
  a[0]*b[1] - a[1]*b[0] + a[2]*b[3] + a[3]*b[2],
  -a[0]*b[0] - a[1]*b[1] - a[2]*b[2] + a[3]*b[3],
];
/** Inverse of Babylon's RotationYawPitchRoll, back to [pitch, yaw, roll] deg. */
const toPYR = (q) => {
  const [x, y, z, w] = q;
  const sp = 2 * (w * x - y * z);
  const pitch = Math.abs(sp) >= 1 ? Math.sign(sp) * Math.PI / 2 : Math.asin(sp);
  const yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y));
  const roll = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
  return [pitch, yaw, roll].map((v) => +((v * 180) / Math.PI).toFixed(2));
};
const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error('usage: node clipOffsets.mjs <from.glb> <to.glb>');
  process.exit(1);
}
const A = await read(from);
const B = await read(to);
for (const [name, a] of A) {
  const b = B.get(name);
  if (!b) continue;
  const n = Math.min(a.length, b.length);
  const offs = [];
  for (let i = 0; i < n; i++) offs.push(mul(conj(a[i]), b[i]));
  // how constant is it across keyframes?
  const first = offs[0];
  let drift = 0;
  for (const o of offs) drift = Math.max(drift, 2 * Math.acos(Math.min(1, Math.abs(o[0]*first[0]+o[1]*first[1]+o[2]*first[2]+o[3]*first[3]))) * 180 / Math.PI);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(first[3]))) * 180 / Math.PI;
  if (angle > 0.5) console.log(`${name.padEnd(14)} ${JSON.stringify(toPYR(first)).padEnd(28)} ${angle.toFixed(1)}° total, drift across keys ${drift.toFixed(2)}°`);
}
