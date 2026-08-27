// Verification suite for Social Space — run it after ANY change to
// shared/games/social.
//
//     npm run check:social
//
// It reads the shared SOURCE (via tsx), so it can never pass against a stale
// build. What it proves, and why each check exists:
//
//   the island   — every prop is on the island, out of the paths, and clear of
//                  every other prop. The layout is generated from a fixed seed
//                  by a rejection sampler, and a sampler that quietly gives up
//                  would leave a park with a tree growing through a bench and
//                  nothing to say so
//   walking      — resolveMove NEVER returns a point inside something solid or
//                  outside the island, from anywhere, including from inside a
//                  prop. This is the one function the client and the server
//                  both call, and a disagreement between them is a player who
//                  can see themselves standing somewhere the server says they
//                  are not
//   arriving     — spawn points are clear, close together, and different for
//                  consecutive seats. "Everybody lands in the same area" is the
//                  whole social premise; "inside the fountain" is not
//   the routes   — the bot graph is connected, and every edge of it is clear of
//                  every prop. That property is what lets the population walk
//                  without pathfinding, and it is the only thing standing
//                  between a bot and a tree
//   the walk     — forty minutes of every bot, sampled: always on the island,
//                  never inside anything, and identical when replayed. A walk
//                  that drifts is a bot standing in the sea
//   earshot      — the volume curve is 1 at ten metres, 0 at twenty, continuous
//                  at both ends and falling in between. Voice is the point of
//                  this game and this curve is all of it
//   the wire     — a position survives the round trip through the packet within
//                  its own quantisation, and a malformed packet is refused
//                  rather than thrown
//   the seats    — the game declares itself drop-in, holds twenty, and refuses
//                  every input kind, because it has none
import {
  ANIM_IDLE,
  ANIM_RUN,
  ANIM_WALK,
  BEACH_IN,
  CAPACITY,
  GAME_ID,
  HEAR_FULL_M,
  HEAR_MAX_M,
  PLAZA_R,
  PROP_KINDS,
  RING_R,
  PROP_SPEC,
  SESSION_MS,
  WALK_R,
  WALK_SPEED,
  Wanderer,
  EXTRAPOLATE_MS,
  INTERP_DELAY_MS,
  MAX_POSE_AGE_MS,
  MAX_POSE_AHEAD_MS,
  PoseTrack,
  REPORT_HZ,
  SNAPSHOT_HZ,
  TRACK_IDLE_MS,
  TRACK_LEFT,
  TRACK_MIN_MS,
  TRACK_MOVE_M,
  angleDelta,
  packTrack,
  readTrack,
  hearGain,
  heightAt,
  isClear,
  islandProps,
  keyOf,
  LANDMARKS,
  mapArrow,
  mapHeading,
  placeOf,
  packReport,
  packWire,
  pathDist,
  readReport,
  readWire,
  resolveMove,
  spawnPoint,
  surfaceAt,
  walkGraph,
  wrapAngle,
  CAM_FOLLOW_RATE,
  STICK_TURN,
  TURN_RATE,
  followYaw,
  stickWant,
  type Held,
} from "../../shared/games/social/index.js";
// The server definition is checked through the same registry the platform
// reads it from — importing it is what registers it.
import "../../backend/src/games/social/index.js";
import { getGame } from "../../backend/src/platform/games.js";

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    fails++;
    console.log(`  FAIL ${msg}`);
  }
};
const head = (name: string) => console.log(`\n${name}`);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PLAYER_R = 0.34;

// ---------------------------------------------------------------------------
head("The island");
{
  const props = islandProps();
  ok(props.length > 200, `the park is furnished (${props.length} props)`);
  const kinds = new Set(props.map((p) => p.k));
  ok(
    PROP_KINDS.every((k) => kinds.has(k)),
    `every kind of prop is actually placed (${kinds.size}/${PROP_KINDS.length})`
  );

  let offIsland = 0;
  for (const p of props) if (Math.hypot(p.x, p.z) > WALK_R + 4) offIsland++;
  ok(offIsland === 0, `nothing is standing in the sea (${offIsland} off the island)`);

  // Scattered props must keep off the paths. The hand-placed furniture — lamps,
  // benches, arches, planters — is deliberately ON them, which is the point of
  // a lamp post, so those kinds are exempt.
  const ONPATH_OK = new Set(["lamp", "bench", "arch", "planter", "fountain", "kiosk", "statue"]);
  let onPath = 0;
  for (const p of props) if (!ONPATH_OK.has(p.k) && pathDist(p.x, p.z) < 1.6) onPath++;
  ok(onPath === 0, `nothing is growing out of the middle of a path (${onPath})`);

  // No two solid props inside each other.
  let overlaps = 0;
  for (let i = 0; i < props.length; i++) {
    for (let j = i + 1; j < props.length; j++) {
      const a = props[i];
      const b = props[j];
      const ra = PROP_SPEC[a.k].r;
      const rb = PROP_SPEC[b.k].r;
      if (ra <= 0 || rb <= 0) continue;
      const need = (ra + rb) * 0.75;
      if ((a.x - b.x) ** 2 + (a.z - b.z) ** 2 < need * need) overlaps++;
    }
  }
  ok(overlaps === 0, `no two solid props are inside each other (${overlaps})`);

  ok(Math.abs(heightAt(0, 0)) < 1e-9, "the plaza is dead flat");
  ok(heightAt(0, PLAZA_R - 1) === 0, "…all the way to its rim");
  ok(heightAt(0, WALK_R) < 0, "and the sand shelves down towards the sea");
  ok(surfaceAt(0, 0) === "plaza", "you stand on paving in the middle");
  ok(surfaceAt(0, WALK_R - 2) === "sand", "and on sand at the edge");
  // Off the avenues and off the ring, or it is paving and rightly says so.
  ok(surfaceAt(14, 44) === "grass", "and on grass in the park");
}

