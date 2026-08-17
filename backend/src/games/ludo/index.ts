// Ludo — server definition.
//
// The board is the difference. A runner's server keeps one independent
// simulation per player and never has to decide anything; Ludo's keeps ONE
// table per match and decides everything on it:
//
//   * the dice. A face derived from the match seed would be deterministic and
//     also readable in advance by any client, since every client is told the
//     seed. This one comes out of the system's random source at the moment of
//     the roll and is published as an ordinary input, so it is unguessable
//     before it happens and identical for everyone after.
//   * every played token. A player's tap is a REQUEST; the server checks it
//     against the live board and writes the move itself. That is what makes a
//     dropped tap harmless — the platform relays inputs to everyone except
//     their sender and acknowledges nothing, so a client that applied its own
//     move would have no way of learning that nobody else did.
//   * the bots, which must react rather than plan (see bot.ts).
//   * an empty chair, so the table stops waiting for someone who has gone.
//
// Everything else is the platform's, unchanged: the same input envelope, the
// same relay, the same replay at the end.
import { randomInt } from "node:crypto";
import {
  registerGame,
  type MatchContext,
  type RankMember,
  type ServerRunnerSim,
  type ServerRunnerView,
} from "../../platform/games.js";
import type { MatchInput, Standing } from "../../shared/core/protocol.js";
import {
  AWAY_AFTER_MISSES,
  AWAY_KIND,
  BACK_KIND,
  COUNTDOWN_MS,
  DISCONNECT_GRACE_MS,
  DURATION_TICKS,
  GAME_ID,
  INPUT_LATE_LIMIT_MS,
  INPUT_MAX_PER_SEC,
  LudoSim,
  MATCH_SIZE,
  QUIT_KIND,
  TICK_RATE,
  TYPICAL_SEC,
  awaitingServer,
  dieKind,
  isInputKind,
  isOut,
  legalMoves,
  parseInput,
  playKind,
  progressOf,
  publicRules,
  replay,
  scoreOf,
  tokensHome,
  type LudoInput,
  type LudoState,
} from "../../shared/games/ludo/index.js";
import { chooseToken, thinkTicks } from "./bot.js";

/** How far ahead of the current tick a server-authored input is stamped.
 *
 *  Far enough that it reaches every client BEFORE that tick is simulated, so
 *  nobody has to rewind for it — the same trick, and roughly the same margin,
 *  the platform uses when it releases a planned bot's inputs early. */
const LEAD_TICKS = 4;

/** One live table per match. */
interface Table {
  sim: LudoSim;
  /** The last thing each seat ASKED for. The server decides whether it
   *  happens; this is only how the request gets from the socket to the pass
   *  below, which is the one place that reads the board. */
  wish: ({ tick: number; kind: string } | null)[];
  /** Phase instance the server has already written an answer for, as
   *  `turn:phase:since`. Rewriting one would put two dice on one roll. */
  answered: string;
  /** Thinking time for the bot holding the current phase, drawn once. */
  thinkKey: string;
  thinkAt: number;
  quitSent: boolean[];
  /** Consecutive questions the server had to answer for a seat because its
   *  time ran out rather than because its owner said anything. */
  misses: number[];
  /** Tick each seat was declared away, so any request stamped after it means
   *  they are back — whosever turn it happens to be. -1 when the seat is
   *  present; MAX_SAFE_INTEGER once a `back` has been written but the tables
   *  have not reached the tick it lands on, which is the same
   *  one-answer-per-question guard `answered` gives the dice. */
  awayAt: number[];
  /** Last time anything asked for this table — how a finished match is told
   *  from a live one, since the platform offers no "match collected" hook. */
  touchedAt: number;
}

