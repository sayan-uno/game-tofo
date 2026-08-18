// Which devices an account has been seen on.
//
// Not tracking for its own sake: this is the table that makes ban evasion
// visible. One device hash with three accounts on it, one of them banned, is
// the single most useful thing a moderation console can show.
//
// The hash is computed and sent by the client, so it is a CORRELATION HINT and
// never an authentication factor — a modified client can send anything, which
// costs an evader their own linkage and costs us nothing.
//
// Written fire-and-forget at session start: one upsert per session, never
// awaited, so the socket handshake does not wait on Postgres.
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { userDevices } from "../db/schema.js";

export async function recordDevice(userId: string, deviceHash: string, ua: string | null): Promise<void> {
  await db
    .insert(userDevices)
    .values({ userId, deviceHash, ua })
    .onConflictDoUpdate({
      target: [userDevices.userId, userDevices.deviceHash],
      set: {
        lastSeenAt: sql`now()`,
        seenCount: sql`${userDevices.seenCount} + 1`,
        ua: sql`coalesce(excluded.ua, ${userDevices.ua})`,
      },
    });
}

/** Never throws, never blocks the caller. */
export function noteDevice(userId: string, deviceHash: string | null, ua: string | null): void {
  if (!deviceHash) return;
  void recordDevice(userId, deviceHash, ua).catch((err) => console.error("[devices] upsert failed:", err));
}
