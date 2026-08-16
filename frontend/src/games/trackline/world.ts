// The grey-box world (M1): an endless four-lane track and recycled side
// scenery. The ground is ONE mesh that follows the runner and scrolls its
// texture by distance — no tiles, no recycling, one draw call — while the
// discrete scenery (blocks along both sides) is instanced and recycled ahead
// of the runner in fixed-length slabs. M4 replaces the looks, not the shape.
import { Scene } from "@babylonjs/core/scene";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { LANES, LANE_WIDTH } from "../../shared/games/trackline/rules";

/** Metres of shoulder either side of the outer rails. */
const SHOULDER = 3;
/** Ground width; the pack texture is authored to cover exactly this. */
export const GROUND_W = LANES * LANE_WIDTH + 2 * SHOULDER; // 14.8 m
/** How far the ground extends ahead of / behind the runner. */
const GROUND_AHEAD = 260;
const GROUND_BEHIND = 30;
/** Scenery is laid out in slabs this long, recycled as the runner passes. */
const SLAB_LEN = 30;
const SLABS = 9;
const BLOCKS_PER_SIDE = 3;

/** Lane index (fractional mid-change) → world x. Lane 0 is on the left. */
export const laneToX = (lane: number): number => (lane - (LANES - 1) / 2) * LANE_WIDTH;

/** Deterministic per-slab pseudo-noise so recycled scenery doesn't repeat in
 *  lockstep (a visible 30 m rhythm reads as a treadmill). Not the game seed:
 *  scenery is cosmetic and never touches the sim. */
function noise(i: number, k: number): number {
  let h = (i * 374761393 + k * 668265263) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class World {
  private ground: Mesh;
  private groundMat: StandardMaterial;
  private slabZ: number[] = [];
  private blocks: InstancedMesh[][] = [];
  private textureUrl: string | null = null;
  /** Texture repeats every this many metres along the track. */
  private texMetres = GROUND_W;

  constructor(
    private scene: Scene,
    trackTexture: Uint8Array | null
  ) {
    // Ground: a single long quad under the runner, textured with the pack's
    // top-down track art. Its v-offset scrolls with distance.
    this.ground = MeshBuilder.CreateGround("ground", { width: GROUND_W, height: GROUND_AHEAD + GROUND_BEHIND }, scene);
    this.groundMat = new StandardMaterial("groundMat", scene);
    this.groundMat.specularColor = new Color3(0.06, 0.06, 0.07);
    this.groundMat.diffuseColor = new Color3(0.9, 0.9, 0.9);
    if (trackTexture) {
      // A blob URL is the cheapest way to hand raw bytes to Babylon's texture
      // loader (it decodes through the browser's image pipeline, off-thread).
      this.textureUrl = URL.createObjectURL(new Blob([trackTexture as BlobPart], { type: "image/webp" }));
      const tex = new Texture(this.textureUrl, scene, false, true, Texture.TRILINEAR_SAMPLINGMODE);
      tex.uScale = 1;
      tex.vScale = (GROUND_AHEAD + GROUND_BEHIND) / this.texMetres;
      tex.anisotropicFilteringLevel = 8;
      this.groundMat.diffuseTexture = tex;
    } else {
      this.groundMat.diffuseColor = new Color3(0.16, 0.16, 0.18);
    }
    this.ground.material = this.groundMat;
    this.ground.isPickable = false;
    this.ground.receiveShadows = false;

    // Side scenery: dark blocks of varying height, instanced from one box.
    const block = MeshBuilder.CreateBox("block", { size: 1 }, scene);
    const blockMat = new StandardMaterial("blockMat", scene);
    blockMat.diffuseColor = new Color3(0.13, 0.12, 0.15);
    blockMat.specularColor = new Color3(0.02, 0.02, 0.02);
    blockMat.emissiveColor = new Color3(0.02, 0.015, 0.02);
    block.material = blockMat;
    block.isPickable = false;
    block.isVisible = false; // only the instances draw
    for (let i = 0; i < SLABS; i++) {
      const z = i * SLAB_LEN;
      this.slabZ.push(z);
      const row: InstancedMesh[] = [];
      for (let side = -1; side <= 1; side += 2) {
        for (let k = 0; k < BLOCKS_PER_SIDE; k++) {
          const inst = block.createInstance(`block_${i}_${side}_${k}`);
          inst.isPickable = false;
          row.push(inst);
        }
      }
      this.blocks.push(row);
      this.layoutSlab(i);
    }
    // Materials never change again — skip their per-frame readiness checks.
    scene.freezeMaterials();
  }

  private layoutSlab(i: number): void {
    const z0 = this.slabZ[i];
    const row = this.blocks[i];
    let n = 0;
    for (let side = -1; side <= 1; side += 2) {
      for (let k = 0; k < BLOCKS_PER_SIDE; k++) {
        const inst = row[n++];
        const seedIdx = Math.round(z0 / SLAB_LEN);
        const h = 4 + noise(seedIdx, k * 2 + (side > 0 ? 1 : 0)) * 14;
        const w = 5 + noise(seedIdx, 10 + k) * 5;
        const depth = SLAB_LEN / BLOCKS_PER_SIDE - 1.5;
        const x = side * (GROUND_W / 2 + w / 2 + 1.5 + noise(seedIdx, 20 + k) * 3);
        inst.scaling.set(w, h, depth);
        inst.position.set(x, h / 2, z0 + (k + 0.5) * (SLAB_LEN / BLOCKS_PER_SIDE));
      }
    }
  }

  /** Called every frame with the local runner's z: scroll the ground under
   *  them and recycle any slab that fell behind. */
  follow(z: number): void {
    this.ground.position.z = z + (GROUND_AHEAD - GROUND_BEHIND) / 2;
    const tex = this.groundMat.diffuseTexture as Texture | null;
    if (tex) tex.vOffset = -(this.ground.position.z / this.texMetres);
    for (let i = 0; i < SLABS; i++) {
      if (this.slabZ[i] + SLAB_LEN < z - GROUND_BEHIND) {
        this.slabZ[i] += SLABS * SLAB_LEN;
        this.layoutSlab(i);
      }
    }
  }

  dispose(): void {
    if (this.textureUrl) URL.revokeObjectURL(this.textureUrl);
  }
}