/** Tables by match id, keyed on the id rather than the seed because a seed is
 *  a 32-bit number that two live matches could conceivably share, and merging
 *  two boards would be a great deal worse than keeping one too long.
 *
 *  Reclaimed by IDLENESS, not by count. A fixed cap looks tidy and is a trap:
 *  the entry it throws away when a busy evening pushes past it is the OLDEST
 *  one, which on a platform playing many matches at once is a match still
 *  being played — and the next thing to ask for it would be handed a brand new
 *  empty board to author dice onto while four people watched their own board
 *  stop moving. A live table is touched several times a second, so one nothing
 *  has asked about for two minutes is finished, and nothing else is. */
const tables = new Map<string, Table>();
const TABLE_IDLE_MS = 2 * 60_000;
/** Not a limit — a number of live matches large enough that reaching it means
 *  something is wrong with the sweep rather than with the evening. */
const TABLE_ALARM = 5000;

function tableFor(match: MatchContext, seed: number): Table {
  const now = Date.now();
  const found = tables.get(match.id);
  if (found) {
    found.touchedAt = now;
    return found;
  }
  for (const [id, old] of tables) if (now - old.touchedAt > TABLE_IDLE_MS) tables.delete(id);
  const n = Math.max(2, Math.min(4, match.players));
  const t: Table = {
    sim: new LudoSim(seed, n, durationTicks()),
    wish: Array.from({ length: n }, () => null),
    answered: "",
    thinkKey: "",
    thinkAt: 0,
    quitSent: Array.from({ length: n }, () => false),
    misses: Array.from({ length: n }, () => 0),
    awayAt: Array.from({ length: n }, () => -1),
    touchedAt: now,
  };
  tables.set(match.id, t);
  if (tables.size > TABLE_ALARM) console.warn(`[ludo] ${tables.size} live tables — is the idle sweep working?`);
  return t;
}

/** The match clock, in ticks — read from the environment at call time, exactly
 *  as the runner's is, so the ceiling can be raised with a restart and nothing
 *  else. Guarded, because a clock of nought and a clock of a week both break
 *  every match at once. */