// ---------------------------------------------------------------------------
head("Walking");
{
  const rnd = rng(0xc0ffee);
  let outside = 0;
  let inside = 0;
  // From anywhere at all, including well out to sea and deep inside a tree.
  for (let i = 0; i < 200000; i++) {
    const x = (rnd() - 0.5) * 260;
    const z = (rnd() - 0.5) * 260;
    const m = resolveMove(x, z);
    if (Math.hypot(m.x, m.z) > WALK_R + 1e-6) outside++;
    if (!isClear(m.x, m.z, -1e-6)) inside++;
  }
  ok(outside === 0, `resolveMove never leaves the island (${outside} of 200,000)`);
  ok(inside === 0, `resolveMove never leaves you inside something solid (${inside} of 200,000)`);

  // …and it must be STABLE: resolving an already-legal point must not move it,
  // or a player standing still would drift.
  let drifted = 0;
  for (let i = 0; i < 20000; i++) {
    const a = rnd() * Math.PI * 2;
    const r = rnd() * WALK_R;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (!isClear(x, z)) continue;
    const m = resolveMove(x, z);
    if (Math.abs(m.x - x) > 1e-9 || Math.abs(m.z - z) > 1e-9) drifted++;
  }
  ok(drifted === 0, `a legal position is left exactly where it is (${drifted})`);

  // A step into a wall must not tunnel: walk hard at the fountain from every
  // direction and never end up on the far side of it.
  let tunnelled = 0;
  for (let i = 0; i < 720; i++) {
    const a = (i / 720) * Math.PI * 2;
    const from = { x: Math.cos(a) * 8, z: Math.sin(a) * 8 };
    const m = resolveMove(from.x - Math.cos(a) * 16, from.z - Math.sin(a) * 16);
    // The fountain's blocking circle is 3.5 m; landing inside it is the failure.
    if (Math.hypot(m.x, m.z) < 3.5 + PLAYER_R - 1e-6) tunnelled++;
  }
  ok(tunnelled === 0, `a hard step at the fountain is stopped by it (${tunnelled} of 720)`);
}

// ---------------------------------------------------------------------------
head("Arriving");
{
  let clear = 0;
  let far = 0;
  let close = 0;
  const seen: { x: number; z: number }[] = [];
  for (let seed = 1; seed <= 40; seed++) {
    for (let seat = 0; seat < CAPACITY; seat++) {
      const s = spawnPoint(seed * 7919, seat);
      if (isClear(s.x, s.z, 0.4)) clear++;
      const r = Math.hypot(s.x, s.z);
      // "Almost the same area": everybody lands on or just outside the plaza.
      if (r > PLAZA_R + 14) far++;
      if (seed === 3) seen.push(s);
    }
  }
  const total = 40 * CAPACITY;
  ok(clear === total, `every spawn is clear of the scenery (${clear}/${total})`);
  ok(far === 0, `everybody lands in the same part of the island (${far} strays)`);
  for (let i = 0; i < seen.length; i++) {
    for (let j = i + 1; j < seen.length; j++) {
      if (Math.hypot(seen[i].x - seen[j].x, seen[i].z - seen[j].z) < 1.2) close++;
    }
  }
  ok(close === 0, `and never on top of each other (${close} pairs)`);
  const a = spawnPoint(1234, 3);
  const b = spawnPoint(1234, 3);
  ok(a.x === b.x && a.z === b.z, "the same seat always lands in the same spot");
}

