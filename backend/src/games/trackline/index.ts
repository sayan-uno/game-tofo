// Trackline — server definition. Rules come from the shared copy so the
// client's numbers and the server's are the same file; ranking replays the
// shared sim over the input logs, so the result of record is computed by the
// same code the client used to show the run.
import { registerGame, type RankMember } from "../../platform/games.js";
import type { Standing } from "../../shared/core/protocol.js";
import {
  COUNTDOWN_MS,
  DURATION_TICKS,
  GAME_ID,
  INPUT_LATE_LIMIT_MS,
  INPUT_MAX_PER_SEC,
  MATCH_SIZE,
  TICK_RATE,
  isInputKind,
  publicRules,
  replay,
  scoreOf,
  type RunnerInput,
} from "../../shared/games/trackline/index.js";
import { PACK } from "./pack.js";

function rank(members: RankMember[], endTick: number): Standing[] {
  const rows = members.map((mbr) => {
    const upTo = mbr.left && mbr.leftAtTick !== null ? Math.min(mbr.leftAtTick, endTick) : endTick;
    const state = replay(mbr.seat, mbr.inputs as RunnerInput[], upTo);
    return {
      uid: mbr.uid,
      name: mbr.name,
      forfeit: mbr.left,
      score: scoreOf(state),
      detail: { distance: Math.floor(state.distance), lane: state.lane, ticks: upTo },
      // Sort key: everyone who stayed above everyone who forfeited; then score;
      // then, among forfeits, whoever lasted longer.
      key: [mbr.left ? 0 : 1, scoreOf(state), upTo] as const,
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
  rank,
});
