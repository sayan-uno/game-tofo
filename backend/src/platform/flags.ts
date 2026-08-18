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
  /** Nobody new may connect. Players already in a match are left alone —
   *  cutting a match short is what maintenance mode is trying to avoid. */
  maintenance: boolean;
  /** Shown on the way in when maintenance is on. */
  maintenanceMessage: string;
  /** A notice pushed to everyone online. Cleared by setting it empty. */
  notice: string;
}

const EMPTY: PlatformFlags = { maintenance: false, maintenanceMessage: "", notice: "" };

export async function getFlags(): Promise<PlatformFlags> {
  try {
    const h = await redis.hgetall(KEY);
    return {
      maintenance: h.maintenance === "1",
      maintenanceMessage: h.maintenanceMessage ?? "",
      notice: h.notice ?? "",
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
  if (patch.maintenanceMessage !== undefined) write.maintenanceMessage = patch.maintenanceMessage;
  if (patch.notice !== undefined) write.notice = patch.notice;
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
