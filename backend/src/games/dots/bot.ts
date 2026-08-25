// The Dots & Boxes bot: which line to draw, and how long to look like it
// thought about it.
//
// This is the first game on the platform where the bot IS the difficulty. There
// is no dice to be lucky with and no flick to mishit: both players see the
// whole board and the whole future of it, so a bot that plays greedily is a bot
// anybody beats every time, and one that plays properly is genuinely hard. So
// it plays properly, and `skill` decides how often it takes its own advice.
//
// THE THREE THINGS THAT MATTER, in the order a player learns them:
//
//   1. Take a box when you can, and keep taking. Free boxes are free.
//   2. Never hand one over. A line that gives a box its third side gives that
//      box away, so play a SAFE line while any exists.
//   3. When every line gives something away — which is most of the endgame —
//      give away the SMALLEST chain. The whole middlegame is manoeuvring to be
//      the player who does not have to open the long one.
//
// And the fourth thing, which is what separates a good player from a beginner
// and is the reason this file is not fifty lines: the DOUBLE-CROSS. Eating a
// chain to the end means you must open the next one. Leaving the last two boxes
// of it instead — a move that scores nothing — hands the opponent two boxes and
// hands you the whole of the next chain. See `doubleCross` below.
//
// NOTHING HERE IS PART OF THE DETERMINISTIC SIMULATION. It may use Math.random
// freely, because its output is one integer that goes through exactly the same
// input path a person's tap does — and that integer is what every table replays.
import {
  BOX_LINES,
  BOX_COUNT,
  LINE_BOXES,
  LINE_COUNT,
  type DotsState,
} from "../../shared/games/dots/index.js";

/** Ordinary randomness: a bot's choice is not part of the deterministic
 *  simulation (its OUTPUT is), so seeding it from the match would only make
 *  every match with the same seed play out identically. Injectable so the
 *  self-check can pin it. */
export type Rand = () => number;

/** Below this a bot never double-crosses — it eats every chain to the end,
 *  which is exactly what a player who has not learnt the trick does. */
const DOUBLE_CROSS_SKILL = 0.55;

/** ---------------------------------------------------------------------------
 *  A shadow grid: the two arrays the rules actually turn on, and nothing else.
 *
 *  The bot tries hundreds of hypothetical moves per turn, and copying a whole
 *  simulation state for each of them would be copying eight arrays to look at
 *  two. This is those two.
 * ------------------------------------------------------------------------- */
interface Grid {
  line: number[];
  box: number[];
}

const shadow = (s: DotsState): Grid => ({ line: s.line.slice(), box: s.box.slice() });

function sidesIn(g: Grid, box: number): number {
  const lines = BOX_LINES[box];
  let n = 0;
  for (let i = 0; i < 4; i++) if (g.line[lines[i]] >= 0) n++;
  return n;
}

/** How many boxes drawing this line would close, right now. */
function closesIn(g: Grid, line: number): number {
  const boxes = LINE_BOXES[line];
  let n = 0;
  for (let i = 0; i < boxes.length; i++) if (g.box[boxes[i]] < 0 && sidesIn(g, boxes[i]) === 3) n++;
  return n;
}

/** Draw a line on the shadow and return how many boxes it closed. */
function drawIn(g: Grid, line: number): number {
  g.line[line] = 0;
  let n = 0;
  for (const box of LINE_BOXES[line]) {
    if (g.box[box] < 0 && sidesIn(g, box) === 4) {
      g.box[box] = 0;
      n++;
    }
  }
  return n;
}

/** How many boxes whoever moves next could take in one unbroken run, taking
 *  everything greedily. This is the length of the chain that is on offer, and
 *  it is the number the whole endgame is played over. Mutates the grid. */
function eatIn(g: Grid): number {
  let taken = 0;
  for (;;) {
    let found = -1;
    for (let l = 0; l < LINE_COUNT; l++) {
      if (g.line[l] < 0 && closesIn(g, l) > 0) {
        found = l;
        break;
      }
    }
    if (found < 0) return taken;
    taken += drawIn(g, found);
  }
}

/** Would this line leave any box with three sides — that is, would it hand a
 *  box to whoever plays next? */
function gives(g: Grid, line: number): boolean {
  for (const box of LINE_BOXES[line]) {
    if (g.box[box] < 0 && sidesIn(g, box) === 2) return true;
  }
  return false;
}

/** Lines that close nothing and give nothing away. While one of these exists
 *  there is no reason at all to play anything else. */
function safeLines(g: Grid): number[] {
  const out: number[] = [];
  for (let l = 0; l < LINE_COUNT; l++) {
    if (g.line[l] >= 0) continue;
    if (closesIn(g, l) > 0) continue;
    if (gives(g, l)) continue;
    out.push(l);
  }
  return out;
}

/** The cheapest thing to give away, when everything gives something away.
 *
 *  Every candidate is played out in full: the line is drawn and then the
 *  opponent is allowed to eat everything they can, which is exactly what they
 *  will do. The line that feeds them least is the move. */
function smallestSacrifice(g: Grid, from: readonly number[]): { line: number; cost: number } {
  let best = -1;
  let cost = Number.MAX_SAFE_INTEGER;
  for (const l of from) {
    const t = { line: g.line.slice(), box: g.box.slice() };
    drawIn(t, l);
    const fed = eatIn(t);
    if (fed < cost) {
      cost = fed;
      best = l;
    }
  }
  return { line: best, cost: best < 0 ? 0 : cost };
}