function durationTicks(): number {
  const raw = Number(process.env.LUDO_MATCH_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DURATION_TICKS;
  const seconds = Math.min(3600, Math.max(120, Math.round(raw)));
  return seconds * TICK_RATE;
}

/** A runner's view of the shared table: its own inputs go in, its own standing
 *  comes out, and the platform never learns that the four of them are one. */
function createSim(seed: number, seat: number, match: MatchContext): ServerRunnerSim {
  const t = tableFor(match, seed);
  return {
    addInput: (input: MatchInput) => {
      t.sim.addInput({ tick: input.tick, seat, kind: input.kind });
      // Remember what they asked for. The simulation ignores requests; this is
      // how one reaches the pass that decides.
      const parsed = parseInput(input.kind);
      if (parsed && (parsed.type === "ask-roll" || parsed.type === "ask-play")) {
        if (seat >= 0 && seat < t.wish.length) t.wish[seat] = { tick: input.tick, kind: input.kind };
      }
    },
    advanceTo: (tick: number) => t.sim.advanceTo(tick),
    isOut: () => isOut(t.sim.state, seat),
  };
}

/** Does this request belong to the question currently being asked? */
function wishFits(kind: string, phase: LudoState["phase"]): boolean {
  const parsed = parseInput(kind);
  if (!parsed) return false;
  if (phase === "roll") return parsed.type === "ask-roll";
  if (phase === "pick") return parsed.type === "ask-play";
  return false;
}

/** Everything the server has to say this instant. Called a few times a second
 *  while a match runs, and idempotent: it will be asked again long before its
 *  previous answer has been simulated, which is what `answered` is for. */
function serverInputs(
  match: MatchContext,
  seed: number,
  tick: number,
  runners: ServerRunnerView[]
): { uid: string; input: MatchInput }[] {
  const t = tableFor(match, seed);
  // The live turn, not the deliberately-lagged one the outcome poll uses: an
  // answer has to be about the board as it stands. A late input that arrives
  // afterwards rewinds this the ordinary way, and the guards below re-answer.
  t.sim.advanceTo(tick);
  const s = t.sim.state;
  const out: { uid: string; input: MatchInput }[] = [];
  const at = Math.min(tick + LEAD_TICKS, durationTicks());

  // An empty chair, once. The table stops waiting for them and skips their
  // turns from here on; their tokens stay on the board to be knocked about.
  for (const r of runners) {
    if (!r.left || r.seat >= t.quitSent.length) continue;
    if (t.quitSent[r.seat] || s.quit[r.seat]) continue;
    t.quitSent[r.seat] = true;
    out.push({ uid: r.uid, input: { tick: at, kind: QUIT_KIND } });
  }
  // Somebody who had stopped answering has touched the screen. Any request
  // will do and it need not be their turn — an absent seat gets no time to
  // think, so waiting for their turn to come round would be waiting for a
  // moment that plays itself.
  for (const r of runners) {
    if (r.isBot || r.left || r.seat >= t.awayAt.length || !s.away[r.seat]) continue;
    const w = t.wish[r.seat];
    if (!w || w.tick <= t.awayAt[r.seat]) continue;
    t.misses[r.seat] = 0;
    t.awayAt[r.seat] = Number.MAX_SAFE_INTEGER;
    out.push({ uid: r.uid, input: { tick: at, kind: BACK_KIND } });
  }
  if (s.over || !awaitingServer(s)) return out;

  const holder = runners.find((r) => r.seat === s.turn);
  if (!holder) return out;
  const key = `${s.turn}:${s.phase}:${s.since}`;
  if (t.answered === key) return out;

  // Out of time is the one thing that overrides everything: whoever the chair
  // belongs to, the turn gets played so the other three are not held up.
  const expired = tick >= s.deadline;
  const choosing = s.phase === "pick";
  let asked = false;
  if (holder.isBot) {
    if (t.thinkKey !== key) {
      t.thinkKey = key;
      t.thinkAt = tick + thinkTicks(TICK_RATE, choosing);
    }
    asked = tick >= t.thinkAt;
  } else {
    const w = t.wish[s.turn];
    asked = Boolean(w && w.tick >= s.since && wishFits(w.kind, s.phase));
  }
  if (!asked && !expired) return out;
  t.answered = key;

  // Who actually decided this — them, or the clock? Enough of the latter in a
  // row and the table stops holding a turn open for a chair nobody is sitting
  // in. Bots are never away: they always answer.
  if (!holder.isBot && s.turn < t.misses.length) {
    if (asked) {
      t.misses[s.turn] = 0;
    } else if (++t.misses[s.turn] >= AWAY_AFTER_MISSES && !s.away[s.turn] && t.awayAt[s.turn] < 0) {
      t.awayAt[s.turn] = at;
      out.push({ uid: holder.uid, input: { tick: at, kind: AWAY_KIND } });
    }
  }

  if (!choosing) {
    // The die. Nobody — not the player, not the seed, not a modified client —
    // knows this before now.
    out.push({ uid: holder.uid, input: { tick: at, kind: dieKind(randomInt(1, 7)) } });
    return out;
  }

  const moves = legalMoves(s, s.turn, s.die);
  if (moves.length === 0) return out; // the simulation never asks with none
  let token = moves[0];
  if (holder.isBot) {
    token = chooseToken(s, s.turn, holder.skill);
  } else {
    const w = t.wish[s.turn];
    const parsed = w && w.tick >= s.since ? parseInput(w.kind) : null;
    // Their choice if it is still legal; otherwise the first legal token,
    // which is also what an expired turn gets.
    if (parsed && parsed.type === "ask-play" && moves.includes(parsed.token)) token = parsed.token;
  }
  out.push({ uid: holder.uid, input: { tick: at, kind: playKind(token) } });
  return out;
}

/** The authoritative result: every input replayed onto a fresh board.
 *
 *  Cold, from the logs, rather than read off the live table — the same
 *  discipline the runner uses. Nothing a client reported about its own game is
 *  consulted, because nothing a client reports is used to play it in the first
 *  place.
 *
 *  Ordering: whoever stayed beats whoever walked out, then whoever finished
 *  beats whoever did not, then who finished FIRST, then tokens home, squares
 *  covered and knock-outs. Equal on all of it is a genuine tie and shares the
 *  placement. */
function rank(members: RankMember[], endTick: number, seed: number): Standing[] {
  const players = Math.max(2, Math.min(4, members.length));
  const inputs: LudoInput[] = [];
  for (const mbr of members) {
    for (const i of mbr.inputs) inputs.push({ tick: i.tick, seat: mbr.seat, kind: i.kind });
  }
  const s = replay(seed, players, inputs, endTick, durationTicks());
  const rows = members.map((mbr) => {
    const seat = mbr.seat;
    const known = seat >= 0 && seat < s.players;
    const finished = known && s.homeAt[seat] >= 0;
    // Leaving is only a forfeit if you left with something still to play for.
    //
    // Ludo runs on after the first player is home — the others are still
    // racing for second and third — so the winner is precisely the person with
    // nothing left to do, and quite likely to close the tab. Treating that as
    // walking out would rank whoever won the game below everyone who lost it,
    // and dock their XP for it.
    const bailed = mbr.left && !finished;
    return {
      uid: mbr.uid,
      name: mbr.name,
      seat,
      known,
      forfeit: bailed,
      detail: {
        home: known ? tokensHome(s, seat) : 0,
        captures: known ? s.captures[seat] : 0,
        squares: known ? progressOf(s, seat) : 0,
        finished: finished ? 1 : 0,
      },
      // Sort key, most significant first. A finished player's key carries the
      // NEGATED tick they finished on, so earlier is larger is better.
      key: [
        bailed ? 0 : 1,
        finished ? 1 : 0,
        finished ? -s.homeAt[seat] : 0,
        known ? tokensHome(s, seat) : 0,
        known ? progressOf(s, seat) : 0,
        known ? s.captures[seat] : 0,
      ] as const,
    };
  });
  rows.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return b.key[i] - a.key[i];
    return 0;
  });
  // Placements first, then scores FROM them — the score is a place plus a
  // bounded garnish, so the table can never print a lower place with a bigger
  // number beside it. See the note above PLACE_POINTS.
  const out: Standing[] = [];
  let place = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = rows[i - 1];
    const same = prev && prev.key.every((v, k) => v === r.key[k]);
    if (!same) place = i + 1;
    out.push({
      uid: r.uid,
      name: r.name,
      placement: place,
      score: r.known ? scoreOf(s, r.seat, place) : 0,
      detail: r.detail,
      forfeit: r.forfeit,
    });
  }
  return out;
}

