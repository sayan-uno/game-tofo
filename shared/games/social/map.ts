// The island itself.
//
// It is a PLACE, not a course: the same island every session, laid out the
// same way, so that "meet me by the fountain" means something. That is why
// nothing here takes a seed — the layout is a constant, generated once from a
// fixed number and then identical on every device and in the console's map for
// ever.
//
// Three readers, which is why it lives in shared/:
//   the client   draws it, walks on it and stops you walking through a tree;
//   the server   validates where a player claims to be, and walks the bots;
//   the console  draws the same map with everybody's dot on it.
//
// Everything is plain arithmetic over a few hundred props, computed once at
// module load (~0.5 ms) and then read. No allocation on any hot path.

export type PropKind =
  | "tree"
  | "pine"
  | "palm"
  | "bush"
  | "rock"
  | "bench"
  | "lamp"
  | "planter"
  | "picnic"
  | "kiosk"
  | "fountain"
  | "gazebo"
  | "statue"
  | "arch";

/** Draw order is this order, and the client's model table is keyed on it. */
export const PROP_KINDS: readonly PropKind[] = [
  "tree", "pine", "palm", "bush", "rock", "bench", "lamp",
  "planter", "picnic", "kiosk", "fountain", "gazebo", "statue", "arch",
];

// ---------------------------------------------------------------------------
// The shape of the place, in metres
// ---------------------------------------------------------------------------

/** Paved plaza in the middle: the fountain, the arches, where everyone lands. */
export const PLAZA_R = 15;
/** The ring path around the park. */
export const RING_R = 34;
/** How far the four avenues run before they give out on the sand. */
export const AVENUE_OUT = 66;
/** Where grass becomes sand. */
export const BEACH_IN = 62;
/** The hard edge: you cannot walk further out than this. */
export const WALK_R = 78;
/** Where the sand disappears under the sea, for drawing only. */
export const SHORE_R = 84;
/** The ground disc is drawn out to here and is under water past the shore. */
export const GROUND_R = 118;
/** Sea level. */
export const WATER_Y = -1.3;

const PATH_HALF = 2.6;
const RING_HALF = 2.3;
const PLAYER_R = 0.34;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Height
// ---------------------------------------------------------------------------

const smooth01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** A round polynomial hill, 1 at the centre and 0 outside the unit circle.
 *  Polynomial rather than a gaussian: no `exp` on a function the client calls
 *  for every vertex of the ground and once per character per frame. */
const bump = (u: number, v: number): number => {
  const t = 1 - (u * u + v * v);
  return t > 0 ? t * t : 0;
};

/** Ground height at a point. Gentle: a knoll in the north-west, a rise in the
 *  south-east, and a shelf that carries the sand down under the sea. The
 *  plaza is dead flat, because a paved square that undulates looks broken. */
export function heightAt(x: number, z: number): number {
  const d = Math.sqrt(x * x + z * z);
  const hills =
    3.1 * bump((x + 36) / 27, (z - 27) / 27) +
    1.9 * bump((x - 41) / 25, (z + 21) / 25) +
    1.0 * bump((x - 4) / 30, (z + 44) / 23);
  const shelf = 1.9 * smooth01((d - BEACH_IN) / 30);
  return hills * smooth01((d - PLAZA_R) / 12) - shelf;
}

/** What you are standing on — the client blends the three ground textures on
 *  this and the footstep sound picks from it. */