/** THE DOUBLE-CROSS.
 *
 *  With two boxes left in the chain you are eating, you have a choice. Take
 *  them, and you have then run out of free boxes and must open the next chain
 *  for your opponent. Or play a line that scores NOTHING and leaves those two
 *  boxes sitting there: your opponent takes them — two boxes, a real cost — and
 *  is then the one who must open the next chain, which is usually worth far
 *  more than two.
 *
 *  Looked for as a shape rather than reasoned about: a free line that closes
 *  nothing, after which the opponent's greedy run is EXACTLY two and then stops.
 *  Returns -1 when the position has no such move, which is most positions. */
function doubleCross(g: Grid): number {
  for (let l = 0; l < LINE_COUNT; l++) {
    if (g.line[l] >= 0) continue;
    if (closesIn(g, l) > 0) continue;
    const t = { line: g.line.slice(), box: g.box.slice() };
    drawIn(t, l);
    if (eatIn(t) === 2) return l;
  }
  return -1;
}

/** What is left to play for once the boxes on offer have been eaten. Zero means
 *  this run finishes the board, and giving two away to keep a turn nobody will
 *  ever take is simply losing two boxes. */
function boxesBeyond(g: Grid): number {
  const t = { line: g.line.slice(), box: g.box.slice() };
  eatIn(t);
  let open = 0;
  for (let b = 0; b < BOX_COUNT; b++) if (t.box[b] < 0) open++;
  return open;
}

/** The line this bot plays. Always LEGAL — the caller has already established
 *  the grid is not full — so the server can write it as the move without a
 *  second opinion. */
export function chooseLine(s: DotsState, _seat: number, skill: number, rand: Rand = Math.random): number {
  const sk = skill < 0 ? 0 : skill > 1 ? 1 : skill;
  const g = shadow(s);
  const free: number[] = [];
  for (let l = 0; l < LINE_COUNT; l++) if (g.line[l] < 0) free.push(l);
  if (free.length === 0) return 0;
  if (free.length === 1) return free[0];

  // How often it takes its own advice. The weakest bot still plays the right
  // move two times in five, which is roughly what somebody who has understood
  // rule 1 and none of the others does.
  const follows = 0.4 + 0.55 * sk;
  if (rand() >= follows) return free[Math.floor(rand() * free.length) % free.length];

  // ---- 1. take what is free -------------------------------------------
  const capture: number[] = [];
  for (const l of free) if (closesIn(g, l) > 0) capture.push(l);
  if (capture.length > 0) {
    if (sk >= DOUBLE_CROSS_SKILL) {
      const onOffer = (() => {
        const t = { line: g.line.slice(), box: g.box.slice() };
        return eatIn(t);
      })();
      // Only ever at the very end of a chain, and only while there is a board
      // left to win with the turn it buys.
      if (onOffer === 2 && boxesBeyond(g) > 2) {
        const dc = doubleCross(g);
        if (dc >= 0) {
          // What the turn is worth: after they have taken the two, what would
          // they have to open for us? Anything over two and the trade is on.
          const t = { line: g.line.slice(), box: g.box.slice() };
          drawIn(t, dc);
          eatIn(t);
          const rest: number[] = [];
          for (let l = 0; l < LINE_COUNT; l++) if (t.line[l] < 0) rest.push(l);
          const safe = safeLines(t);
          const worth = safe.length > 0 ? BOX_COUNT : smallestSacrifice(t, rest).cost;
          if (worth > 2) return dc;
        }
      }
    }
    return capture[Math.floor(rand() * capture.length) % capture.length];
  }

  // ---- 2. play a line that costs nothing -------------------------------
  const safe = safeLines(g);
  if (safe.length > 0) return safe[Math.floor(rand() * safe.length) % safe.length];

  // ---- 3. give away as little as possible ------------------------------
  const sac = smallestSacrifice(g, free);
  return sac.line >= 0 ? sac.line : free[0];
}

/** ---------------------------------------------------------------------------
 *  Thinking time. A bot that answered the instant its turn began would be the
 *  one tell no roster entry can hide, so it waits — briefly while it is eating
 *  a chain, which is a decision anybody makes at once, and longer over the move
 *  that opens one, which is the move a person actually thinks about.
 * ------------------------------------------------------------------------- */
const THINK_QUICK = [0.35, 0.8]; // seconds, while taking free boxes
const THINK_REAL = [0.9, 2.2];

/** Ticks to wait before moving, drawn once per turn — the caller remembers it,
 *  because redrawing it every poll would fire the bot at the first low sample. */
export function thinkTicks(tickRate: number, taking: boolean, rand: Rand = Math.random): number {
  const [lo, hi] = taking ? THINK_QUICK : THINK_REAL;
  return Math.round((lo + (hi - lo) * rand()) * tickRate);
}

/** Is there a box on offer right now? Only used to decide how long to pause. */
export function canTake(s: DotsState): boolean {
  const g = shadow(s);
  for (let l = 0; l < LINE_COUNT; l++) if (g.line[l] < 0 && closesIn(g, l) > 0) return true;
  return false;
}

/** A bot's turn, decided up front: the line it will draw, preceded by a line it
 *  "considered" first.
 *
 *  A SEAT THAT NEVER APPEARS TO HOVER IS A SEAT ANYONE CAN SPOT. Every human at
 *  this table broadcasts the line their finger is over while they think, so a
 *  bot that goes from nothing to a drawn line is the tell. Deciding up front and
 *  then showing the working is also the only order that can be honest: the line
 *  a bot hovers last is the line it draws. */
export function botPlan(s: DotsState, seat: number, skill: number, rand: Rand = Math.random): number[] {
  const line = chooseLine(s, seat, skill, rand);
  const free: number[] = [];
  for (let l = 0; l < LINE_COUNT; l++) if (s.line[l] < 0 && l !== line) free.push(l);
  if (free.length === 0) return [line];
  // A first idea somewhere else on the board, then the real one.
  const decoy = free[Math.floor(rand() * free.length) % free.length];
  return [decoy, line];
}
