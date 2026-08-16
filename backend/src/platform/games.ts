// The game registry — the ONE place the platform meets a specific game.
//
// A game is a folder under backend/src/games/<id>/ that calls registerGame()
// with a GameServerDefinition. Everything else in backend/src/platform/ (match
// runtime, matchmaking, sockets, results) works through this interface and
// never imports a game directly, so adding a game is a folder + one line in
// games/index.ts, and changing one game can't touch another.
import type { MatchInput, PartyMode, Standing } from "../shared/core/protocol.js";

/** What the ranker sees of each runner at the end of a match. */
export interface RankMember {
  uid: string;
  name: string;
  /** Position in the roster — games derive start lanes/spawns from it. */
  seat: number;
  inputs: MatchInput[];
  /** Left before the end (forfeit) — ranked below everyone who stayed. */
  left: boolean;
  leftAtTick: number | null;
  /** Server-only knowledge; never forwarded to clients. */
  isBot: boolean;
}

/** A live, authoritative simulation of ONE runner, owned by the match runtime.
 *  The game supplies it; the platform only feeds inputs and asks whether the
 *  runner is still going, so the platform never learns what a lane is. */
export interface ServerRunnerSim {
  addInput(input: MatchInput): void;
  advanceTo(tick: number): void;
  isOut(): boolean;
}

export interface GameServerDefinition {
  id: string;
  name: string;
  tagline: string;
  /** Runners a match holds for a party started in this mode. */
  matchSizeFor(mode: PartyMode): number;
  /** The downloadable pack: CDN key prefix (versioned folder) and its size,
   *  so the picker can show honest numbers before a byte is fetched. */
  pack: { key: string; version: string; bytes: number };
  /** Rule numbers the client is told at match:prepare. */
  rules(): Record<string, number>;
  tickRate: number;
  durationTicks: number;
  countdownMs: number;
  /** Input acceptance window and ceiling (see shared rules). */
  inputLateLimitMs: number;
  inputMaxPerSec: number;
  isValidInputKind(kind: string): boolean;
  /** Build the server's own simulation of a runner. Used to decide when the
   *  match is over because everyone has crashed — the server must know that
   *  itself rather than believe a client that says "I'm out". */
  createSim(seed: number, seat: number): ServerRunnerSim;
  /** Authoritative results: replays the shared sim over the input logs, on the
   *  course the match's seed produced. Nothing a client sent is trusted here
   *  beyond the inputs themselves. */
  rank(members: RankMember[], endTick: number, seed: number): Standing[];
}

const games = new Map<string, GameServerDefinition>();

export function registerGame(def: GameServerDefinition): void {
  if (games.has(def.id)) throw new Error(`game "${def.id}" registered twice`);
  games.set(def.id, def);
}

export const getGame = (id: string): GameServerDefinition | undefined => games.get(id);
export const listGames = (): GameServerDefinition[] => [...games.values()];
