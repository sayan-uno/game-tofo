// The carrom bot: where to set the striker, where to aim it, and how hard.
//
// It cannot be planned. A runner's bot knows its whole course before the match
// starts and nobody can interfere with it, so its entire run is written up
// front (games/trackline/bot.ts). A board bot knows none of that: where the
// coins are is the sum of every choice everybody has made so far. So this
// decides one flick at a time, on the server's own copy of the board, and its
// answer travels as an ordinary input — the same channel, the same relay, the
// same replay.
//
// HOW IT AIMS: the ghost ball, which is how people aim too. To send a coin into
// a pocket, the striker has to arrive at the point one striker-plus-coin radius
// behind that coin on the line from the pocket — the "ghost". So the bot walks
// its own coins against the four pockets, works out each ghost, and asks
// whether it can reach it: is there a place on the base line the ghost is
// visible from, is anything in the way, and is the cut thin enough to be
// pointless. What comes out is scored, and `skill` decides how often the bot
// actually plays the best one it found and how straight it hits it.
//
// NOTHING HERE IS PART OF THE DETERMINISTIC SIMULATION. It may use Math.random
// and any trigonometry it likes, because its output is four integers that go
// through exactly the same input path a person's flick does — and those four
// integers are what every table replays.
import {
  COIN_COUNT,
  COIN_R,
  FRICTION,
  KIND_QUEEN,
  MAX_SPEED,
  MIN_SPEED,
  POCKETS,
  STRIKER_R,
  baseSpot,
  coinTeam,
  queenAllowed,
  sideOf,
  slotFree,
  teamOf,
  toLocal,
  toWorld,
  type CarromState,
  type ShotParams,
} from "../../shared/games/carrom/index.js";

/** Ordinary randomness: a bot's choice is not part of the deterministic
 *  simulation (its OUTPUT is), so seeding it from the match would only make
 *  every match with the same seed play out identically. Injectable so the
 *  self-check can pin it. */
export type Rand = () => number;

/** Striker placements tried per target. Twenty-five across the base line is
 *  about a striker's width apart, which is as finely as the difference between
 *  two placements can matter. */
const SLOTS = 25;

/** A cut thinner than this transfers almost nothing to the coin — it is the
 *  shot that looks perfect and leaves the coin where it was. Measured as the
 *  cosine of the angle between where the striker is going and where the coin
 *  has to go, so no trigonometry is needed to reject one. */
const MIN_CUT = 0.34;

/** ---------------------------------------------------------------------------
 *  What a shot is worth. Same made-up unit throughout; only the ordering
 *  matters and the comments say what each number buys.
 * ------------------------------------------------------------------------- */
/** A straight-on shot beats a thin one, by a lot. */
const V_CUT = 140;
/** Every board unit the striker or the coin has to travel is a unit of things
 *  going wrong. The coin's journey counts for more: it is the half of the shot
 *  the bot cannot correct. */
const V_STRIKER_DIST = -9;
const V_COIN_DIST = -16;
/** The queen is worth going for — it is a coin AND another shot. */
const V_QUEEN = 70;
/** Clearing the last of a colour wins the board outright. */
const V_MATCH_POINT = 240;

interface Candidate {
  shot: ShotParams;
  value: number;
}

/** Is anything in the way between two points, ignoring `skip`? `clear` is how
 *  much room the traveller needs either side of the line. */
function pathClear(
  s: CarromState,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  clear: number,
  skip: number
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0) return true;
  for (let i = 0; i < COIN_COUNT; i++) {
    if (!s.alive[i] || i === skip) continue;
    const ox = s.x[i] - ax;
    const oy = s.y[i] - ay;
    let t = (ox * dx + oy * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = ax + dx * t - s.x[i];
    const cy = ay + dy * t - s.y[i];
    if (cx * cx + cy * cy < clear * clear) return false;
  }
  return true;
}

/** How hard to hit it.
 *
 *  The striker has to still be moving when it gets there, and the coin has to
 *  reach the pocket after taking only part of the striker's speed — a thin cut
 *  takes less. Constant deceleration makes the sums easy: a disc travelling at
 *  v covers v²/(2·FRICTION), so the speed needed to cover d is √(2·FRICTION·d).
 *  Everything after that is a fudge factor for restitution and the fact that
 *  arriving with nothing to spare is how a coin stops on the lip. */
