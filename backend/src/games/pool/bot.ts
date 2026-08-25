// The 8-ball bot: where to put the cue ball, where to aim it, and how hard.
//
// It cannot be planned. A runner's bot knows its whole course before the match
// starts; a pool bot knows nothing until it sees where fifteen balls came to
// rest, which is a consequence of every shot anybody has played. So this
// decides one shot at a time, on the server's own table, and its answer travels
// as an ordinary input — the same channel, the same relay, the same replay.
//
// HOW IT AIMS: the ghost ball, which is how people aim too. To send a ball into
// a pocket the cue ball has to arrive at the point one ball-diameter behind it
// on the line from that pocket — the "ghost". So the bot walks its own group
// against the six pockets, works out each ghost, and asks whether it can reach
// it: is anything in the way, and is the cut so thin the ball will not go.
// What comes out is scored, and `skill` decides how often it plays the best one
// it found and how straight it hits it.
//
// BALL IN HAND is the other half. A foul hands over the whole table, and a bot
// that put the cue ball back where it was would be throwing away the biggest
// advantage in the game — so when it has the ball it searches PLACEMENTS as
// well as shots, and picks the pair.
//
// NOTHING HERE IS PART OF THE DETERMINISTIC SIMULATION. It may use Math.random
// and any trigonometry it likes, because its output is five integers that go
// through exactly the same input path a person's shot does — and those five
// integers are what every table replays.
import {
  BALLS,
  BALL_R,
  BREAK_SPOT,
  CUE,
  EIGHT,
  FRICTION,
  HALF_X,
  HALF_Y,
  HEAD_STRING,
  MAX_SPEED,
  MIN_SPEED,
  POCKETS,
  legalTargets,
  spotFree,
  teamOf,
  type PoolState,
  type ShotParams,
} from "../../shared/games/pool/index.js";

/** Ordinary randomness: a bot's choice is not part of the deterministic
 *  simulation (its OUTPUT is), so seeding it from the match would only make
 *  every match with the same seed play out identically. Injectable so the
 *  self-check can pin it. */
export type Rand = () => number;

/** A cut thinner than this barely moves the object ball — the shot that looks
 *  perfect on paper and leaves the ball where it was. Measured as the cosine of
 *  the angle between where the cue ball is going and where the object ball has
 *  to go, so no trigonometry is needed to reject one. */
const MIN_CUT = 0.3;

/** ---------------------------------------------------------------------------
 *  What a shot is worth. Same made-up unit throughout; only the ordering
 *  matters and the comments say what each number buys.
 * ------------------------------------------------------------------------- */
/** A straight-in pot beats a thin cut, by a lot. */
const V_CUT = 150;
/** Every table unit the cue ball or the object ball has to travel is a unit of
 *  things going wrong. The object ball's journey counts for more: it is the
 *  half of the shot the bot cannot correct once it is struck. */
const V_CUE_DIST = -22;
const V_OBJ_DIST = -46;
/** The black, when it is the shot that wins the rack. */
const V_BLACK = 120;
/** The last ball of a group is worth reaching for: it opens the black. */
const V_LAST = 60;

interface Candidate {
  shot: ShotParams;
  value: number;
}

/** Is anything in the way between two points, ignoring the two balls the shot
 *  is about? `clear` is how much room the traveller needs either side. */
