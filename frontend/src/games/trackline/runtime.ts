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
  Course,
  DURATION_TICKS,
  RunnerSim,
  TICK_RATE,
  scoreOf,
  type InputKind,
} from "../../shared/games/trackline/index";
import { Controls } from "./controls";
import { TracklineHud } from "./hud";
import { Props } from "./props";
import { RunnerView } from "./runnerView";
import { World, laneToX } from "./world";

/** Ghosts run this many ticks behind the local clock (150 ms). */
const GHOST_DELAY = 9;
const CAM_BACK = 7.5;
const CAM_UP = 3.3;
const CAM_LOOK_AHEAD = 10;
const CAM_LOOK_UP = 1.0;

interface Sim {
  uid: string;
  seat: number;
  /** THE simulation — the same class the server judges with, so the run drawn
   *  here and the run scored there cannot drift apart. */
  sim: RunnerSim;
  left: boolean;
  view: RunnerView;
}

export class TracklineRuntime implements GameRuntime {
  private scene: Scene;
  private camera: TargetCamera;
  private world: World | null = null;
  private props: Props | null = null;
  private course: Course;
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
    this.course = new Course(ctx.seed);
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
      sim: new RunnerSim(seat, this.course),
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
    this.props = new Props(this.scene, this.course);
    this.hud = new TracklineHud(ctx.hudRoot, ctx.roster, ctx.you);
    // Characters in parallel; each is already in the on-device store from the
    // lobby, so this is a parse, not a download.
    await Promise.all(this.allSims().map((s) => s.view.load(ctx.roster[s.seat].character)));
    this.placeAll(0);
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
    sim.sim.addInput({ tick: input.tick, kind: input.kind as InputKind });
  }

  seedInputs(inputs: MatchInputRelay[]): void {
    for (const i of inputs) {
      const sim = this.byUid.get(i.uid);
      // Own inputs included: on a reconnect the log is the only record of what
      // this player did before the tab went away.
      if (sim) sim.sim.addInput({ tick: i.tick, kind: i.kind as InputKind });
    }
  }

  onLeft(uid: string): void {
    const sim = this.byUid.get(uid);
    if (!sim || sim.left) return;
    sim.left = true;
    sim.view.setLeft();
    this.hud?.setStatus(uid, "left", "left");
  }

  /** Dev-only snapshot (see MatchClient.debug). */
  debug(): unknown {
    const pick = (s: Sim) => ({
      uid: s.uid,
      seat: s.seat,
      tick: s.sim.state.tick,
      lane: s.sim.state.lane,
      x: Number(s.sim.state.x.toFixed(3)),
      y: Number(s.sim.state.y.toFixed(2)),
      distance: Number(s.sim.state.distance.toFixed(2)),
      alive: s.sim.state.alive,
      coins: s.sim.state.coins,
      nearMisses: s.sim.state.nearMisses,
      score: scoreOf(s.sim.state),
      inputs: s.sim.inputs.length,
      left: s.left,
    });
    // What the local runner is about to meet — the harness drives the course
    // with this, which is how jump/roll/lane-change get exercised end to end.
    const me = this.local.sim.state;
    const nextIndex = Math.max(0, Course.indexAt(me.distance) + 1);
    const row = this.course.rowAt(nextIndex);
    return {
      startAt: this.startAt,
      ended: this.ended,
      local: pick(this.local),
      ghosts: this.ghosts.map(pick),
      upcoming: {
        z: row.z,
        ahead: Number((row.z - me.distance).toFixed(2)),
        safeLane: row.safeLane,
        obstacles: row.obstacles.map((o) => ({ lane: o.lane, kind: o.kind })),
      },
      scene: {
        meshes: this.scene.meshes.length,
        particleSystems: this.scene.particleSystems.length,
        activeMeshes: this.scene.getActiveMeshes().length,
      },
    };
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
    this.props?.dispose();
    this.world?.dispose();
    this.scene.dispose();
  }

  // ---- per frame ----

  render(): void {
    if (this.disposed) return;
    const dt = Math.min(this.scene.getEngine().getDeltaTime(), 100) / 1000;
    if (this.startAt !== null && !this.ended) this.stepToNow();
    this.placeAll(dt);
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
    this.local.sim.advanceTo(target);
    // Everyone else runs a little behind, so their inputs have normally landed
    // before the tick they belong to and their run is drawn smoothly rather
    // than corrected in front of you.
    const ghostTarget = Math.max(0, target - GHOST_DELAY);
    for (const g of this.ghosts) g.sim.advanceTo(ghostTarget);
    this.hud?.setRemaining((this.durationTicks - target) / this.tickRate);
    this.paintHud();
  }

  private onLocalInput(kind: InputKind): void {
    if (this.startAt === null || this.ended) return;
    // Before tick 0 (countdown) there is nothing to steer yet.
    if (Date.now() < this.startAt) return;
    const s = this.local.sim.state;
    if (!s.alive || s.tick >= this.durationTicks) return;
    // Predicted and logged in one step, then sent: this player never waits for
    // the server to see their own move.
    const input = this.local.sim.predict(kind);
    this.ctx.sendInput(input);
  }

  /** Scoreboard, repainted from simulation state. The HUD itself only touches
   *  the DOM when a value actually changed. */
  private paintHud(): void {
    if (!this.hud) return;
    for (const s of [this.local, ...this.ghosts]) {
      if (s.left) continue;
      const st = s.sim.state;
      this.hud.setStatus(s.uid, st.alive ? String(scoreOf(st)) : "out", st.alive ? undefined : "out");
    }
    const me = this.local.sim.state;
    this.hud.setScore(scoreOf(me), me.coins, me.alive);
  }

  /** World positions from sim state + camera follow. */
  private placeAll(dt: number): void {
    const me = this.local.sim.state;
    for (const s of [this.local, ...this.ghosts]) {
      const st = s.sim.state;
      s.view.setState(laneToX(st.x), st.y, st.distance, { rolling: st.rolling > 0, alive: st.alive && !s.left });
    }

    // The camera follows whoever you are watching: yourself while you are
    // running, and the leader once you are out — a spectator with nothing to
    // look at is the dullest way to spend the rest of a match.
    const watched = me.alive ? this.local : this.bestAlive() ?? this.local;
    const ws = watched.sim.state;
    const z = ws.distance;
    const x = laneToX(ws.x);
    this.world?.follow(z);
    this.props?.update(z, dt);
    this.camX += (x - this.camX) * 0.12;
    this.camera.position.set(this.camX * 0.6, CAM_UP + ws.y * 0.35, z - CAM_BACK);
    this.lookAt.set(this.camX * 0.6, CAM_LOOK_UP + ws.y * 0.5, z + CAM_LOOK_AHEAD);
    this.camera.setTarget(this.lookAt);
  }

  /** The runner worth watching: alive, furthest ahead on score. */
  private bestAlive(): Sim | null {
    let best: Sim | null = null;
    for (const s of [this.local, ...this.ghosts]) {
      if (s.left || !s.sim.state.alive) continue;
      if (!best || scoreOf(s.sim.state) > scoreOf(best.sim.state)) best = s;
    }
    return best;
  }
}
