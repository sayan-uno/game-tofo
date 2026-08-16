// Everything standing on the track: obstacles and coins.
//
// Nothing here is created during a run. Each obstacle kind has ONE source mesh
// and a fixed pool of instances; every frame the pool is re-pointed at whatever
// the course puts in view and the surplus is parked out of sight. So the cost
// of a busy stretch of track is a few dozen position writes and one draw call
// per kind — never an allocation, a material compile or a GC pause mid-match.
//
// The shapes are the grey box: readable blocks sized to what the SIMULATION
// says they are, so what you see is exactly what kills you. M4 swaps the meshes
// for the real barriers and trains without touching the sim or this pooling.
import { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import {
  BARRIER_DEPTH,
  Course,
  ROOF_HEIGHT,
  TRAIN_LENGTH,
  type Obstacle,
} from "../../shared/games/trackline/course";
import { laneToX } from "./world";
import type { TracklineModels } from "./models";

/** How far ahead obstacles are drawn. Past this the fog has them anyway. */
const VIEW_AHEAD = 170;
/** And how far behind, so a barrier does not vanish while still beside you. */
const VIEW_BEHIND = 14;

/** Pool sizes: a row can hold three obstacles and rows are 15 m apart, so the
 *  view holds about 12 rows. Generous enough that the cap is never reached in
 *  practice, small enough to stay a handful of instances. */
/** Pools are per DRAWN KIND, and a train draws as one of three different
 *  shapes, so each gets its own. */
type DrawKind = "low" | "high" | "full" | "train_solid" | "train_ramp" | "train_open";
const POOL: Record<DrawKind, number> = { low: 16, high: 16, full: 16, train_solid: 6, train_ramp: 6, train_open: 6 };

/** What a carriage draws as. The shape IS the instruction: a sloped back you
 *  can obviously run up, or an open box you can obviously see through. A
 *  player should never have to learn which grey box is which. */
const drawKindOf = (o: Obstacle): DrawKind =>
  o.kind !== "train" ? o.kind : o.train === "ramp" ? "train_ramp" : o.train === "open" ? "train_open" : "train_solid";
const COIN_POOL = 90;

/** Size and seat height of each kind, in metres. Width is deliberately under a
 *  lane (2.2 m) so the gap you can squeeze through is visible. */
const SHAPE: Record<DrawKind, { w: number; h: number; d: number; y: number; colour: Color3; glow: Color3 }> = {
  // Knee-high: jump it.
  low: { w: 1.8, h: 0.55, d: BARRIER_DEPTH, y: 0.275, colour: new Color3(0.9, 0.45, 0.08), glow: new Color3(0.28, 0.1, 0.0) },
  // Overhead beam: roll under it. Hangs with its underside at 1.2 m.
  high: { w: 1.9, h: 0.5, d: BARRIER_DEPTH, y: 1.45, colour: new Color3(0.2, 0.65, 0.85), glow: new Color3(0.02, 0.14, 0.2) },
  // Wall: go round.
  full: { w: 1.9, h: 2.4, d: BARRIER_DEPTH, y: 1.2, colour: new Color3(0.62, 0.6, 0.6), glow: new Color3(0.05, 0.04, 0.04) },
  // Carriage: go round, and it stays beside you for a while.
  train_solid: { w: 2.0, h: ROOF_HEIGHT, d: TRAIN_LENGTH, y: ROOF_HEIGHT / 2, colour: new Color3(0.34, 0.36, 0.42), glow: new Color3(0.03, 0.03, 0.05) },
  // Amber trim: the one you can climb.
  train_ramp: { w: 2.0, h: ROOF_HEIGHT, d: TRAIN_LENGTH, y: ROOF_HEIGHT / 2, colour: new Color3(0.42, 0.34, 0.22), glow: new Color3(0.1, 0.06, 0.01) },
  // Lit inside: the one you can run through.
  train_open: { w: 2.0, h: ROOF_HEIGHT, d: TRAIN_LENGTH, y: ROOF_HEIGHT / 2, colour: new Color3(0.3, 0.34, 0.4), glow: new Color3(0.04, 0.05, 0.07) },
};

interface Pool {
  source: Mesh;
  free: InstancedMesh[];
}

/** Point the TOP face of a carriage at a plain patch of the texture sheet.
 *
 *  A box's six faces all sample the same sheet, so a carriage-side texture
 *  prints windows and doors across the ROOF — the surface the player actually
 *  runs along, which looked like running over glass. Collapsing that face's
 *  UVs onto a single texel gives it a flat metal colour at no cost: still one
 *  mesh, one material, one draw call.
 *
 *  Babylon lays a box's faces out in a fixed order and the top face is
 *  vertices 16..19 (front, back, right, left, top, bottom). */
function flattenTopFace(mesh: Mesh, u: number, v: number): void {
  const uvs = mesh.getVerticesData("uv");
  if (!uvs || uvs.length < 48) return;
  for (let i = 16; i < 20; i++) {
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }
  mesh.setVerticesData("uv", uvs);
}

/** Point every UV at one texel, so a face shows a flat sample of the sheet
 *  instead of the whole thing stretched across it. */
function flattenAllUVs(mesh: Mesh, u: number, v: number): void {
  const uvs = mesh.getVerticesData("uv");
  if (!uvs) return;
  for (let i = 0; i < uvs.length; i += 2) {
    uvs[i] = u;
    uvs[i + 1] = v;
  }
  mesh.setVerticesData("uv", uvs);
}

/** A ramp: a solid wedge rising from y=0 at z=0 to y=h at z=len, `w` wide and
 *  centred on x. Written out as vertices because Babylon has no wedge
 *  primitive and every approximation with a rotated box read as a box. */
function buildWedge(name: string, w: number, h: number, len: number, scene: Scene): Mesh {
  const hw = w / 2;
  const positions = [
    // 0..3 bottom face (y = 0)
    -hw, 0, 0, hw, 0, 0, hw, 0, len, -hw, 0, len,
    // 4..5 top edge at the far end
    -hw, h, len, hw, h, len,
  ];
  const indices = [
    // bottom
    0, 2, 1, 0, 3, 2,
    // the slope you run up
    0, 1, 5, 0, 5, 4,
    // vertical face where it meets the carriage
    3, 4, 5, 3, 5, 2,
    // the two triangular sides
    0, 4, 3, 1, 2, 5,
  ];
  const mesh = new Mesh(name, scene);
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  data.normals = normals;
  // UVs are not used by the flat material, but a merge refuses to combine
  // meshes whose attribute sets differ — and the box it merges with has them.
  data.uvs = [0, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 1];
  data.applyToMesh(mesh);
  return mesh;
}

/** Build the source mesh for one drawn kind.
 *
 *  The two special carriages are merged from parts into a SINGLE mesh so they
 *  still cost one draw call for all their instances — a ramp is a box with a
 *  wedge on its back, and an open car is a shell with both ends missing so you
 *  can see the aisle you are about to run down. */
function buildSource(
  kind: DrawKind,
  s: { w: number; h: number; d: number; y: number },
  scene: Scene
): Mesh {
  if (kind === "train_ramp") {
    // A real WEDGE, not a tilted plank: the way up has to read as a solid
    // slope from a hundred metres back, and two earlier attempts (a plank
    // inside the body, then a thin plank outside it) both rendered as a plain
    // box. A box that looks like every other box is a trap, not an invitation.
    const rampLen = s.d * 0.4;
    const body = MeshBuilder.CreateBox(`ob_${kind}_body`, { width: s.w, height: s.h, depth: s.d - rampLen }, scene);
    flattenTopFace(body, 0.5, 0.03); // roof: plain metal, not windows
    body.position.z = rampLen / 2;
    const wedge = buildWedge(`ob_${kind}_wedge`, s.w, s.h, rampLen, scene);
    // Plate metal, not a carriage side stretched over the slope. Unflattened,
    // the whole window sheet smeared across a 3 m x 3 m face and the ramp read
    // as a blank white slab leaning on the track — the most conspicuous
    // unreal thing in the scene.
    flattenAllUVs(wedge, 0.5, 0.03);
    wedge.position.set(0, -s.h / 2, -s.d / 2);
    const merged = Mesh.MergeMeshes([body, wedge], true, true, undefined, false, false);
    return merged ?? body;
  }
  if (kind === "train_open") {
    const t = 0.16;
    const parts: Mesh[] = [];
    for (const side of [-1, 1]) {
      const wall = MeshBuilder.CreateBox(`ob_${kind}_w`, { width: t, height: s.h, depth: s.d }, scene);
      wall.position.x = (side * (s.w - t)) / 2;
      parts.push(wall);
    }
    const roof = MeshBuilder.CreateBox(`ob_${kind}_r`, { width: s.w, height: t, depth: s.d }, scene);
    flattenTopFace(roof, 0.5, 0.03);
    roof.position.y = (s.h - t) / 2;
    parts.push(roof);
    const floor = MeshBuilder.CreateBox(`ob_${kind}_f`, { width: s.w, height: t, depth: s.d }, scene);
    floor.position.y = -(s.h - t) / 2;
    parts.push(floor);
    const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, false);
    return merged ?? parts[0];
  }
  const box = MeshBuilder.CreateBox(`ob_${kind}`, { width: s.w, height: s.h, depth: s.d }, scene);
  if (kind === "train_solid") flattenTopFace(box, 0.5, 0.03);
  return box;
}

