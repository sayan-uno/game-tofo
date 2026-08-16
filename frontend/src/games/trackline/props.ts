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
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { BARRIER_DEPTH, Course, TRAIN_LENGTH, type ObstacleKind } from "../../shared/games/trackline/course";
import { laneToX } from "./world";

/** How far ahead obstacles are drawn. Past this the fog has them anyway. */
const VIEW_AHEAD = 170;
/** And how far behind, so a barrier does not vanish while still beside you. */
const VIEW_BEHIND = 14;

/** Pool sizes: a row can hold three obstacles and rows are 15 m apart, so the
 *  view holds about 12 rows. Generous enough that the cap is never reached in
 *  practice, small enough to stay a handful of instances. */
const POOL: Record<ObstacleKind, number> = { low: 16, high: 16, full: 16, train: 10 };
const COIN_POOL = 90;

/** Size and seat height of each kind, in metres. Width is deliberately under a
 *  lane (2.2 m) so the gap you can squeeze through is visible. */
const SHAPE: Record<ObstacleKind, { w: number; h: number; d: number; y: number; colour: Color3; glow: Color3 }> = {
  // Knee-high: jump it.
  low: { w: 1.8, h: 0.55, d: BARRIER_DEPTH, y: 0.275, colour: new Color3(0.9, 0.45, 0.08), glow: new Color3(0.28, 0.1, 0.0) },
  // Overhead beam: roll under it. Hangs with its underside at 1.2 m.
  high: { w: 1.9, h: 0.5, d: BARRIER_DEPTH, y: 1.45, colour: new Color3(0.2, 0.65, 0.85), glow: new Color3(0.02, 0.14, 0.2) },
  // Wall: go round.
  full: { w: 1.8, h: 2.4, d: BARRIER_DEPTH, y: 1.2, colour: new Color3(0.75, 0.12, 0.18), glow: new Color3(0.22, 0.02, 0.04) },
  // Carriage: go round, and it stays beside you for a while.
  train: { w: 2.0, h: 3.2, d: TRAIN_LENGTH, y: 1.6, colour: new Color3(0.34, 0.36, 0.42), glow: new Color3(0.03, 0.03, 0.05) },
};

interface Pool {
  source: Mesh;
  free: InstancedMesh[];
}

export class Props {
  private pools = new Map<ObstacleKind, Pool>();
  private coinSource: Mesh;
  private coins: InstancedMesh[] = [];
  private coinSpin = 0;

  constructor(
    private scene: Scene,
    private course: Course
  ) {
    for (const kind of Object.keys(SHAPE) as ObstacleKind[]) {
      const s = SHAPE[kind];
      const source = MeshBuilder.CreateBox(`ob_${kind}`, { width: s.w, height: s.h, depth: s.d }, scene);
      const mat = new StandardMaterial(`obMat_${kind}`, scene);
      mat.diffuseColor = s.colour;
      mat.emissiveColor = s.glow;
      mat.specularColor = new Color3(0.05, 0.05, 0.06);
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

    const used: Record<string, number> = { low: 0, high: 0, full: 0, train: 0 };
    const firstRow = Math.max(0, Course.indexAt(from) - 1);
    const lastRow = Course.indexAt(to);
    for (let i = firstRow; i <= lastRow; i++) {
      if (i < 0) continue;
      for (const o of this.course.rowAt(i).obstacles) {
        if (o.z + o.length < from || o.z > to) continue;
        const pool = this.pools.get(o.kind)!;
        const slot = used[o.kind];
        if (slot >= pool.free.length) continue; // pool exhausted — see POOL
        const inst = pool.free[slot];
        used[o.kind] = slot + 1;
        inst.position.set(laneToX(o.lane), SHAPE[o.kind].y, o.z + o.length / 2);
        inst.setEnabled(true);
      }
    }
    for (const kind of Object.keys(used) as ObstacleKind[]) {
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
        inst.position.set(laneToX(coin.lane), 1.0, coin.z);
        inst.rotation.y = this.coinSpin;
        inst.setEnabled(true);
      }
    }
    for (let i = c; i < this.coins.length; i++) this.coins[i].setEnabled(false);
  }

  dispose(): void {
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