export type Surface = "plaza" | "grass" | "sand";
export function surfaceAt(x: number, z: number): Surface {
  const d = Math.sqrt(x * x + z * z);
  if (d <= PLAZA_R) return "plaza";
  if (d >= BEACH_IN) return "sand";
  return pathDist(x, z) <= 0 ? "plaza" : "grass";
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** How far outside the nearest path you are, in metres. Zero or less means you
 *  are on one. Four axis-aligned avenues out of the plaza plus one ring, so
 *  this is four interval tests and a circle — no trigonometry. */
export function pathDist(x: number, z: number): number {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  const d = Math.sqrt(x * x + z * z);
  let best = Infinity;
  // Avenues: +X, -X, +Z, -Z. Inside the plaza everything is paved anyway.
  if (ax >= PLAZA_R - 1 && ax <= AVENUE_OUT) best = Math.min(best, az - PATH_HALF);
  if (az >= PLAZA_R - 1 && az <= AVENUE_OUT) best = Math.min(best, ax - PATH_HALF);
  best = Math.min(best, Math.abs(d - RING_R) - RING_HALF);
  return best;
}

// ---------------------------------------------------------------------------
// The props
// ---------------------------------------------------------------------------

export interface Prop {
  k: PropKind;
  x: number;
  z: number;
  /** Rotation about Y, radians. */
  ry: number;
  /** Size multiplier on the model's nominal height. */
  s: number;
}

/** Per kind: how tall one stands in metres, and how wide a circle it blocks.
 *
 *  A zero radius means you walk through it — the arch, the gazebo and the
 *  stall are places to walk THROUGH or stand IN, and are given real posts by
 *  `circlesOf` instead of a disc covering the doorway.
 *
 *  The radii are measured off the built models rather than guessed. That
 *  matters more than it sounds: the fountain was blocked at 3.5 m against a
 *  basin 3.52 m ACROSS, so it stopped players a metre and three quarters short
 *  of touching it and there was nothing on screen to explain why. A collider
 *  you cannot see has to match the thing you can. */
export const PROP_SPEC: Record<PropKind, { h: number; r: number }> = {
  // Canopies are wide and trunks are not; the circle is the trunk, and walking
  // under the branches is the point of a tree.
  tree: { h: 7.4, r: 0.75 },
  pine: { h: 8.6, r: 0.5 },
  palm: { h: 6.8, r: 0.4 },
  bush: { h: 1.15, r: 0.55 },
  rock: { h: 1.5, r: 1.0 },
  bench: { h: 0.92, r: 0.8 },
  lamp: { h: 4.3, r: 0.28 },
  planter: { h: 0.95, r: 0.7 },
  picnic: { h: 2.3, r: 1.3 },
  kiosk: { h: 3.4, r: 0 },
  fountain: { h: 2.6, r: 1.9 },
  gazebo: { h: 4.8, r: 0 },
  statue: { h: 3.6, r: 0.85 },
  arch: { h: 5.6, r: 0 },
};

/** How much room a prop takes up on the ground, for laying the park out.
 *  Differs from its BLOCKING radius exactly where you can walk into the thing:
 *  the stall is eight metres across whether or not you can stand under its
 *  awning. */
const FOOTPRINT: Record<PropKind, number> = {
  tree: 0.75,
  pine: 0.5,
  palm: 0.4,
  bush: 0.55,
  rock: 1.0,
  bench: 0.9,
  lamp: 0.28,
  planter: 0.7,
  picnic: 1.3,
  kiosk: 4.4,
  fountain: 1.9,
  gazebo: 3.2,
  statue: 0.85,
  arch: 3.4,
};

/** Deterministic, seedable, and identical on every engine — the layout has to
 *  be the same island in a browser, in Node and in the console. */
function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildProps(): Prop[] {
  const rnd = mulberry32(0x50c1a1); // "SOCIAL", near enough
  const out: Prop[] = [];

  const push = (k: PropKind, x: number, z: number, ry: number, s = 1) => out.push({ k, x, z, ry, s });

  // --- the fixed pieces, placed by hand because they are landmarks ---------
  push("fountain", 0, 0, 0, 1);
  // Four arches, one where each avenue leaves the plaza, turned to face along it.
  push("arch", PLAZA_R + 0.5, 0, 0, 1);
  push("arch", -(PLAZA_R + 0.5), 0, Math.PI, 1);
  push("arch", 0, PLAZA_R + 0.5, Math.PI / 2, 1);
  push("arch", 0, -(PLAZA_R + 0.5), -Math.PI / 2, 1);
  // The bandstand on the north-west knoll, the statue on the south-east rise,
  // and a stall on two of the four avenues.
  push("gazebo", -30, 30, 0.5, 1.05);
  // Off the ring path, deliberately: a landmark standing ON a path is a
  // landmark somebody has to walk round, and it collided with a lamp there.
  push("statue", 41, -21, -0.8, 1);
  push("kiosk", 24, 9.5, -Math.PI / 2, 1);
  push("kiosk", -25, -9.5, Math.PI / 2, 1);
  // Flower boxes around the plaza rim, skipping the four gateways.
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU + 0.196;
    if (Math.abs(Math.sin(a * 2)) < 0.5) continue; // near an axis = a gateway
    push("planter", Math.cos(a) * (PLAZA_R - 1.6), Math.sin(a) * (PLAZA_R - 1.6), -a, 1);
  }
  // Benches and lamps along the ring path, benches turned to face the middle.
  //
  // The two rings are deliberately 2.2 m apart in RADIUS rather than merely
  // spread by angle. Angles alone put a lamp post through the arm of a bench —
  // and worse, left a 7 cm gap between them that a player could be pushed into
  // and not pushed out of, because sliding off one wedged them against the
  // other. Separating the radii makes both problems impossible by geometry
  // rather than by luck, and check:social asserts it stays that way.
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * TAU + 0.31;
    const r = RING_R + (i % 2 === 0 ? 3.2 : -3.2);
    push("bench", Math.cos(a) * r, Math.sin(a) * r, -a + (i % 2 === 0 ? Math.PI : 0), 1);
  }
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * TAU;
    push("lamp", Math.cos(a) * (RING_R + 5.4), Math.sin(a) * (RING_R + 5.4), -a, 1);
  }
  // …and down the four avenues.
  for (let i = 0; i < 5; i++) {
    const r = PLAZA_R + 6 + i * 9;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      push("lamp", dx * r + dz * 3.6, dz * r + dx * 3.6, 0, 1);
    }
  }

  // --- the scattered ones -------------------------------------------------
  const placed = out.slice();
  const fits = (x: number, z: number, gap: number, clearPath: number): boolean => {
    if (pathDist(x, z) < clearPath) return false;
    for (const p of placed) {
      const dx = p.x - x;
      const dz = p.z - z;
      // FOOTPRINT, not the blocking radius. The three props you can walk into
      // — the stall, the bandstand, the gateway — have a blocking radius of
      // ZERO because their posts block instead, and using that here scattered
      // bushes inside the stall. One of them ended up in a gap too narrow for
      // a player to leave, which is the same class of bug as the bench and the
      // lamp post; the difference is that this one is a lie about how much
      // room a thing takes up rather than about where two things are.
      const need = gap + FOOTPRINT[p.k];
      if (dx * dx + dz * dz < need * need) return false;
    }
    return true;
  };
  const scatter = (
    k: PropKind,
    count: number,
    rMin: number,
    rMax: number,
    gap: number,
    clearPath: number,
    scale: [number, number]
  ): void => {
    let made = 0;
    for (let tries = 0; made < count && tries < count * 40; tries++) {
      const a = rnd() * TAU;
      // Uniform in AREA, not in radius — otherwise everything piles up at the
      // middle and the beach is bare.
      const r = Math.sqrt(rMin * rMin + rnd() * (rMax * rMax - rMin * rMin));
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (!fits(x, z, gap, clearPath)) continue;
      const p: Prop = { k, x, z, ry: rnd() * TAU, s: scale[0] + rnd() * (scale[1] - scale[0]) };
      out.push(p);
      placed.push(p);
      made++;
    }
  };

  scatter("tree", 62, 20, 58, 4.2, 3.2, [0.82, 1.24]);
  scatter("pine", 26, 26, 60, 4.0, 3.2, [0.85, 1.2]);
  scatter("palm", 34, 58, 74, 3.4, 3.0, [0.8, 1.25]);
  scatter("bush", 70, 17, 60, 2.0, 2.6, [0.7, 1.3]);
  scatter("rock", 30, 24, 76, 2.6, 2.8, [0.7, 1.5]);
  // Loosened after a run placed one picnic table out of six and none of the
  // extra benches: a rejection sampler that never says so is a park that
  // silently loses its furniture.
  scatter("picnic", 6, 22, 52, 3.6, 3.4, [1, 1]);
  scatter("bench", 8, 20, 56, 3.2, 3.2, [1, 1]);

  return out;
}

