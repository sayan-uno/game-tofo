// The Trackline runner simulation — deterministic, fixed-step, shared.
//
// One instance per runner. The same input log produces the same state on every
// client and on the server, which IS the netcode: only inputs travel, everyone
// replays. The rules that keep that true:
//
//  - Never read the wall clock, Math.random, or anything outside `state`, the
//    inputs and the seeded course. Determinism is the contract.
//  - Plain arithmetic in a fixed order. No transcendental functions, so two
//    engines cannot disagree in the last bit and drift apart over 7,200 ticks.
//  - Inputs are stamped in ticks. An input stamped T is applied at the start of
//    tick T's step, on every device, however late it arrived.
//
// The verbs are the genre's: change lane, jump a low barrier, roll under a
// gantry. Everything else — who crashed, who has how many coins, the final
// score — falls out of these steps, which is why the server can recompute the
// whole match from the input logs alone and never has to trust a client.
import { Course, ROOF_HEIGHT, type Obstacle } from "./course.js";
import { DURATION_TICKS, LANES, LANE_CHANGE_TICKS, TICK_RATE, distanceAt } from "./rules.js";

export type InputKind = "left" | "right" | "jump" | "roll";
export const INPUT_KINDS: readonly InputKind[] = ["left", "right", "jump", "roll"];
export const isInputKind = (k: unknown): k is InputKind => INPUT_KINDS.includes(k as InputKind);

export interface RunnerInput {
  tick: number;
  kind: InputKind;
}

/** ---------------------------------------------------------------------------
 *  Movement constants. Tuned against the speed schedule in rules.ts: at
 *  SPEED_MAX a jump covers ~16 m and a roll ~13 m, both comfortably shorter
 *  than ROW_SPACING, so neither verb can carry you blindly through the NEXT
 *  row before you can react to it.
 * ------------------------------------------------------------------------- */
export const JUMP_TICKS = 45; // 0.75 s airborne
export const JUMP_HEIGHT = 1.7; // metres at the apex
export const ROLL_TICKS = 36; // 0.6 s low

/** Clears a low barrier while the runner is above this. */
const LOW_CLEAR_Y = 0.55;

/** How close to an obstacle's centre, in LANE UNITS, counts as touching it:
 *  inside HIT_HALF is a direct hit, the band out to GRAZE_HALF is a graze.
 *
 *  GRAZE_HALF must not exceed HALF A LANE. Anything wider makes an obstacle
 *  bleed into the lanes either side of it, so a runner that has just passed a
 *  row and starts moving to the next safe lane clips the barrier standing
 *  beside it — the solvability check found exactly that, on nearly every seed,
 *  with the 0.62 this used to be. Half a lane reads as "you are clear once
 *  your centre is out of its half of the track", which is also what a player
 *  sees. */
const HIT_HALF = 0.3;
const GRAZE_HALF = 0.5;
/** A second graze within this many ticks is a crash rather than a stumble. */
const STUMBLE_WINDOW = 2 * TICK_RATE;

export interface RunnerState {
  tick: number;
  /** Lane the runner is heading to (0 = leftmost). */
  lane: number;
  /** Lateral position in LANE UNITS (fractional mid-change). */
  x: number;
  /** Height above the track, metres. 0 while grounded. */
  y: number;
  /** Ticks left of the jump arc; 0 when grounded. */
  airborne: number;
  /** Ticks left of the roll; 0 when upright. */
  rolling: number;
  /** Metres run since tick 0. Frozen at the moment of death. */
  distance: number;
  alive: boolean;
  /** Tick the runner crashed on, or -1. Ranks the dead against each other. */
  deadAtTick: number;
  coins: number;
  /** Obstacles cleared by a jump or a roll — the risky way past. */
  nearMisses: number;
  /** Tick of the last graze, or -1. */
  stumbledAtTick: number;
  /** While riding a carriage roof: the distance at which that roof ends.
   *  -1 when on the ground. Up there the runner is above every ground
   *  obstacle, which is the whole reward for taking the ramp. */
  roofEndZ: number;
  /** While running through the inside of an open carriage: where it ends. */
  insideEndZ: number;
}