export class Props {
  private pools = new Map<DrawKind, Pool>();
  private coinSource: Mesh;
  private coins: InstancedMesh[] = [];
  private coinSpin = 0;

  private urls: string[] = [];
  /** Real models for the kinds that have one; the rest keep their shapes. */
  private models: TracklineModels | null = null;

  constructor(
    scene: Scene,
    private course: Course,
    textures: {
      train?: Uint8Array | null;
      barrier?: Uint8Array | null;
      beam?: Uint8Array | null;
      hoarding?: Uint8Array | null;
    } = {},
    models: TracklineModels | null = null
  ) {
    this.models = models;
    const trainTexture = textures.train ?? null;
    const makeTex = (bytes: Uint8Array | null | undefined, uScale: number): Texture | null => {
      if (!bytes) return null;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/webp" }));
      this.urls.push(url);
      const t = new Texture(url, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
      t.uScale = uScale;
      return t;
    };
    // One skin per obstacle role: orange plastic for the things you jump,
    // hazard-striped steel for the beam you roll under. The COLOUR coding the
    // grey box used is now carried by real materials, so the read is the same
    // but the street stops looking like a toolkit.
    const barrierTex = makeTex(textures.barrier, 1);
    const beamTex = makeTex(textures.beam, 1);
    const hoardingTex = makeTex(textures.hoarding, 1);
    // The carriage skin, shared by all three carriage types: a real stainless
    // commuter side with windows, doors and a livery stripe. Boxes get a long
    // way with the right texture on them.
    let trainTex: Texture | null = null;
    if (trainTexture) {
      const url = URL.createObjectURL(new Blob([trainTexture as BlobPart], { type: "image/webp" }));
      this.urls.push(url);
      trainTex = new Texture(url, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE);
      trainTex.uScale = 1.6; // the carriage is longer than the sheet
    }
    for (const kind of Object.keys(SHAPE) as DrawKind[]) {
      const s = SHAPE[kind];
      // A real model wins over the built shape wherever the pack has one. The
      // solid carriage and the low barrier are the two that exist today; the
      // ramp and the open car keep their built geometry, because their SHAPE
      // is the instruction to the player and a generated carriage has neither
      // a ramp nor open ends.
      const model = kind === "low" ? models?.barrier : kind === "train_solid" ? models?.carriage : null;
      if (model) {
        const free: InstancedMesh[] = [];
        for (let i = 0; i < POOL[kind]; i++) {
          const inst = model.createInstance(`${kind}_${i}`);
          inst.isPickable = false;
          inst.setEnabled(false);
          free.push(inst);
        }
        this.pools.set(kind, { source: model, free });
        continue;
      }
      const source = buildSource(kind, s, scene);
      const mat = new StandardMaterial(`obMat_${kind}`, scene);
      mat.diffuseColor = s.colour;
      mat.emissiveColor = s.glow;
      mat.specularColor = new Color3(0.05, 0.05, 0.06);
      const skin =
        kind === "low" ? barrierTex : kind === "high" ? beamTex : kind === "full" ? hoardingTex ?? barrierTex : null;
      if (skin) {
        mat.diffuseTexture = skin;
        mat.diffuseColor = new Color3(1, 1, 1);
        mat.specularColor = new Color3(0.2, 0.2, 0.22);
        mat.specularPower = 48;
        // Reflective stripes and the beam's warning lamp read at night only
        // if they light themselves a little.
        mat.emissiveTexture = skin;
        mat.emissiveColor = new Color3(0.12, 0.12, 0.12);
      }
      if (trainTex && kind.startsWith("train")) {
        mat.diffuseTexture = trainTex;
        // Keep the colour cue the three carriages are told apart by: plain
        // steel for the one you must avoid, warm for the ramp you climb, cool
        // and bright for the one you run through. The texture supplies the
        // detail, this supplies the read-at-distance.
        mat.diffuseColor =
          kind === "train_ramp"
            ? new Color3(1.0, 0.78, 0.46)
            : kind === "train_open"
              ? new Color3(0.78, 0.9, 1.0)
              : new Color3(1, 1, 1);
        // Lit windows: the sheet lights itself faintly so a carriage reads as
        // a vehicle with people in it rather than a painted block.
        mat.emissiveTexture = trainTex;
        mat.emissiveColor = new Color3(0.16, 0.16, 0.18);
        mat.specularColor = new Color3(0.35, 0.36, 0.4);
        mat.specularPower = 64;
      }
      source.material = mat;
      source.isPickable = false;
      source.isVisible = false; // only the instances draw
      const free: InstancedMesh[] = [];
      for (let i = 0; i < POOL[kind]; i++) {
        const inst = source.createInstance(`${kind}_${i}`);
        inst.isPickable = false;
        inst.setEnabled(false);
        free.push(inst);
      }
      this.pools.set(kind, { source, free });
    }

    // Coins: a disc standing across the track, spinning. One mesh, one draw
    // call for all of them.
    this.coinSource = MeshBuilder.CreateCylinder("coin", { diameter: 0.55, height: 0.07, tessellation: 14 }, scene);
    const coinMat = new StandardMaterial("coinMat", scene);
    coinMat.diffuseColor = new Color3(1, 0.78, 0.2);
    coinMat.emissiveColor = new Color3(0.55, 0.36, 0.03);
    coinMat.specularColor = new Color3(0.6, 0.5, 0.2);
    this.coinSource.material = coinMat;
    this.coinSource.isPickable = false;
    this.coinSource.isVisible = false;
    for (let i = 0; i < COIN_POOL; i++) {
      const inst = this.coinSource.createInstance(`coin_${i}`);
      inst.isPickable = false;
      // Lying across the track so the flat face reads from behind.
      inst.rotation.x = Math.PI / 2;
      inst.setEnabled(false);
      this.coins.push(inst);
    }
  }

  /** Re-point the pools at what is in view from `z`. Called once a frame. */
  update(z: number, dt: number): void {
    const from = z - VIEW_BEHIND;
    const to = z + VIEW_AHEAD;

    const used: Record<DrawKind, number> = {
      low: 0,
      high: 0,
      full: 0,
      train_solid: 0,
      train_ramp: 0,
      train_open: 0,
    };
    const firstRow = Math.max(0, Course.indexAt(from) - 1);
    const lastRow = Course.indexAt(to);
    for (let i = firstRow; i <= lastRow; i++) {
      if (i < 0) continue;
      for (const o of this.course.rowAt(i).obstacles) {
        if (o.z + o.length < from || o.z > to) continue;
        const draw = drawKindOf(o);
        const pool = this.pools.get(draw)!;
        const slot = used[draw];
        if (slot >= pool.free.length) continue; // pool exhausted — see POOL
        const inst = pool.free[slot];
        used[draw] = slot + 1;
        // A model's origin is at its BASE, a built box's at its centre, so
        // they cannot share a height. Getting this wrong buries a barrier
        // half-way into the road.
        const onGround = draw === "low" ? !!this.models?.barrier : draw === "train_solid" ? !!this.models?.carriage : false;
        inst.position.set(laneToX(o.lane), onGround ? 0 : SHAPE[draw].y, o.z + o.length / 2);
        inst.setEnabled(true);
      }
    }
    for (const kind of Object.keys(used) as DrawKind[]) {
      const pool = this.pools.get(kind)!;
      for (let i = used[kind]; i < pool.free.length; i++) pool.free[i].setEnabled(false);
    }

    // Coins, only ahead of the runner: one you missed drops out of sight
    // behind you, which is where a missed coin belongs. The COUNT on the HUD
    // is the simulation's, never this.
    this.coinSpin = (this.coinSpin + dt * 3.2) % (Math.PI * 2);
    let c = 0;
    for (let i = firstRow; i <= lastRow && c < this.coins.length; i++) {
      if (i < 0) continue;
      for (const coin of this.course.coinsOf(i)) {
        if (coin.z < z - 1 || coin.z > to) continue;
        if (c >= this.coins.length) break;
        const inst = this.coins[c++];
        // Roof coins sit on the carriage; they are only reachable from up there.
        inst.position.set(laneToX(coin.lane), coin.level === 1 ? ROOF_HEIGHT + 0.55 : 1.0, coin.z);
        inst.rotation.y = this.coinSpin;
        inst.setEnabled(true);
      }
    }
    for (let i = c; i < this.coins.length; i++) this.coins[i].setEnabled(false);
  }

  dispose(): void {
    for (const url of this.urls) URL.revokeObjectURL(url);
    for (const pool of this.pools.values()) {
      for (const inst of pool.free) inst.dispose();
      pool.source.material?.dispose();
      pool.source.dispose();
    }
    for (const inst of this.coins) inst.dispose();
    this.coinSource.material?.dispose();
    this.coinSource.dispose();
  }
}