function pathClear(
  s: PoolState,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  clear: number,
  skipA: number,
  skipB: number
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0) return true;
  for (let i = 0; i < BALLS; i++) {
    if (!s.alive[i] || i === skipA || i === skipB) continue;
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

/** How hard to hit it, as a slider position rather than a speed.
 *
 *  The object ball has to reach the pocket, and it only takes the part of the
 *  cue ball's pace that lies along the cut. Constant deceleration makes the
 *  sums easy — a ball at v covers v²/(2·FRICTION) — and everything after that
 *  is a fudge for restitution and for the fact that arriving with nothing to
 *  spare is how a ball stops on the lip. The slider is not linear (see
 *  `speedFor`), so the answer is inverted through the same curve. */
function powerFor(cueDist: number, objDist: number, cut: number): number {
  // What the object ball must still have LEFT when it reaches the hole. A
  // distance fudge would have been a speed fudge in disguise, and would have
  // silently changed meaning the day FRICTION did; this is the thing actually
  // meant — a ball arriving at the lip with a walking pace on it drops, and one
  // arriving with nothing hangs.
  const ARRIVE = 0.82;
  const objSpeed = Math.sqrt(ARRIVE * ARRIVE + 2 * FRICTION * objDist);
  const atImpact = objSpeed / Math.max(MIN_CUT, cut) / 1.05;
  const need = Math.sqrt(atImpact * atImpact + 2 * FRICTION * cueDist);
  // speed = MIN + (MAX - MIN)·p^1.5  →  p = ((speed - MIN)/(MAX - MIN))^(2/3)
  const frac = (need - MIN_SPEED) / (MAX_SPEED - MIN_SPEED);
  if (frac <= 0) return 0.06;
  const p = Math.cbrt(frac * frac);
  return p > 1 ? 1 : p < 0.06 ? 0.06 : p;
}

/** Every pot worth considering from one cue-ball position, best first. */
function shotsFrom(s: PoolState, cx: number, cy: number, targets: readonly number[], out: Candidate[]): void {
  const team = teamOf(s.turn, s.players);
  const group = s.group[team];
  const left = group >= 0 ? targets.length : 99;
  for (const ball of targets) {
    const bx = s.x[ball];
    const by = s.y[ball];
    for (const pocket of POCKETS) {
      const px = bx - pocket.x;
      const py = by - pocket.y;
      const pl = Math.hypot(px, py);
      if (pl <= 0) continue;
      // The ghost: where the cue ball's centre has to be at the moment of
      // contact for the object ball to set off towards this pocket.
      const gap = BALL_R * 2;
      const gx = bx + (px / pl) * gap;
      const gy = by + (py / pl) * gap;
      if (!pathClear(s, bx, by, pocket.x, pocket.y, BALL_R * 1.9, ball, CUE)) continue;
      const ax = gx - cx;
      const ay = gy - cy;
      const al = Math.hypot(ax, ay);
      if (al < gap * 0.6) continue; // the ghost is under our feet
      const ux = ax / al;
      const uy = ay / al;
      // How square the hit is: the cue ball's line against the object's line.
      const cut = ux * (-px / pl) + uy * (-py / pl);
      if (cut < MIN_CUT) continue;
      if (!pathClear(s, cx, cy, gx, gy, BALL_R * 1.9, ball, CUE)) continue;

      let value = V_CUT * cut + V_CUE_DIST * al + V_OBJ_DIST * pl;
      if (ball === EIGHT) value += V_BLACK;
      else if (left === 1) value += V_LAST;
      out.push({
        shot: {
          x: Math.round(cx * 1000),
          y: Math.round(cy * 1000),
          dx: Math.round(ux * 1000),
          dy: Math.round(uy * 1000),
          p: Math.round(powerFor(al, pl, cut) * 1000),
        },
        value,
      });
    }
  }
}

/** Places the cue ball could be put down, when the shooter has it in hand.
 *
 *  A coarse lattice rather than a search: the point is to find a line to a ball
 *  rather than to find the perfect one, and forty positions across a table is
 *  about a ball's width apart in the direction that matters. */
function placements(s: PoolState): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const maxX = s.behindLine ? HEAD_STRING : HALF_X - BALL_R * 1.5;
  const minX = -HALF_X + BALL_R * 1.5;
  const cols = 9;
  const rows = 5;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const x = minX + ((maxX - minX) * c) / (cols - 1);
      const y = -HALF_Y + BALL_R * 1.5 + ((HALF_Y * 2 - BALL_R * 3) * r) / (rows - 1);
      if (spotFree(x, y, s.x, s.y, s.alive, CUE)) out.push({ x, y });
    }
  }
  return out;
}

