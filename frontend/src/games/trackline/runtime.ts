// The Trackline runtime: one scene, N runners, one deterministic sim each.
//
//  - The LOCAL runner is predicted: an input applies to its sim the instant it
//    is pressed (stamped for the next tick) and is sent at the same moment.
//  - Every OTHER runner is a replay of their inputs, run GHOST_DELAY ticks
//    behind the local clock so inputs have normally arrived before the tick
//    they belong to; a late one triggers a cheap full replay of that runner.
//  - Nothing here reads the wall clock for gameplay except to derive the
//    current tick from the synced start time; the sim owns all state.
//
// Rendering budget notes for this grey box: one ground draw, one instanced
// scenery draw, N characters + N tags, no shadows, DOM HUD updated on change,
// no per-frame allocations in the step loop.
import { Scene } from "@babylonjs/core/scene";
import { TargetCamera } from "@babylonjs/core/Cameras/targetCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import type { GameRuntime, GameRuntimeContext } from "../../platform/types";
import type { MatchEnd, MatchInputRelay } from "../../shared/core/protocol";
import {
  DURATION_TICKS,
  TICK_RATE,
  applyInput,
  createState,
  replay,
  step,
  type InputKind,
  type RunnerInput,
  type RunnerState,
} from "../../shared/games/trackline/index";
import { Controls } from "./controls";
import { TracklineHud } from "./hud";
import { RunnerView } from "./runnerView";
import { World, laneToX } from "./world";

/** Ghosts run this many ticks behind the local clock (150 ms). */
const GHOST_DELAY = 9;
/** Beyond this gap, catching up steps one at a time is silly — replay. */
const FAST_FORWARD_TICKS = 180;
const CAM_BACK = 7.5;
const CAM_UP = 3.3;
const CAM_LOOK_AHEAD = 10;
const CAM_LOOK_UP = 1.0;

interface Sim {
  uid: string;
  seat: number;
  state: RunnerState;
  /** Sorted by tick once dirty is cleared. */
  log: RunnerInput[];
  /** Index into log of the next input not yet applied (incremental path). */
  cursor: number;
  /** A late/out-of-order input arrived: rebuild from the log. */
  dirty: boolean;
  left: boolean;
  view: RunnerView;
}

export class TracklineRuntime implements GameRuntime {
  private scene: Scene;
  private camera: TargetCamera;
  private world: World | null = null;
  private hud: TracklineHud | null = null;
  private controls: Controls | null = null;
  private local: Sim;
  private ghosts: Sim[] = [];
  private byUid = new Map<string, Sim>();
  private startAt: number | null = null;
  private ended = false;
  private disposed = false;
  private camX = 0;
  /** Reused every frame — no per-frame allocation in the camera path. */
  private readonly lookAt = new Vector3(0, 0, 0);
  private readonly tickRate: number;
  private readonly durationTicks: number;