let props: Prop[] | null = null;
/** Every prop on the island, in a fixed order. Built once. */
export function islandProps(): Prop[] {
  return (props ??= buildProps());
}

// ---------------------------------------------------------------------------
// Colliders
// ---------------------------------------------------------------------------

export interface Circle {
  x: number;
  z: number;
  r: number;
}

/** A prop's blocking circles. Most props are one; the two you can stand
 *  INSIDE are their posts instead, so the gazebo is shelter and the arch is a
 *  gateway rather than a wall with a picture of a hole on it. */
function circlesOf(p: Prop): Circle[] {
  // `ry` on these three means "the direction you face when you walk through /
  // into it", and their posts are placed ACROSS that. The model is turned to
  // match by MODEL_YAW on the client, so what blocks you and what you can see
  // are the same object.
  if (p.k === "arch") {
    const c = Math.cos(p.ry);
    const s = Math.sin(p.ry);
    // A 6.2 m arch: pillars at ±2.5, opening about four metres wide.
    return [
      { x: p.x - s * 2.5 * p.s, z: p.z + c * 2.5 * p.s, r: 0.7 },
      { x: p.x + s * 2.5 * p.s, z: p.z - c * 2.5 * p.s, r: 0.7 },
    ];
  }
  if (p.k === "kiosk") {
    // Eight metres wide and four deep — a circle round that would block half
    // the avenue. Three along its width instead, so you can walk past its ends.
    const c = Math.cos(p.ry);
    const s = Math.sin(p.ry);
    const out: Circle[] = [];
    for (const off of [-2.4, 0, 2.4]) {
      out.push({ x: p.x - s * off * p.s, z: p.z + c * off * p.s, r: 1.5 * p.s });
    }
    return out;
  }
  if (p.k === "gazebo") {
    const out: Circle[] = [];
    for (let i = 0; i < 8; i++) {
      const a = p.ry + (i / 8) * TAU;
      out.push({ x: p.x + Math.cos(a) * 2.45 * p.s, z: p.z + Math.sin(a) * 2.45 * p.s, r: 0.24 });
    }
    return out;
  }
  // The three kinds that come in a range of sizes block in proportion.
  const r = PROP_SPEC[p.k].r * (p.k === "bush" || p.k === "rock" || p.k === "tree" ? p.s : 1);
  return r > 0 ? [{ x: p.x, z: p.z, r }] : [];
}

