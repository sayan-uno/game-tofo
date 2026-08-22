// Platform-wide switches: maintenance mode, and the notice everyone sees.
//
// Kept in Redis rather than in the environment because they have to change
// while the server is running — putting the platform into maintenance by
// editing a variable and redeploying would mean the deploy is the outage.
//
// Read once per connection, never per event.
import { redis } from "../redis.js";

const KEY = "platform:flags";

export interface PlatformFlags {
  /** Maintenance is HAPPENING. Nobody may connect, and everybody who is
   *  connected is held behind a notice they cannot dismiss. */
  maintenance: boolean;
  /** When it starts, as epoch ms — 0 when nothing is scheduled.
   *
   *  Announced ahead of time rather than sprung on people. A player halfway
   *  through a match deserves to know it is going to end, and a party about to
   *  start one deserves the chance not to. */
  maintenanceAt: number;
  /** Shown on the way in, and on the notice nobody can close. */
  maintenanceMessage: string;
}

const EMPTY: PlatformFlags = {
  maintenance: false,
  maintenanceAt: 0,
  maintenanceMessage: "",
};

export async function getFlags(): Promise<PlatformFlags> {
  try {
    const h = await redis.hgetall(KEY);
    return {
      maintenance: h.maintenance === "1",
      maintenanceAt: Number(h.maintenanceAt ?? 0) || 0,
      maintenanceMessage: h.maintenanceMessage ?? "",
    };
  } catch {
    // A Redis wobble must not lock every player out of the game. Failing
    // OPEN is right here: the worst case is the platform staying up slightly
    // longer than intended, and the alternative is an outage.
    return EMPTY;
  }
}

export async function setFlags(patch: Partial<PlatformFlags>): Promise<PlatformFlags> {
  const write: Record<string, string> = {};
  if (patch.maintenance !== undefined) write.maintenance = patch.maintenance ? "1" : "0";
  if (patch.maintenanceAt !== undefined) write.maintenanceAt = String(patch.maintenanceAt);
  if (patch.maintenanceMessage !== undefined) write.maintenanceMessage = patch.maintenanceMessage;
  if (Object.keys(write).length > 0) await redis.hset(KEY, write);
  return getFlags();
}

/** The one the socket handshake asks. Deliberately a single field read rather
 *  than the whole hash — it happens on every connection. */
export async function inMaintenance(): Promise<boolean> {
  try {
    return (await redis.hget(KEY, "maintenance")) === "1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// THE GATE
//
// Maintenance has to be enforced by the SERVER, not drawn by the client. A
// curtain in the page is a picture of a closed door: anybody with dev tools
// deletes the element and carries on playing, because every socket handler and
// every route behind it still answers. The screen is a courtesy; this is the
// rule.
//
// Held in memory because it is asked on every request and every socket event.
// Kept honest by three things: the ops command sets it the instant an admin
// acts (on every instance, through the same pub/sub the other commands use),
// the watch below re-reads it every few seconds as a backstop, and boot reads
// it before the first request is served.
// ---------------------------------------------------------------------------
let gateClosed = false;
let gateMessage = "TOFO is down for maintenance.";

export function setGate(closed: boolean, message?: string): void {
  gateClosed = closed;
  if (message) gateMessage = message;
}

/** Synchronous on purpose: a gate that costs a round trip is a gate that gets
 *  skipped on the hot path "just this once". */
export const gateShut = (): boolean => gateClosed;
export const gateReason = (): string => gateMessage;

/** How much warning a scheduled maintenance must give.
 *
 *  Not a suggestion. A match takes minutes and a player who has just started
 *  one has done nothing to deserve losing it; half an hour is long enough for
 *  anybody in the middle of something to finish and for a party to decide not
 *  to start another. An admin who genuinely needs the platform down NOW turns
 *  it on directly — that is a different act, and it looks different in the
 *  record. */
export const MAINTENANCE_LEAD_MS = 30 * 60_000;

/** Watch for a scheduled maintenance falling due.
 *
 *  One timer for the process, checking a single Redis field. The schedule
 *  lives in Redis rather than in this timer so that it survives a restart and
 *  so that every instance agrees — the one that happens to notice first flips
 *  the switch, and the flip itself is what every other instance reacts to.
 */
export function startMaintenanceWatch(onDue: (flags: PlatformFlags) => Promise<void>): NodeJS.Timeout {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const flags = await getFlags();
        // The backstop: an instance that missed the command still shuts within
        // a few seconds, and one that missed the all-clear reopens.
        setGate(flags.maintenance, flags.maintenanceMessage);
        if (flags.maintenance || flags.maintenanceAt === 0) return;
        if (Date.now() < flags.maintenanceAt) return;
        // Due. Claim it with a compare-and-set so two instances cannot both
        // announce the same start.
        const claimed = await redis.hsetnx(KEY, "maintenanceStarted", String(flags.maintenanceAt));
        if (claimed !== 1) return;
        await setFlags({ maintenance: true });
        setGate(true, flags.maintenanceMessage);
        console.log("⚠ Maintenance window has begun — everybody is being held");
        await onDue({ ...flags, maintenance: true });
      } catch (err) {
        console.error("maintenance watch:", err);
      }
    })();
  }, 5000);
  timer.unref();
  return timer;
}

/** Clearing maintenance also clears the claim, so the next window can be
 *  scheduled and claimed cleanly. */
export async function clearMaintenance(): Promise<PlatformFlags> {
  setGate(false);
  await redis.hdel(KEY, "maintenanceStarted");
  return setFlags({ maintenance: false, maintenanceAt: 0, maintenanceMessage: "" });
}

/** How far through the notice list this player has been shown, as a moment in
 *  time. One small key per player rather than a row per player per notice, and
 *  the only thing it has to get right is "do not show it twice". */
const seenKey = (userId: string) => `notice:seen:${userId}`;
export const noticeSeen = async (userId: string): Promise<number> => Number((await redis.get(seenKey(userId))) ?? 0) || 0;
export const markNoticeSeen = (userId: string, at: number): Promise<unknown> =>
  redis.set(seenKey(userId), String(at), "EX", 60 * 86_400);
