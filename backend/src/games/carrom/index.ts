// Carrom — server definition.
//
// The shape is Ludo's, because the problem is Ludo's: many people, one board.
// The server keeps ONE table per match and is the only thing allowed to move
// anything on it —
//
//   * every flick. A player's flick is a REQUEST. The server reads it off the
//     live board, checks it against the rules, and writes the shot itself. That
//     is what makes a dropped tap harmless: the platform relays inputs to
//     everyone EXCEPT their sender and acknowledges nothing, so a client that
//     fired its own striker would be the one participant who could never learn
//     that nobody else had.
//   * the bots, which must react rather than plan — where the coins are is the
//     sum of every choice anybody has made so far (see bot.ts).
//   * a turn nobody answered, so three people are not held up by a fourth.
//   * an empty chair, so the table stops waiting for someone who has gone.
//
// What is NOT here is any physics. The flick is four integers and the board is
// shared code; the server runs the identical simulation every client runs, and
// the end-of-match ranking replays it cold from the log. Nothing a client
// reports about its own board is ever consulted, because nothing a client
// reports is used to play it in the first place.
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
  COINS_PER_TEAM,
  COUNTDOWN_MS,
  CarromSim,
  DISCONNECT_GRACE_MS,
  DURATION_TICKS,
  GAME_ID,
  INPUT_LATE_LIMIT_MS,
  INPUT_MAX_PER_SEC,
  MATCH_SIZE,
  QUIT_KIND,
  TICK_RATE,
  TYPICAL_SEC,
  aimKind,
  awaitingServer,
  isInputKind,
  isOut,
  outcome,
  parseInput,
  publicRules,
  replay,
  scoreOf,
  seatsOfTeam,
  shotKind,
  teamOf,
  teamPocketed,
  type CarromInput,
  type CarromState,
  type ShotParams,
} from "../../shared/games/carrom/index.js";
import { chooseShot, thinkTicks } from "./bot.js";

/** How far ahead of the current tick a server-authored input is stamped.
 *
 *  A fifth of a second, and it is a fifth of a second on purpose: far enough
 *  that the shot reaches every client BEFORE the tick it starts on, so nobody
 *  has to rewind for it, and short enough that a flick still feels like it went
 *  off under the thumb that made it. Twelve ticks rather than Ludo's four
 *  because a tick here is a sixtieth of a second rather than a twentieth — the
 *  number that matters is the milliseconds. */
const LEAD_TICKS = 12;

/** The skill an unanswered turn is played at. Middling on purpose: a player who
 *  ran out of time should have their turn taken competently enough that the
 *  board keeps moving, and not so well that letting the clock run out is a
 *  strategy. */
const AUTOPLAY_SKILL = 0.45;

/** One live table per match. */
interface Table {
  sim: CarromSim;
  /** The last thing each seat ASKED FOR — a commit, nothing else. The
   *  simulation ignores requests; this is only how one gets from the socket to
   *  the pass below, which is the one place that reads the board.
   *
   *  Kept apart from `seen` on purpose. A live aim arrives several times a
   *  turn and is not a request to shoot, so if it shared this slot it would
   *  either fire the striker the moment a thumb moved or — arriving a moment
   *  late, out of order — overwrite the commit and mean the shot was never
   *  taken at all. */
  wish: ({ tick: number; kind: string } | null)[];
  /** The last time each seat did ANYTHING: a commit, an aim, a touch. This is
   *  what "are they still there" is decided on, and an aim counts. */
  seen: ({ tick: number } | null)[];
  /** Turn instance the server has already written an answer for, as
   *  `turn:since`. Rewriting one would put two strikers on one flick. */
  answered: string;
  /** Thinking time for the bot holding the current turn, drawn once. */
  thinkKey: string;
  thinkFrom: number;
  thinkAt: number;
  /** The shot a bot settled on the moment it started thinking, and the one or
   *  two half-formed versions of it that it shows the table on the way there.
   *
   *  A BOT THAT NEVER APPEARS TO AIM IS A BOT ANYONE CAN SPOT. Every human at
   *  this table broadcasts their placement and their angle while they think
   *  (see `aimKind`), so a seat that goes from nothing to a struck striker is
   *  the one tell no roster entry can hide. Deciding up front and then showing
   *  the working is also the only order that can be honest: the aim a bot shows
   *  is the shot it actually takes. */
  plan: ShotParams[];
  planCursor: number;
  quitSent: boolean[];
  /** Consecutive turns the server had to play for a seat because its time ran
   *  out rather than because its owner said anything. */
  misses: number[];
  /** Tick each seat was declared away, so any request stamped after it means
   *  they are back. -1 when present; MAX_SAFE_INTEGER once a `back` has been
   *  written but the tables have not reached the tick it lands on — the same
   *  one-answer-per-question guard `answered` gives the flick. */
  awayAt: number[];
  /** Last time anything asked for this table — how a finished match is told
   *  from a live one, since the platform offers no "match collected" hook. */
  touchedAt: number;
}