// ---------------------------------------------------------------------------
head("The routes the population walks");
{
  const g = walkGraph();
  ok(g.length > 40, `there is a network to walk (${g.length} nodes)`);
  ok(
    g.every((n) => n.adj.length > 0),
    "every node goes somewhere"
  );

  // Connected: a node the walk cannot reach is a node a bot could be dropped
  // into and never leave.
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length) for (const n of g[queue.pop()!].adj) if (!seen.has(n)) (seen.add(n), queue.push(n));
  ok(seen.size === g.length, `the whole network is reachable (${seen.size}/${g.length})`);

  // Every edge, sampled every half metre: clear of every prop and on the island.
  let blocked = 0;
  let edges = 0;
  for (let i = 0; i < g.length; i++) {
    for (const j of g[i].adj) {
      if (j < i) continue;
      edges++;
      const steps = Math.max(2, Math.ceil(Math.hypot(g[j].x - g[i].x, g[j].z - g[i].z) * 2));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = g[i].x + (g[j].x - g[i].x) * t;
        const z = g[i].z + (g[j].z - g[i].z) * t;
        if (!isClear(x, z, 0.2)) {
          blocked++;
          break;
        }
      }
    }
  }
  ok(blocked === 0, `all ${edges} routes are clear end to end (${blocked} blocked)`);
}

// ---------------------------------------------------------------------------
head("Forty minutes of a bot's life");
{
  const seed = 0x51de;
  const uids = ["bot-alpha", "bot-bravo", "bot-charlie", "bot-delta", "bot-echo"];
  let offIsland = 0;
  let solid = 0;
  let still = 0;
  let ran = 0;
  const STEP = 500;
  for (const uid of uids) {
    const w = new Wanderer(seed, keyOf(uid));
    let moved = 0;
    let last = { x: 0, z: 0 };
    for (let t = 0; t <= SESSION_MS; t += STEP) {
      const p = w.poseAt(t);
      if (Math.hypot(p.x, p.z) > WALK_R) offIsland++;
      if (!isClear(p.x, p.z, -1e-6)) solid++;
      if (p.anim === ANIM_RUN) ran++;
      if (t > 0 && Math.hypot(p.x - last.x, p.z - last.z) > 0.05) moved++;
      last = { x: p.x, z: p.z };
      if (p.anim !== ANIM_IDLE && p.anim !== ANIM_WALK && p.anim !== ANIM_RUN) still++;
    }
    // A bot that never moves is a mannequin, and a bot that never stops is a
    // machine. Both are tells.
    const share = moved / (SESSION_MS / STEP);
    ok(share > 0.25 && share < 0.9, `${uid} spends ${(share * 100).toFixed(0)}% of the session walking`);
  }
  ok(offIsland === 0, `no bot ever steps off the island (${offIsland})`);
  ok(solid === 0, `no bot ever stands inside a prop (${solid})`);
  ok(still === 0, "every pose is one of the three the wire can carry");
  ok(ran > 0, "and they sometimes run");

  // Determinism, which is the whole reason the walk can be a pure function:
  // the same bot asked twice gives the same answer, and asking BACKWARDS
  // (which is what a player joining a running island does) rebuilds it.
  const a = new Wanderer(seed, keyOf("bot-alpha"));
  const b = new Wanderer(seed, keyOf("bot-alpha"));
  let same = true;
  for (let t = 0; t <= 20 * 60_000; t += 1237) {
    const pa = a.poseAt(t);
    const pb = b.poseAt(t);
    if (pa.x !== pb.x || pa.z !== pb.z || pa.anim !== pb.anim) same = false;
  }
  ok(same, "two copies of the same bot walk in step");
  const late = new Wanderer(seed, keyOf("bot-alpha"));
  const at35 = late.poseAt(35 * 60_000);
  const rewound = late.poseAt(60_000);
  const forward = late.poseAt(35 * 60_000);
  ok(
    forward.x === at35.x && forward.z === at35.z && Number.isFinite(rewound.x),
    "a bot asked about the past rebuilds and still agrees about the present"
  );

  // Two different bots must not be walking the same route in lockstep.
  const w1 = new Wanderer(seed, keyOf(uids[0]));
  const w2 = new Wanderer(seed, keyOf(uids[1]));
  let apart = 0;
  for (let t = 0; t <= 10 * 60_000; t += 5000) {
    const p1 = w1.poseAt(t);
    const p2 = w2.poseAt(t);
    if (Math.hypot(p1.x - p2.x, p1.z - p2.z) > 6) apart++;
  }
  ok(apart > 100, `different bots walk different routes (apart on ${apart} of 121 samples)`);
}

// ---------------------------------------------------------------------------
head("Earshot");
{
  ok(hearGain(0) === 1 && hearGain(HEAR_FULL_M) === 1, "full volume out to ten metres");
  ok(hearGain(HEAR_MAX_M) === 0 && hearGain(40) === 0, "and silence past twenty");
  let monotone = true;
  let prev = 1;
  for (let d = HEAR_FULL_M; d <= HEAR_MAX_M; d += 0.05) {
    const g = hearGain(d);
    if (g > prev + 1e-12) monotone = false;
    prev = g;
  }
  ok(monotone, "it only ever gets quieter as you walk away");
  ok(Math.abs(hearGain(HEAR_FULL_M + 0.01) - 1) < 0.01, "no step at the inner edge");
  ok(hearGain(HEAR_MAX_M - 0.01) < 0.01, "no step at the outer edge");
  // The middle of the range must be a real fade, not a cliff at one end.
  const mid = hearGain((HEAR_FULL_M + HEAR_MAX_M) / 2);
  ok(mid > 0.15 && mid < 0.85, `halfway out you are half heard (${mid.toFixed(2)})`);
}

