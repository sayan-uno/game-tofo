// The nineteen people you did not bring with you.
//
// A social island is empty at one person and awkward at three, so every seat a
// real player is not standing in is held by somebody from the server
// population — and they have to LOOK like they are there: walking somewhere,
// stopping, looking around, walking somewhere else.
//
// The obvious way to do that is to simulate them on the server and broadcast
// their positions. That is also the expensive way: nineteen more bodies in
// every snapshot, ten times a second, for forty minutes, for every island on
// the platform, to say things nobody can disagree about.
//
// So they are not broadcast at all. A bot's whole life is a pure function of
// (island seed, bot uid, milliseconds since the island opened), and every
// client — and the server, and the admin console's map — computes the same
// walk from the same three numbers. It costs the wire nothing and the server
// nothing, and it cannot desynchronise, because there is no state to sync.
//
// The one thing that has to be got right for that to hold is the ROUTE. A bot
// walking from an arbitrary point to another arbitrary point walks through a
// tree; so bots do not walk to arbitrary points. They walk a GRAPH whose every
// edge has been checked clear of every prop, built once from the island
// itself. See buildGraph.
import { isClear, PLAZA_R, RING_R, AVENUE_OUT, BEACH_IN } from "./map.js";
import { ANIM_IDLE, ANIM_RUN, ANIM_WALK, type Pose } from "./net.js";
import { RUN_SPEED, WALK_SPEED } from "./rules.js";

const TAU = Math.PI * 2;

interface Node {
  x: number;
  z: number;
  adj: number[];
}

/** Is every part of this segment clear of props and inside the island?
 *
 *  Sampled every 40 cm with a 30 cm pad — deliberately FINER and WIDER than
 *  the self-check that verifies the finished graph, so the builder can never
 *  accept an edge the check then fails. Getting that relationship the wrong
 *  way round cost a run: the builder sampled every metre and let through a leg
 *  that passes a lamp post at 79 cm. */
function legClear(ax: number, az: number, bx: number, bz: number): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  const steps = Math.max(2, Math.ceil(len / 0.4));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!isClear(ax + dx * t, az + dz * t, 0.3)) return false;
  }
  return true;
}