/** Tables by match id, keyed on the id rather than the seed for the reason
 *  Ludo's are: a seed is a 32-bit number two live matches could share, and
 *  merging two boards would be very much worse than keeping one too long.
 *
 *  Reclaimed by IDLENESS, not by count — a fixed cap throws away the OLDEST
 *  entry, which on a busy evening is a match somebody is still playing. */
const tables = new Map<string, Table>();
const TABLE_IDLE_MS = 2 * 60_000;
/** Not a limit — a number large enough that reaching it means the sweep is
 *  broken rather than that the evening is busy. */
const TABLE_ALARM = 5000;

function tableFor(match: MatchContext, seed: number): Table {
  const now = Date.now();
  const found = tables.get(match.id);
  if (found) {
    found.touchedAt = now;
    return found;
  }
  for (const [id, old] of tables) if (now - old.touchedAt > TABLE_IDLE_MS) tables.delete(id);
  const n = match.players >= 3 ? 4 : 2;
  const t: Table = {
    sim: new CarromSim(seed, n, durationTicks()),
    wish: Array.from({ length: n }, () => null),
    seen: Array.from({ length: n }, () => null),
    answered: "",
    thinkKey: "",
    thinkFrom: 0,
    thinkAt: 0,
    plan: [],
    planCursor: 0,
    quitSent: Array.from({ length: n }, () => false),
    misses: Array.from({ length: n }, () => 0),
    awayAt: Array.from({ length: n }, () => -1),
    touchedAt: now,
  };
  tables.set(match.id, t);
  if (tables.size > TABLE_ALARM) console.warn(`[carrom] ${tables.size} live tables — is the idle sweep working?`);
  return t;
}

/** The match clock, in ticks — read from the environment at call time, exactly
 *  as the other games' are, so the ceiling can be raised with a restart and
 *  nothing else. Guarded, because a clock of nought and a clock of a week both
 *  break every match at once. */