/** Runners start spread across the middle lanes rather than stacked. */
export function startLane(seat: number): number {
  const order = [1, 2, 0, 3];
  return order[seat % order.length];
}

export function createState(seat: number): RunnerState {
  const lane = startLane(seat);
  return {
    tick: 0,
    lane,
    x: lane,
    y: 0,
    airborne: 0,
    rolling: 0,
    distance: 0,
    alive: true,
    deadAtTick: -1,
    coins: 0,
    nearMisses: 0,
    stumbledAtTick: -1,
    roofEndZ: -1,
    insideEndZ: -1,
  };
}

/** Lateral speed in lane units per tick — a full lane in LANE_CHANGE_TICKS. */
const X_STEP = 1 / LANE_CHANGE_TICKS;

/** Height of the jump arc at `t` ticks into it. A parabola through 0 at both
 *  ends: cheap, exact, and it peaks in the middle where the barrier is. */
function arc(ticksLeft: number): number {
  const t = 1 - ticksLeft / JUMP_TICKS;
  return 4 * JUMP_HEIGHT * t * (1 - t);
}

/** Apply one input AT its tick. Impossible inputs are ignored the same way on
 *  every device, so a modified client that spams "left" at lane 0 changes
 *  nothing anywhere — the server replays the same no-op. */
export function applyInput(s: RunnerState, kind: InputKind): void {
  if (!s.alive) return;
  switch (kind) {
    case "left":
      if (s.lane > 0) s.lane -= 1;
      return;
    case "right":
      if (s.lane < LANES - 1) s.lane += 1;
      return;
    case "jump":
      // No double jumps; a roll can be cut short by jumping out of it.
      if (s.airborne === 0) {
        s.airborne = JUMP_TICKS;
        s.rolling = 0;
      }
      return;
    case "roll":
      // Rolling in mid-air drops you straight down — the way to duck a gantry
      // you jumped at by mistake, and how a good player recovers.
      s.airborne = 0;
      s.y = 0;
      s.rolling = ROLL_TICKS;
      return;
  }
}

/** Is the runner up on a carriage roof at this distance? */
export const onRoof = (s: RunnerState): boolean => s.roofEndZ > 0 && s.distance < s.roofEndZ;
/** Is the runner inside an open carriage? */
export const inside = (s: RunnerState): boolean => s.insideEndZ > 0 && s.distance < s.insideEndZ;

/** Can this state pass this obstacle? */
function clears(s: RunnerState, o: Obstacle): boolean {
  switch (o.kind) {
    case "low":
      return s.y > LOW_CLEAR_Y;
    case "high":
      // Only a roll. Being airborne is worse than doing nothing.
      return s.rolling > 0 && s.airborne === 0;
    case "full":
      return false;
    case "train":
      // A carriage taken head-on at its back end may be climbable or
      // run-through-able; those are handled in step(), because they change
      // the runner's state rather than merely letting them past.
      return false;
  }
}

/** Kill a runner. Idempotent, so a tick that finds two collisions still reads
 *  as one death at one tick. */
function kill(s: RunnerState, tick: number): void {
  if (!s.alive) return;
  s.alive = false;
  s.deadAtTick = tick;
  s.airborne = 0;
  s.rolling = 0;
  s.y = 0;
}