  constructor(private ctx: GameRuntimeContext) {
    // The server's numbers win; the shared copy is what we were built with.
    this.tickRate = ctx.rules.tickRate ?? TICK_RATE;
    this.durationTicks = ctx.rules.durationTicks ?? DURATION_TICKS;
    if (this.tickRate !== TICK_RATE || this.durationTicks !== DURATION_TICKS) {
      console.warn("[trackline] rules differ from this build's copy — server wins", ctx.rules);
    }
    this.scene = new Scene(ctx.engine);
    const scene = this.scene;
    scene.clearColor = new Color4(0.05, 0.06, 0.1, 1);
    scene.skipPointerMovePicking = true;
    scene.skipPointerDownPicking = true;
    scene.skipPointerUpPicking = true;
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.0085;
    scene.fogColor = new Color3(0.05, 0.06, 0.1);
    this.camera = new TargetCamera("cam", new Vector3(0, CAM_UP, -CAM_BACK), scene);
    this.camera.fov = 0.95;
    this.camera.minZ = 0.3;
    this.camera.maxZ = 400;

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.55;
    hemi.diffuse = new Color3(0.75, 0.8, 1.0);
    hemi.groundColor = new Color3(0.2, 0.12, 0.1);
    const key = new DirectionalLight("key", new Vector3(-0.35, -1, 0.4), scene);
    key.intensity = 0.9;
    key.diffuse = new Color3(1.0, 0.85, 0.7);

    // Sims: one per roster seat, in roster order (the server ranks by seat too).
    const sims: Sim[] = ctx.roster.map((r, seat) => ({
      uid: r.uid,
      seat,
      state: createState(seat),
      log: [],
      cursor: 0,
      dirty: false,
      left: false,
      view: new RunnerView(scene, r.uid, r.name, r.uid === ctx.you),
    }));
    for (const s of sims) this.byUid.set(s.uid, s);
    const me = sims.find((s) => s.uid === ctx.you);
    if (!me) throw new Error("local player is not in the roster");
    this.local = me;
    this.ghosts = sims.filter((s) => s !== me);
  }

  // ---- lifecycle ----

  async prepare(): Promise<void> {
    const ctx = this.ctx;
    const trackTex = ctx.assets.has("textures/track.webp") ? await ctx.assets.get("textures/track.webp") : null;
    this.world = new World(this.scene, trackTex);
    this.hud = new TracklineHud(ctx.hudRoot, ctx.roster, ctx.you);
    // Characters in parallel; each is already in the on-device store from the
    // lobby, so this is a parse, not a download.
    await Promise.all(this.allSims().map((s) => s.view.load(ctx.roster[s.seat].character)));
    this.placeAll();
    // Compile every material now, behind the curtain, so the first real frame
    // doesn't stall on shader builds.
    await Promise.all(
      this.scene.meshes.map((m) => (m.material ? m.material.forceCompilationAsync(m).catch(() => {}) : Promise.resolve()))
    );
    this.controls = new Controls(ctx.canvas, (kind) => this.onLocalInput(kind));
  }

  go(localStartAt: number): void {
    this.startAt = localStartAt;
  }

  onRemoteInput(input: MatchInputRelay): void {
    const sim = this.byUid.get(input.uid);
    if (!sim || sim === this.local || sim.left) return;
    this.pushInput(sim, { tick: input.tick, kind: input.kind as InputKind });
  }

  seedInputs(inputs: MatchInputRelay[]): void {
    for (const i of inputs) {
      const sim = this.byUid.get(i.uid);
      if (!sim) continue;
      this.pushInput(sim, { tick: i.tick, kind: i.kind as InputKind });
    }
  }

  onLeft(uid: string): void {
    const sim = this.byUid.get(uid);
    if (!sim || sim.left) return;
    sim.left = true;
    sim.view.setLeft();
    this.hud?.setStatus(uid, "left", "left");
  }

  end(_result: MatchEnd): void {
    this.ended = true;
    this.controls?.dispose();
    this.controls = null;
    this.hud?.setEnded();
  }

  dispose(): void {
    this.disposed = true;
    this.controls?.dispose();
    this.hud?.dispose();
    for (const s of this.allSims()) s.view.dispose();
    this.world?.dispose();
    this.scene.dispose();
  }

  /** Dev-only: a snapshot for test harnesses (see MatchClient.debug). */
  debug(): unknown {
    const pick = (s: Sim) => ({ uid: s.uid, seat: s.seat, tick: s.state.tick, lane: s.state.lane, x: Number(s.state.x.toFixed(3)), distance: Number(s.state.distance.toFixed(2)), inputs: s.log.length, left: s.left });
    return {
      startAt: this.startAt,
      ended: this.ended,
      local: pick(this.local),
      ghosts: this.ghosts.map(pick),
      scene: {
        meshes: this.scene.meshes.length,
        particleSystems: this.scene.particleSystems.length,
        activeMeshes: this.scene.getActiveMeshes().length,
      },
    };
  }

