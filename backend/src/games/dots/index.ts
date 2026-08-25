// Dots & Boxes — server definition.
//
// The shape is the one Ludo set and carrom refined: many people, one board, and
// the server the only thing allowed to change it —
//
//   * every line. A player's tap is a REQUEST. The server checks it against the
//     live grid — is it that player's turn, is that line still free — and writes
//     the move itself. That is what makes a dropped tap harmless: the platform
//     relays inputs to everyone EXCEPT their sender and acknowledges nothing, so
//     a client that drew its own line would be the one participant who could
//     never learn that nobody else had.
//   * the bots, which must react rather than plan — where the chains are is the
//     sum of every choice anybody has made so far (see bot.ts).
//   * a turn nobody answered, so three people are not held up by a fourth.
//   * an empty chair, so the table stops waiting for someone who has gone.
//
// An INVALID request is simply ignored rather than answered. A line somebody
// else took a moment ago is the commonest thing a finger lands on, and refusing
// it by playing something else on that player's behalf would be worse than
// letting them tap again — so `answered` is only marked once a move is actually
// written.
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
  BOX_COUNT,
  COUNTDOWN_MS,
  DISCONNECT_GRACE_MS,
  DURATION_TICKS,
  DotsSim,
  GAME_ID,
  INPUT_LATE_LIMIT_MS,
  INPUT_MAX_PER_SEC,
  MATCH_SIZE,
  QUIT_KIND,
  TICK_RATE,
  TYPICAL_SEC,
  awaitingServer,
  drawKind,
  hoverKind,
  isInputKind,
  isOut,
  parseInput,
  publicRules,
  replay,
  scoreOf,
  type DotsInput,
  type DotsState,
} from "../../shared/games/dots/index.js";
import { botPlan, canTake, chooseLine, thinkTicks } from "./bot.js";

/** How far ahead of the current tick a server-authored input is stamped.
 *
 *  Four ticks is a fifth of a second at this rate — far enough that the move
 *  reaches every client BEFORE the tick it lands on, so nobody has to rewind
 *  for it, and short enough that a tap still feels answered. */
const LEAD_TICKS = 4;

/** The skill an unanswered turn is played at. Middling on purpose: a player
 *  whose clock ran out should have their turn taken competently enough that the
 *  board keeps moving, and not so well that letting it run out is a strategy. */
const AUTOPLAY_SKILL = 0.45;

/** One live grid per match. */
interface Table {
  sim: DotsSim;
  /** The last LINE each seat asked for — a commit, nothing else. */
  wish: ({ tick: number; line: number } | null)[];
  /** The last time each seat did anything at all: a commit, a hover, a touch.
   *  This is what "are they still there" is decided on, and a hover counts. */
  seen: ({ tick: number } | null)[];
  /** Turn instance the server has already written a move for, as `turn:since`.
   *  Rewriting one would draw two lines on one turn. */
  answered: string;
  /** Thinking time and the plan for the bot holding the current turn. */
  thinkKey: string;
  thinkFrom: number;
  thinkAt: number;
  plan: number[];
  planCursor: number;
  quitSent: boolean[];
  /** Consecutive turns the server had to play for a seat because its time ran
   *  out rather than because its owner said anything. */
  misses: number[];
  /** Tick each seat was declared away, so any request stamped after it means
   *  they are back. -1 when present; MAX_SAFE_INTEGER once a `back` has been
   *  written but the tables have not reached the tick it lands on. */
  awayAt: number[];
  /** Last time anything asked for this table — how a finished match is told
   *  from a live one, since the platform offers no "match collected" hook. */
  touchedAt: number;
}

/** Tables by match id, keyed on the id rather than the seed for the reason the
 *  other board games are: a seed is a 32-bit number two live matches could
 *  share, and merging two grids would be very much worse than keeping one too
 *  long. Reclaimed by IDLENESS — a fixed cap throws away the OLDEST entry,
 *  which on a busy evening is a match somebody is still playing. */
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
    sim: new DotsSim(seed, n, durationTicks()),
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
  if (tables.size > TABLE_ALARM) console.warn(`[dots] ${tables.size} live tables — is the idle sweep working?`);
  return t;
}

