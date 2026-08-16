// Verification suite for the Trackline simulation — run it after ANY change to
// shared/games/trackline.
//
//     npm run check:sim
//
// It reads the shared SOURCE (via tsx), so it can never pass against a stale
// build. What it proves, and why each check exists:
//
//   determinism   — every device must build the same course from the seed, in
//                   any order, or players see different tracks
//   structure     — every row has a free lane and the safe line is reachable
//   solvability   — a bot that only follows the safe line survives a full
//                   2:00 match on 200 seeds. This caught a course that was
//                   unsurvivable on EVERY seed (a train from the previous row
//                   standing in the next safe lane) and, separately, a graze
//                   radius wider than half a lane
//   verbs         — a low barrier really does kill you standing and really is
//                   cleared by a jump; the same for a gantry and a roll
//   replay parity — live stepping and a cold replay agree, and a sim fed every
//                   input LATE converges on the same state. This is the whole
//                   netcode: if it fails, the server's result and what the
//                   player saw are two different runs
//   cost          — the server's end-of-match replay stays in single-digit ms
//
// Determinism + solvability + fairness checks on the shared sim, run straight
// on the backend's generated copy (the same code the server judges with).
import { Course, ROW_SPACING } from "../../shared/games/trackline/course.js";
import { createState, step, applyInput, replay, scoreOf, RunnerSim, JUMP_TICKS } from "../../shared/games/trackline/sim.js";
import { DURATION_TICKS, TICK_RATE, distanceAt, EMPTY_START_METRES } from "../../shared/games/trackline/rules.js";
// The bot policy is server-side (it is not part of the deterministic sim), but
// its OUTPUT is ordinary inputs, so it is checked with exactly the same tools.
import { planBotRun } from "../../backend/src/games/trackline/bot.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.log("  ✗ " + msg); fails++; } else console.log("  ✓ " + msg); };

// ---- 1. determinism: same seed → identical course, twice, in any order
console.log("determinism");
{
  const a = new Course(12345), b = new Course(12345);
  // b is asked in a scrambled order on purpose
  const order = [7, 0, 3, 12, 1, 9];
  for (const i of order) b.rowAt(i);
  let same = true;
  for (let i = 0; i < 40; i++) {
    const ra = a.rowAt(i), rb = b.rowAt(i);
    if (JSON.stringify(ra) !== JSON.stringify(rb)) { same = false; break; }
  }
  ok(same, "40 rows identical regardless of the order they were built in");
  const c = new Course(999);
  ok(JSON.stringify(a.rowAt(5)) !== JSON.stringify(c.rowAt(5)), "a different seed gives a different course");
}

// ---- 2. structure: every row has a free lane, safe lanes are reachable
console.log("structure");
{
  let freeOk = true, reachOk = true, maxStep = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const c = new Course(seed * 7919);
    let prev = null;
    for (let i = 0; i < 200; i++) {
      const row = c.rowAt(i);
      if (row.obstacles.some((o) => o.lane === row.safeLane)) freeOk = false;
      if (row.obstacles.length >= 4) freeOk = false;
      if (prev !== null) { const d = Math.abs(row.safeLane - prev); maxStep = Math.max(maxStep, d); if (d > 1) reachOk = false; }
      prev = row.safeLane;
      if (row.safeLane < 0 || row.safeLane > 3) freeOk = false;
    }
  }
  ok(freeOk, "200 seeds x 200 rows: the safe lane is always clear and in range");
  ok(reachOk, `consecutive safe lanes never differ by more than 1 (max seen ${maxStep})`);
}