// ---------------------------------------------------------------------------
head("The wire");
{
  const rnd = rng(7);
  let worstPos = 0;
  let worstRot = 0;
  for (let i = 0; i < 20000; i++) {
    const pose = {
      x: (rnd() - 0.5) * 2 * WALK_R,
      z: (rnd() - 0.5) * 2 * WALK_R,
      ry: rnd() * Math.PI * 2,
      anim: (Math.floor(rnd() * 3) as 0 | 1 | 2),
    };
    const back = readReport(packReport(pose));
    if (!back) {
      worstPos = Infinity;
      break;
    }
    worstPos = Math.max(worstPos, Math.abs(back.x - pose.x), Math.abs(back.z - pose.z));
    worstRot = Math.max(worstRot, Math.abs(angleDelta(pose.ry, back.ry)));
    if (back.anim !== pose.anim) worstPos = Infinity;
  }
  ok(worstPos < 0.02, `a position survives the wire to within ${(worstPos * 100).toFixed(1)} cm`);
  ok(worstRot < 0.01, `and a facing to within ${((worstRot * 180) / Math.PI).toFixed(2)}°`);

  const wire = packWire(7, { x: 12.5, z: -4.25, ry: 1, anim: ANIM_WALK }, 42);
  const read = readWire(wire);
  ok(read?.seat === 7, "a seat survives too");

  // THE SPACING, which is the whole of why people used to stutter and bots did
  // not: a pose is true at a moment, and a snapshot is built at a different
  // one. Both numbers have to survive or the receiver spaces the samples
  // evenly when they were not.
  ok(read?.age === 42, `and so does how old the pose was (${read?.age} ms)`);
  const spaced = readReport(packReport({ x: 1, z: 2, ry: 0, anim: ANIM_WALK }, 67));
  ok(spaced?.dt === 67, `a report carries the gap its sender measured (${spaced?.dt} ms)`);
  const capped = readReport(packReport({ x: 1, z: 2, ry: 0, anim: ANIM_WALK }, 99999));
  ok((capped?.dt ?? 0) <= 2000, `and a silly one is capped rather than believed (${capped?.dt})`);
  ok(readReport([0, 0, 0, 0])?.dt === 0, "a report that does not say reads as no gap at all");
  ok((readWire([1, 0, 0, 0, 0] as never)?.age ?? -1) === 0, "…and so does a wire entry");
  ok(
    (readWire([1, 0, 0, 0, 0, 99999] as never)?.age ?? 0) <= 1000,
    "an absurd age is clamped to the window the smoother can use"
  );

  // Rubbish is REFUSED, not thrown: this is the hot path, ten times a second
  // per player, and one malformed packet must not unwind anything.
  const junk: unknown[] = [null, undefined, {}, [], [1, 2], "hello", [1, 2, 3, "x"], [NaN, 0, 0, 0], [1, 2, Infinity, 0]];
  let threw = false;
  let accepted = 0;
  for (const j of junk) {
    try {
      if (readReport(j) !== null) accepted++;
    } catch {
      threw = true;
    }
  }
  ok(!threw, "a malformed packet never throws");
  ok(accepted === 0, `and is never accepted (${accepted} got through)`);
  // An out-of-range anim is clamped rather than believed.
  const wild = readReport([0, 0, 0, 99]);
  ok(wild?.anim === ANIM_IDLE, "an unknown pose reads as standing still");
}

