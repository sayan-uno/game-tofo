// Trackline — server definition. Rules come from the shared copy so the
// client's numbers and the server's are the same file; ranking replays the
// shared sim over the input logs, so the result of record is computed by the
// same code the client used to show the run.
import { registerGame, type RankMember, type ServerRunnerSim } from "../../platform/games.js";
import type { Standing } from "../../shared/core/protocol.js";
import {
  COUNTDOWN_MS,
  Course,
  DURATION_TICKS,
  GAME_ID,
  INPUT_LATE_LIMIT_MS,
  INPUT_MAX_PER_SEC,
  MATCH_SIZE,
  TICK_RATE,
  isInputKind,
  publicRules,
  replay,
  RunnerSim,
  scoreOf,
  type InputKind,
  type RunnerInput,
} from "../../shared/games/trackline/index.js";
import { PACK } from "./pack.js";
import { planBotRun } from "./bot.js";

/** The authoritative result: every runner's inputs replayed over the course
 *  the seed produced. Nothing the client reported about its own run is used —
 *  scores, coins and deaths are all recomputed here.
 *
 *  Ordering: whoever is still running beats whoever crashed, then score, then
 *  (among the fallen) whoever lasted longer. Forfeits rank below everyone who
 *  stayed. Equal on all three is a genuine tie and shares the placement. */
function rank(members: RankMember[], endTick: number, seed: number): Standing[] {
  const course = courseFor(seed);
  const rows = members.map((mbr) => {
    const upTo = mbr.left && mbr.leftAtTick !== null ? Math.min(mbr.leftAtTick, endTick) : endTick;
    const state = replay(mbr.seat, mbr.inputs as RunnerInput[], upTo, course);
    const survived = state.alive && !mbr.left;
    return {
      uid: mbr.uid,
      name: mbr.name,
      forfeit: mbr.left,
      score: scoreOf(state),
      detail: {
        distance: Math.floor(state.distance),
        coins: state.coins,
        nearMisses: state.nearMisses,
        survived: survived ? 1 : 0,
        diedAtTick: state.deadAtTick,
        ticks: upTo,
      },
      // Sort key: still running > crashed > forfeited; then score; then how
      // long they lasted.
      key: [mbr.left ? 0 : survived ? 2 : 1, scoreOf(state), state.alive ? upTo : state.deadAtTick] as const,
    };
  });
  rows.sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2]);
  // Shared placements: equal keys share the same place (a draw at the top).
  const out: Standing[] = [];
  let place = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = rows[i - 1];
    if (!prev || prev.key[0] !== r.key[0] || prev.key[1] !== r.key[1] || prev.key[2] !== r.key[2]) place = i + 1;
    out.push({ uid: r.uid, name: r.name, placement: place, score: r.score, detail: r.detail, forfeit: r.forfeit });
  }
  return out;
}

/** One course per seed, shared by every runner's sim in that match (they all
 *  run the same track) and by the ranking replay. Held weakly by match id so a
 *  finished match's course is collectable. */
const courses = new Map<number, Course>();
const courseFor = (seed: number): Course => {
  let c = courses.get(seed);
  if (!c) {
    c = new Course(seed);
    courses.set(seed, c);
    // A course is a few hundred small objects; keeping the last handful is
    // cheaper than rebuilding rows for every late input, and unbounded growth
    // is the only thing worth avoiding.
    if (courses.size > 32) courses.delete(courses.keys().next().value as number);
  }
  return c;
};

function createSim(seed: number, seat: number): ServerRunnerSim {
  const sim = new RunnerSim(seat, courseFor(seed));
  return {
    addInput: (input) => sim.addInput({ tick: input.tick, kind: input.kind as InputKind }),
    advanceTo: (tick) => sim.advanceTo(tick),
    isOut: () => !sim.state.alive,
  };
}

registerGame({
  id: GAME_ID,
  name: "Trackline",
  tagline: "Four rails. Two minutes. Last one running wins.",
  matchSizeFor: (mode) => MATCH_SIZE[mode],
  pack: { key: PACK.key, version: PACK.version, bytes: PACK.bytes },
  rules: publicRules,
  tickRate: TICK_RATE,
  durationTicks: DURATION_TICKS,
  countdownMs: COUNTDOWN_MS,
  inputLateLimitMs: INPUT_LATE_LIMIT_MS,
  inputMaxPerSec: INPUT_MAX_PER_SEC,
  isValidInputKind: (kind) => isInputKind(kind),
  createSim,
  planBot: planBotRun,
  rank,
});