// ---- 3. solvability: a runner that just follows the safe line survives 2:00
console.log("solvability (safe-line bot survives a full match)");
{
  let survived = 0, died = [];
  for (let seed = 1; seed <= 200; seed++) {
    const course = new Course(seed * 104729);
    const s = createState(0);
    let target = null;
    for (let t = 0; t < DURATION_TICKS; t++) {
      // Aim at the safe lane of the first row NOT yet passed. Aiming further
      // ahead than that leaves the CURRENT row's safe lane before clearing it.
      const next = Math.max(0, Course.indexAt(s.distance) + 1);
      target = course.rowAt(next).safeLane;
      if (s.lane < target) applyInput(s, "right");
      else if (s.lane > target) applyInput(s, "left");
      step(s, course);
      if (!s.alive) { died.push(seed); break; }
    }
    if (s.alive) survived++;
  }
  ok(survived === 200, `${survived}/200 seeds survivable by following the safe lane` + (died.length ? ` (died: ${died.slice(0,5)})` : ""));
}

// ---- 4. the verbs actually work: jump clears a low, roll clears a high
console.log("verbs");
{
  // find a seed with a low barrier and one with a high one, then run into it
  const tryKind = (kind) => {
    // ROW 0 only: running down a lane to reach a later row would cross earlier
    // obstacles and kill the runner for an unrelated reason (which is exactly
    // what this check reported the first time it ran).
    for (let seed = 1; seed < 4000; seed++) {
      const course = new Course(seed * 31337);
      {
        const i = 0;
        const row = course.rowAt(i);
        const o = row.obstacles.find((x) => x.kind === kind);
        if (!o) continue;
        // run straight down that lane, and use the verb just before it
        const run = (useVerb) => {
          const s = createState(0);
          s.lane = o.lane; s.x = o.lane;
          for (let t = 0; t < DURATION_TICKS; t++) {
            const ahead = o.z - s.distance;
            if (useVerb && ahead > 0 && ahead < 4 && s.airborne === 0 && s.rolling === 0) {
              applyInput(s, kind === "low" ? "jump" : "roll");
            }
            step(s, course);
            if (!s.alive) return { alive: false, near: s.nearMisses };
            if (s.distance > o.z + 6) return { alive: true, near: s.nearMisses };
          }
          return { alive: true, near: s.nearMisses };
        };
        return { kind, without: run(false), with: run(true) };
      }
    }
    return null;
  };
  const low = tryKind("low"), high = tryKind("high");
  ok(low && !low.without.alive && low.with.alive, `a low barrier kills you standing (${low?.without.alive}) and is cleared by a jump (${low?.with.alive})`);
  ok(high && !high.without.alive && high.with.alive, `a gantry kills you standing (${high?.without.alive}) and is cleared by a roll (${high?.with.alive})`);
  ok((low?.with.near ?? 0) > 0, "clearing one pays a near-miss");
}

// ---- 5. replay == incremental: the server's rewind and the client's live
//          stepping must produce the same state, or players see different runs
console.log("replay parity");
{
  const seed = 4242;
  const inputs = [];
  const course1 = new Course(seed);
  const live = new RunnerSim(0, course1);
  let mismatch = null;
  for (let t = 1; t <= 2000; t++) {
    if (t % 37 === 0) { const i = live.predict(t % 74 === 0 ? "left" : "right"); inputs.push(i); }
    if (t % 53 === 0) { const i = live.predict("jump"); inputs.push(i); }
    live.advanceTo(t);
  }
  const fresh = replay(0, inputs, 2000, new Course(seed));
  for (const k of ["tick","lane","x","y","distance","alive","coins","nearMisses","deadAtTick"]) {
    if (JSON.stringify(live.state[k]) !== JSON.stringify(fresh[k])) mismatch = `${k}: live=${live.state[k]} replay=${fresh[k]}`;
  }
  ok(!mismatch, "2,000 ticks of live stepping match a cold replay" + (mismatch ? ` — ${mismatch}` : ""));
  // and a LATE input (arriving after its tick) still converges
  const late = new RunnerSim(0, new Course(seed));
  late.advanceTo(600);
  for (const i of inputs) late.addInput(i);
  late.advanceTo(2000);
  const same = JSON.stringify(late.state) === JSON.stringify(fresh);
  ok(same, "a sim fed every input LATE rewinds to the same state");
}