registerGame({
  id: GAME_ID,
  name: "Ludo",
  tagline: "Roll, race, and knock them all the way home.",
  matchSizeFor: (mode) => MATCH_SIZE[mode],
  // No pack: the board is drawn, not downloaded. Zero bytes is what tells the
  // lobby there is nothing to wait for.
  pack: { key: "", version: "none", bytes: 0 },
  rules: () => ({ ...publicRules(), durationTicks: durationTicks() }),
  tickRate: TICK_RATE,
  get durationTicks() {
    return durationTicks();
  },
  typicalSec: TYPICAL_SEC,
  countdownMs: COUNTDOWN_MS,
  // A minute, not twenty seconds. A Ludo player is doing nothing for minutes at
  // a time by design — they are watching three other people take turns — so a
  // dropped connection is invisible to them until it has already cost them the
  // match, and the table loses nothing by waiting: their turns auto-play.
  disconnectGraceMs: DISCONNECT_GRACE_MS,
  inputLateLimitMs: INPUT_LATE_LIMIT_MS,
  inputMaxPerSec: INPUT_MAX_PER_SEC,
  // Only the two request kinds. The dice, the played token and the empty chair
  // are server-written, so a client that sends one is refused right here.
  isValidInputKind: (kind) => isInputKind(kind),
  createSim,
  serverInputs,
  rank,
});
