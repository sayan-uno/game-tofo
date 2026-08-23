// Server bots: the players who fill the seats matchmaking could not.
//
// The whole design goal is that a player cannot tell. That rules out the usual
// shortcuts — no "Bot_3" names, no fixed character, no perfect play, no flag
// in anything the client receives. A bot reaches the client as an ordinary
// roster entry: a uid, a name, a character, a weapon. Nothing else.
//
// W1 changed where the identity comes from, and nothing else. A bot used to be
// invented at match creation and thrown away at match end; it is now drawn
// from the persistent pool in platform/botAccounts.ts, so the Nova you lost to
// last night is the same Nova, with the same record, tonight. What makes that
// safe rather than merely convincing:
//
//   * a bot still has no `users` row, so there is no account to sign in to and
//     no credential anywhere that would let one be forged;
//   * its name and uid were checked against real ones when the account was
//     minted, so it can never shadow an actual player;
//   * its play comes from the GAME (createBotPlan) and travels as ordinary
//     inputs, so clients replay it exactly as they replay a human.
import { takeBots, type BotAccount } from "./botAccounts.js";
import type { GameServerDefinition } from "./games.js";

export interface BotIdentity {
  /** The bot account this seat belongs to — what its career is written
   *  against when the match is recorded. */
  botId: string;
  uid: string;
  name: string;
  character: string;
  weapon: string | null;
  /** 0 = weakest, 1 = strongest. The game turns this into behaviour. */
  skill: number;
}

/** One pool account as a match seat. */
export const asIdentity = (bot: BotAccount): BotIdentity => ({
  botId: bot.id,
  uid: bot.uid,
  name: bot.name,
  character: bot.character,
  weapon: bot.weapon,
  skill: bot.skill,
});

/** Build `count` bots for a match, from the pool.
 *
 *  `avoid` keeps a match from seating the same account twice — which happens
 *  for real: a party that walked in with reserved bot seats has already taken
 *  those accounts, and matchmaking is filling what is left.
 *
 *  Cold path only (match creation), never during play. `game` is kept in the
 *  signature because difficulty is a per-game property and the day a game
 *  wants its own selection rule, it belongs here rather than at the call site.
 */
export async function buildBots(
  _game: GameServerDefinition,
  count: number,
  avoid: Set<string> = new Set()
): Promise<BotIdentity[]> {
  if (count <= 0) return [];
  const bots = await takeBots(count, avoid);
  return bots.map(asIdentity);
}

/** ---------------------------------------------------------------------------
 *  Telemetry
 *
 *  How often bots win, and how far they get, is the only way to tell whether
 *  their difficulty is right — guessing produces opponents who are either
 *  free wins or impossible. Aggregated in memory and logged periodically;
 *  cheap, and it costs nothing when no bots are playing.
 * ------------------------------------------------------------------------- */
interface GameStat {
  matches: number;
  botRuns: number;
  humanRuns: number;
  botWins: number;
  humanWins: number;
  /** Only games that report one contribute here (see recordBotOutcome). */
  botDistance: number;
  humanDistance: number;
  hasDistance: boolean;
}

/** Per GAME, not one bucket for all of them.
 *
 *  Difficulty is a property of a game, so mixing two games' numbers makes both
 *  meaningless — and a game with no notion of distance would drag the other's
 *  average towards nought simply by being played. */
const stats = new Map<string, GameStat>();

const statFor = (gameId: string): GameStat => {
  let s = stats.get(gameId);
  if (!s) {
    s = {
      matches: 0,
      botRuns: 0,
      humanRuns: 0,
      botWins: 0,
      humanWins: 0,
      botDistance: 0,
      humanDistance: 0,
      hasDistance: false,
    };
    stats.set(gameId, s);
  }
  return s;
};

/** `distance` is null for games that do not measure one; their rows still
 *  count towards win rates, which is the half of this that every game has. */
export function recordBotOutcome(
  gameId: string,
  rows: { isBot: boolean; placement: number; distance: number | null }[]
): void {
  if (!rows.some((r) => r.isBot)) return;
  const stat = statFor(gameId);
  stat.matches += 1;
  for (const r of rows) {
    if (r.distance !== null) stat.hasDistance = true;
    if (r.isBot) {
      stat.botRuns += 1;
      stat.botDistance += r.distance ?? 0;
      if (r.placement === 1) stat.botWins += 1;
    } else {
      stat.humanRuns += 1;
      stat.humanDistance += r.distance ?? 0;
      if (r.placement === 1) stat.humanWins += 1;
    }
  }
  if (stat.matches % 10 === 0) logBotTelemetry(gameId);
}

/** `only` prints one game's line — what a milestone in THAT game should say.
 *  Called without it (on shutdown, or from a console) it prints them all. */
export function logBotTelemetry(only?: string): void {
  for (const [gameId, stat] of stats) {
    if (only && gameId !== only) continue;
    if (stat.botRuns === 0) continue;
    const dist = stat.hasDistance
      ? ` · avg distance bot ${(stat.botDistance / stat.botRuns).toFixed(0)}m vs human ${(
          stat.humanDistance / Math.max(1, stat.humanRuns)
        ).toFixed(0)}m`
      : "";
    console.info(
      `[bots] ${gameId}: ${stat.matches} matches with bots · bot win rate ` +
        `${((stat.botWins / stat.matches) * 100).toFixed(0)}%${dist}`
    );
  }
}

export const botTelemetry = (): Record<string, GameStat> => Object.fromEntries(stats);