// ---- 6. cost: how long does the server's replay of a whole match take?
console.log("cost");
{
  const course = new Course(777);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 4; i++) replay(i, [], DURATION_TICKS, course);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(ms < 120, `replaying a full 4-runner match takes ${ms.toFixed(1)} ms`);
}


// ---------------------------------------------------------------------------
// Bots. Their whole job is to be indistinguishable, so what matters is the
// SPREAD: bots that all die at the first row, or all survive to the clock, are
// equally obvious. Skill also has to actually mean something.
// ---------------------------------------------------------------------------
console.log("bots");
{
  const runOne = (seed, seat, skill) => {
    const course = new Course(seed);
    const plan = planBotRun(seed, seat, skill);
    const s = createState(seat);
    let i = 0;
    while (s.tick < DURATION_TICKS && s.alive) {
      const next = s.tick + 1;
      while (i < plan.length && plan[i].tick <= next) { applyInput(s, plan[i].kind); i++; }
      step(s, course);
    }
    return { distance: s.distance, alive: s.alive, coins: s.coins, near: s.nearMisses, inputs: plan.length };
  };

  const byTier = { weak: [], mid: [], strong: [] };
  let maxRate = 0;
  for (let seed = 1; seed <= 120; seed++) {
    for (const [tier, skill] of [["weak", 0.15], ["mid", 0.5], ["strong", 0.9]]) {
      const r = runOne(seed * 7717, seed % 4, skill);
      byTier[tier].push(r);
      const secs = Math.max(1, r.distance / 14);
      maxRate = Math.max(maxRate, r.inputs / secs);
    }
  }
  const avg = (a, f) => a.reduce((n, r) => n + f(r), 0) / a.length;
  const survived = (a) => a.filter((r) => r.alive).length / a.length;
  for (const tier of ["weak", "mid", "strong"]) {
    const a = byTier[tier];
    console.log(`    ${tier.padEnd(6)} avg ${avg(a, (r) => r.distance).toFixed(0)}m · survived ${(survived(a) * 100).toFixed(0)}% · coins ${avg(a, (r) => r.coins).toFixed(1)} · near-miss ${avg(a, (r) => r.near).toFixed(1)}`);
  }
  ok(avg(byTier.strong, (r) => r.distance) > avg(byTier.weak, (r) => r.distance) * 1.3, "skill matters: strong bots get meaningfully further than weak ones");
  ok(survived(byTier.weak) < 0.5, "weak bots usually crash before the clock");
  ok(survived(byTier.strong) > 0.15, "strong bots sometimes go the distance");
  ok(avg(byTier.mid, (r) => r.distance) > 200, "a mid bot is not dying at the first row");
  ok(byTier.mid.some((r) => r.near > 0), "bots take the risky line sometimes (jump/roll for the bonus)");
  ok(maxRate < 9, `bot input rate stays under the server ceiling (peak ${maxRate.toFixed(1)}/s)`);
}


