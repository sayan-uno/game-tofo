// The island: everything that does not move.
//
// Budget first, because it is what every decision below follows from. Twenty
// characters is already an expensive scene on a phone, so the scenery gets
// almost nothing: FOUR ground draws (grass, paving, sand, sea), one sky, and
// ONE draw per kind of prop however many of them there are. Two hundred and
// eighty trees, benches, lamps and rocks therefore cost fourteen draw calls,
// not two hundred and eighty — every one is a hardware instance of a mesh that
// is loaded once, and every instance's world matrix is frozen the moment it is
// placed, because nothing here ever moves again.
//
// The layout is not decided here. It comes from shared/games/social/map.ts, so
// the fountain the client draws is the fountain the server stops you walking
// through and the fountain the admin console's map marks.
import { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { loadContainer } from "../../game/characterRig";
import type { PackAssets } from "../../platform/types";
import {
  AVENUE_OUT,
  BEACH_IN,
  GROUND_R,
  PLAZA_R,
  PROP_KINDS,
  RING_R,
  WATER_Y,
  clearBack,
  heightAt,
  islandProps,
  type PropKind,
} from "../../shared/games/social/index";

/** Where the sand starts to win over the grass, and where it has. The two
 *  overlap so the join is a fade rather than a line drawn on the beach. */
const SAND_FADE_IN = BEACH_IN - 3;
const SAND_FULL = BEACH_IN + 5;
/** Paving sits this far above the grass. Enough to beat depth precision at a
 *  hundred metres, small enough that nobody sees a step. */
const PAVE_LIFT = 0.035;
const PATH_HALF = 2.6;
const RING_HALF = 2.3;

/** Metres covered by one repeat of each ground texture. */
const TILE_GRASS = 7;
const TILE_PAVE = 4.5;
const TILE_SAND = 9;

/** Which way a model's own "forward" points, in radians about Y, so that a
 *  bench placed facing the fountain actually looks at it. Generated meshes
 *  arrive facing wherever the generator felt like, and the only way to know is
 *  to look — see tools/checks/social-look.py, which renders the sheet these
 *  were read off.
 *
 *  The arch is the one that matters rather than merely looks odd: `ry` on a
 *  gateway means "the way you walk through it", and the model is 6.2 m across
 *  by 1.6 m deep, so untunred it stood ALONG the avenue with its pillars in
 *  the path instead of either side of it. */
const MODEL_YAW: Partial<Record<PropKind, number>> = {
  arch: Math.PI / 2,
};

/** How far away each kind stops being drawn.
 *
 *  Not decoration: a bush is a thousand triangles and there are seventy of
 *  them, and at sixty metres it is four pixels. Everything here is chosen so
 *  the thing disappears while it is already most of the way into the haze —
 *  see the fog density in the runtime, which is set FROM these numbers rather
 *  than the other way round.
 *
 *  Landmarks are deliberately visible from anywhere: the bandstand and the
 *  fountain are how you say where you are standing. */
const CULL_M: Record<PropKind, number> = {
  bush: 52,
  rock: 62,
  planter: 70,
  bench: 72,
  picnic: 80,
  lamp: 95,
  palm: 130,
  tree: 140,
  pine: 140,
  kiosk: 150,
  statue: 170,
  arch: 180,
  fountain: 999,
  gazebo: 999,
};

/** The horizon colour. Everything — fog, the bottom of the sky, the far sea —
 *  is mixed towards this, which is what makes the island end in haze instead
 *  of at a visible edge. */
export const HAZE = new Color3(0.72, 0.83, 0.9);

export interface IslandOptions {
  scene: Scene;
  assets: PackAssets;
}

export class Island {
  private meshes: Mesh[] = [];
  private textures: Texture[] = [];
  private materials: StandardMaterial[] = [];
  private sources = new Map<PropKind, Mesh>();
  /** Every placed instance, with the square of the distance past which it is
   *  not drawn. One flat array rather than a map of arrays: the cull pass
   *  walks it start to finish a few times a second and never allocates. */
  private placed: { node: InstancedMesh; x: number; z: number; cull2: number; on: boolean }[] = [];
  private nextCullAt = 0;
  private waterTex: DynamicTexture | null = null;
  private waterPhase = 0;

  constructor(private scene: Scene) {}

  /** Build the whole island. Resolves when the last byte is on the GPU, so the
   *  platform's "ready" means ready. */
  async build(assets: PackAssets): Promise<void> {
    const scene = this.scene;
    this.sky();
    const [grass, pave, sand] = await Promise.all([
      this.groundTexture(assets, "textures/grass.webp"),
      this.groundTexture(assets, "textures/paving.webp"),
      this.groundTexture(assets, "textures/sand.webp"),
    ]);
    this.land(grass, sand);
    this.paving(pave);
    this.sea();
    await this.props(assets);
    // Nothing on this island is ever re-lit, re-scaled or re-coloured, so
    // every SCENERY material can stop checking whether it has been.
    //
    // The block is released again deliberately. It suppresses every
    // markAsDirty in the scene, and the characters have not loaded yet — a
    // material created while it is on never gets its effect rebuilt when
    // something changes it, which is how the legendary emissive stopped
    // appearing. It belongs around this loop and nowhere else.
    scene.blockMaterialDirtyMechanism = true;
    for (const m of this.materials) m.freeze();
    scene.blockMaterialDirtyMechanism = false;
  }

  // -- sky ----------------------------------------------------------------
  /** A painted gradient on the inside of a box. One draw, no geometry, and it
   *  can never fall behind the far plane the way a distant plane can. */
  private sky(): void {
    const size = 512;
    const tex = new DynamicTexture("skyTex", { width: 8, height: size }, this.scene, false);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, "#1f6fd0");
    grad.addColorStop(0.42, "#67aee8");
    grad.addColorStop(0.78, "#b7dcf2");
    grad.addColorStop(1, "#dff0f7");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 8, size);
    tex.update(false);
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    const mat = new StandardMaterial("skyMat", this.scene);
    mat.emissiveTexture = tex;
    mat.diffuseColor = Color3.Black();
    mat.specularColor = Color3.Black();
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    const dome = MeshBuilder.CreateSphere("sky", { diameter: GROUND_R * 3.4, segments: 16 }, this.scene);
    dome.material = mat;
    dome.isPickable = false;
    dome.infiniteDistance = true;
    dome.applyFog = false;
    this.keep(dome, mat);
    this.textures.push(tex as unknown as Texture);
  }

  /** A ground texture, read from the pack that is already on the device.
   *
   *  Deliberately NOT `new Texture(assets.url(path))`: that would fetch the
   *  file from the CDN a second time — over the network, subject to the
   *  bucket's CORS policy, and into the browser's HTTP cache where nothing can
   *  ever delete it. The bytes are already in IndexedDB because the pack was
   *  downloaded; this hands them to Babylon through a blob URL and revokes it
   *  once the image has been decoded. */
  private async groundTexture(assets: PackAssets, path: string): Promise<Texture> {
    let url = assets.url(path);
    let blob: string | null = null;
    try {
      const bytes = await assets.get(path);
      blob = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/webp" }));
      url = blob;
    } catch {
      // Not in the store (a resume that beat the download). The CDN copy is
      // correct, merely more expensive.
    }
    // Mipmaps ON: this texture is tiled a hundred and forty times across the
    // island and every one of them is seen at a shallow angle. Without them
    // the grass shimmers at ten metres and crawls at forty.
    const tex = new Texture(url, this.scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    this.textures.push(tex);
    await new Promise<void>((resolve) => {
      if (tex.isReady()) return resolve();
      tex.onLoadObservable.addOnce(() => resolve());
      // A texture that never arrives must not hold the island shut.
      setTimeout(resolve, 8000);
    });
    if (blob) URL.revokeObjectURL(blob);
    return tex;
  }

  // -- the ground ---------------------------------------------------------
  /** A radial sheet: rings of vertices out from the middle, each sitting at
   *  the island's own height. Radial rather than square because the island IS
   *  a circle — a square grid would spend two thirds of its triangles on sea.
   *
   *  Rings are spaced by a power curve so the plaza and the park, where people
   *  actually stand, get the detail, and the empty water past the shore gets
   *  almost none. */
  private sheet(name: string, rOuter: number, rings: number, spokes: number, tile: number, blend = true): Mesh {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= rings; i++) {
      const r = rOuter * Math.pow(i / rings, 1.55);
      for (let j = 0; j <= spokes; j++) {
        const a = (j / spokes) * Math.PI * 2;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        positions.push(x, heightAt(x, z), z);
        uvs.push(x / tile, z / tile);
        // Alpha carries the sand blend; the colour itself stays white so the
        // texture is not tinted. Left off entirely for the paving, because
        // MergeMeshes refuses to merge meshes whose ATTRIBUTE SETS differ —
        // a sheet with colours and a path strip without cannot become one
        // mesh, and the paving is one mesh or it is six draw calls.
        if (blend) {
          const t = (r - SAND_FADE_IN) / (SAND_FULL - SAND_FADE_IN);
          colors.push(1, 1, 1, t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
        }
      }
    }
    const row = spokes + 1;
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < spokes; j++) {
        const a = i * row + j;
        indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
    VertexData.ComputeNormals(positions, indices, normals);
    const mesh = new Mesh(name, this.scene);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.normals = normals;
    data.uvs = uvs;
    if (blend) data.colors = colors;
    data.applyToMesh(mesh, false);
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    return mesh;
  }

  private land(grass: Texture, sand: Texture): void {
    const grassMat = new StandardMaterial("grassMat", this.scene);
    grassMat.diffuseTexture = grass;
    grassMat.specularColor = Color3.Black();
    const g = this.sheet("grass", GROUND_R, 40, 84, TILE_GRASS);
    g.material = grassMat;
    // The grass sheet's own alpha channel is the sand mask, so it must NOT be
    // read as transparency here — only the sand above it uses it.
    g.useVertexColors = false;
    this.keep(g, grassMat);

    const sandMat = new StandardMaterial("sandMat", this.scene);
    sandMat.diffuseTexture = sand;
    sandMat.specularColor = Color3.Black();
    const s = this.sheet("sand", GROUND_R, 40, 84, TILE_SAND);
    s.material = sandMat;
    // Sand fades IN over the grass, so the beach has an edge you can walk
    // across rather than a line somebody drew on the island.
    s.hasVertexAlpha = true;
    s.useVertexColors = true;
    s.position.y = 0.012;
    s.freezeWorldMatrix();
    this.keep(s, sandMat);
  }

  /** The plaza and the paths: one mesh, one material, laid a few centimetres
   *  over the grass. */
  private paving(pave: Texture): void {
    const mat = new StandardMaterial("paveMat", this.scene);
    mat.diffuseTexture = pave;
    mat.specularColor = Color3.Black();

    const parts: Mesh[] = [];
    // The plaza itself.
    parts.push(this.sheet("plaza", PLAZA_R + 0.8, 8, 64, TILE_PAVE, false));
    // Four avenues, each a strip that follows the ground.
    for (let k = 0; k < 4; k++) {
      const ang = (k * Math.PI) / 2;
      const dx = Math.round(Math.cos(ang));
      const dz = Math.round(Math.sin(ang));
      parts.push(this.strip(`av${k}`, dx, dz, PLAZA_R - 1, AVENUE_OUT, PATH_HALF));
    }
    // The ring.
    parts.push(this.annulus("ring", RING_R - RING_HALF, RING_R + RING_HALF, 96));
    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
    if (!merged) return;
    merged.name = "paving";
    merged.material = mat;
    merged.isPickable = false;
    merged.position.y = PAVE_LIFT;
    merged.freezeWorldMatrix();
    this.keep(merged, mat);
  }

  private strip(name: string, dx: number, dz: number, from: number, to: number, half: number): Mesh {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const steps = Math.ceil((to - from) / 3);
    // Across the direction of travel.
    const px = -dz;
    const pz = dx;
    for (let i = 0; i <= steps; i++) {
      const r = from + ((to - from) * i) / steps;
      for (let s = -1; s <= 1; s += 2) {
        const x = dx * r + px * half * s;
        const z = dz * r + pz * half * s;
        positions.push(x, heightAt(x, z), z);
        uvs.push(x / TILE_PAVE, z / TILE_PAVE);
      }
    }
    for (let i = 0; i < steps; i++) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    VertexData.ComputeNormals(positions, indices, normals);
    const mesh = new Mesh(name, this.scene);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.normals = normals;
    data.uvs = uvs;
    data.applyToMesh(mesh, false);
    return mesh;
  }

  private annulus(name: string, rIn: number, rOut: number, spokes: number): Mesh {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    for (let j = 0; j <= spokes; j++) {
      const a = (j / spokes) * Math.PI * 2;
      for (const r of [rIn, rOut]) {
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        positions.push(x, heightAt(x, z), z);
        uvs.push(x / TILE_PAVE, z / TILE_PAVE);
      }
    }
    for (let j = 0; j < spokes; j++) {
      const a = j * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    VertexData.ComputeNormals(positions, indices, normals);
    const mesh = new Mesh(name, this.scene);
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.normals = normals;
    data.uvs = uvs;
    data.applyToMesh(mesh, false);
    return mesh;
  }

  // -- the sea ------------------------------------------------------------
  /** One translucent disc with a painted ripple, scrolled slowly. It is the
   *  only thing on the island that is animated at all, and it costs two
   *  numbers a frame. */
  private sea(): void {
    const size = 256;
    const tex = new DynamicTexture("seaTex", { width: size, height: size }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.fillStyle = "#2f7fae";
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 2;
    for (let i = 0; i < 26; i++) {
      const y = (i / 26) * size;
      ctx.beginPath();
      for (let x = 0; x <= size; x += 8) {
        const yy = y + Math.sin((x / size) * Math.PI * 4 + i) * 3;
        if (x === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    tex.update(false);
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    tex.uScale = 26;
    tex.vScale = 26;
    this.waterTex = tex;

    const mat = new StandardMaterial("seaMat", this.scene);
    mat.diffuseTexture = tex;
    mat.emissiveColor = new Color3(0.08, 0.16, 0.2);
    mat.specularColor = new Color3(0.5, 0.55, 0.6);
    mat.specularPower = 96;
    // OPAQUE, and a ring rather than a disc.
    //
    // Both are the same decision: a translucent full-screen surface is the
    // most expensive thing a phone can be asked to draw, and none of it is
    // visible — the island's own ground covers everything inside the shore, so
    // the middle of that disc was overdraw behind opaque geometry, every
    // frame, for nothing. You cannot see into stylised water anyway.
    mat.alpha = 1;
    const disc = MeshBuilder.CreateDisc("sea", { radius: GROUND_R * 1.9, tessellation: 48, arc: 1 }, this.scene);
    disc.rotation.x = Math.PI / 2;
    disc.position.y = WATER_Y;
    disc.material = mat;
    disc.isPickable = false;
    disc.freezeWorldMatrix();
    this.keep(disc, mat);
  }

  // -- everything standing on it -----------------------------------------
  private async props(assets: PackAssets): Promise<void> {
    // Loaded in parallel: fourteen small files, and the island cannot be shown
    // until the last of them lands anyway.
    await Promise.all(
      PROP_KINDS.map(async (kind) => {
        const source = await this.loadModel(assets.url(`models/${kind}.glb`), kind);
        if (source) this.sources.set(kind, source);
      })
    );
    const counts = new Map<PropKind, number>();
    for (const p of islandProps()) {
      const source = this.sources.get(p.k);
      if (!source) continue;
      const n = (counts.get(p.k) ?? 0) + 1;
      counts.set(p.k, n);
      const inst = source.createInstance(`${p.k}_${n}`);
      inst.position.set(p.x, heightAt(p.x, p.z) - 0.04, p.z);
      inst.rotation.y = p.ry + (MODEL_YAW[p.k] ?? 0);
      inst.scaling.setAll(p.s);
      // Tapping a character opens their card; tapping a tree must not cost the
      // pick a ray test against nearly three hundred of them.
      inst.isPickable = false;
      inst.alwaysSelectAsActiveMesh = false;
      inst.freezeWorldMatrix();
      const cull = CULL_M[p.k];
      this.placed.push({ node: inst, x: p.x, z: p.z, cull2: cull * cull, on: true });
    }
  }

  /** Hide what is too far to be worth drawing.
   *
   *  Frustum culling already drops whatever is behind you; this drops what is
   *  in front of you and too far to see. Together they are the difference
   *  between drawing the whole island every frame and drawing the part of it
   *  you are standing in.
   *
   *  Four times a second, not sixty: nothing here moves, and a walking player
   *  crosses a cull boundary about once a second at most. Three hundred
   *  distance checks four times a second is twelve hundred comparisons — less
   *  than one character's skeleton costs in a single frame. `setEnabled` is
   *  only ever called on a CHANGE, because it dirties the scene graph. */
  cull(now: number, atX: number, atZ: number): void {
    if (now < this.nextCullAt) return;
    this.nextCullAt = now + 250;
    for (const p of this.placed) {
      const dx = p.x - atX;
      const dz = p.z - atZ;
      const want = dx * dx + dz * dz <= p.cull2;
      if (want === p.on) continue;
      p.on = want;
      p.node.setEnabled(want);
    }
  }

  /** One pack model as a single mesh ready to be instanced.
   *
   *  ALWAYS merged, even when the file holds one mesh: a merge bakes each
   *  source's world matrix into its vertices, and glTF keeps a model's scale on
   *  the parent node rather than in the vertex data. Taking the single-mesh
   *  shortcut drops that scale and every model arrives the wrong size. */
  private async loadModel(url: string, name: string): Promise<Mesh | null> {
    try {
      const container = await loadContainer(url, this.scene);
      const entries = container.instantiateModelsToScene((n) => `${name}_${n}`, false, { doNotInstantiate: true });
      const parts = entries.rootNodes
        .flatMap((node: AbstractMesh | { getDescendants: (d: boolean) => AbstractMesh[] }) => [
          node as AbstractMesh,
          ...(node.getDescendants(false) as AbstractMesh[]),
        ])
        .filter((n): n is Mesh => n instanceof Mesh && n.getTotalVertices() > 0);
      if (parts.length === 0) {
        entries.dispose();
        return null;
      }
      for (const m of parts) m.computeWorldMatrix(true);
      const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true);
      if (!merged) {
        entries.dispose();
        return null;
      }
      merged.name = name;
      merged.isVisible = false; // only the instances draw
      merged.isPickable = false;
      merged.alwaysSelectAsActiveMesh = false;
      daylight(merged);
      this.meshes.push(merged);
      return merged;
    } catch (err) {
      // A prop that will not load is a gap in a park, not a reason nobody can
      // meet anybody.
      console.warn(`[social] could not load ${name}`, err);
      return null;
    }
  }

  private keep(mesh: Mesh, mat: StandardMaterial): void {
    this.meshes.push(mesh);
    this.materials.push(mat);
  }

  /** Called once a frame. The only moving part of the scenery. */
  update(dtMs: number): void {
    if (!this.waterTex) return;
    this.waterPhase += dtMs * 0.000018;
    this.waterTex.uOffset = this.waterPhase;
    this.waterTex.vOffset = this.waterPhase * 0.6;
  }

  /** Keep the scenery OUT of the glow pass.
   *
   *  A glow layer re-renders everything it considers into its own buffer, and
   *  left to itself it considers the lot — the ground, the sea, the sky and
   *  two hundred props, none of which is meant to bloom. Measured, that took
   *  the island from 370k triangles a frame to over a million. What is meant
   *  to bloom is a legendary character and the effect it wears, and nothing
   *  else. */
  excludeFromGlow(glow: { addExcludedMesh(m: Mesh): void }): void {
    for (const m of this.meshes) glow.addExcludedMesh(m);
  }

  /** Where the sea surface is, for the camera's own clamp. */
  get seaLevel(): number {
    return WATER_Y;
  }

  dispose(): void {
    this.placed = [];
    this.waterTex?.dispose();
    for (const m of this.meshes) m.dispose(false, true);
    for (const t of this.textures) t.dispose();
    this.meshes = [];
    this.textures = [];
    this.materials = [];
    this.sources.clear();
  }
}

/** Bring a generated model into a bright outdoor scene.
 *
 *  Two things, and both are things a GLB out of a generator gets wrong for a
 *  park. It arrives METALLIC — glTF's default metallic factor is 1 — and a
 *  metal surface in a scene with no environment texture reflects nothing, so
 *  it renders as good as black. And it arrives with a specular highlight tuned
 *  for a studio, which on a sunny lawn reads as wet plastic.
 *
 *  Written against both material families because a GLB may load as either,
 *  and the caller should not have to know which. Same shape as the runner's
 *  applyLook, for the same reason.
 *
 *  Frozen afterwards: nothing on this island is ever re-lit or re-coloured, so
 *  every material can stop checking whether it has been. */
function daylight(mesh: Mesh): void {
  const one = mesh.material as { subMaterials?: unknown[] } | null;
  const mats = one && Array.isArray(one.subMaterials) ? one.subMaterials : [mesh.material];
  for (const raw of mats) {
    const mat = raw as {
      metallic?: number | null;
      roughness?: number | null;
      environmentIntensity?: number;
      specularColor?: { set(r: number, g: number, b: number): void };
      emissiveColor?: { set(r: number, g: number, b: number): void };
      emissiveTexture?: unknown;
      emissiveIntensity?: number;
      freeze?: () => void;
    } | null;
    if (!mat) continue;
    if (typeof mat.metallic === "number" || mat.metallic === null) {
      mat.metallic = 0;
      mat.roughness = 0.92;
      mat.environmentIntensity = 0.6;
    }
    mat.specularColor?.set(0.05, 0.05, 0.05);
    // NOTHING IN A PARK GLOWS IN THE DARK.
    //
    // Generated models routinely arrive with an emissive map — a copy of the
    // albedo, usually — which on its own merely makes a tree read a stop too
    // bright, and which the moment a glow layer exists makes it BLOOM. The
    // first island with a legendary on it had luminous foliage and a bench
    // giving off orange light. Clearing it here is also what keeps the glow
    // pass cheap: the layer builds its render list from meshes that have
    // something to glow with, so a park with none costs it nothing.
    mat.emissiveTexture = null;
    mat.emissiveColor?.set(0, 0, 0);
    if (typeof mat.emissiveIntensity === "number") mat.emissiveIntensity = 0;
    mat.freeze?.();
  }
}

/** Where the camera should sit, given where the player is standing and which
 *  way they are looking. Exported so the runtime can keep its own state and
 *  this stays a pure function of the two. */
/** How far back the camera CAN sit before something is in the way. Without it
 *  the camera ends up inside the nearest tree and the player is looking at the
 *  inside of a trunk with no way to tell what has happened.
 *
 *  Deliberately only the WANTED distance — the caller eases towards it, and
 *  that easing is not optional. `clearBack` samples along the line in
 *  forty-centimetre steps, so its answer jumps as the line clears or catches
 *  an obstacle; used raw, turning on the spot beside a tree makes the camera
 *  lurch in and out several times a second. It is the kind of fault a player
 *  reports as "turning feels wrong" without being able to say why. */
export function cameraWants(x: number, z: number, yaw: number, distance: number): number {
  return Math.max(1.7, clearBack(x, z, -Math.sin(yaw), -Math.cos(yaw), distance));
}

/** The camera, at a distance the caller has already settled on. */
export function cameraAt(x: number, z: number, yaw: number, back: number, height: number, out: Vector3): Vector3 {
  const bx = -Math.sin(yaw);
  const bz = -Math.cos(yaw);
  out.set(x + bx * back, heightAt(x, z) + height, z + bz * back);
  // Never under the sea, and never inside the ground on a slope.
  const floor = Math.max(WATER_Y + 0.8, heightAt(out.x, out.z) + 0.9);
  if (out.y < floor) out.y = floor;
  return out;
}