const CELL = 8;
const GRID_R = Math.ceil((WALK_R + 6) / CELL);
const GRID_W = GRID_R * 2 + 1;
let grid: Circle[][] | null = null;

function buildGrid(): Circle[][] {
  const cells: Circle[][] = Array.from({ length: GRID_W * GRID_W }, () => []);
  for (const p of islandProps()) {
    for (const c of circlesOf(p)) {
      // A circle belongs to every cell it can reach into, so a lookup only
      // ever has to read the ONE cell a point is in.
      const span = Math.ceil((c.r + PLAYER_R) / CELL);
      const cx = Math.round(c.x / CELL);
      const cz = Math.round(c.z / CELL);
      for (let ix = cx - span; ix <= cx + span; ix++) {
        for (let iz = cz - span; iz <= cz + span; iz++) {
          if (ix < -GRID_R || ix > GRID_R || iz < -GRID_R || iz > GRID_R) continue;
          cells[(iz + GRID_R) * GRID_W + (ix + GRID_R)].push(c);
        }
      }
    }
  }
  return cells;
}

function cellAt(x: number, z: number): Circle[] {
  const ix = Math.round(x / CELL);
  const iz = Math.round(z / CELL);
  if (ix < -GRID_R || ix > GRID_R || iz < -GRID_R || iz > GRID_R) return EMPTY;
  return (grid ??= buildGrid())[(iz + GRID_R) * GRID_W + (ix + GRID_R)];
}
const EMPTY: Circle[] = [];

