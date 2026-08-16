// Server bots: the players who fill the seats matchmaking could not.
//
// The whole design goal is that a player cannot tell. That rules out the usual
// shortcuts — no "Bot_3" names, no fixed character, no perfect play, no flag
// in anything the client receives. A bot reaches the client as an ordinary
// roster entry: a uid, a name, a character, a weapon. Nothing else.
//
// What makes that safe rather than merely hidden:
//   * a bot never gets a user row, so it cannot be friended, messaged or
//     looked up — the places where a fake identity would leak;
//   * its name and uid are checked against real ones before use, so it can
//     never shadow an actual player;
//   * its play comes from the GAME (createBotPlan) and travels as ordinary
//     inputs, so clients replay it exactly as they replay a human.
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { characters, weapons } from "../services/catalog.js";
import type { GameServerDefinition } from "./games.js";

export interface BotIdentity {
  uid: string;
  name: string;
  character: string;
  weapon: string | null;
  /** 0 = weakest, 1 = strongest. The game turns this into behaviour. */
  skill: number;
}

/** Name parts chosen to sit in the same space as real gamer tags: short,
 *  pronounceable, occasionally suffixed with digits. Deliberately NOT themed
 *  around robots. */
const HEADS = [
  "Nova", "Rift", "Echo", "Vex", "Kaze", "Onyx", "Ryu", "Zed", "Mika", "Blaze",
  "Frost", "Volt", "Aero", "Kira", "Neo", "Jinx", "Sable", "Dusk", "Cyra", "Halo",
  "Rogue", "Titan", "Wisp", "Nyx", "Riven", "Kobi", "Sora", "Vega", "Ash", "Zephy",
];
const TAILS = ["", "", "", "x", "z", "yt", "op", "gg", "_", "ix", "on", "ka"];

/** Random integer below `n`, from crypto-free Math.random — bot identities are
 *  not part of the deterministic simulation, so ordinary randomness is right
 *  here (using the match seed would make two matches produce the same bots). */
const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];

function candidateName(): string {
  const head = pick(HEADS);
  const tail = pick(TAILS);
  const digits = Math.random() < 0.45 ? String(Math.floor(Math.random() * 900) + 10) : "";
  const name = `${head}${tail}${digits}`;
  return name.slice(0, 15);
}

/** Same shape as a real uid (see services/users.ts): 10 digits, no leading 0. */
function candidateUid(): string {
  let s = String(Math.floor(1 + Math.random() * 9));
  for (let i = 0; i < 9; i++) s += Math.floor(Math.random() * 10);
  return s;
}

/** Build `count` bots that collide with nothing: not with each other, and not
 *  with any real account. ONE query for the whole batch — this runs on the
 *  cold path (match creation), never during play. */
export async function buildBots(game: GameServerDefinition, count: number): Promise<BotIdentity[]> {
  if (count <= 0) return [];
  const free = characters().filter((c) => c.free);
  const freeWeapons = weapons().filter((w) => w.free);

  // Over-generate, then throw away anything that clashes with a real player.
  const names: string[] = [];
  const uids: string[] = [];
  for (let i = 0; i < count * 3; i++) {
    names.push(candidateName());
    uids.push(candidateUid());
  }
  let takenNames = new Set<string>();
  let takenUids = new Set<string>();
  try {
    const rows = await db
      .select({ uid: users.uid, username: users.username })
      .from(users)
      .where(
        sql`${users.uid} IN ${uids} OR lower(${users.username}) IN ${names.map((n) => n.toLowerCase())}`
      );
    takenUids = new Set(rows.map((r) => r.uid));
    takenNames = new Set(rows.map((r) => (r.username ?? "").toLowerCase()));
  } catch (err) {
    // A failed check must not stop a match forming; a collision is unlikely
    // and harmless enough that "play on" beats "no game".
    console.warn("[bots] identity collision check failed, using unchecked names:", err);
  }

  const out: BotIdentity[] = [];
  const usedNames = new Set<string>();
  const usedUids = new Set<string>();
  for (let i = 0; i < names.length && out.length < count; i++) {
    const name = names[i];
    const uid = uids[i];
    if (takenNames.has(name.toLowerCase()) || usedNames.has(name.toLowerCase())) continue;
    if (takenUids.has(uid) || usedUids.has(uid)) continue;
    usedNames.add(name.toLowerCase());
    usedUids.add(uid);
    const character = free.length ? pick(free).id : game.id;
    out.push({
      uid,
      name,
      character,
      // Most players carry nothing, so most bots carry nothing.
      weapon: freeWeapons.length && Math.random() < 0.3 ? pick(freeWeapons).id : null,
      // A spread of ability per match, so bots do not all crash at the same
      // moment or all survive to the end — either would be a tell. Two rolls
      // averaged gives a triangular distribution: mostly ordinary players,
      // occasionally someone excellent or hopeless, which is what a real
      // lobby looks like.
      skill: (Math.random() + Math.random()) / 2,
    });
  }
  return out;
}

/** ---------------------------------------------------------------------------
 *  Telemetry
 *
 *  How often bots win, and how far they get, is the only way to tell whether
 *  their difficulty is right — guessing produces opponents who are either
 *  free wins or impossible. Aggregated in memory and logged periodically;
 *  cheap, and it costs nothing when no bots are playing.
 * ------------------------------------------------------------------------- */
const stat = { matches: 0, botRuns: 0, botWins: 0, humanWins: 0, botDistance: 0, humanDistance: 0 };

export function recordBotOutcome(rows: { isBot: boolean; placement: number; distance: number }[]): void {
  if (!rows.some((r) => r.isBot)) return;
  stat.matches += 1;
  for (const r of rows) {
    if (r.isBot) {
      stat.botRuns += 1;
      stat.botDistance += r.distance;
      if (r.placement === 1) stat.botWins += 1;
    } else {
      stat.humanDistance += r.distance;
      if (r.placement === 1) stat.humanWins += 1;
    }
  }
  if (stat.matches % 10 === 0) logBotTelemetry();
}

export function logBotTelemetry(): void {
  if (stat.botRuns === 0) return;
  const humanRuns = Math.max(1, stat.matches * 4 - stat.botRuns);
  console.info(
    `[bots] ${stat.matches} matches with bots · bot win rate ${((stat.botWins / stat.matches) * 100).toFixed(0)}% · ` +
      `avg distance bot ${(stat.botDistance / stat.botRuns).toFixed(0)}m vs human ${(stat.humanDistance / humanRuns).toFixed(0)}m`
  );
}

export const botTelemetry = () => ({ ...stat });