function durationTicks(): number {
  const raw = Number(process.env.CARROM_MATCH_SECONDS);
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
      // Remember what they asked for, and separately that they said anything
      // at all. The simulation ignores both; this is how they reach the pass
      // that decides.
      const parsed = parseInput(input.kind);
      if (!parsed || seat < 0 || seat >= t.wish.length) return;
      if (parsed.type === "ask" || parsed.type === "aim" || parsed.type === "nudge") {
        t.seen[seat] = { tick: input.tick };
      }
      if (parsed.type === "ask") t.wish[seat] = { tick: input.tick, kind: input.kind };
    },
    advanceTo: (tick: number) => t.sim.advanceTo(tick),
    isOut: () => isOut(t.sim.state, seat),
  };
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
  // The live board, not a deliberately-lagged one: an answer has to be about
  // the table as it stands. A late input arriving afterwards rewinds this the
  // ordinary way, and the guards below re-answer.
  t.sim.advanceTo(tick);
  const s = t.sim.state;
  const out: { uid: string; input: MatchInput }[] = [];
  const at = Math.min(tick + LEAD_TICKS, durationTicks());

  // An empty chair, once. The table stops waiting for them and skips their
  // turns from here on; their side's coins stay in play for their partner.
  for (const r of runners) {
    if (!r.left || r.seat >= t.quitSent.length) continue;
    if (t.quitSent[r.seat] || s.quit[r.seat]) continue;
    t.quitSent[r.seat] = true;
    out.push({ uid: r.uid, input: { tick: at, kind: QUIT_KIND } });
  }
  // Somebody who had stopped answering has touched the screen. Any request will
  // do and it need not be their turn — an absent seat gets no time to think, so
  // waiting for their turn to come round would be waiting for a moment that
  // plays itself.
  for (const r of runners) {
    if (r.isBot || r.left || r.seat >= t.awayAt.length || !s.away[r.seat]) continue;
    // ANY sign of life, not just a commit: somebody who has started sliding
    // their striker about is plainly back at the table.
    const w = t.seen[r.seat];
    if (!w || w.tick <= t.awayAt[r.seat]) continue;
    t.misses[r.seat] = 0;
    t.awayAt[r.seat] = Number.MAX_SAFE_INTEGER;
    out.push({ uid: r.uid, input: { tick: at, kind: BACK_KIND } });
  }
  if (s.over || !awaitingServer(s)) return out;

  const holder = runners.find((r) => r.seat === s.turn);
  if (!holder) return out;
  const key = `${s.turn}:${s.since}`;
  if (t.answered === key) return out;

  // Out of time is the one thing that overrides everything: whoever the chair
  // belongs to, the turn gets played so the others are not held up.
  const expired = tick >= s.deadline;
  let asked = false;
  if (holder.isBot) {
    if (t.thinkKey !== key) {
      t.thinkKey = key;
      t.thinkFrom = tick;
      t.thinkAt = tick + thinkTicks(TICK_RATE);
      t.plan = botPlan(s, s.turn, holder.skill);
      t.planCursor = 0;
    }
    // The working, shown on the way to the answer. Two beats: something roughly
    // right about half way through the thinking, and the real thing just before
    // the flick — which is what a person's aim looks like from the other side
    // of the board.
    const span = Math.max(1, t.thinkAt - t.thinkFrom);
    const shown = tick >= t.thinkFrom + span * 0.8 ? 2 : tick >= t.thinkFrom + span * 0.4 ? 1 : 0;
    while (t.planCursor < shown && t.planCursor < t.plan.length) {
      const a = t.plan[t.planCursor++];
      out.push({ uid: holder.uid, input: { tick: at, kind: aimKind(a.t, a.dx, a.dy, a.p) } });
    }
    asked = tick >= t.thinkAt;
  } else {
    const w = t.wish[s.turn];
    asked = Boolean(w && w.tick >= s.since && parseInput(w.kind)?.type === "ask");
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

  // The flick itself. A person's own if they made one and it is still about
  // this turn; otherwise the bot policy — which is what plays for a bot, for a
  // seat that has gone quiet, and for a turn whose clock ran out.
  let shot = null as ReturnType<typeof chooseShot> | null;
  if (!holder.isBot && asked) {
    const w = t.wish[s.turn];
    const parsed = w ? parseInput(w.kind) : null;
    if (parsed && parsed.type === "ask") shot = parsed.shot;
  }
  // A bot plays the shot it has been showing the table, not a fresh one — the
  // aim it advertised has to be the aim it takes.
  if (!shot && holder.isBot && t.plan.length > 0) shot = t.plan[t.plan.length - 1];
  if (!shot) shot = chooseShot(s, s.turn, holder.isBot ? holder.skill : AUTOPLAY_SKILL);
  out.push({ uid: holder.uid, input: { tick: at, kind: shotKind(shot.t, shot.dx, shot.dy, shot.p) } });
  return out;
}

/** A bot's turn, decided up front: the shot it will take, preceded by a rougher
 *  version of it to show while it "thinks".
 *
 *  The rough one is the real one with the angle knocked sideways and the weight
 *  moved — a plausible first idea, not a random one, because the point is to
 *  look like somebody adjusting rather than like somebody twitching. */
function botPlan(s: CarromState, seat: number, skill: number): ShotParams[] {
  const shot = chooseShot(s, seat, skill);
  const swing = 40 + Math.round(Math.random() * 90);
  const side = Math.random() < 0.5 ? -1 : 1;
  const rough: ShotParams = {
    t: Math.max(-1000, Math.min(1000, shot.t + side * Math.round(swing * 1.4))),
    dx: Math.max(-1000, Math.min(1000, shot.dx + side * swing)),
    dy: shot.dy,
    p: Math.max(0, Math.min(1000, shot.p + side * 60)),
  };
  // The parser refuses a direction of nothing; the clamps above cannot produce
  // one from a real aim, but a plan is not worth a crash if they ever did.
  if (rough.dx === 0 && rough.dy === 0) rough.dy = 1000;
  return [rough, shot];
}

