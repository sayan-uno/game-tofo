// Compatibility report for a built or live character: joint names, bind pose
// against every core joint, and how it compares to the known-good baseline.
//
//   node verify.mjs out/characters/<id>/v1/model.glb
//   node verify.mjs characters/<id>/v1/model.glb --live
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { CDN, CANONICAL_MODEL, CANONICAL_JOINTS, CORE_JOINTS, BIND_TOLERANCE_DEG, inverseBinds, angleBetweenDeg } from './lib.mjs';

const target = process.argv[2];
const live = process.argv.includes('--live');
if (!target) { console.error('usage: node verify.mjs <path|key> [--live]'); process.exit(1); }

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const fromCdn = async (k) => io.readBinary(new Uint8Array(await (await fetch(`${CDN}/${k}`)).arrayBuffer()));

const canon = inverseBinds((await fromCdn(CANONICAL_MODEL)).getRoot());
const baseline = inverseBinds((await fromCdn('characters/female/v1/model.glb')).getRoot());
const root = (live ? await fromCdn(target) : await io.read(target)).getRoot();

const joints = root.listSkins()[0].listJoints().map((j) => j.getName());
const missing = CANONICAL_JOINTS.filter((j) => !joints.includes(j));
console.log(missing.length ? `✗ missing joints: ${missing.join(', ')}` : `✓ all ${CANONICAL_JOINTS.length} canonical joints present`);

const mine = inverseBinds(root);
console.log('\nbind-pose difference vs canonical (degrees)   [Vanguard = known-good]');
console.log('  joint            Vanguard   this');
let worst = 0;
for (const n of CORE_JOINTS) {
  const b = +angleBetweenDeg(canon.get(n), baseline.get(n)).toFixed(1);
  const a = +angleBetweenDeg(canon.get(n), mine.get(n)).toFixed(1);
  worst = Math.max(worst, a);
  console.log(`  ${n.padEnd(15)} ${String(b).padStart(8)} ${String(a).padStart(7)}${a > BIND_TOLERANCE_DEG ? '   <-- WILL DEFORM' : ''}`);
}
console.log(worst > BIND_TOLERANCE_DEG
  ? `\n✗ worst core joint ${worst}° — re-export from Meshy`
  : `\n✓ worst core joint ${worst}° — clips will drive this cleanly`);