/** The match clock, in ticks — read from the environment at call time, exactly
 *  as the other games' are, so the ceiling can be raised with a restart and
 *  nothing else. Guarded, because a clock of nought and a clock of a week both
 *  break every match at once. */
function durationTicks(): number {
  const raw = Number(process.env.DOTS_MATCH_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DURATION_TICKS;
  const seconds = Math.min(3600, Math.max(120, Math.round(raw)));
  return seconds * TICK_RATE;
}

/** A runner's view of the shared grid: its own inputs go in, its own standing
 *  comes out, and the platform never learns that the four of them are one. */
function createSim(seed: number, seat: number, match: MatchContext): ServerRunnerSim {
  const t = tableFor(match, seed);
  return {
    addInput: (input: MatchInput) => {
      t.sim.addInput({ tick: input.tick, seat, kind: input.kind });
      // Remember what they asked for, and separately that they said anything at
      // all. The simulation ignores both; this is how they reach the pass that
      // decides. A HOVER is not a request — see `hoverKind` — so it counts as a
      // sign of life and nothing more.
      const parsed = parseInput(input.kind);
      if (!parsed || seat < 0 || seat >= t.wish.length) return;
      if (parsed.type === "ask" || parsed.type === "hover" || parsed.type === "nudge") {
        t.seen[seat] = { tick: input.tick };
      }
      if (parsed.type === "ask") t.wish[seat] = { tick: input.tick, line: parsed.line };
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
  // The live grid, not a deliberately-lagged one: an answer has to be about the
  // board as it stands. A late input arriving afterwards rewinds this the
  // ordinary way, and the guards below re-answer.
  t.sim.advanceTo(tick);
  const s = t.sim.state;
  const out: { uid: string; input: MatchInput }[] = [];
  const at = Math.min(tick + LEAD_TICKS, durationTicks());

  // An empty chair, once. The table stops waiting for them; the lines they drew
  // stay on the grid and the boxes they took stay theirs.
  for (const r of runners) {
    if (!r.left || r.seat >= t.quitSent.length) continue;
    if (t.quitSent[r.seat] || s.quit[r.seat]) continue;
    t.quitSent[r.seat] = true;
    out.push({ uid: r.uid, input: { tick: at, kind: QUIT_KIND } });
  }
  // Somebody who had stopped answering has touched the screen. Any sign of life
  // will do and it need not be their turn — an absent seat gets no time to
  // think, so waiting for their turn to come round would be waiting for a
  // moment that plays itself.
  for (const r of runners) {
    if (r.isBot || r.left || r.seat >= t.awayAt.length || !s.away[r.seat]) continue;
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
  let line = -1;
  if (holder.isBot) {
    if (t.thinkKey !== key) {
      t.thinkKey = key;
      t.thinkFrom = tick;
      t.thinkAt = tick + thinkTicks(TICK_RATE, canTake(s));
      t.plan = botPlan(s, s.turn, holder.skill);
      t.planCursor = 0;
    }
    // The working, shown on the way to the answer: a line it considered about
    // half way through the thinking, and the real one just before it draws.
    const span = Math.max(1, t.thinkAt - t.thinkFrom);
    const shown = tick >= t.thinkFrom + span * 0.75 ? 2 : tick >= t.thinkFrom + span * 0.35 ? 1 : 0;
    while (t.planCursor < shown && t.planCursor < t.plan.length) {
      out.push({ uid: holder.uid, input: { tick: at, kind: hoverKind(t.plan[t.planCursor++]) } });
    }
    if (tick >= t.thinkAt) line = t.plan[t.plan.length - 1] ?? -1;
  } else {
    const w = t.wish[s.turn];
    if (w && w.tick >= s.since) line = w.line;
  }

  // A line somebody else already took, or one this player asked for before the
  // turn began. Not an answer — say nothing and let them tap again.
  const asked = line >= 0 && s.line[line] < 0;
  if (!asked && !expired) return out;

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

  if (!asked) line = chooseLine(s, s.turn, holder.isBot ? holder.skill : AUTOPLAY_SKILL);
  if (line < 0 || s.line[line] >= 0) return out; // a full grid; the step will end it
  t.answered = key;
  out.push({ uid: holder.uid, input: { tick: at, kind: drawKind(line) } });
  return out;
}

/** The authoritative result: every input replayed onto a fresh grid.
 *
 *  Cold, from the logs, rather than read off the live table — the same
 *  discipline every game here uses. Nothing a client reported about its own
 *  board is consulted, because nothing a client reports is used to play it in
 *  the first place.
 *
 *  Free-for-all, so the placement is simply the box count, and equal counts
 *  share a place — which on a thirty-six box board between two people is a
 *  genuine eighteen-all draw and happens often enough to be worth saying. */
function rank(members: RankMember[], endTick: number, seed: number): Standing[] {
  const players = members.length >= 3 ? 4 : 2;
  const inputs: DotsInput[] = [];
  for (const mbr of members) {
    for (const i of mbr.inputs) inputs.push({ tick: i.tick, seat: mbr.seat, kind: i.kind });
  }
  const s = replay(seed, players, inputs, endTick, durationTicks());
  const rows = members.map((mbr) => {
    const seat = mbr.seat;
    const known = seat >= 0 && seat < s.players;
    // LEAVING IS ONLY A FORFEIT IF YOU LEFT WITH SOMETHING TO PLAY FOR. The
    // grid can be decided while a third of it is still undrawn, and the people
    // most likely to close the tab that second are the ones who just won it.
    const afterTheEnd = mbr.leftAtTick !== null && s.decidedAt >= 0 && mbr.leftAtTick >= s.decidedAt;
    return {
      uid: mbr.uid,
      name: mbr.name,
      seat,
      known,
      forfeit: mbr.left && !afterTheEnd,
      boxes: known ? s.score[seat] : 0,
      detail: {
        boxes: known ? s.score[seat] : 0,
        moves: known ? s.moves[seat] : 0,
        gifts: known ? s.gifts[seat] : 0,
        best: known ? s.best[seat] : 0,
        // So the results card can tell a grid that was won from one the clock
        // stopped, without guessing from the platform's end reason.
        cleared: s.decided ? 1 : 0,
      },
    };
  });
  // Most boxes first; a walk-out is never above somebody who stayed.
  rows.sort((a, b) => Number(a.forfeit) - Number(b.forfeit) || b.boxes - a.boxes);
  const out: Standing[] = [];
  let place = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = rows[i - 1];
    const same = prev && prev.forfeit === r.forfeit && prev.boxes === r.boxes;
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
  name: "Dots & Boxes",
  tagline: "Draw a line. Close a square. Take the chain.",
  matchSizeFor: (mode) => MATCH_SIZE[mode],
  // No pack: a grid of dots is drawn, not downloaded. Zero bytes is what tells
  // the lobby there is nothing to wait for.
  pack: { key: "", version: "none", bytes: 0 },
  rules: () => ({ ...publicRules(), durationTicks: durationTicks() }),
  tickRate: TICK_RATE,
  get durationTicks() {
    return durationTicks();
  },
  typicalSec: TYPICAL_SEC,
  countdownMs: COUNTDOWN_MS,
  // A minute, for the reason every turn game here has one: a player spends most
  // of the match watching somebody else decide, so a dropped connection is
  // invisible to them until it has already cost them the board.
  disconnectGraceMs: DISCONNECT_GRACE_MS,
  inputLateLimitMs: INPUT_LATE_LIMIT_MS,
  inputMaxPerSec: INPUT_MAX_PER_SEC,
  // Requests and hovers only. The move, the empty chair and the away flags are
  // the server's to write, so a client that sends one is refused right here.
  isValidInputKind: (kind) => isInputKind(kind),
  createSim,
  serverInputs,
  rank,
});

/** Dev-only: what the check harness needs to talk about a live table without
 *  reaching into the map. */
export const _tableForTest = (matchId: string): DotsState | undefined => tables.get(matchId)?.sim.state;
export const _boxCount = BOX_COUNT;