function powerFor(strikerDist: number, coinDist: number, cut: number): number {
  const coinSpeed = Math.sqrt(2 * FRICTION * (coinDist + 0.25));
  // Only the component along the cut is passed on, and the collision is not
  // perfectly elastic between unequal masses.
  const needAtImpact = coinSpeed / Math.max(MIN_CUT, cut) / 1.25;
  const need = Math.sqrt(needAtImpact * needAtImpact + 2 * FRICTION * strikerDist);
  const p = (need - MIN_SPEED) / (MAX_SPEED - MIN_SPEED);
  return p < 0.12 ? 0.12 : p > 1 ? 1 : p;
}

/** Every shot worth considering, best first. */
function candidates(s: CarromState, seat: number): Candidate[] {
  const side = sideOf(seat, s.players);
  const team = teamOf(seat, s.players);
  const takeQueen = queenAllowed(s, team);
  const out: Candidate[] = [];

  // How many of our own are left — the last one is worth reaching for.
  let mine = 0;
  for (let i = 0; i < COIN_COUNT; i++) {
    if (s.alive[i] && coinTeam(s.kind[i]) === team) mine++;
  }

  for (let coin = 0; coin < COIN_COUNT; coin++) {
    if (!s.alive[coin]) continue;
    const isQueen = s.kind[coin] === KIND_QUEEN;
    if (isQueen ? !takeQueen : coinTeam(s.kind[coin]) !== team) continue;
    const cx = s.x[coin];
    const cy = s.y[coin];
    for (const pocket of POCKETS) {
      const px = cx - pocket.x;
      const py = cy - pocket.y;
      const pl = Math.hypot(px, py);
      if (pl <= 0) continue;
      // The ghost: where the striker's centre has to be at the moment of
      // contact for the coin to set off towards this pocket.
      const gap = COIN_R + STRIKER_R;
      const gx = cx + (px / pl) * gap;
      const gy = cy + (py / pl) * gap;
      // The coin's own road has to be clear as well.
      if (!pathClear(s, cx, cy, pocket.x, pocket.y, COIN_R * 1.85, coin)) continue;

      for (let k = 0; k < SLOTS; k++) {
        const t = (k / (SLOTS - 1)) * 2 - 1;
        if (!slotFree(side, t, s.x, s.y, s.alive)) continue;
        const local = baseSpot(t);
        const from = toWorld(side, local.x, local.y);
        const ax = gx - from.x;
        const ay = gy - from.y;
        const al = Math.hypot(ax, ay);
        if (al < gap) continue; // the ghost is under our feet
        // In the shooter's own frame the aim must go INTO the board.
        // Any direction: the aim is no longer forward-only, so a coin behind
        // the base line is a shot like any other.
        const aimLocal = toLocal(side, ax / al, ay / al);
        // How square the hit is: the striker's line against the coin's line.
        const cut = (ax / al) * (-px / pl) + (ay / al) * (-py / pl);
        if (cut < MIN_CUT) continue;
        if (!pathClear(s, from.x, from.y, gx, gy, COIN_R + STRIKER_R * 0.92, coin)) continue;

        let value = V_CUT * cut + V_STRIKER_DIST * al + V_COIN_DIST * pl;
        if (isQueen) value += V_QUEEN;
        else if (mine === 1) value += V_MATCH_POINT;
        out.push({
          shot: {
            t: Math.round(t * 1000),
            dx: Math.round(aimLocal.x * 1000),
            dy: Math.round(aimLocal.y * 1000),
            p: Math.round(powerFor(al, pl, cut) * 1000),
          },
          value,
        });
      }
    }
  }
  out.sort((a, b) => b.value - a.value);
  return out;
}

/** When there is no shot on: hit SOMETHING, and prefer one of ours.
 *
 *  This is the opening break and every safety shot after it, and it must aim at
 *  a disc rather than at a place. An earlier version aimed at the centre of
 *  gravity of the bot's own coins, which on a scattered board is very often a
 *  patch of empty felt — the striker sailed straight past everything, which is
 *  a foul, and a weak bot spent whole matches doing it. Aim at a coin the
 *  striker can actually see, and contact is a certainty rather than a hope. */
