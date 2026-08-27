// Derives a new clip from an existing one by rotating named joints.
//
//   node poseClip.mjs <source-anim.glb> <out.glb> <clipName> <offsets.json>
//        [--freeze=Joint,Joint,...]
//
// Used to author a STANCE the animation library doesn't have — an idle for a
// character holding a weapon, say — without going back to Meshy for a clip
// that would have to match the canonical skeleton all over again.
//
// The offsets file is { "JointName": [pitch, yaw, roll], ... } in DEGREES,
// applied in each joint's own frame. Every rotation keyframe on that joint is
// post-multiplied by the offset, so whatever motion the source clip had — the
// breathing in idle, the stride in walk — survives underneath the new pose.
// A joint with no rotation track gets a constant one, built from its rest
// rotation, rather than being silently ignored.
//
// --freeze REPLACES a joint's animation with a constant instead of adding to
// it, and a two-handed weapon does not work without it. A weapon is bolted to
// ONE hand; the other hand only looks like it is holding the thing while it
// stays in the same place relative to it. The idle these stances derive from
// swings a hand 31 cm, and it does not swing both arms identically — so a
// constant offset, which faithfully preserves that motion, slides the support
// hand up to 13 cm along the handguard and the grip visibly lets go.
//
// Freezing every joint from both shoulders outward fixes it exactly, because
// both shoulders hang off the same `Spine` joint: the arms and the weapon
// become one rigid assembly relative to the chest, while the chest, hips, legs
// and head keep every bit of their breathing. The weapon then rises and falls
// with the ribcage, which is what a person holding a rifle actually does —
// this reads as MORE alive than the sliding version, not less.
//
// The Euler convention and the multiply order below are Babylon's exactly
// (RotationYawPitchRoll, then q_key * q_offset), because the numbers are tuned
// in a live Babylon harness and a different convention would quietly land
// somewhere else.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { execFileSync } from 'node:child_process';
import { readFile, unlink, mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const [src, dst, clipName, offsetsPath] = argv.filter((a) => !a.startsWith('--'));
if (!src || !dst || !clipName || !offsetsPath) {
  console.error('usage: node poseClip.mjs <source-anim.glb> <out.glb> <clipName> <offsets.json> [--freeze=Joint,...]');
  process.exit(1);
}
const frozen = new Set((flag('freeze') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const offsets = JSON.parse(await readFile(path.resolve(offsetsPath), 'utf8'));

/** Babylon's Quaternion.RotationYawPitchRoll, in Babylon's argument order. */
function fromYawPitchRoll(yaw, pitch, roll) {
  const hr = roll * 0.5, hp = pitch * 0.5, hy = yaw * 0.5;
  const sr = Math.sin(hr), cr = Math.cos(hr);
  const sp = Math.sin(hp), cp = Math.cos(hp);
  const sy = Math.sin(hy), cy = Math.cos(hy);
  return [
    cy * sp * cr + sy * cp * sr,
    sy * cp * cr - cy * sp * sr,
    cy * cp * sr - sy * sp * cr,
    cy * cp * cr + sy * sp * sr,
  ];
}

/** Babylon's Quaternion.multiply: a * b. */
const mul = (a, b) => [
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  -a[0] * b[2] + a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[1] - a[1] * b[0] + a[2] * b[3] + a[3] * b[2],
  -a[0] * b[0] - a[1] * b[1] - a[2] * b[2] + a[3] * b[3],
];

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(path.resolve(src));
const root = doc.getRoot();
// The source is already meshopt-compressed. Reading decodes it, but the
// declaration stays and the writer would try to RE-encode with an encoder this
// script never registered. The CLI pass at the end puts it back.
for (const ext of root.listExtensionsUsed()) {
  if (ext.extensionName === 'EXT_meshopt_compression') ext.dispose();
}

const anim = root.listAnimations()[0];
if (!anim) {
  console.error('✗ the source has no animation to derive from');
  process.exit(1);
}
anim.setName(clipName);
for (const extra of root.listAnimations().slice(1)) extra.dispose();

// Which joints the offsets name, and in what units.
const wanted = new Map(
  Object.entries(offsets).map(([joint, e]) => [
    joint,
    fromYawPitchRoll(((e[1] ?? 0) * Math.PI) / 180, ((e[0] ?? 0) * Math.PI) / 180, ((e[2] ?? 0) * Math.PI) / 180),
  ])
);

const touched = new Set();
const held = new Set();
for (const channel of anim.listChannels()) {
  const name = channel.getTargetNode()?.getName();
  if (!name) continue;
  const path = channel.getTargetPath();
  const freeze = frozen.has(name);
  const off = path === 'rotation' ? wanted.get(name) : undefined;
  if (!off && !freeze) continue;
  const out = channel.getSampler()?.getOutput();
  if (!out) continue;
  // getElement/setElement, NOT getArray: a meshopt clip stores rotations as
  // NORMALIZED INT16, so the raw array holds values like -11522 and doing
  // quaternion maths on those saturates every key to a constant. The element
  // API denormalises on the way in and re-normalises on the way out.
  const count = out.getCount();
  const q = new Array(out.getElementSize()).fill(0);
  if (freeze) {
    // Hold the FIRST keyframe, which is the pose the stance was solved and
    // looked at. Everything downstream of this joint stops moving on its own
    // and rides its parent instead.
    out.getElement(0, q);
    let v = path === 'rotation' && off ? mul(q, off) : q.slice();
    if (path === 'rotation') {
      const n = Math.hypot(v[0], v[1], v[2], v[3]) || 1;
      v = v.map((x) => x / n);
    }
    for (let i = 0; i < count; i++) out.setElement(i, v);
    if (path === 'rotation') { touched.add(name); held.add(name); }
    continue;
  }
  for (let i = 0; i < count; i++) {
    out.getElement(i, q);
    const r = mul(q, off);
    const n = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
    out.setElement(i, [r[0] / n, r[1] / n, r[2] / n, r[3] / n]);
  }
  touched.add(name);
  console.log(`✓ ${name.padEnd(14)} ${String(count).padStart(4)} keyframes rotated by [${offsets[name]}]`);
}
for (const name of held) {
  console.log(`✓ ${name.padEnd(14)} HELD at frame 0${offsets[name] ? ` (offset [${offsets[name]}])` : ''} — rides its parent`);
}
const missed = [...frozen].filter((n) => !held.has(n));
if (missed.length) console.log(`· not animated, so nothing to freeze: ${missed.join(', ')}`);

// A joint the clip never rotates still has to take the offset, or the stance
// silently comes out half-applied.
for (const [name, off] of wanted) {
  if (touched.has(name)) continue;
  const node = root.listNodes().find((n) => n.getName() === name);
  if (!node) {
    console.error(`✗ no joint named "${name}" in this clip`);
    process.exit(1);
  }
  const q = mul(node.getRotation(), off);
  const n = Math.hypot(...q) || 1;
  node.setRotation(q.map((v) => v / n));
  console.log(`✓ ${name.padEnd(14)} no rotation track — rest rotation adjusted instead`);
}

let duration = 0;
for (const s of anim.listSamplers()) {
  const input = s.getInput()?.getArray();
  if (input?.length) duration = Math.max(duration, input[input.length - 1]);
}

await mkdir(path.dirname(path.resolve(dst)), { recursive: true });
const out = path.resolve(dst);
const raw = out.replace(/\.glb$/, '.raw.glb');
await io.write(raw, doc);
execFileSync('npx', ['--yes', '@gltf-transform/cli@latest', 'meshopt', raw, out], { stdio: 'inherit' });
await unlink(raw);

console.log(`\n${path.basename(out)}  ${(statSync(out).size / 1024).toFixed(1)} KB  clip "${clipName}"  ${duration.toFixed(2)}s`);
console.log('NEXT: play it on a character holding the weapon before publishing.');
