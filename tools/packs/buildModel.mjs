#!/usr/bin/env node
// Turn a raw generated GLB into a game-ready pack model.
//
//   node tools/packs/buildModel.mjs <in.glb> <gameId> <name> <heightMetres> [textureSize]
//
// A model straight out of Meshy is 20–80 MB: 2K–4K textures, unwelded vertices,
// an arbitrary scale and an origin wherever the generator happened to put it.
// Dropping that into a runner would blow the whole pack budget on one lamp
// post. This does the four things that matter, in the order that matters:
//
//   1. SIZE IT. Scale so the model's real height is what the game expects, and
//      put the origin at the BOTTOM CENTRE — so placing one is
//      `position.set(x, 0, z)` and it stands on the road, every time.
//   2. SIMPLIFY. Weld first (generated meshes are usually split at every
//      triangle, which makes simplification impossible), then decimate.
//   3. SHRINK THE TEXTURES. This is nearly all of the file size. Resized and
//      re-encoded to WebP.
//   4. COMPRESS THE GEOMETRY with meshopt — the decoder is already shipped for
//      characters, so it costs the client nothing new.
//
// Everything is reported before/after, because "it got smaller" is the only
// claim here worth making and it should be checkable.
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, weld, simplify, textureCompress, resample, flatten, join } from "@gltf-transform/functions";
import { MeshoptSimplifier, MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [input, gameId, name, heightText, texText] = process.argv.slice(2);
if (!input || !gameId || !name || !heightText) {
  console.error("usage: node tools/packs/buildModel.mjs <in.glb> <gameId> <name> <heightMetres> [textureSize]");
  process.exit(2);
}
const targetHeight = Number(heightText);
const texSize = Number(texText ?? 1024);

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptEncoder,
  "meshopt.encoder": MeshoptEncoder,
});

const before = (await fs.stat(input)).size;
const doc = await io.read(input);
const root = doc.getRoot();

/** World-space bounds of every mesh, after node transforms. */
function bounds() {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      for (let i = 0; i < pos.getCount(); i++) {
        const p = pos.getElement(i, [0, 0, 0]);
        // column-major 4x4
        const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
        const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
        const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
        min[0] = Math.min(min[0], x); max[0] = Math.max(max[0], x);
        min[1] = Math.min(min[1], y); max[1] = Math.max(max[1], y);
        min[2] = Math.min(min[2], z); max[2] = Math.max(max[2], z);
      }
    }
  }
  return { min, max };
}

const b0 = bounds();
const size0 = [b0.max[0] - b0.min[0], b0.max[1] - b0.min[1], b0.max[2] - b0.min[2]];
console.log(`in : ${(before / 1e6).toFixed(1)} MB · ${size0.map((v) => v.toFixed(2)).join(" x ")} units`);

// ---- 1. size and origin ----------------------------------------------------
// Applied to the scene's root nodes, so it survives everything below.
const scale = targetHeight / (size0[1] || 1);
const cx = (b0.min[0] + b0.max[0]) / 2;
const cz = (b0.min[2] + b0.max[2]) / 2;
for (const scene of root.listScenes()) {
  for (const node of scene.listChildren()) {
    const t = node.getTranslation();
    node.setTranslation([(t[0] - cx) * scale, (t[1] - b0.min[1]) * scale, (t[2] - cz) * scale]);
    const s = node.getScale();
    node.setScale([s[0] * scale, s[1] * scale, s[2] * scale]);
  }
}

// ---- 2..4 optimise ---------------------------------------------------------
await doc.transform(
  dedup(),
  flatten(),
  join(),
  // Weld BEFORE simplify: a generated mesh usually has every triangle split,
  // and an unwelded mesh cannot be decimated at all — simplify silently does
  // nothing and the model stays at full density.
  weld({ tolerance: 0.0001 }),
  simplify({ simplifier: MeshoptSimplifier, ratio: Number(process.env.SIMPLIFY_RATIO ?? 0.5), error: 0.004 }),
  resample(),
  textureCompress({ encoder: sharp, targetFormat: "webp", resize: [texSize, texSize], quality: 84 }),
  prune()
);
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });

const outDir = path.join(here, gameId, "src", "models");
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, `${name}.glb`);
await io.write(outPath, doc);

const after = (await fs.stat(outPath)).size;
const b1 = bounds();
let tris = 0;
for (const mesh of root.listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices();
    tris += (idx ? idx.getCount() : prim.getAttribute("POSITION").getCount()) / 3;
  }
}
console.log(
  `out: ${(after / 1e6).toFixed(2)} MB (${((1 - after / before) * 100).toFixed(0)}% smaller) · ` +
    `${Math.round(tris)} tris · ${(b1.max[1] - b1.min[1]).toFixed(2)} m tall · ${outPath}`
);
