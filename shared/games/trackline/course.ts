// The course: what stands on the track, derived entirely from the match seed.
//
// Every client and the server build the SAME course from the same seed, so
// nothing about the world is ever sent over the wire — only inputs are. That
// only holds if generation is perfectly deterministic, which is why this file
// uses integer hashing rather than a stateful PRNG, never reads a clock, and
// never branches on anything outside (seed, row index).
//
// SHAPE
// The track is a sequence of ROWS, one every ROW_SPACING metres. A row picks
// one SAFE lane that is guaranteed clear, and may put an obstacle in each of
// the others. Coins are strung between rows along the next row's safe lane, so
// following the coins is also the line that survives — the oldest teaching
// trick in the genre, and it falls out of the layout for free.
//
// SOLVABILITY is structural, not hoped for:
//   * every row has at least one empty lane;
//   * consecutive safe lanes differ by at most one, so the safe line is always
//     reachable with a single lane change;
//   * rows are spaced far enough apart that a lane change (LANE_CHANGE_TICKS)
//     always completes between them, even at SPEED_MAX;
//   * the next safe lane never holds a TRAIN from the previous row. A train is
//     long enough to still be beside you as you move across, so without this
//     the safe line walks you into the side of one — which is exactly what the
//     solvability check caught on every seed it tried.
// `verifyCourse` in the test script checks the last two by simulation.
import { EMPTY_START_METRES, LANES } from "./rules.js";

/** Metres between obstacle rows. At SPEED_MAX (22 m/s) that is 0.68 s of
 *  travel, comfortably more than a 0.18 s lane change. */
export const ROW_SPACING = 15;

/** How long a train carriage is. Kept under ROW_SPACING so a train can never
 *  reach into the next row and turn a solvable pattern into a wall. */
export const TRAIN_LENGTH = 8;

/** How deep a barrier is along the track — a real jersey barrier or gantry
 *  beam, not a metre-thick slab. It matters more than it looks: an obstacle
 *  stays dangerous while the runner is inside its depth, so a deep one is
 *  still beside you as you move off after passing the row, and turns an
 *  ordinary lane change into a graze. */
export const BARRIER_DEPTH = 0.6;

/** Obstacle kinds, and what gets you past each one:
 *   low   — a knee-high barrier: JUMP it (or go round)
 *   high  — an overhead gantry: ROLL under it (jumping into it is a crash)
 *   full  — floor to ceiling: only a lane change gets you past
 *   train — a carriage; what it offers depends on its TrainKind below
 */
export type ObstacleKind = "low" | "high" | "full" | "train";

/** What a carriage offers a runner who reaches its BACK END head-on:
 *
 *   solid — nothing. It is a wall on rails.
 *   ramp  — a sloped rear you run up onto the ROOF and along it. Up there no
 *           ground obstacle can touch you, but the carriage ends and you come
 *           down, so it is a corridor and not a hiding place.
 *   open  — doors at both ends and a clear aisle: run straight through.
 *
 * Reaching one from the SIDE — sliding into it mid-length — is a crash
 * whatever kind it is. That is what stops "aim at any train" being a free
 * escape, and keeps a late swerve genuinely dangerous. */
export type TrainKind = "solid" | "ramp" | "open";

/** Height of a carriage roof, in metres. Shared with the renderer so the thing
 *  you run along is exactly the thing you see. */
export const ROOF_HEIGHT = 3.2;

export interface Obstacle {
  lane: number;
  kind: ObstacleKind;
  /** Where it starts, in metres from the start line. */
  z: number;
  /** How far it extends along the track. */
  length: number;
  /** Only on `train`. */
  train?: TrainKind;
}

export interface Coin {
  lane: number;
  z: number;
  /** 0 = on the track, 1 = on a carriage roof. A roof coin can only be taken
   *  by a runner who is actually up there, which is what makes taking a ramp
   *  worth doing rather than merely surviving it. */
  level: 0 | 1;
}

export interface Row {
  index: number;
  z: number;
  /** Always free of obstacles. */
  safeLane: number;
  obstacles: Obstacle[];
  /** Coins leading from this row towards the next one's safe lane. */
  coins: Coin[];
}

/** ---------------------------------------------------------------------------
 *  Hashing
 *
 *  A pure integer hash of (seed, row, slot) rather than a running PRNG: any row
 *  can be generated on its own, in any order, on any device, and the answer is
 *  identical. All arithmetic is via Math.imul and >>> 0, which are exact on
 *  32-bit integers in every JS engine — plain `*` would lose bits to doubles
 *  and could differ between engines.
 * ------------------------------------------------------------------------- */