// ---------------------------------------------------------------------------
head("Places with names");
{
  ok(placeOf(0, 0) === "The Fountain", `the middle of the plaza is ${placeOf(0, 0)}`);
  ok(placeOf(-30, 30) === "The Bandstand", `the knoll is ${placeOf(-30, 30)}`);
  ok(placeOf(41, -21) === "The Statue", `the rise is ${placeOf(41, -21)}`);
  ok(placeOf(0, 72) === "The Beach", `the sand is ${placeOf(0, 72)}`);
  ok(placeOf(RING_R, 0) === "The Ring Path", `the ring is ${placeOf(RING_R, 0)}`);
  ok(placeOf(14, 44) === "The Park", `open grass is ${placeOf(14, 44)}`);

  // EVERY point on the island has to have an answer — a map that says nothing
  // about where you are standing is worse than no map.
  const rnd = rng(31);
  let blank = 0;
  for (let i = 0; i < 20000; i++) {
    const a = rnd() * Math.PI * 2;
    const r2 = Math.sqrt(rnd()) * WALK_R;
    const name = placeOf(Math.cos(a) * r2, Math.sin(a) * r2);
    if (!name || name.length < 3) blank++;
  }
  ok(blank === 0, `and every square metre of it is somewhere (${blank} blanks in 20,000)`);

  // Landmarks must not sit inside each other, or a name means two places.
  let clash = 0;
  for (let i = 0; i < LANDMARKS.length; i++) {
    for (let j = i + 1; j < LANDMARKS.length; j++) {
      const d = Math.hypot(LANDMARKS[i].x - LANDMARKS[j].x, LANDMARKS[i].z - LANDMARKS[j].z);
      if (d < Math.max(LANDMARKS[i].r, LANDMARKS[j].r) * 0.5) clash++;
    }
  }
  ok(clash === 0, `no two named places are on top of each other (${clash})`);
  // …and each one names somewhere you can actually GO. The point itself is
  // where the label is written — on the thing it names, which for a fountain
  // is inside the basin — so what has to be true is that some part of its
  // reach can be stood in.
  const stranded: string[] = [];
  for (const l of LANDMARKS) {
    let reachable = false;
    for (let ring = 2; ring <= l.r && !reachable; ring += 2) {
      for (let a = 0; a < 16 && !reachable; a++) {
        const t = (a / 16) * Math.PI * 2;
        if (isClear(l.x + Math.cos(t) * ring, l.z + Math.sin(t) * ring, 0.3)) reachable = true;
      }
    }
    if (!reachable) stranded.push(l.name);
  }
  ok(stranded.length === 0, `and every one can be walked to (${stranded.join(", ") || "all reachable"})`);

  // WHAT IS DRAWN is its own decision, and it has to survive the reaches being
  // retuned. Keying the map's labels off `r` meant tightening a stall's reach
  // silently dropped the fountain, both stalls and every gate off the map and
  // left two names on the whole island.
  const drawn = LANDMARKS.filter((l) => l.onMap);
  ok(drawn.length >= 4, `the map has ${drawn.length} names written on it`);
  ok(
    drawn.some((l) => l.name === "The Fountain"),
    "including the one in the middle, which is where everybody lands"
  );
  // …and they must not be written on top of each other. Twenty metres apart
  // is about a label's width at the scale the full map is drawn.
  let crowded = 0;
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      if (Math.hypot(drawn[i].x - drawn[j].x, drawn[i].z - drawn[j].z) < 20) crowded++;
    }
  }
  ok(crowded === 0, `and none is written over another (${crowded} pairs too close)`);
}

// ---------------------------------------------------------------------------
head("The arrow on the map");
{
  // The map holds north up and the ARROW turns, so the arrow is the only thing
  // saying which way anybody is facing — and it shipped stuck. Twice, for two
  // different reasons: once pointing where the CAMERA looked (which on a phone
  // does not move when you turn, because you turn by walking), and the maths
  // itself is the sort that gets "corrected" wrongly because the sign is not
  // obvious. So it is asserted rather than eyeballed.
  //
  // The claim: a marker drawn pointing UP and then turned by mapArrow(ry) ends
  // up pointing exactly where a heading of ry faces on the map.
  const turned = (ry: number) => {
    const t = mapArrow(ry);
    // A canvas rotate(t) takes the up vector (0, -1) to (sin t, -cos t).
    return { x: Math.sin(t), y: -Math.cos(t) };
  };
  let worst = 0;
  for (let i = 0; i < 720; i++) {
    const ry = (i / 720) * Math.PI * 2;
    const got = turned(ry);
    const want = mapHeading(ry);
    worst = Math.max(worst, Math.hypot(got.x - want.x, got.y - want.y));
  }
  ok(worst < 1e-9, `it points where the player faces, at every heading (worst ${worst.toExponential(1)})`);

  // …and the four a player would name, in screen terms: +y is DOWN on a map.
  const NORTH = Math.PI;
  const SOUTH = 0;
  const EAST = Math.PI / 2;
  const WEST = -Math.PI / 2;
  const dir = (ry: number) => {
    const v = turned(ry);
    return `${v.y < -0.5 ? "up" : v.y > 0.5 ? "down" : ""}${v.x > 0.5 ? "right" : v.x < -0.5 ? "left" : ""}`;
  };
  // …and the ISLAND has to agree with the compass the arrow is drawn against.
  // The gate names are the only thing on it that says which way north is, and
  // they shipped pointing the other way — so a player standing at the north
  // gate was drawn at the bottom of their own map while the HUD said "north
  // gate". A screenshot will not catch that; this will.
  const up = LANDMARKS.find((l) => l.name === "North Gate")!;
  const down = LANDMARKS.find((l) => l.name === "South Gate")!;
  const right = LANDMARKS.find((l) => l.name === "East Gate")!;
  ok(up.z < 0 && down.z > 0, `the north gate is drawn above the middle (z ${up.z.toFixed(0)}) and the south below`);
  ok(right.x > 0, "and the east gate to the right of it");
  ok(placeOf(0, up.z) === "North Gate", `standing there, the HUD says ${placeOf(0, up.z)}`);

  ok(dir(NORTH) === "up", `facing north draws it ${dir(NORTH)}`);
  ok(dir(SOUTH) === "down", `facing south draws it ${dir(SOUTH)}`);
  ok(dir(EAST) === "right", `facing east draws it ${dir(EAST)}`);
  ok(dir(WEST) === "left", `facing west draws it ${dir(WEST)}`);

  // And it must actually MOVE: four distinct headings, four distinct angles.
  const angles = new Set([NORTH, EAST, SOUTH, WEST].map((r) => Math.round(mapArrow(r) * 1000)));
  ok(angles.size === 4, `turning the character turns the arrow (${angles.size} distinct angles from 4 headings)`);

  // A teammate's dot says the same thing a second way: a SPUR drawn off it
  // straight along (sin ry, cos ry), with no rotate() in the way. Two players
  // walking the same way must be drawn pointing the same way — so the two
  // formulas are cross-checked against each other rather than each against
  // itself, which is what catches a sign "corrected" in only one of them.
  let spur = 0;
  for (let i = 0; i < 720; i++) {
    const ry = (i / 720) * Math.PI * 2;
    const arrow = turned(ry);
    spur = Math.max(spur, Math.hypot(arrow.x - Math.sin(ry), arrow.y - Math.cos(ry)));
  }
  ok(spur < 1e-9, `a teammate's heading spur points the same way as their own arrow would (${spur.toExponential(1)})`);
}