  // ---- per frame ----

  render(): void {
    if (this.disposed) return;
    if (this.startAt !== null && !this.ended) this.stepToNow();
    this.placeAll();
    this.scene.render();
  }

  private allSims(): Sim[] {
    return [this.local, ...this.ghosts];
  }

  /** Current tick from the synced clock, clamped to the match. */
  private tickNow(): number {
    const t = Math.floor(((Date.now() - this.startAt!) * this.tickRate) / 1000);
    return Math.max(0, Math.min(t, this.durationTicks));
  }

  private stepToNow(): void {
    const target = this.tickNow();
    this.advance(this.local, target);
    const ghostTarget = Math.max(0, target - GHOST_DELAY);
    for (const g of this.ghosts) this.advance(g, ghostTarget);
    this.hud?.setRemaining((this.durationTicks - target) / this.tickRate);
  }

  /** Bring one sim to `target` ticks: incrementally when close, by full replay
   *  when it is dirty or far behind. Inputs stamped for tick T apply just
   *  before T's step — the same rule replay() uses, so both paths agree. */
  private advance(sim: Sim, target: number): void {
    if (sim.state.tick >= target) return;
    if (sim.dirty || target - sim.state.tick > FAST_FORWARD_TICKS) {
      sim.log.sort((a, b) => a.tick - b.tick);
      sim.state = replay(sim.seat, sim.log, target);
      // The replay consumed everything up to target; the cursor points at the
      // first input still in the future.
      sim.cursor = sim.log.findIndex((i) => i.tick > target);
      if (sim.cursor < 0) sim.cursor = sim.log.length;
      sim.dirty = false;
      return;
    }
    const s = sim.state;
    while (s.tick < target) {
      const next = s.tick + 1;
      while (sim.cursor < sim.log.length && sim.log[sim.cursor].tick <= next) {
        applyInput(s, sim.log[sim.cursor].kind);
        sim.cursor++;
      }
      step(s);
    }
  }

  private pushInput(sim: Sim, input: RunnerInput): void {
    // In order and in the future → the incremental path handles it.
    const last = sim.log.length ? sim.log[sim.log.length - 1] : null;
    if (input.tick <= sim.state.tick || (last && input.tick < last.tick)) sim.dirty = true;
    sim.log.push(input);
  }

  private onLocalInput(kind: InputKind): void {
    if (this.startAt === null || this.ended) return;
    const s = this.local.state;
    // Before tick 0 (countdown) inputs are ignored — nothing to steer yet.
    if (Date.now() < this.startAt) return;
    if (s.tick >= this.durationTicks) return;
    const tick = s.tick + 1;
    // Predict now; the log keeps the same input so a replay reproduces it.
    applyInput(s, kind);
    this.local.log.push({ tick, kind });
    this.local.cursor = this.local.log.length;
    this.ctx.sendInput({ tick, kind });
  }

  /** World positions from sim state + camera follow. */
  private placeAll(): void {
    const me = this.local.state;
    const z = me.distance;
    const x = laneToX(me.x);
    this.local.view.setPosition(x, z);
    // Ghosts are truly level with you (same speed schedule); a small stagger
    // keeps two runners in one lane from z-fighting.
    let k = 1;
    for (const g of this.ghosts) {
      g.view.setPosition(laneToX(g.state.x), z - 0.45 * k);
      k++;
    }
    this.world?.follow(z);
    // Camera eases sideways toward the runner's lane; forward it is rigid.
    this.camX += (x - this.camX) * 0.12;
    this.camera.position.set(this.camX * 0.6, CAM_UP, z - CAM_BACK);
    this.lookAt.set(this.camX * 0.6, CAM_LOOK_UP, z + CAM_LOOK_AHEAD);
    this.camera.setTarget(this.lookAt);
  }
}
