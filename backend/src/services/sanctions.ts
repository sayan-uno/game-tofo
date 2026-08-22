// Bans and mutes.
//
// Two stores, two jobs, and the split is the whole design:
//
//   Postgres  is the record — who, what, why, by whom, with the evidence. It
//             is queried by the console and by nothing else.
//   Redis     is the enforcement — one key per sanctioned user, read with a
//             single GET at the socket handshake and in requireAuth.
//
// Nothing on a hot path ever touches Postgres for this. A clean player is a
// GET that returns null, which is the cheapest thing Redis does.
//
// The cache is authoritative for enforcement, so it MUST be rebuilt at boot:
// a flushed Redis would otherwise silently un-ban everyone.
import { and, eq, isNull, or, gt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { sanctions } from "../db/schema.js";
import { redis } from "../redis.js";
import { logEvent } from "./eventLog.js";

/** ban — cannot connect at all.
 *  match — lobby and friends work, matchmaking refuses.
 *  voice — LiveKit token comes back without publish rights.
 *  chat — text messages rejected.
 *  shadow-chat — messages "send" and reach nobody. */
export type SanctionType = "ban" | "match" | "voice" | "chat" | "shadow-chat";
export const SANCTION_TYPES: readonly SanctionType[] = ["ban", "match", "voice", "chat", "shadow-chat"];
export const isSanctionType = (v: unknown): v is SanctionType =>
  typeof v === "string" && (SANCTION_TYPES as readonly string[]).includes(v);

/** What the hot path gets to see. Deliberately tiny — it is parsed on every
 *  connection. `until` is an epoch in ms, or null for permanent. */
export interface CachedSanction {
  id: string;
  reason: string;
  until: number | null;
}
export type SanctionCache = Partial<Record<SanctionType, CachedSanction>>;

const key = (userId: string) => `ban:${userId}`;
/** The key's TTL is only a backstop — the reader filters on `until` anyway —
 *  so it is deliberately generous. */
const TTL_SLACK_MS = 60_000;

function live(c: SanctionCache): SanctionCache {
  const now = Date.now();
  const out: SanctionCache = {};
  for (const [type, s] of Object.entries(c) as [SanctionType, CachedSanction][]) {
    if (s.until === null || s.until > now) out[type] = s;
  }
  return out;
}

/** THE hot-path read: one GET. Returns an empty object for a clean player. */
export async function getSanctions(userId: string): Promise<SanctionCache> {
  try {
    const raw = await redis.get(key(userId));
    if (!raw) return {};
    return live(JSON.parse(raw) as SanctionCache);
  } catch {
    // A Redis hiccup must not lock every player out of the game. Failing open
    // here is the right trade: the worst case is a banned player getting one
    // more session, and the alternative is a total outage.
    return {};
  }
}

/** The same read for a page of players, in ONE round trip.
 *
 *  A console list is fifty rows; asking Redis fifty separate times to draw one
 *  screen is fifty network waits an admin sits through. MGET is one. Same
 *  fail-open rule as the single read — a hiccup must never look like a ban. */
export async function getSanctionsMany(userIds: string[]): Promise<Map<string, SanctionCache>> {
  const out = new Map<string, SanctionCache>();
  if (userIds.length === 0) return out;
  try {
    const raw = await redis.mget(userIds.map(key));
    userIds.forEach((id, i) => {
      const v = raw[i];
      out.set(id, v ? live(JSON.parse(v) as SanctionCache) : {});
    });
  } catch {
    for (const id of userIds) out.set(id, {});
  }
  return out;
}

export const bannedReason = (c: SanctionCache): string | null => c.ban?.reason ?? null;

/** Rebuild one user's cache from the record. Called after every change, and
 *  for everyone at boot. */
export async function refreshSanctionCache(userId: string): Promise<SanctionCache> {
  const rows = await db
    .select()
    .from(sanctions)
    .where(
      and(
        eq(sanctions.userId, userId),
        isNull(sanctions.revokedAt),
        or(isNull(sanctions.expiresAt), gt(sanctions.expiresAt, sql`now()`))
      )
    );

  const cache: SanctionCache = {};
  for (const r of rows) {
    if (!isSanctionType(r.type)) continue;
    const until = r.expiresAt ? r.expiresAt.getTime() : null;
    const existing = cache[r.type];
    // Keep the one that lasts longest; permanent always wins.
    if (!existing || (existing.until !== null && (until === null || until > existing.until))) {
      cache[r.type] = { id: r.id, reason: r.reason, until };
    }
  }

  if (Object.keys(cache).length === 0) {
    await redis.del(key(userId));
    return cache;
  }
  const untils = Object.values(cache).map((s) => s.until);
  const permanent = untils.some((u) => u === null);
  const value = JSON.stringify(cache);
  if (permanent) await redis.set(key(userId), value);
  else {
    const ms = Math.max(...(untils as number[])) - Date.now() + TTL_SLACK_MS;
    await redis.set(key(userId), value, "PX", Math.max(1000, ms));
  }
  return cache;
}

/** Everyone currently sanctioned, back into Redis. One query, few rows, once
 *  per boot — and the difference between a working ban list and none at all. */
export async function warmSanctionCache(): Promise<number> {
  const rows = await db
    .selectDistinct({ userId: sanctions.userId })
    .from(sanctions)
    .where(
      and(
        isNull(sanctions.revokedAt),
        or(isNull(sanctions.expiresAt), gt(sanctions.expiresAt, sql`now()`))
      )
    );
  for (const r of rows) await refreshSanctionCache(r.userId);
  return rows.length;
}

export interface ApplyInput {
  userId: string;
  uid?: string | null;
  type: SanctionType;
  reason: string;
  note?: string | null;
  /** null / omitted = permanent. */
  expiresAt?: Date | null;
  createdBy?: string | null;
  evidence?: Record<string, unknown>;
}

/** Write the record, then make it real. Does NOT hang up the player's socket —
 *  that is a separate step (`ops:cmd disconnect`) so this stays usable from a
 *  process that owns no sockets. */
export async function applySanction(input: ApplyInput): Promise<{ id: string; cache: SanctionCache }> {
  const [row] = await db
    .insert(sanctions)
    .values({
      userId: input.userId,
      type: input.type,
      reason: input.reason,
      note: input.note ?? null,
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy ?? null,
      evidence: input.evidence ?? {},
    })
    .returning({ id: sanctions.id });
  const cache = await refreshSanctionCache(input.userId);
  logEvent({
    type: "sanction.applied",
    userId: input.userId,
    uid: input.uid ?? null,
    data: {
      sanctionId: row.id,
      sanctionType: input.type,
      reason: input.reason,
      until: input.expiresAt ? input.expiresAt.toISOString() : null,
      by: input.createdBy ?? null,
    },
  });
  return { id: row.id, cache };
}

export async function liftSanction(sanctionId: string, by: string | null): Promise<boolean> {
  const [row] = await db
    .update(sanctions)
    .set({ revokedAt: sql`now()`, revokedBy: by })
    .where(and(eq(sanctions.id, sanctionId), isNull(sanctions.revokedAt)))
    .returning({ userId: sanctions.userId, type: sanctions.type });
  if (!row) return false;
  await refreshSanctionCache(row.userId);
  logEvent({
    type: "sanction.lifted",
    userId: row.userId,
    data: { sanctionId, sanctionType: row.type, by },
  });
  return true;
}