/** Advance exactly one tick. */
export function step(s: RunnerState, course: Course, durationTicks: number = DURATION_TICKS): void {
  s.tick += 1;
  if (!s.alive) return;

  // Lateral: slide towards the target lane, snapping when within a step.
  const dx = s.lane - s.x;
  if (dx > X_STEP) s.x += X_STEP;
  else if (dx < -X_STEP) s.x -= X_STEP;
  else s.x = s.lane;

  // Vertical.
  if (s.airborne > 0) {
    s.airborne -= 1;
    s.y = s.airborne > 0 ? arc(s.airborne) : 0;
  }
  if (s.rolling > 0) s.rolling -= 1;

  const from = s.distance;
  const to = distanceAt(s.tick / TICK_RATE);
  s.distance = to;
  // The clock is a PARAMETER, not a constant, so the match length can be
  // raised on the server without shipping a new client — the server sends it
  // in MatchPrepare.rules and both sides step with the same number. Defaulting
  // to the shared constant keeps every existing caller correct.
  if (s.tick >= durationTicks) return; // the clock ran out; nothing more counts

  // Riding a roof, or through a carriage: both end where the carriage does.
  const wasOnRoof = s.roofEndZ > 0 && from < s.roofEndZ;
  const wasInside = s.insideEndZ > 0 && from < s.insideEndZ;
  if (s.roofEndZ > 0 && to >= s.roofEndZ) s.roofEndZ = -1;
  if (s.insideEndZ > 0 && to >= s.insideEndZ) s.insideEndZ = -1;
  const riding = onRoof(s);
  const through = inside(s);
  // Height: the roof carries the runner; a jump adds to it.
  const base = riding ? ROOF_HEIGHT : 0;
  s.y = base + (s.airborne > 0 ? arc(s.airborne) : 0);
  if (wasOnRoof && !riding) {
    // Ran off the end — back to the track, and the drop cancels a jump so a
    // runner cannot glide off a carriage.
    s.airborne = 0;
    s.y = 0;
  }
  // On a roof or inside a carriage, nothing on the track can reach you.
  if (riding || through) {
    for (const c of course.coinsBetween(from, to)) {
      const wantLevel = riding ? 1 : 0;
      if (c.level === wantLevel && Math.abs(s.x - c.lane) <= 0.55) s.coins += 1;
    }
    return;
  }
  // The tick you come OFF the far end is special: the position you started it
  // at is still inside the carriage, so the ordinary collision pass reads it
  // as sliding into the train's flank and kills you for finishing the move it
  // just rewarded. Collisions are skipped for this one tick — the carriage
  // ends well before the next row, so there is nothing else here to hit.
  if (wasOnRoof || wasInside) {
    for (const c of course.coinsBetween(from, to)) {
      if (c.level === 0 && Math.abs(s.x - c.lane) <= 0.55) s.coins += 1;
    }
    return;
  }

  // Collisions. Entering an obstacle decides life or death; leaving one you
  // cleared is what pays the near-miss, so both edges are checked.
  for (const o of course.obstaclesBetween(from, to)) {
    const gap = Math.abs(s.x - o.lane);
    if (gap > GRAZE_HALF) continue;
    const entering = from <= o.z && to > o.z;
    const alongside = from > o.z && from < o.z + o.length;
    // A carriage met head-on at its back end, dead centre of the lane, on the
    // ground: climb it or run through it. Anything else about a train — a
    // side entry, or clipping its corner — is what it always was.
    // Mounting or entering is as forgiving as the lane itself (GRAZE_HALF,
    // not HIT_HALF): if you met the back of the carriage at all, you took it.
    // Requiring dead centre meant a runner who swerved in a shade late hit the
    // very ramp they were aiming at, which reads as the game refusing a move
    // it had just invited. Side entry stays fatal — that is the real gate.
    if (o.kind === "train" && entering && gap <= GRAZE_HALF && s.airborne === 0 && o.train && o.train !== "solid") {
      if (o.train === "ramp") s.roofEndZ = o.z + o.length;
      else s.insideEndZ = o.z + o.length;
      s.nearMisses += 1; // taking the line through a train is worth something
      continue;
    }
    if ((entering || alongside) && !clears(s, o)) {
      if (gap <= HIT_HALF) {
        kill(s, s.tick);
        return;
      }
      // A graze: survivable once. Twice inside STUMBLE_WINDOW is a crash —
      // clipping your way down the track is not a strategy.
      if (s.stumbledAtTick >= 0 && s.tick - s.stumbledAtTick < STUMBLE_WINDOW) {
        kill(s, s.tick);
        return;
      }
      s.stumbledAtTick = s.tick;
    }
    // Cleared it and just came out the far side.
    const end = o.z + o.length;
    if (from < end && to >= end && clears(s, o) && gap <= HIT_HALF) s.nearMisses += 1;
  }

  for (const c of course.coinsBetween(from, to)) {
    if (c.level === 0 && Math.abs(s.x - c.lane) <= 0.55) s.coins += 1;
  }
}