function buildGraph(): Node[] {
  const nodes: Node[] = [];
  const add = (x: number, z: number): number => {
    nodes.push({ x, z, adj: [] });
    return nodes.length - 1;
  };
  const link = (a: number, b: number): void => {
    if (a === b) return;
    if (!legClear(nodes[a].x, nodes[a].z, nodes[b].x, nodes[b].z)) return;
    if (!nodes[a].adj.includes(b)) nodes[a].adj.push(b);
    if (!nodes[b].adj.includes(a)) nodes[b].adj.push(a);
  };

  // The plaza rim: eight nodes, four of them exactly on the avenues.
  const plaza: number[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    plaza.push(add(Math.cos(a) * (PLAZA_R - 3.6), Math.sin(a) * (PLAZA_R - 3.6)));
  }
  for (let i = 0; i < 8; i++) link(plaza[i], plaza[(i + 1) % 8]);

  // A loop right round the fountain, so somebody can be standing at it.
  const rim: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.4;
    rim.push(add(Math.cos(a) * 5.4, Math.sin(a) * 5.4));
  }
  for (let i = 0; i < 6; i++) link(rim[i], rim[(i + 1) % 6]);
  for (let i = 0; i < 6; i++) link(rim[i], plaza[Math.round((i * 8) / 6) % 8]);

  // The ring path.
  const ring: number[] = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    ring.push(add(Math.cos(a) * RING_R, Math.sin(a) * RING_R));
  }
  for (let i = 0; i < 24; i++) link(ring[i], ring[(i + 1) % 24]);

  // Four avenues, each joining its plaza node to its ring node and running on
  // to the sand. Indices 0/2/4/6 of the plaza ring and 0/6/12/18 of the path
  // ring already sit on the axes, so they are reused rather than duplicated.
  const dirs: [number, number][] = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  const beachHeads: number[] = [];
  dirs.forEach(([dx, dz], k) => {
    let prev = plaza[k * 2];
    for (const r of [20, 26, RING_R, 42, 50, 58, AVENUE_OUT - 2]) {
      const here = r === RING_R ? ring[k * 6] : add(dx * r, dz * r);
      link(prev, here);
      prev = here;
    }
    beachHeads.push(prev);
  });

  // The sand: a loose arc off the end of each avenue, so the beach is somewhere
  // to walk rather than a wall you turn round at.
  dirs.forEach(([dx, dz], k) => {
    const base = Math.atan2(dz, dx);
    for (const off of [-0.34, -0.17, 0.17, 0.34]) {
      const a = base + off;
      const r = BEACH_IN + 7;
      const n = add(Math.cos(a) * r, Math.sin(a) * r);
      link(beachHeads[k], n);
    }
  });

  // The landmarks worth standing at. Each is attached to whichever existing
  // node it can actually be reached from; one that cannot is simply left out,
  // which is why a prop moving can never strand a bot inside a bush.
  const spots: [number, number][] = [
    [-30, 30], // under the bandstand
    [37, -19], // by the statue
    [21, 8], // in front of the east stall
    [-22, -8], // in front of the west stall
    [-38, 12],
    [40, 26],
    [12, -44],
    [-14, 46],
    [48, -6],
    [-48, 4],
  ];
  for (const [sx, sz] of spots) {
    if (!isClear(sx, sz, 0.5)) continue;
    // Nearest three nodes, so a landmark is a place you pass THROUGH.
    const near = nodes
      .map((n, i) => ({ i, d: (n.x - sx) ** 2 + (n.z - sz) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    const id = add(sx, sz);
    for (const n of near) link(id, n.i);
    if (nodes[id].adj.length === 0) nodes.pop(); // unreachable — forget it
  }

  // Anything the walk cannot reach from the plaza is dead weight and, worse, a
  // place a bot could be spawned into and never leave.
  const seen = new Set<number>([plaza[0]]);
  const queue = [plaza[0]];
  while (queue.length) {
    for (const n of nodes[queue.pop()!].adj) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  if (seen.size === nodes.length) return nodes;
  const keep = [...seen].sort((a, b) => a - b);
  const remap = new Map(keep.map((old, i) => [old, i]));
  return keep.map((old) => ({
    x: nodes[old].x,
    z: nodes[old].z,
    adj: nodes[old].adj.filter((a) => remap.has(a)).map((a) => remap.get(a)!),
  }));
}

let graph: Node[] | null = null;
/** The walkable graph. Exported so the self-check can assert every edge is
 *  clear and every node reachable — the two properties bots depend on. */
export const walkGraph = (): Node[] => (graph ??= buildGraph());

/** A stable number for a uid, so a bot's walk follows the ACCOUNT rather than
 *  the seat it happens to be sitting in — seats are handed round as people
 *  arrive and leave, and a bot that teleported every time somebody else left
 *  would be the one tell nothing else gives away. */
export function keyOf(uid: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < uid.length; i++) {
    h ^= uid.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One bot's walk, computed forward from the moment the island opened.
 *
 *  Stateful only as an optimisation: `poseAt` is always asked for a time at or
 *  after the last one, so the walk is advanced rather than recomputed. Asking
 *  for an earlier time rebuilds from zero, which is what a player joining an
 *  island that has been running for half an hour does exactly once. */
export class Wanderer {
  private rnd: () => number;
  private node = 0;
  private prev = -1;
  private legFrom = { x: 0, z: 0 };
  private legTo = { x: 0, z: 0 };
  private legStart = 0;
  private legEnd = 0;
  private paused = true;
  private running = 0;
  private ry = 0;
  private readonly pose: Pose = { x: 0, z: 0, ry: 0, anim: ANIM_IDLE };

  constructor(
    private readonly seed: number,
    private readonly key: number
  ) {
    this.rnd = mulberry32((seed ^ key) >>> 0);
    this.reset();
  }

  private reset(): void {
    const g = walkGraph();
    this.rnd = mulberry32((this.seed ^ this.key) >>> 0);
    // Everybody starts near the middle, like everybody else on the island, and
    // spreads out over the first few minutes by walking.
    const start = Math.floor(this.rnd() * Math.min(14, g.length));
    this.node = start;
    this.prev = -1;
    this.legFrom = { x: g[start].x, z: g[start].z };
    this.legTo = { ...this.legFrom };
    this.legStart = 0;
    this.legEnd = 400 + this.rnd() * 2600;
    this.paused = true;
    this.running = 0;
    this.ry = this.rnd() * TAU;
  }

  private advance(): void {
    const g = walkGraph();
    if (this.paused) {
      // Choose somewhere to go. Never straight back the way we came unless
      // there is nowhere else — a bot pacing between two nodes reads as broken.
      const adj = g[this.node].adj;
      const options = adj.length > 1 ? adj.filter((n) => n !== this.prev) : adj;
      const next = options[Math.floor(this.rnd() * options.length)] ?? this.node;
      if (this.running > 0) this.running--;
      else if (this.rnd() < 0.16) this.running = 1 + Math.floor(this.rnd() * 3);
      const from = g[this.node];
      const to = g[next];
      const dist = Math.hypot(to.x - from.x, to.z - from.z);
      const speed = this.running > 0 ? RUN_SPEED : WALK_SPEED;
      this.legFrom = { x: from.x, z: from.z };
      this.legTo = { x: to.x, z: to.z };
      this.ry = Math.atan2(to.x - from.x, to.z - from.z);
      this.prev = this.node;
      this.node = next;
      this.legStart = this.legEnd;
      this.legEnd = this.legStart + Math.max(220, (dist / speed) * 1000);
      this.paused = false;
    } else {
      // Stop for a moment. Now and then, stop for a good deal longer — that is
      // the difference between a crowd and a procession.
      const roll = this.rnd();
      const ms = roll < 0.1 ? 6000 + this.rnd() * 11000 : roll < 0.55 ? 900 + this.rnd() * 4200 : 120;
      this.legStart = this.legEnd;
      this.legEnd = this.legStart + ms;
      this.legFrom = { ...this.legTo };
      this.paused = true;
    }
  }

  /** Where this bot is at `tMs` after the island opened. Returns a SHARED
   *  object — read it before the next call. */
  poseAt(tMs: number): Pose {
    const t = tMs < 0 ? 0 : tMs;
    if (t < this.legStart) this.reset();
    // Bounded: a client that has been in the background for ten minutes catches
    // up in a few hundred iterations, which is cheaper than the frame it is
    // about to draw.
    for (let guard = 0; t >= this.legEnd && guard < 20000; guard++) this.advance();
    const p = this.pose;
    if (this.paused) {
      p.x = this.legTo.x;
      p.z = this.legTo.z;
      p.anim = ANIM_IDLE;
    } else {
      const k = (t - this.legStart) / Math.max(1, this.legEnd - this.legStart);
      p.x = this.legFrom.x + (this.legTo.x - this.legFrom.x) * k;
      p.z = this.legFrom.z + (this.legTo.z - this.legFrom.z) * k;
      p.anim = this.running > 0 ? ANIM_RUN : ANIM_WALK;
    }
    p.ry = this.ry;
    return p;
  }
}

/** A bot's occasional flourish: a wave, a laugh, something over their head.
 *
 *  Windowed rather than scheduled, so it can be answered for any moment
 *  without keeping a queue: each minute of each bot's life either has one
 *  gesture in it or it does not, decided by a hash. A client shows the gesture
 *  when it first sees a window whose moment has passed, and remembers the
 *  window number so it never shows the same one twice.
 *
 *  Bots use the fixed emoji wheel rather than the 3D emote clips, for a reason
 *  that is about the player and not about the bot: a clip is a download, and a
 *  crowd of nineteen performing dances nobody asked for would spend a phone's
 *  data on scenery. */
export const BUBBLE_WINDOW_MS = 45_000;

export function bubbleWindow(key: number, seed: number, tMs: number): { window: number; at: number; slot: number } | null {
  const w = Math.floor(tMs / BUBBLE_WINDOW_MS);
  if (w < 0) return null;
  let h = (key ^ Math.imul(w + 1, 0x9e3779b1) ^ Math.imul(seed, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  // A gesture in roughly one window in three.
  if (h % 3 !== 0) return null;
  const at = w * BUBBLE_WINDOW_MS + ((h >>> 8) % BUBBLE_WINDOW_MS);
  if (tMs < at) return null;
  return { window: w, at, slot: (h >>> 4) & 7 };
}
