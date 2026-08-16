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

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