function touchShot(s: CarromState, seat: number, rand: Rand): ShotParams {
  const side = sideOf(seat, s.players);
  const team = teamOf(seat, s.players);
  let best: { t: number; aim: { x: number; y: number } } | null = null;
  // Ours before theirs, and the nearest of whichever we settle on: one number,
  // smallest wins, no special cases.
  let bestRank = Infinity;
  for (let coin = 0; coin < COIN_COUNT; coin++) {
    if (!s.alive[coin]) continue;
    const mine = coinTeam(s.kind[coin]) === team;
    for (let k = 0; k < SLOTS; k++) {
      const t = (k / (SLOTS - 1)) * 2 - 1;
      if (!slotFree(side, t, s.x, s.y, s.alive)) continue;
      const local = baseSpot(t);
      const from = toWorld(side, local.x, local.y);
      const ax = s.x[coin] - from.x;
      const ay = s.y[coin] - from.y;
      const al = Math.hypot(ax, ay);
      if (al < COIN_R + STRIKER_R) continue;
      const aim = toLocal(side, ax / al, ay / al);
      if (!pathClear(s, from.x, from.y, s.x[coin], s.y[coin], COIN_R + STRIKER_R * 0.92, coin)) continue;
      const rank = (mine ? 0 : 100) + al;
      if (rank >= bestRank) continue;
      bestRank = rank;
      best = { t, aim };
    }
  }
  if (!best) {
    // Nothing is visible from anywhere on the line. Fire up the middle: the
    // walls will bring the striker back through the board.
    return { t: 0, dx: 0, dy: 1000, p: 620 + Math.round(rand() * 300) };
  }
  return {
    t: Math.round(best.t * 1000),
    dx: Math.round(best.aim.x * 1000),
    dy: Math.round(best.aim.y * 1000),
    // Hard enough to scatter, not so hard that it comes back off two walls into
    // its own pocket.
    p: 420 + Math.round(rand() * 300),
  };
}

/** The flick this bot takes. Always legal: the placement is checked against the
 *  live board and the aim always goes forwards, so the server can write it as
 *  the shot without a second opinion. */
export function chooseShot(s: CarromState, seat: number, skill: number, rand: Rand = Math.random): ShotParams {
  const sk = skill < 0 ? 0 : skill > 1 ? 1 : skill;
  const list = candidates(s, seat);
  let shot: ShotParams;
  if (list.length === 0) {
    shot = touchShot(s, seat, rand);
  } else {
    // How often it takes its own advice. The weakest bot still finds a real
    // shot a third of the time, which is roughly what a distracted person does;
    // the rest of the time it plays something else it had considered rather
    // than something silly, because a person who misjudges a board still hits
    // a coin.
    const follows = 0.45 + 0.5 * sk;
    if (rand() < follows) {
      shot = list[0].shot;
    } else {
      // The alternative is another shot it was already considering — a person
      // who misjudges a board still hits a coin, they just hit the wrong one.
      const spread = Math.min(list.length, 4 + Math.round((1 - sk) * 8));
      shot = list[Math.floor(rand() * spread) % spread].shot;
    }
  }
  // And how straight it hits it. At full skill this is a third of a degree; at
  // none of it, nearly three — enough to catch the wrong half of a coin from
  // across the board, which is exactly what a weak player does.
  const wobble = (1 - sk) * 44 + 6;
  const dx = shot.dx + Math.round((rand() * 2 - 1) * wobble);
  const dy = shot.dy;
  // A WEAK SHOT IS NOT A SHOT THAT NEVER ARRIVES.
  //
  // The weight error is a FRACTION of the shot, never a fixed number of power
  // points. As a fixed number it happily took a shot that wanted a power of 150
  // down to nothing at all, the striker rolled to a stop short of the coin, and
  // that is a foul — which was the single largest thing wrong with this bot:
  // the weakest ones fouled a hundred and fifty times a board and no game ever
  // finished. A person can hit softly, and a person can hit the wrong coin, but
  // nobody flicks so gently that the striker stops halfway across the board.
  const slip = 1 + (rand() * 2 - 1) * ((1 - sk) * 0.34 + 0.06);
  const cx = Math.max(-1000, Math.min(1000, dx));
  const cy = Math.max(-1000, Math.min(1000, dy));
  return {
    t: Math.max(-1000, Math.min(1000, shot.t)),
    // A direction of nothing is refused by the parser, so the one arrangement
    // of numbers that could produce it is nudged rather than sent.
    dx: cx === 0 && cy === 0 ? 0 : cx,
    dy: cx === 0 && cy === 0 ? 1000 : cy,
    p: Math.max(60, Math.min(1000, Math.round(shot.p * slip))),
  };
}

/** ---------------------------------------------------------------------------
 *  Thinking time. A bot that flicked the instant its turn began would be the one
 *  tell no roster entry can hide, so it waits — and longer than Ludo's bot,
 *  because there is more to decide: a placement, an angle and a weight, which
 *  is what a person spends those seconds on too.
 * ------------------------------------------------------------------------- */
const THINK = [0.9, 2.4]; // seconds

/** Ticks to wait before flicking, drawn once per turn — the caller remembers
 *  it, because redrawing it every poll would fire the bot at the first low
 *  sample. */
export function thinkTicks(tickRate: number, rand: Rand = Math.random): number {
  return Math.round((THINK[0] + (THINK[1] - THINK[0]) * rand()) * tickRate);
}