/** Is this point clear of every prop? Used when placing a spawn or a bot's
 *  waypoint, never per frame. */
export function isClear(x: number, z: number, pad = 0): boolean {
  if (x * x + z * z > WALK_R * WALK_R) return false;
  for (const c of cellAt(x, z)) {
    const dx = x - c.x;
    const dz = z - c.z;
    const need = c.r + PLAYER_R + pad;
    if (dx * dx + dz * dz < need * need) return false;
  }
  return true;
}

/** How far a camera can be pulled back from a point before something solid is
 *  in the way. Returns a distance in metres, never more than `want`.
 *
 *  A third-person camera that ignores this ends up INSIDE the nearest tree,
 *  and what the player then sees is the inside of a trunk filling the screen
 *  with no way to work out what happened. Sampled every 40 cm out along the
 *  line, which is a handful of grid lookups on a path that runs once a frame.
 *
 *  Deliberately in shared/ next to the colliders it reads: a camera that
 *  disagreed with the walls would be its own bug. */
export function clearBack(fromX: number, fromZ: number, dirX: number, dirZ: number, want: number): number {
  const pad = 0.42; // the camera needs a little room of its own
  for (let d = 0.8; d <= want; d += 0.4) {
    const x = fromX + dirX * d;
    const z = fromZ + dirZ * d;
    if (x * x + z * z > WALK_R * WALK_R) return d - 0.4;
    for (const c of cellAt(x, z)) {
      const dx = x - c.x;
      const dz = z - c.z;
      const need = c.r + pad;
      if (dx * dx + dz * dz < need * need) return d - 0.4;
    }
  }
  return want;
}

export interface Move {
  x: number;
  z: number;
  /** True when something got in the way — the client uses it to stop the run
   *  animation sliding on the spot against a wall. */
  blocked: boolean;
}

const move: Move = { x: 0, z: 0, blocked: false };

/** Take a step and find out where it actually ends up: inside the island, and
 *  outside everything solid.
 *
 *  Pushing OUT of an overlap rather than refusing the step is deliberate —
 *  refusing sticks a player to a tree they are brushing past, while pushing
 *  slides them around it, which is what every game of this kind does and what
 *  a thumb expects. Two passes, because sliding out of one circle can push you
 *  into its neighbour and one pass leaves you standing in a bush.
 *
 *  Returns a SHARED object: this is called once per frame per character and
 *  must not allocate. Read it before calling again. */
export function resolveMove(toX: number, toZ: number): Move {
  let x = toX;
  let z = toZ;
  let blocked = false;
  const d2 = x * x + z * z;
  if (d2 > WALK_R * WALK_R) {
    // A millimetre INSIDE the edge, not exactly on it. Clamping to the radius
    // itself lands on a value whose own square rounds above WALK_R² about half
    // the time, so `isClear` would then disagree with the position resolveMove
    // had just produced — and the two are the client and the server.
    const k = (WALK_R - 0.001) / Math.sqrt(d2);
    x *= k;
    z *= k;
    blocked = true;
  }
  // Push out of the DEEPEST overlap, one at a time, and look again.
  //
  // The obvious version — walk the list and push out of each in turn — is
  // wrong wherever colliders overlap each other, which they do by design: the
  // stall is three circles in a row, and a point at the middle of that chain is
  // pushed out of the middle into the right-hand one, out of that back into the
  // middle, and so on for as long as you let it. Leaving the deepest one first
  // always walks the point towards open ground.
  //
  // TWELVE passes, and the number is not padding: a point in the lens where two
  // circles overlap has to travel sideways out of the chain, and each pass only
  // moves it as far as one circle's edge. Six left two points in eight hundred
  // thousand still inside the stall. It costs nothing in the case that
  // matters — a walking player is inside at most one circle by a few
  // centimetres and the loop breaks after the first pass.
  for (let pass = 0; pass < 12; pass++) {
    let worst: Circle | null = null;
    let worstDepth = 0;
    let worstDist = 0;
    for (const c of cellAt(x, z)) {
      const dx = x - c.x;
      const dz = z - c.z;
      const need = c.r + PLAYER_R;
      const dist2 = dx * dx + dz * dz;
      if (dist2 >= need * need) continue;
      const dist = Math.sqrt(dist2);
      const depth = need - dist;
      if (depth > worstDepth) {
        worstDepth = depth;
        worst = c;
        worstDist = dist;
      }
    }
    if (!worst) break;
    blocked = true;
    // A tenth of a millimetre PAST the surface, for the same reason the shore
    // clamp lands a millimetre inside the edge: a point placed at exactly the
    // radius has a square that rounds either way, so `isClear` disagrees with
    // `resolveMove` about half the time — and those two are the client and the
    // server.
    const need = worst.r + PLAYER_R + 1e-4;
    if (worstDist < 1e-4) {
      // Dead centre: any direction will do, and a fixed one keeps it stable.
      x = worst.x + need;
      z = worst.z;
    } else {
      x = worst.x + ((x - worst.x) / worstDist) * need;
      z = worst.z + ((z - worst.z) / worstDist) * need;
    }
  }
  move.x = x;
  move.z = z;
  move.blocked = blocked;
  return move;
}