// ---------------------------------------------------------------------------
head("Turning, and the camera coming round behind it");
{
  // The whole control loop, at sixty frames a second, with nothing in it but
  // arithmetic: a stick, a character who turns towards where it points, and a
  // camera that settles in behind the character. What is being checked is the
  // STABLE STATE of the three together, which is the thing you cannot see by
  // reading any one of them.
  const DT = 1 / 60;
  const run = (
    seconds: number,
    push: (t: number) => number,
    opts: { steering?: (t: number) => boolean; naive?: boolean } = {}
  ) => {
    let ry = 0;
    let yaw = 0;
    let held: Held | null = null;
    let turned = 0;
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      const t = i * DT;
      const steering = opts.steering?.(t) ?? false;
      // The naive loop is the one this replaced: the stick read in camera
      // space EVERY frame. Kept here because the failure it produces is the
      // whole reason the other one looks the way it does.
      const want = opts.naive ? yaw + push(t) : (held = stickWant(push(t), yaw, steering, held)).want;
      const was = ry;
      ry += angleDelta(ry, want) * Math.min(1, DT * TURN_RATE);
      turned += Math.abs(angleDelta(was, ry));
      if (!steering) yaw = followYaw(yaw, ry, DT);
    }
    return { ry, yaw, turned, gap: Math.abs(angleDelta(yaw, ry)) };
  };
  const deg = (r: number) => (r * 180) / Math.PI;

  // A THUMB HELD STILL, hard left, for three seconds.
  const left = run(3, () => -Math.PI / 2);
  ok(
    Math.abs(deg(left.turned) - 90) < 6,
    `a stick held left turns you left once — ${Math.round(deg(left.turned))}°, not a circle`
  );
  ok(left.gap < 0.05, `and the camera ends up behind you (${Math.round(deg(left.gap))}° off)`);

  // …which is exactly what the obvious loop does NOT do.
  const spun = run(3, () => -Math.PI / 2, { naive: true });
  ok(
    deg(spun.turned) > 300,
    `reading the stick against the camera every frame would spin you ${Math.round(deg(spun.turned))}° instead`
  );

  // A THUMB ON THE VIEW. Dragging the camera while running forward has to
  // turn the run — it is the other half of how anybody steers.
  const dragged = run(2, () => 0, { steering: (t) => t < 1.2 });
  ok(
    Math.abs(deg(angleDelta(dragged.ry, 0))) < 2,
    "holding forward while the view is dragged keeps the character with the camera"
  );
  const swung = (() => {
    let ry = 0;
    let yaw = 0;
    let held: Held | null = null;
    for (let i = 0; i < 120; i++) {
      yaw += Math.PI / 240; // a thumb dragging the view, 90° over two seconds
      held = stickWant(0, yaw, true, held);
      ry += angleDelta(ry, held.want) * Math.min(1, DT * TURN_RATE);
    }
    return { ry, yaw };
  })();
  // Five degrees behind, not zero: the character turns AT a rate rather than
  // teleporting, so a view swinging at 45°/s is trailed by 45/TURN_RATE. That
  // trail is the weight of the character and is meant to be there — what would
  // be wrong is the character not coming with it at all.
  ok(
    Math.abs(deg(angleDelta(swung.ry, swung.yaw))) < 8,
    `and a view dragged 90° while running takes the character with it (${Math.round(deg(swung.ry))}° of 90°)`
  );

  // ROLLING the stick turns you by however far it rolled, whatever the camera
  // is doing — that is what "world-locked while held" has to mean.
  const rolled = run(3, (t) => (t < 1 ? 0 : -Math.PI / 6));
  ok(
    Math.abs(deg(angleDelta(rolled.ry, -Math.PI / 6))) < 3,
    `rolling the stick 30° turns you 30° (${Math.round(deg(rolled.ry))}°)`
  );
  // …and a thumb wobbling below the threshold does not turn you at all.
  const wobble = run(2, (t) => Math.sin(t * 12) * (STICK_TURN * 0.6));
  ok(Math.abs(deg(wobble.ry)) < 2, `a thumb resting on the stick does not steer (${deg(wobble.ry).toFixed(1)}°)`);

  // And the camera is the follower, not the leader: it must be slower than the
  // character or the picture swings while the player is still turning.
  ok(CAM_FOLLOW_RATE < TURN_RATE, `the camera follows slower than the player turns (${CAM_FOLLOW_RATE} < ${TURN_RATE})`);
}
// ---------------------------------------------------------------------------
head("Smoothness — a steady walk drawn steadily");
{
  // The whole pipeline, end to end, in numbers rather than in an opinion:
  //
  //   a sender walks in a straight line at a constant speed, sampling its own
  //   position on a JITTERY frame loop (a phone does not render evenly);
  //   its reports cross a network with variable latency;
  //   the server stamps them and batches them onto its own fixed tick;
  //   the receiver interpolates and draws at sixty a second.
  //
  // If the drawn speed wobbles, the world skates. This measures the wobble.
  //
  // It is the check that would have caught the fault this game shipped with:
  // the server stamped every entry with the moment the SNAPSHOT was built
  // rather than the moment the pose was true, so two samples labelled a
  // fifteenth of a second apart could hold anything from nothing to two
  // fifteenths of walking — and the drawn character alternately stalled and
  // sprinted while the bots beside it, whose poses ARE computed at the
  // snapshot instant, moved perfectly.
  const SPEED = WALK_SPEED;
  const RUN_MS = 6000;

  /** One end-to-end run. `carryAge` false is the old behaviour: the receiver
   *  is told when the SNAPSHOT was built and nothing about the pose. */
  function drift(carryAge: boolean, jitter: () => number, lag: () => number): number {
    const track = new PoseTrack();
    const reportEvery = 1000 / REPORT_HZ;
    const snapEvery = 1000 / SNAPSHOT_HZ;

    // The sender: a frame loop that does not tick evenly.
    const reports: { at: number; x: number; dt: number }[] = [];
    let frame = 0;
    let lastReport = -1e9;
    let lastSentAt = 0;
    while (frame < RUN_MS) {
      frame += jitter();
      if (frame - lastReport < reportEvery) continue;
      lastReport = frame;
      const dt = lastSentAt > 0 ? frame - lastSentAt : 0;
      lastSentAt = frame;
      reports.push({ at: frame + lag(), x: (SPEED * frame) / 1000, dt });
    }

    // The server: a fixed tick, holding whatever has arrived, and advancing
    // each sender's own timeline by the gap that sender measured.
    const snaps: { arriveAt: number; sampleAt: number; x: number }[] = [];
    let cursor = 0;
    let poseX = 0;
    let poseTime = 0;
    let seenAny = false;
    for (let t = 0; t <= RUN_MS + 600; t += snapEvery) {
      while (cursor < reports.length && reports[cursor].at <= t) {
        const r = reports[cursor++];
        poseTime = seenAny
          ? Math.min(t + MAX_POSE_AHEAD_MS, Math.max(t - MAX_POSE_AGE_MS, poseTime + r.dt))
          : t;
        poseX = r.x;
        seenAny = true;
      }
      if (!seenAny) continue;
      // The receiver converts the snapshot's own stamp with its clock offset,
      // so the hop back is a delay on AVAILABILITY, never on the timestamp.
      snaps.push({ arriveAt: t + lag(), sampleAt: carryAge ? poseTime : t, x: poseX });
    }

    // The receiver: sixty frames a second, taking delivery as it goes — which
    // is the part the first draft of this check got wrong. Push every snapshot
    // up front and the six-deep buffer holds only the last six, so the whole
    // run interpolates off the end and every step reads as a stall.
    let worst = 0;
    let prev: number | null = null;
    let next = 0;
    for (let t = 0; t <= RUN_MS; t += 1000 / 60) {
      while (next < snaps.length && snaps[next].arriveAt <= t) {
        const sn = snaps[next++];
        track.push(sn.sampleAt, sn.x, 0, 0, ANIM_WALK);
      }
      // Skip the opening, before there is anything to interpolate between.
      if (t < 700 || t > RUN_MS - 400) {
        prev = null;
        continue;
      }
      const p = track.sample(t, INTERP_DELAY_MS);
      if (prev !== null) {
        const drawn = (p.x - prev) / (1 / 60);
        worst = Math.max(worst, Math.abs(drawn - SPEED) / SPEED);
      }
      prev = p.x;
    }
    return worst;
  }

  // A frame loop that runs at roughly 60 fps but not evenly, and a network
  // that delivers between 20 and 90 ms late — an ordinary mobile connection.
  const jr = rng(7);
  const lr = rng(11);
  const jitter = () => 10 + jr() * 14;
  const lag = () => 20 + lr() * 70;

  const before = drift(false, jitter, lag);
  const after = drift(true, jitter, lag);
  ok(
    after < 0.35,
    `a steady walk is drawn steady to within ${(after * 100).toFixed(0)}% of its speed`
  );
  ok(
    after < before * 0.6,
    `carrying each pose's own age more than halves the wobble (${(before * 100).toFixed(0)}% → ${(after * 100).toFixed(0)}%)`
  );

  // …and it must survive a packet going missing entirely, which is what the
  // extrapolation is for.
  // …and a connection that STALLS — the stream is ordered, so a slow packet
  // holds up everything behind it and then the whole lot lands at once. The
  // gap itself cannot be drawn over: nobody knows where the sender went. What
  // can be got right is the return, which is walked off rather than jumped.
  const stalled = drift(true, jitter, () => (lr() < 0.1 ? 400 : 20 + lr() * 70));
  ok(stalled < 3.5, `a stalled stream costs ${(stalled * 100).toFixed(0)}% of walking speed, not a teleport`);

  // The buffer has to be deep enough to hold the jitter it is sized for.
  ok(INTERP_DELAY_MS > 1000 / SNAPSHOT_HZ, "the smoothing window is longer than one snapshot interval");
  ok(EXTRAPOLATE_MS > 1000 / SNAPSHOT_HZ, "and a dropped one can be carried over");
}

