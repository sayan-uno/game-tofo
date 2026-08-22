// Anti-cheat signals, out of what the server already knows.
//
// NO NEW CAPTURE. The server plays every match itself, refuses the inputs it
// does not believe, and keeps the tick of every input it accepts. That is
// enough to say something useful about how a player is playing, and it is all
// measured on data already sitting in memory when the match ends.
//
// THESE ARE SIGNALS, NOT VERDICTS. Every number here has an innocent
// explanation — a bad connection, a held key, a turn-based game, a short
// match. They exist to RANK who is worth watching in the studio, and the
// studio is what decides. Nothing here bans anybody, and nothing here is shown
// to a player.
//
// Pure functions on purpose: the scoring is the part that is easy to get
// subtly wrong, and it is the part a check harness can pin down exactly.

/** Too few gaps and any number is noise: three inputs make two gaps, and two
 *  identical gaps is a coincidence, not a pattern. */
const MIN_GAPS = 8;

/**
 * How MECHANICAL a player's input timing is, 0–100.
 *
 * The share of consecutive gaps that are exactly the most common gap. A person
 * pressing a button produces a spread — reaction time varies by tens of
 * milliseconds even when they are trying to be regular. A script does not: it
 * fires every N ticks, and every gap is N.
 *
 * Returns null when there is not enough to say, which is different from 0 and
 * must stay different: "no evidence" ranked as "definitely human" is how a
 * short match becomes an alibi.
 */
export function cadence(ticks: number[]): number | null {
  if (ticks.length < MIN_GAPS + 1) return null;
  const gaps: number[] = [];
  for (let i = 1; i < ticks.length; i++) {
    const g = ticks[i] - ticks[i - 1];
    // Two inputs on one tick are one action, not a rhythm.
    if (g > 0) gaps.push(g);
  }
  if (gaps.length < MIN_GAPS) return null;
  const counts = new Map<number, number>();
  let best = 0;
  for (const g of gaps) {
    const n = (counts.get(g) ?? 0) + 1;
    counts.set(g, n);
    if (n > best) best = n;
  }
  return Math.round((best / gaps.length) * 100);
}

export interface PlayerSignals {
  /** Matches this is measured over. One match proves nothing. */
  matches: number;
  /** Inputs the server accepted. */
  inputs: number;
  /** Inputs it refused, all reasons. */
  rejects: number;
  /** Refusals for being over the per-second ceiling. */
  rateRejects: number;
  /** Refusals for a tick the player could not have reached yet. */
  earlyRejects: number;
  /** Mean of the per-match cadence readings that exist, or null. */
  cadence: number | null;
  /** Firsts, and matches with a human field to have won them in. */
  wins: number;
  contested: number;
}

export interface Suspicion {
  /** 0–100. A RANKING, not a probability and not a verdict. */
  score: number;
  /** Why, in the order that contributed most — shown beside the score,
   *  because a number nobody can question is a number nobody should trust. */
  reasons: string[];
}

/**
 * Rank how much a player is worth watching.
 *
 * Deliberately conservative and deliberately explainable. Every component is
 * capped, so no single measurement can carry somebody to the top of the list
 * on its own, and each one that fires says so in words.
 */
export function suspicion(s: PlayerSignals): Suspicion {
  const reasons: string[] = [];
  let score = 0;

  // Nothing to go on. Not innocent — unmeasured.
  if (s.matches < 3 || s.inputs < 50) return { score: 0, reasons: [] };

  // Sitting on the rate ceiling. A human hits it in a panic; a client that
  // hits it repeatedly, across matches, is sending faster than a hand can.
  const ratePer = s.rateRejects / s.matches;
  if (ratePer >= 1) {
    const add = Math.min(30, Math.round(ratePer * 6));
    score += add;
    reasons.push(`refused ${s.rateRejects} input(s) for exceeding the rate ceiling`);
  }

  // Ticks they could not have reached yet. Latency makes inputs LATE; only a
  // clock that has run ahead makes them early.
  if (s.earlyRejects >= 3) {
    const add = Math.min(25, 5 + s.earlyRejects);
    score += add;
    reasons.push(`sent ${s.earlyRejects} input(s) for ticks that had not happened`);
  }

  // Mechanical timing.
  if (s.cadence !== null && s.cadence >= 60) {
    const add = Math.min(30, Math.round((s.cadence - 55) * 1.2));
    score += add;
    reasons.push(`${s.cadence}% of their inputs fall on exactly the same gap`);
  }

  // Winning more than a seed should allow. Only counted where there were
  // people to beat: winning a lobby of bots is what bots are for.
  if (s.contested >= 5) {
    const rate = s.wins / s.contested;
    if (rate >= 0.8) {
      const add = Math.min(20, Math.round((rate - 0.75) * 80));
      score += add;
      reasons.push(`won ${s.wins} of ${s.contested} contested matches`);
    }
  }

  return { score: Math.min(100, score), reasons };
}