function hash(seed: number, a: number, b: number): number {
  let h = (seed ^ Math.imul(a, 0x9e3779b1) ^ Math.imul(b, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** Hash as a float in [0, 1). */
const rand = (seed: number, a: number, b: number): number => hash(seed, a, b) / 4294967296;

/** How likely a non-safe lane is blocked, by row index: an easy opening that
 *  tightens and then holds, so the first few rows teach and the rest test. */
function blockChance(row: number): number {
  return Math.min(0.42 + row * 0.02, 0.85);
}

/** Obstacle kind for one slot. Weights shift with distance: early rows are
 *  mostly jump/roll (which teach the two verbs), later ones bring in the walls
 *  and trains that force a lane change. */
function kindFor(seed: number, row: number, lane: number): ObstacleKind {
  const r = rand(seed, row * 8 + lane, 0x51ed);
  const hard = Math.min(0.15 + row * 0.012, 0.45); // share of full/train
  if (r < hard * 0.72) return "full";
  if (r < hard) return "train";
  return rand(seed, row * 8 + lane, 0x9e17) < 0.6 ? "low" : "high";
}

/** Which sort of carriage. Most are solid — a ramp or an open car is a chance,
 *  and a chance you get every time stops being one. */
function trainKindFor(seed: number, row: number, lane: number): TrainKind {
  const r = rand(seed, row * 16 + lane, 0x3b7a);
  if (r < 0.28) return "ramp";
  if (r < 0.48) return "open";
  return "solid";
}

export class Course {
  /** Rows built so far, dense from index 0 — see rowAt. */
  private rows: Row[] = [];

  constructor(readonly seed: number) {}

  /** Distance at which row `index` stands. */
  static zOf(index: number): number {
    return EMPTY_START_METRES + index * ROW_SPACING;
  }

  /** Row index at or before a distance (negative before the first row). */
  static indexAt(z: number): number {
    return Math.floor((z - EMPTY_START_METRES) / ROW_SPACING);
  }

  /** The safe lane of a row. Walks from row 0 so consecutive rows never differ
   *  by more than one lane — the property that makes the course solvable — and
   *  caches, so the walk is paid once however often it is asked for. */
  private safeLane(index: number): number {
    return this.rowAt(index).safeLane;
  }

  /** Build (or fetch) a row. Rows are built in order because the safe-lane walk
   *  depends on the previous one; everything else about a row depends only on
   *  (seed, index), so a row is identical however it was reached. */
  rowAt(index: number): Row {
    if (index < 0) throw new Error(`row ${index} is before the start`);
    for (let i = this.rows.length; i <= index; i++) {
      const prev = i === 0 ? hash(this.seed, 0, 0x5a1e) % LANES : this.rows[i - 1].safeLane;
      // Step at most one lane, and never off the track.
      let safe = prev;
      const move = rand(this.seed, i, 0x1d3f);
      if (move < 0.34) safe = prev - 1;
      else if (move < 0.68) safe = prev + 1;
      if (safe < 0) safe = 1;
      if (safe > LANES - 1) safe = LANES - 2;
      // A train in the PREVIOUS row is still alongside while the runner slides
      // across into this row's safe lane, so that lane must be clear of one.
      // Falling back to the previous safe lane is always valid: it carried no
      // obstacle at all, so it cannot carry a train either.
      if (i > 0 && this.rows[i - 1].obstacles.some((o) => o.kind === "train" && o.lane === safe)) {
        safe = prev;
      }

      const z = Course.zOf(i);
      const obstacles: Obstacle[] = [];
      for (let lane = 0; lane < LANES; lane++) {
        if (lane === safe) continue;
        if (rand(this.seed, i * 4 + lane, 0x2f9d) > blockChance(i)) continue;
        const kind = kindFor(this.seed, i, lane);
        const obstacle: Obstacle = { lane, kind, z, length: kind === "train" ? TRAIN_LENGTH : BARRIER_DEPTH };
        if (kind === "train") obstacle.train = trainKindFor(this.seed, i, lane);
        obstacles.push(obstacle);
      }
      this.rows.push({ index: i, z, safeLane: safe, obstacles, coins: [] });
    }
    return this.rows[index];
  }

  /** Coins for a row: a short line running from this row's safe lane towards
   *  the next one's, laid in the gap between them. Built lazily and separately
   *  from the row itself because it needs the NEXT row's safe lane, and asking
   *  for that inside rowAt would recurse. */
  coinsOf(index: number): Coin[] {
    const row = this.rowAt(index);
    if (row.coins.length > 0) return row.coins;
    // Not every gap carries coins — a track paved end to end stops reading as a
    // reward and starts reading as decoration.
    if (rand(this.seed, index, 0x77c1) < 0.35) return row.coins;
    const next = this.safeLane(index + 1);
    const count = 5;
    for (let i = 0; i < count; i++) {
      const t = (i + 1) / (count + 1);
      // Slide across to the next safe lane so the line is also the racing line.
      const lane = Math.round(row.safeLane + (next - row.safeLane) * t);
      row.coins.push({ lane, z: row.z + ROW_SPACING * t, level: 0 });
    }
    // A ramp carriage pays for the climb: coins along its roof, out of reach
    // of anyone still running on the track.
    for (const o of row.obstacles) {
      if (o.kind !== "train" || o.train !== "ramp") continue;
      for (let i = 0; i < 4; i++) {
        row.coins.push({ lane: o.lane, z: o.z + o.length * (0.3 + i * 0.18), level: 1 });
      }
    }
    return row.coins;
  }

  /** Every obstacle overlapping the distance range (z0, z1]. Used by the sim
   *  per tick, so it walks only the two or three rows that can possibly be in
   *  range rather than scanning the course. */
  obstaclesBetween(z0: number, z1: number): Obstacle[] {
    const out: Obstacle[] = [];
    // A train starting a row earlier can still reach into this range.
    const first = Math.max(0, Course.indexAt(z0 - TRAIN_LENGTH));
    const last = Course.indexAt(z1);
    for (let i = first; i <= last; i++) {
      if (i < 0) continue;
      for (const o of this.rowAt(i).obstacles) {
        if (o.z <= z1 && o.z + o.length >= z0) out.push(o);
      }
    }
    return out;
  }

  /** Every coin whose position falls in (z0, z1]. */
  coinsBetween(z0: number, z1: number): Coin[] {
    const out: Coin[] = [];
    const first = Math.max(0, Course.indexAt(z0) - 1);
    const last = Course.indexAt(z1);
    for (let i = first; i <= last; i++) {
      if (i < 0) continue;
      for (const c of this.coinsOf(i)) {
        if (c.z > z0 && c.z <= z1) out.push(c);
      }
    }
    return out;
  }
}
