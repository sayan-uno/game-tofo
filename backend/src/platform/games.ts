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

/** What a game is told about the match a sim belongs to.
 *
 *  A runner game simulates each player alone: the seed is the whole world and
 *  nobody can touch anybody. A BOARD game cannot — its players share one board
 *  and knock each other off it — so it keeps one state per MATCH and hands each
 *  runner a view of it. That state has to be keyed on something unique, and a
 *  seed is not: two live matches drawing the same 32-bit number is unlikely,
 *  and silently merging their boards if it happened. Hence the id. */
export interface MatchContext {
  id: string;
  /** Runners in this match, bots included. */
  players: number;
}

/** What the server tells a game about each runner when it asks for the inputs
 *  only the server may author. Deliberately thin: a uid, where they sit, and
 *  the two facts the platform knows that the game cannot. */
export interface ServerRunnerView {
  uid: string;
  seat: number;
  isBot: boolean;
  /** 0…1 for bots, 0 for people. */
  skill: number;
  /** They have walked out; the game may want to stop waiting for them. */
  left: boolean;
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
  /** The hard ceiling on a match, in ticks. */
  durationTicks: number;
  /** How long a match ACTUALLY tends to take, in seconds, when it differs from
   *  the ceiling. A race ends when its clock does, so it leaves this unset; a
   *  board game's clock is the point at which a stalled table is stopped, and
   *  showing that in the picker would misdescribe the game by a factor of two. */
  typicalSec?: number;
  countdownMs: number;
  /** How long a dropped socket keeps its seat before the match gives up on it.
   *  Optional; the platform's own default suits a game that is over in a
   *  minute and a half. A game that runs for twenty-five, and in which a player
   *  legitimately does nothing for minutes while other people take their turns,
   *  wants considerably longer — a lift is not a forfeit. */
  disconnectGraceMs?: number;
  /** Input acceptance window and ceiling (see shared rules). */
  inputLateLimitMs: number;
  inputMaxPerSec: number;
  isValidInputKind(kind: string): boolean;
  /** Build the server's own simulation of a runner. Used to decide when the
   *  match is over because everyone has crashed — the server must know that
   *  itself rather than believe a client that says "I'm out".
   *
   *  `match` is there for games that keep ONE state per match and return a
   *  view of it per runner; a game that simulates each runner independently
   *  can declare the two-argument form and ignore it entirely. */
  createSim(seed: number, seat: number, match: MatchContext): ServerRunnerSim;
  /** Every input a bot will make, planned up front. Planned rather than
   *  reacted to because the server's own sims deliberately lag real time, and
   *  a bot deciding at that lag would emit inputs too late for clients to
   *  apply without a visible rewind. See games/<id>/bot.ts.
   *
   *  Optional: a game whose bots must REACT to the other players supplies
   *  `serverInputs` instead. */
  planBot?(seed: number, seat: number, skill: number): MatchInput[];
  /** Inputs the SERVER itself authors, asked for on the bot release timer.
   *
   *  Two jobs, both impossible anywhere else. One is a bot that has to react:
   *  a board game's bot cannot be planned before the first move, because what
   *  it should do depends on what everyone else did. The other is a number no
   *  player may be allowed to choose — a dice roll. Deriving one from the seed
   *  would be deterministic and also PREDICTABLE, since every client is told
   *  the seed; deciding it here, at the moment of the roll, is not.
   *
   *  Whatever comes back is logged, simulated and relayed exactly like a
   *  player's own input, so it reaches every client — including the one who
   *  rolled — through the ordinary path, and the end-of-match replay treats it
   *  identically. Clients cannot forge these: `isValidInputKind` is what the
   *  input handler checks, and a game keeps its server-only kinds out of it.
   *
   *  Called a few times a second while a match runs; it must be cheap and it
   *  must be idempotent, because it will be asked again before its previous
   *  answer has been simulated. */
  serverInputs?(
    match: MatchContext,
    seed: number,
    tick: number,
    runners: ServerRunnerView[]
  ): { uid: string; input: MatchInput }[];
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