// ---------------------------------------------------------------------------
// Places with names
// ---------------------------------------------------------------------------

/** Somewhere worth saying you are.
 *
 *  "Where were you" is the question a map exists to answer, and coordinates
 *  are not an answer — "by the bandstand" is. The same list labels the
 *  player's map and, one day, the console's: an island is a PLACE, and a
 *  place's parts have names or it is a field with objects on it. */
export interface Landmark {
  name: string;
  x: number;
  z: number;
  /** How far its name reaches, in metres — what `placeOf` answers with. */
  r: number;
  /** Whether it is worth WRITING on a map.
   *
   *  Its own field rather than a threshold on `r`, because the two are
   *  different questions and tying them together broke both: tightening the
   *  reaches so a stall stopped claiming the ring path also silently dropped
   *  the fountain, the stalls and every gate off the map, leaving two labels
   *  on the whole island. How far a name reaches is about where you are
   *  standing; whether it is drawn is about how crowded the map would be. */
  onMap: boolean;
}

/** A landmark's point is where its NAME is written on the map, so it sits on
 *  the thing it names — inside the fountain, at the foot of the statue. That is
 *  not somewhere you can stand, and it does not need to be: what has to be
 *  true is that somewhere WITHIN its reach can be, or the name points at a
 *  place nobody can go. check:social asserts that rather than the centre.
 *
 *  The reaches are deliberately modest. An earlier set had the east stall
 *  calling the ring path its own from thirteen metres away, which is how a
 *  map starts lying about where you are. */
export const LANDMARKS: readonly Landmark[] = [
  { name: "The Fountain", x: 0, z: 0, r: 10, onMap: true },
  { name: "The Bandstand", x: -30, z: 30, r: 16, onMap: true },
  { name: "The Statue", x: 41, z: -21, r: 14, onMap: true },
  { name: "East Stall", x: 24, z: 9.5, r: 10, onMap: true },
  { name: "West Stall", x: -25, z: -9.5, r: 10, onMap: true },
  // The gates are worth NAMING — "meet me at the north gate" is a sentence
  // people say — and not worth drawing: four labels round a thirty-metre
  // plaza would sit on top of the fountain's and each other's.
  // NORTH IS −Z, because north is up on the map and the map draws +z downwards
  // (see mapArrow). These names shipped the other way round, which put a
  // player standing at the "north gate" at the BOTTOM of their own map.
  { name: "North Gate", x: 0, z: -(PLAZA_R + 1), r: 7, onMap: false },
  { name: "South Gate", x: 0, z: PLAZA_R + 1, r: 7, onMap: false },
  { name: "East Gate", x: PLAZA_R + 1, z: 0, r: 7, onMap: false },
  { name: "West Gate", x: -(PLAZA_R + 1), z: 0, r: 7, onMap: false },
];