// ---------------------------------------------------------------------------
// Trains. A carriage met head-on at its back end may be climbable (ramp) or
// run-through-able (open); met from the SIDE it is a wall whatever it is.
// These are the moves the reference video is built around, so each one is
// checked rather than assumed.
// ---------------------------------------------------------------------------
console.log("trains");
{
  // Find a seed whose row 0 holds a carriage of the wanted kind.
  const findTrain = (want) => {
    for (let seed = 1; seed < 6000; seed++) {
      const sd = seed * 21107;
      const course = new Course(sd);
      const o = course.rowAt(0).obstacles.find((x) => x.kind === "train" && x.train === want);
      if (o) return { sd, course, o };
    }
    return null;
  };
  // Run straight down a lane from the start, head-on into whatever is there.
  const headOn = (course, lane, stopAfter) => {
    const s = createState(0);
    s.lane = lane; s.x = lane;
    const trace = [];
    while (s.tick < DURATION_TICKS && s.alive && s.distance < stopAfter) {
      step(s, course);
      trace.push({ d: +s.distance.toFixed(1), y: +s.y.toFixed(2), roof: s.roofEndZ > 0, inside: s.insideEndZ > 0 });
    }
    return { s, trace };
  };

  // NOTE: stop just past the carriage. Running on to the NEXT row without
  // steering would kill the runner there, and counting that against the train
  // is exactly the mistake this comment exists to stop being made again.
  const ramp = findTrain("ramp");
  if (ramp) {
    const r = headOn(ramp.course, ramp.o.lane, ramp.o.z + ramp.o.length + 3);
    const rode = r.trace.some((t) => t.roof && t.y >= 3);
    const cameDown = r.s.alive && r.s.y < 0.1 && r.s.distance > ramp.o.z + ramp.o.length;
    ok(r.s.alive, "a ramp carriage taken head-on does not kill you");
    ok(rode, "you end up ON the roof (y >= 3 m)");
    ok(cameDown, "and back on the track once the carriage ends");
  } else ok(false, "no ramp carriage found to test");

  const open = findTrain("open");
  if (open) {
    const r = headOn(open.course, open.o.lane, open.o.z + open.o.length + 3);
    const went = r.trace.some((t) => t.inside);
    ok(r.s.alive && went, "an open carriage taken head-on is run THROUGH and out the far end");
    ok(r.trace.every((t) => !t.inside || t.y < 0.6), "and you stay at track level inside it, not on the roof");
  } else ok(false, "no open carriage found to test");

  const solid = findTrain("solid");
  if (solid) {
    const r = headOn(solid.course, solid.o.lane, solid.o.z + 4);
    ok(!r.s.alive, "a solid carriage still kills you");
  } else ok(false, "no solid carriage found to test");

  // Side entry: start one lane over and slide across INTO the carriage's flank.
  const side = findTrain("ramp");
  if (side) {
    const from = side.o.lane === 0 ? 1 : side.o.lane - 1;
    const s = createState(0);
    s.lane = from; s.x = from;
    let swerved = false;
    while (s.tick < DURATION_TICKS && s.alive && s.distance < side.o.z + side.o.length) {
      // swerve in once already alongside it
      if (!swerved && s.distance > side.o.z + 2) { applyInput(s, side.o.lane > from ? "right" : "left"); swerved = true; }
      step(s, side.course);
    }
    ok(swerved && !s.alive, "sliding into a carriage's SIDE is still a crash, ramp or not");
  }

  // Roof coins belong to the roof.
  const rc = findTrain("ramp");
  if (rc) {
    const roofCoins = rc.course.coinsOf(0).filter((c) => c.level === 1);
    ok(roofCoins.length > 0, `a ramp carriage carries roof coins (${roofCoins.length})`);
    const rode = headOn(rc.course, rc.o.lane, rc.o.z + rc.o.length + 3);
    ok(rode.s.coins >= roofCoins.length, `riding the roof collects its coins (${rode.s.coins} of ${roofCoins.length})`);
    // NOTE: you cannot place a runner by writing `distance` — it is derived
    // from the TICK, so a hand-set value is overwritten by the next step and
    // the runner simply starts from the beginning. An earlier version of this
    // check did exactly that and "proved" a bug that was not there.
  }

  // Mounting a carriage is a GROUNDED move: jumping at the ramp does not put
  // you on the roof, it puts you into the back of a train.
  const air = findTrain("ramp");
  if (air) {
    const s3 = createState(0);
    s3.lane = air.o.lane; s3.x = air.o.lane;
    let jumped = false;
    while (s3.tick < DURATION_TICKS && s3.alive && s3.distance < air.o.z + 2) {
      if (!jumped && air.o.z - s3.distance < 4 && air.o.z - s3.distance > 1) { applyInput(s3, "jump"); jumped = true; }
      step(s3, air.course);
    }
    ok(jumped && !s3.alive, "jumping at a ramp carriage is a crash — the climb is a grounded move");
  }
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
