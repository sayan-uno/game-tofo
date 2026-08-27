// Social Space — server definition.
//
// It is the first DROP-IN game on the platform: pressing START does not queue
// for a match to be assembled, it walks the party into an island that is
// already running (platform/island.ts). Everything a match runtime would ask
// of a game — a simulation, a ranking, a bot plan — is not asked for here, so
// the stubs below are declared honestly as stubs rather than dressed up as
// behaviour nobody calls.
//
// What this file DOES decide is the two things the platform must know before
// the island exists: how big one is, and what a client has to download before
// it can stand in it.
import { registerGame, type RankMember, type ServerRunnerSim } from "../../platform/games.js";
import type { Standing } from "../../shared/core/protocol.js";
import { CAPACITY, GAME_ID, SESSION_MS, TICK_RATE, publicRules } from "../../shared/games/social/index.js";
import { PACK } from "./pack.js";

/** Nobody is ranked for standing in a park. The island writes its own leaving
 *  card (how long you were there, how many people you stood next to) and never
 *  calls this — it exists because every game declares one. */
function rank(members: RankMember[]): Standing[] {
  return members.map((m) => ({
    uid: m.uid,
    name: m.name,
    placement: 1,
    score: 0,
    detail: {},
    forfeit: false,
  }));
}

/** Likewise: the platform builds one of these per runner in a MATCH, and an
 *  island is not one. Never out, never advanced. */
function createSim(): ServerRunnerSim {
  return { addInput: () => {}, advanceTo: () => {}, isOut: () => false };
}

registerGame({
  id: GAME_ID,
  name: "Social Space",
  tagline: "An island for twenty. Walk over and say something.",
  dropIn: true,
  matchSizeFor: () => CAPACITY,
  pack: { key: PACK.key, version: PACK.version, bytes: PACK.bytes },
  rules: () => publicRules(),
  tickRate: TICK_RATE,
  durationTicks: Math.round((SESSION_MS / 1000) * TICK_RATE),
  typicalSec: Math.round(SESSION_MS / 1000),
  countdownMs: 0,
  // Ten seconds and no longer — a body standing motionless in front of
  // somebody is worse than an empty seat. See DISCONNECT_GRACE_MS.
  disconnectGraceMs: 10_000,
  inputLateLimitMs: 0,
  inputMaxPerSec: 0,
  // There are no inputs. Not "none yet" — the position channel is deliberately
  // not one (see platform/island.ts), so anything arriving on match:input is
  // either a bug or a client trying it on, and both are refused here.
  isValidInputKind: () => false,
  createSim,
  rank,
});
