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
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import type { GameRuntime, GameRuntimeContext } from "../../platform/types";
import type { MatchEnd, MatchInputRelay } from "../../shared/core/protocol";
import {
  Course,
  DURATION_TICKS,
  ROOF_HEIGHT,
  TRAIN_LENGTH,
  RunnerSim,
  TICK_RATE,
  onRoof,
  scoreOf,
  type InputKind,
} from "../../shared/games/trackline/index";
import { Controls } from "./controls";
import { TracklineHud } from "./hud";
import { Props } from "./props";
import { RunnerView } from "./runnerView";
import { loadTracklineModels } from "./models";
import { FOG_COLOUR, LAMP_WARM, World, laneToX } from "./world";

/** Ghosts run this many ticks behind the local clock (150 ms). */
const GHOST_DELAY = 9;
const CAM_BACK = 7.5;
/** Never blur past this: below it the game stops being readable, and a
 *  device that cannot hold the budget at this scale should drop frames
 *  visibly rather than silently turn to mush. */
const MAX_HARDWARE_SCALE = 1.9;
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
  /** Eased camera height. Climbing onto a carriage roof lifts the whole shot
   *  by 3.2 m; snapping to it reads as a cut, so it is followed rather than
   *  set — and the jump arc is only partly followed, so a jump still feels
   *  like the runner leaving the ground rather than the world dropping. */
  private camY = CAM_UP;
  private frameAccum = 0;
  private frameCount = 0;
  /** Whatever the lobby set for this device — never sharpen past it. */
  private baseScale = 1;
  /** Travels with the runner so the near street always sits in a warm pool. */
  private streetLight: PointLight | null = null;
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
    scene.clearColor = new Color4(FOG_COLOUR.r, FOG_COLOUR.g, FOG_COLOUR.b, 1);
    scene.skipPointerMovePicking = true;
    scene.skipPointerDownPicking = true;
    scene.skipPointerUpPicking = true;
    // Fog is the depth cue AND the draw-distance budget: it hides the end of
    // the street, so nothing has to be drawn past it. Its colour is the sky's
    // horizon, so distance dissolves into the sky rather than into a grey wall.
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.0075;
    scene.fogColor = FOG_COLOUR;
    this.camera = new TargetCamera("cam", new Vector3(0, CAM_UP, -CAM_BACK), scene);
    this.camera.fov = 0.95;
    this.camera.minZ = 0.3;
    this.camera.maxZ = 400;

    // BLUE HOUR in two lights. The sky is a cool fill from above; the street
    // lamps are a warm key from the side. Everything the player reads as
    // atmosphere comes from that contrast, so both stay deliberately low —
    // the bright things here are the emissive lamps, the lit windows and the
    // wet road's specular, not the lighting.
    const sky = new HemisphericLight("sky", new Vector3(0, 1, 0), scene);
    sky.intensity = 0.22; // the blue is the SHADOW colour, not the light
    sky.diffuse = new Color3(0.36, 0.45, 0.8);
    sky.groundColor = new Color3(0.08, 0.07, 0.1);
    sky.specular = new Color3(0.15, 0.18, 0.32);
    const lamps = new DirectionalLight("lamps", new Vector3(-0.45, -0.7, 0.3), scene);
    lamps.intensity = 1.05;
    lamps.diffuse = LAMP_WARM;
    lamps.specular = new Color3(1.0, 0.78, 0.45);
    // ONE travelling point light, riding with the runner. The reference's
    // whole look is pools of sodium light with darkness between them, and a
    // directional light alone cannot make a pool — it lights everything
    // equally, however far away. This gives the near street the falloff that
    // reads as street lighting, for the cost of a single light.
    //
    // Intensity is single digits on purpose: Babylon's point-light units are
    // not photometric, and the first attempt at 260 turned the road into a
    // sheet of white.
    this.streetLight = new PointLight("street", new Vector3(0, 10, 0), scene);
    this.streetLight.diffuse = LAMP_WARM;
    this.streetLight.specular = new Color3(0.25, 0.18, 0.1);
    this.streetLight.intensity = 7;
    this.streetLight.range = 70;

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
    // The three sheets the street is built from. All are optional: a pack
    // without them still plays, just untextured.
    const grab = async (path: string) => (ctx.assets.has(path) ? await ctx.assets.get(path) : null);
    const [trackTex, facadeTex, trainTex, barrierTex, beamTex, pavementTex, hoardingTex] = await Promise.all([
      grab("textures/track.webp"),
      grab("textures/facade.webp"),
      grab("textures/train.webp"),
      grab("textures/barrier.webp"),
      grab("textures/beam.webp"),
      grab("textures/pavement.webp"),
      grab("textures/hoarding.webp"),
    ]);
    // The 3D kit. Loaded before the scene is built because both the street and
    // the obstacles are made of it; a pack without models still runs on the
    // simple shapes.
    const models = await loadTracklineModels(ctx.assets, this.scene, TRAIN_LENGTH, ROOF_HEIGHT);
    this.world = new World(this.scene, trackTex, facadeTex, models, pavementTex);
    this.props = new Props(this.scene, this.course, { train: trainTex, barrier: barrierTex, beam: beamTex, hoarding: hoardingTex }, models);
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
    this.baseScale = ctx.engine.getHardwareScalingLevel();
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
      onRoof: onRoof(s.sim.state),
      inside: s.sim.state.insideEndZ > 0 && s.sim.state.distance < s.sim.state.insideEndZ,
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
      // The row just BEHIND matters as much as the one ahead: a carriage is 8 m
      // long, so its flank is still beside you while you set up for the next
      // row, and sliding into it is fatal.
      passed: (() => {
        const i = Course.indexAt(me.distance);
        if (i < 0) return null;
        const r = this.course.rowAt(i);
        return { z: r.z, obstacles: r.obstacles.map((o) => ({ lane: o.lane, kind: o.kind, train: o.train ?? null, endZ: o.z + o.length })) };
      })(),
      upcoming: {
        z: row.z,
        ahead: Number((row.z - me.distance).toFixed(2)),
        safeLane: row.safeLane,
        obstacles: row.obstacles.map((o) => ({ lane: o.lane, kind: o.kind, train: o.train ?? null })),
      },
      scene: {
        meshes: this.scene.meshes.length,
        particleSystems: this.scene.particleSystems.length,
        activeMeshes: this.scene.getActiveMeshes().length,
        hardwareScale: Number(this.scene.getEngine().getHardwareScalingLevel().toFixed(2)),
      },
      // Where the scenery trains are relative to the runner — the only way a
      // headless harness can tell "a train went past" from "no train exists".
      world: this.world?.debug() ?? null,
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
    // Hand the lobby back the resolution it chose.
    this.scene.getEngine().setHardwareScalingLevel(this.baseScale);
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
    this.guardFrameRate(dt);
    if (this.startAt !== null && !this.ended) this.stepToNow();
    this.placeAll(dt);
    this.scene.render();
  }

  /** Keep the frame inside its budget by trading resolution for it.
   *
   *  A runner may not stutter: the whole game is reacting to something 6 m
   *  ahead. So rather than let a slow device drop frames, the internal
   *  resolution steps down until the frame fits, and climbs back when there is
   *  headroom. Judged on a two-second average, because reacting to single
   *  slow frames would make the picture pulse.
   *
   *  The simulation is untouched by any of this — it is fixed-step and driven
   *  by the clock, so a device rendering at 0.7 scale still runs exactly the
   *  same match as everyone else. */
  private guardFrameRate(dt: number): void {
    this.frameAccum += dt;
    this.frameCount += 1;
    if (this.frameAccum < 2) return;
    const avgMs = (this.frameAccum / this.frameCount) * 1000;
    this.frameAccum = 0;
    this.frameCount = 0;
    const engine = this.scene.getEngine();
    const scale = engine.getHardwareScalingLevel();
    if (avgMs > 18 && scale < MAX_HARDWARE_SCALE) {
      engine.setHardwareScalingLevel(Math.min(MAX_HARDWARE_SCALE, scale * 1.12));
    } else if (avgMs < 13 && scale > this.baseScale) {
      engine.setHardwareScalingLevel(Math.max(this.baseScale, scale / 1.08));
    }
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
    this.world?.follow(z, dt);
    this.props?.update(z, dt);
    if (this.streetLight) this.streetLight.position.set(x * 0.4, 10, z + 20);
    this.camX += (x - this.camX) * 0.12;
    const base = onRoof(ws) ? ROOF_HEIGHT : 0;
    const wantY = CAM_UP + base + (ws.y - base) * 0.35;
    this.camY += (wantY - this.camY) * Math.min(1, dt * 6);
    this.camera.position.set(this.camX * 0.6, this.camY, z - CAM_BACK);
    this.lookAt.set(this.camX * 0.6, this.camY - CAM_UP + CAM_LOOK_UP + (ws.y - base) * 0.4, z + CAM_LOOK_AHEAD);
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
