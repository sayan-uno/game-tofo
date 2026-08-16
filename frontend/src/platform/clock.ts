// Server clock offset, so "tick 0 lands on startAt (server time)" means the
// same instant on every device. NTP in miniature: a few round trips, keep the
// one with the smallest RTT (its midpoint estimate is the least uncertain),
// and refine over the session — never fewer samples, only better ones.
import { emitAck } from "../api/socket";
import { EV, type TimePong } from "../shared/core/protocol";

let offset = 0; // serverNow - localNow, in ms
let bestRtt = Infinity;
let sampled = false;

export const clockOffset = (): number => offset;
export const clockSynced = (): boolean => sampled;

/** Local Date.now() equivalent of a server timestamp. */
export const serverToLocal = (serverMs: number): number => serverMs - offset;

async function sampleOnce(): Promise<void> {
  const t0 = Date.now();
  const pong = await emitAck<TimePong>(EV.ping, {});
  const t1 = Date.now();
  const rtt = t1 - t0;
  if (typeof pong?.serverNow !== "number") return;
  if (rtt < bestRtt) {
    bestRtt = rtt;
    offset = pong.serverNow - (t0 + rtt / 2);
  }
  sampled = true;
}

/** Take `n` samples back to back (each is one tiny round trip). Safe to call
 *  again — it only ever tightens the estimate. */
export async function syncClock(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) {
    try {
      await sampleOnce();
    } catch {
      /* one bad sample is nothing; a dead socket surfaces elsewhere */
    }
  }
}

/** A cheap first estimate from any server-stamped payload (prepare/go carry
 *  serverNow): used until real samples land, and never overrides a measured
 *  offset. */
export function seedClock(serverNow: number): void {
  if (sampled) return;
  offset = serverNow - Date.now();
}
