// Attempt ceilings for the sign-in flow.
//
// A six-digit code is a million possibilities, but with a ±1 period tolerance
// three of them are valid at any instant — so without a ceiling it is guessable
// in hours by a script. The ceiling is per account AND per address, because
// either one alone is easy to work around.
//
// Deliberately NOT a permanent lock: locking an account on failed attempts
// hands anyone who knows your email a way to keep you out of your own console.
// It refuses for a window, and it tells you it happened.
import { redis } from "../redis.js";

export interface LimitResult {
  ok: boolean;
  /** Attempts used inside the window. */
  count: number;
  retryAfterSec: number;
}

export async function hit(scope: string, key: string, max: number, windowSec: number): Promise<LimitResult> {
  const k = `admin:rl:${scope}:${key}`;
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, windowSec);
  if (count <= max) return { ok: true, count, retryAfterSec: 0 };
  const ttl = await redis.ttl(k);
  return { ok: false, count, retryAfterSec: ttl > 0 ? ttl : windowSec };
}

/** A successful sign-in clears the counter, so a bad day at the keyboard does
 *  not follow you around. */
export const clear = (scope: string, key: string): Promise<number> => redis.del(`admin:rl:${scope}:${key}`);