/** Points. Coins are the reward for taking the line, near-misses the reward for
 *  using the verbs, distance the floor everyone shares — computed here so the
 *  server's replay and the client's live HUD can never disagree. */
export function scoreOf(s: RunnerState): number {
  return Math.floor(s.distance) + s.coins * 10 + s.nearMisses * 25;
}

/** Run a fresh state through an input log up to `toTick`. Cheap enough to redo
 *  whole (a full match is 7,200 trivial steps), which is what makes late and
 *  out-of-order inputs a non-event: rewind by replaying. */
export function replay(
  seat: number,
  inputs: readonly RunnerInput[],
  toTick: number,
  course: Course,
  durationTicks: number = DURATION_TICKS
): RunnerState {
  const s = createState(seat);
  const sorted = [...inputs].sort((a, b) => a.tick - b.tick);
  let i = 0;
  while (s.tick < toTick) {
    const next = s.tick + 1;
    while (i < sorted.length && sorted[i].tick <= next) {
      applyInput(s, sorted[i].kind);
      i++;
    }
    step(s, course, durationTicks);
  }
  return s;
}

/** ---------------------------------------------------------------------------
 *  RunnerSim — one runner's state, its input log, and the bookkeeping that
 *  keeps stepping cheap.
 *
 *  Shared by the client (which draws it) and the server (which judges it) on
 *  purpose: an incremental fast path here and a replay there is exactly how
 *  the two would drift apart, so there is one implementation of both.
 * ------------------------------------------------------------------------- */
export class RunnerSim {
  state: RunnerState;
  private log: RunnerInput[] = [];
  /** Index of the next input not yet applied on the incremental path. */
  private cursor = 0;
  /** An input arrived for a tick already simulated — rebuild before trusting. */
  private dirty = false;

  constructor(
    readonly seat: number,
    private course: Course,
    /** Match length in ticks. Comes from the server so the clock can be raised
     *  without a client release; both sides must use the SAME number or the
     *  two simulations stop agreeing about when scoring ends. */
    private durationTicks: number = DURATION_TICKS
  ) {
    this.state = createState(seat);
  }

  get inputs(): readonly RunnerInput[] {
    return this.log;
  }

  /** Record an input. Out-of-order or already-past inputs mark the sim dirty
   *  rather than being dropped: the rewind happens on the next advance. */
  addInput(input: RunnerInput): void {
    const last = this.log.length ? this.log[this.log.length - 1] : null;
    if (input.tick <= this.state.tick || (last && input.tick < last.tick)) this.dirty = true;
    this.log.push(input);
  }

  /** Bring the sim to `tick`. Incremental when it can be, a full replay when
   *  the log changed behind the current position or the gap is large. */
  advanceTo(tick: number): void {
    if (this.state.tick >= tick && !this.dirty) return;
    if (this.dirty || tick - this.state.tick > 3 * TICK_RATE) {
      this.log.sort((a, b) => a.tick - b.tick);
      this.state = replay(this.seat, this.log, tick, this.course, this.durationTicks);
      const at = this.log.findIndex((i) => i.tick > tick);
      this.cursor = at < 0 ? this.log.length : at;
      this.dirty = false;
      return;
    }
    const s = this.state;
    while (s.tick < tick) {
      const next = s.tick + 1;
      while (this.cursor < this.log.length && this.log[this.cursor].tick <= next) {
        applyInput(s, this.log[this.cursor].kind);
        this.cursor++;
      }
      step(s, this.course, this.durationTicks);
    }
  }

  /** Apply an input the local player just made, at the next tick, and record
   *  it — prediction and log stay one operation so they cannot disagree. */
  predict(kind: InputKind): RunnerInput {
    const input: RunnerInput = { tick: this.state.tick + 1, kind };
    applyInput(this.state, kind);
    this.log.push(input);
    this.cursor = this.log.length;
    return input;
  }
}