/** The authoritative result: every input replayed onto a fresh board.
 *
 *  Cold, from the logs, rather than read off the live table — the same
 *  discipline the runner uses.
 *
 *  Carrom has two SIDES and not four places, so the placement is the side's:
 *  partners share it, because they shared the board. The score beside it is
 *  personal — how many that player put down themselves, and whether they were
 *  the one who covered the queen — which is what tells two team-mates apart on
 *  a table where they both say "1". */
function rank(members: RankMember[], endTick: number, seed: number): Standing[] {
  const players = members.length >= 3 ? 4 : 2;
  const inputs: CarromInput[] = [];
  for (const mbr of members) {
    for (const i of mbr.inputs) inputs.push({ tick: i.tick, seat: mbr.seat, kind: i.kind });
  }
  const s = replay(seed, players, inputs, endTick, durationTicks());
  let won = outcome(s);
  // A SIDE THAT WALKED OUT LOSES THE BOARD, however the coins happened to be
  // sitting when it did. The simulation already knows this — a `quit` input
  // reaches it and the board ends — but a match can end BEFORE that input has
  // been simulated, because the platform ranks the moment the last person
  // leaves. Without this, a table that was level on coins comes out as an
  // honest draw with a walk-out in it. Only ever applied to a board that play
  // did not decide, so it can never overturn a real result.
  if (!s.decided) {
    const walkedOut = (team: number): boolean =>
      seatsOfTeam(team, s.players).every((seat) => members.some((m) => m.seat === seat && m.left));
    const a = walkedOut(0);
    const b = walkedOut(1);
    if (a !== b) won = a ? 1 : 0;
  }
  return members.map((mbr) => {
    const seat = mbr.seat;
    const known = seat >= 0 && seat < s.players;
    const team = known ? teamOf(seat, s.players) : -1;
    // LEAVING IS ONLY A FORFEIT IF YOU LEFT WITH SOMETHING TO PLAY FOR.
    //
    // Ludo's lesson in its carrom form: the board ends the instant a side
    // clears its ninth coin, and the people most likely to close the tab that
    // second are the pair who just won it. Ranking them as walk-outs would put
    // the winners below the losers and dock their XP for winning.
    const afterTheEnd = mbr.leftAtTick !== null && s.decidedAt >= 0 && mbr.leftAtTick >= s.decidedAt;
    const forfeit = mbr.left && !afterTheEnd;
    // A draw shares first place; otherwise the winning side is first and the
    // other is second. Nobody is ever third at carrom — but somebody who walked
    // out is never first, even on a side that won without them and even on a
    // board that ended level. A table on which the person who left is listed
    // joint first is a table nobody believes.
    const placement = forfeit ? 2 : won < 0 || team === won ? 1 : 2;
    return {
      uid: mbr.uid,
      name: mbr.name,
      placement,
      score: known ? scoreOf(s, seat, placement) : 0,
      detail: {
        coins: known ? s.coinsBy[seat] : 0,
        team: team < 0 ? 0 : team,
        board: known ? teamPocketed(s, team) : 0,
        queen: known && s.queenBy === seat ? 1 : 0,
        fouls: known ? s.fouls[seat] : 0,
        // So the results card can tell a board that was won from one the clock
        // stopped, without having to guess from the platform's end reason.
        cleared: known && s.decided && team === won ? 1 : 0,
      },
      forfeit,
    };
  });
}

registerGame({
  id: GAME_ID,
  name: "Carrom",
  tagline: "Flick, cut, pocket. Take the queen and cover her.",
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
  // A minute, for Ludo's reason: a carrom player spends most of the match
  // watching somebody else line a shot up, so a dropped connection is invisible
  // to them until it has already cost them the board — and the table loses
  // nothing by waiting, because their turns get played.
  disconnectGraceMs: DISCONNECT_GRACE_MS,
  inputLateLimitMs: INPUT_LATE_LIMIT_MS,
  inputMaxPerSec: INPUT_MAX_PER_SEC,
  // Requests only. The shot, the empty chair and the away flags are the
  // server's to write, so a client that sends one is refused right here.
  isValidInputKind: (kind) => isInputKind(kind),
  createSim,
  serverInputs,
  rank,
});

/** Dev-only: what the check harness needs to talk about a live table without
 *  reaching into the map. */
export const _tableForTest = (matchId: string): CarromState | undefined => tables.get(matchId)?.sim.state;
export const _tableTurn = (matchId: string): number => tables.get(matchId)?.sim.state.turn ?? 0;
export const _coinsPerTeam = COINS_PER_TEAM;