/** What you would tell somebody if they asked where you were standing.
 *
 *  Nearest named landmark whose name reaches this far, and otherwise the band
 *  of the island you are in — which is still an answer, and a better one than
 *  a pair of numbers. */
export function placeOf(x: number, z: number): string {
  let best: Landmark | null = null;
  let bestD = Infinity;
  for (const l of LANDMARKS) {
    const d = Math.hypot(l.x - x, l.z - z);
    if (d > l.r || d >= bestD) continue;
    bestD = d;
    best = l;
  }
  if (best) return best.name;
  const d = Math.sqrt(x * x + z * z);
  if (d <= PLAZA_R) return "The Plaza";
  if (d >= BEACH_IN) return "The Beach";
  if (Math.abs(d - RING_R) <= 4) return "The Ring Path";
  return "The Park";
}

/** How far to turn a marker drawn pointing UP so that it points where a
 *  heading of `ry` faces, on a north-up map.
 *
 *  Here rather than in the renderer because it is a fact about how the island
 *  maps onto a map — the client's dial, the client's full map and the
 *  console's island view all need the same answer, and check:social can prove
 *  it without a browser.
 *
 *  The maths, since it is the sort of thing that gets "fixed" wrongly: world
 *  +X is screen right and world +Z is screen DOWN, a heading of `ry` faces
 *  (sin ry, cos ry), and a canvas rotate(θ) turns the up vector (0, −1) into
 *  (sin θ, −cos θ). Setting those equal gives θ = π − ry. */
export const mapArrow = (ry: number): number => Math.PI - ry;

/** Where a heading POINTS on a north-up map, as a unit vector in screen
 *  coordinates (x right, y down). Only the check uses it — it is the
 *  independent statement of what mapArrow is supposed to achieve. */
export function mapHeading(ry: number): { x: number; y: number } {
  return { x: Math.sin(ry), y: Math.cos(ry) };
}

// ---------------------------------------------------------------------------
// Arriving
// ---------------------------------------------------------------------------

/** Where somebody lands. Everyone arrives in the same quarter of the island —
 *  the plaza and the lawn just outside it — because a social space whose
 *  players spawn a hundred metres apart is twenty people playing alone. The
 *  spread within it is wide enough that two people arriving together are not
 *  standing inside each other.
 *
 *  Deterministic in (seed, n) so the server can tell a client exactly where it
 *  put them and both agree without a round trip. */
export function spawnPoint(seed: number, n: number): { x: number; z: number; ry: number } {
  // Every seat from 0 up to this one, so a new arrival can be kept off the
  // people already standing there. Twenty seats is four hundred comparisons
  // in the worst case, on a path that runs once per arrival — and the
  // alternative, a pure function of (seed, n) alone, cannot make the promise
  // at all: two seats would land on top of each other whenever their two
  // random draws happened to agree.
  const taken: { x: number; z: number }[] = [];
  let last = { x: 0, z: PLAZA_R + 6, ry: Math.PI };
  for (let seat = 0; seat <= n; seat++) {
    const rnd = mulberry32((seed ^ (seat * 0x9e3779b1)) >>> 0);
    let placed: { x: number; z: number; ry: number } | null = null;
    for (let tries = 0; tries < 60 && !placed; tries++) {
      // The golden angle spreads consecutive arrivals around the ring instead
      // of dropping them in one arc.
      const a = seat * 2.39996 + rnd() * 0.8;
      const r = PLAZA_R + 2 + rnd() * 11;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (!isClear(x, z, 1.6)) continue;
      if (taken.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < 4)) continue;
      placed = { x, z, ry: Math.atan2(-x, -z) };
    }
    // Nowhere clear at all is not a reason to refuse somebody entry; the plaza
    // rim is always somewhere, and resolveMove will slide them off anybody
    // they land on.
    last = placed ?? { x: Math.cos(seat) * (PLAZA_R + 4), z: Math.sin(seat) * (PLAZA_R + 4), ry: Math.PI };
    taken.push(last);
  }
  return last;
}