// ---------------------------------------------------------------------------
head("The track the console watches back");
{
  const rnd = rng(99);
  let worstPos = 0;
  let worstRot = 0;
  for (let i = 0; i < 20000; i++) {
    const pose = {
      x: (rnd() - 0.5) * 2 * WALK_R,
      z: (rnd() - 0.5) * 2 * WALK_R,
      ry: rnd() * Math.PI * 2,
      anim: Math.floor(rnd() * 3) as 0 | 1 | 2,
    };
    const back = readTrack(packTrack(pose));
    if (!back || back.anim !== pose.anim) {
      worstPos = Infinity;
      break;
    }
    worstPos = Math.max(worstPos, Math.abs(back.x - pose.x), Math.abs(back.z - pose.z));
    worstRot = Math.max(worstRot, Math.abs(angleDelta(pose.ry, back.ry)));
  }
  // Coarser than the live channel on purpose — a moderator does not need
  // centimetres — but it still has to be a position, not an area.
  ok(worstPos < 0.07, `a recorded position survives to within ${(worstPos * 100).toFixed(1)} cm`);
  ok(worstRot < 0.06, `and a facing to within ${((worstRot * 180) / Math.PI).toFixed(1)}°`);
  ok(readTrack(TRACK_LEFT) === null, "a departure is not mistaken for a position");
  const junk = ["", "p", "p1,2", "p1,2,3", "px,2,3,4", "z1,2,3,4", "p1,2,3,4,5"];
  let bad = 0;
  for (const j of junk) {
    try {
      if (readTrack(j) !== null) bad++;
    } catch {
      bad++;
    }
  }
  ok(bad === 0, `and rubbish is refused rather than believed (${bad} of ${junk.length} got through)`);

  // The size of the thing. A session is only archivable if the archive is a
  // sane size, and this is the arithmetic that says so.
  const perPerson = (40 * 60 * 1000) / TRACK_IDLE_MS + (40 * 60 * 1000 * 0.35) / TRACK_MIN_MS;
  const total = perPerson * CAPACITY;
  ok(
    total < 60000,
    `a full forty-minute island is about ${Math.round(total / 1000)}k samples — small enough to keep`
  );
  ok(TRACK_MIN_MS >= 250 && TRACK_MOVE_M > 0, "and a person standing still barely costs anything");
}

// ---------------------------------------------------------------------------
head("The seats");
{
  const game = getGame(GAME_ID);
  ok(!!game, "the game is registered");
  if (game) {
    ok(game.dropIn === true, "it declares itself drop-in, so START never queues");
    ok(
      game.matchSizeFor("solo") === CAPACITY &&
        game.matchSizeFor("duo") === CAPACITY &&
        game.matchSizeFor("squad") === CAPACITY,
      `an island holds ${CAPACITY} whichever mode you start in`
    );
    ok(
      ["walk", "run", "m0", "a1,2", "", "s"].every((k) => !game.isValidInputKind(k)),
      "it accepts no inputs at all — positions are not inputs"
    );
    ok(game.pack.bytes > 0 && game.pack.key !== "", "it has a published pack");
    ok((game.disconnectGraceMs ?? 0) <= 15000, "a dropped socket loses its place within seconds, not minutes");
    const rules = game.rules();
    ok(rules.capacity === CAPACITY && rules.hearMaxM === HEAR_MAX_M, "and tells the client the numbers it needs");
  }
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