/** When there is no pot on: touch a legal ball and leave the table no better
 *  than you found it.
 *
 *  It has to be a legal ball — hitting the wrong group first is a foul and
 *  hands the whole table over — and it has to be hard enough that something
 *  reaches a cushion, because a shot that pots nothing and drives nothing to a
 *  rail is a foul too. Aiming AT the ball rather than at a ghost is the point:
 *  this shot is not trying to pot anything. */
function safety(s: PoolState, cx: number, cy: number, targets: readonly number[], rand: Rand): ShotParams {
  let best = -1;
  let bestD = Infinity;
  for (const ball of targets) {
    const d = Math.hypot(s.x[ball] - cx, s.y[ball] - cy);
    const clear = pathClear(s, cx, cy, s.x[ball], s.y[ball], BALL_R * 1.6, ball, CUE);
    const score = clear ? d : d + 10;
    if (score < bestD) {
      bestD = score;
      best = ball;
    }
  }
  if (best < 0) {
    // Nothing legal is on the table at all, which needs a rack in a very odd
    // state. Up the table, hard enough to find a cushion.
    return { x: Math.round(cx * 1000), y: Math.round(cy * 1000), dx: 1000, dy: 0, p: 520 };
  }
  const ax = s.x[best] - cx;
  const ay = s.y[best] - cy;
  const al = Math.hypot(ax, ay) || 1;
  return {
    x: Math.round(cx * 1000),
    y: Math.round(cy * 1000),
    dx: Math.round((ax / al) * 1000),
    dy: Math.round((ay / al) * 1000),
    // Firm enough to be sure of a cushion, soft enough not to open the table up
    // for whoever is next.
    p: 340 + Math.round(rand() * 160),
  };
}

/** The break. Into the apex, hard, and never dead straight — a break down the
 *  middle of the table is the one that leaves the rack sitting there. */
function breakShot(s: PoolState, rand: Rand): ShotParams {
  let apex = -1;
  let bestX = Infinity;
  for (let i = 1; i < BALLS; i++) {
    if (!s.alive[i]) continue;
    if (s.x[i] < bestX) {
      bestX = s.x[i];
      apex = i;
    }
  }
  const off = (rand() * 2 - 1) * HALF_Y * 0.42;
  const from = { x: BREAK_SPOT.x, y: off };
  if (apex < 0) return { x: Math.round(from.x * 1000), y: Math.round(from.y * 1000), dx: 1000, dy: 0, p: 950 };
  const ax = s.x[apex] - from.x;
  const ay = s.y[apex] - from.y;
  const al = Math.hypot(ax, ay) || 1;
  return {
    x: Math.round(from.x * 1000),
    y: Math.round(from.y * 1000),
    dx: Math.round((ax / al) * 1000),
    dy: Math.round((ay / al) * 1000),
    p: 880 + Math.round(rand() * 120),
  };
}

/** The shot this bot plays. Always legal: the placement is checked against the
 *  live table and the aim always goes somewhere, so the server can write it as
 *  the shot without a second opinion. */
export function chooseShot(s: PoolState, seat: number, skill: number, rand: Rand = Math.random): ShotParams {
  const sk = skill < 0 ? 0 : skill > 1 ? 1 : skill;
  if (!s.broken) return breakShot(s, rand);

  const team = teamOf(seat, s.players);
  const targets = legalTargets(s, team);
  const spots = s.ballInHand || !s.alive[CUE] ? placements(s) : [{ x: s.x[CUE], y: s.y[CUE] }];
  const found: Candidate[] = [];
  for (const spot of spots) shotsFrom(s, spot.x, spot.y, targets, found);
  found.sort((a, b) => b.value - a.value);

  let shot: ShotParams;
  if (found.length === 0) {
    const spot = spots[0] ?? { x: s.x[CUE], y: s.y[CUE] };
    shot = safety(s, spot.x, spot.y, targets, rand);
  } else {
    // How often it takes its own advice. The weakest bot still plays a real
    // shot two times in five, which is roughly what somebody who has just
    // learnt which balls are theirs does; the rest of the time it plays another
    // shot it had considered rather than something silly, because a person who
    // misreads a table still hits one of their own.
    const follows = 0.4 + 0.55 * sk;
    if (rand() < follows) {
      shot = found[0].shot;
    } else {
      const spread = Math.min(found.length, 4 + Math.round((1 - sk) * 10));
      shot = found[Math.floor(rand() * spread) % spread].shot;
    }
  }

  // And how straight it hits it. At full skill this is a third of a degree; at
  // none of it, nearly three — enough to catch the wrong half of a ball from
  // the other end of the table, which is exactly what a weak player does.
  const wobble = (1 - sk) * 46 + 5;
  const dx = Math.round(shot.dx + (rand() * 2 - 1) * wobble);
  const dy = Math.round(shot.dy + (rand() * 2 - 1) * wobble);
  // The weight error is a FRACTION of the shot, never a fixed number of slider
  // points — carrom's hardest-won line. As a fixed number it takes a delicate
  // shot down to nothing, the cue ball stops short of the object ball, and that
  // is a foul rather than a soft shot.
  const slip = 1 + (rand() * 2 - 1) * ((1 - sk) * 0.3 + 0.05);
  const cx = Math.max(-1000, Math.min(1000, dx));
  const cy = Math.max(-1000, Math.min(1000, dy));
  return {
    x: Math.max(-1000, Math.min(1000, shot.x)),
    y: Math.max(-500, Math.min(500, shot.y)),
    dx: cx === 0 && cy === 0 ? 1000 : cx,
    dy: cx === 0 && cy === 0 ? 0 : cy,
    p: Math.max(40, Math.min(1000, Math.round(shot.p * slip))),
  };
}

/** ---------------------------------------------------------------------------
 *  Thinking time. A bot that shot the instant its turn began would be the one
 *  tell no roster entry can hide, so it waits — and longer than carrom's,
 *  because a pool shot is a longer decision: which ball, which pocket, and
 *  where the cue ball has to finish for the next one.
 * ------------------------------------------------------------------------- */
const THINK = [1.1, 2.8]; // seconds
const THINK_HAND = [1.6, 3.4]; // with ball in hand there is more to decide

export function thinkTicks(tickRate: number, ballInHand: boolean, rand: Rand = Math.random): number {
  const [lo, hi] = ballInHand ? THINK_HAND : THINK;
  return Math.round((lo + (hi - lo) * rand()) * tickRate);
}

/** A bot's turn, decided up front: the shot it will play, preceded by a rougher
 *  version of it to show while it "thinks".
 *
 *  A SEAT THAT NEVER APPEARS TO AIM IS A SEAT ANYONE CAN SPOT. Every human at
 *  this table broadcasts their aim while they line up, so a bot that goes from
 *  nothing to a struck cue ball is the tell. Deciding up front and then showing
 *  the working is also the only order that can be honest: the aim a bot shows
 *  last is the shot it plays. */
export function botPlan(s: PoolState, seat: number, skill: number, rand: Rand = Math.random): ShotParams[] {
  const shot = chooseShot(s, seat, skill, rand);
  const swing = 45 + Math.round(rand() * 110);
  const side = rand() < 0.5 ? -1 : 1;
  const dx = Math.max(-1000, Math.min(1000, shot.dx + side * swing));
  const dy = Math.max(-1000, Math.min(1000, shot.dy - side * swing));
  const rough: ShotParams = {
    x: shot.x,
    y: shot.y,
    dx: dx === 0 && dy === 0 ? 1000 : dx,
    dy: dx === 0 && dy === 0 ? 0 : dy,
    p: Math.max(0, Math.min(1000, shot.p + side * 70)),
  };
  return [rough, shot];
}
