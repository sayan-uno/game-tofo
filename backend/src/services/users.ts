import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { friendships, users } from "../db/schema.js";

export type UserRow = typeof users.$inferSelect;

export function toPublicUser(u: UserRow) {
  return { id: u.id, uid: u.uid, name: u.name, avatarUrl: u.avatarUrl };
}

/** Free-Fire style numeric UID, 10 digits, guaranteed unique. */
function randomUid(): string {
  let s = String(Math.floor(1 + Math.random() * 9));
  for (let i = 0; i < 9; i++) s += Math.floor(Math.random() * 10);
  return s;
}

export async function upsertGoogleUser(profile: {
  googleId: string;
  email: string;
  name: string;
  avatarUrl?: string;
}): Promise<UserRow> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await db
        .insert(users)
        .values({
          uid: randomUid(),
          googleId: profile.googleId,
          email: profile.email,
          name: profile.name,
          avatarUrl: profile.avatarUrl ?? null,
        })
        .onConflictDoUpdate({
          target: users.googleId,
          set: {
            name: sql`excluded.name`,
            avatarUrl: sql`excluded.avatar_url`,
            lastLoginAt: sql`now()`,
          },
        })
        .returning();
      return row;
    } catch (err: unknown) {
      // Retry only on a uid collision; anything else bubbles up.
      // (drizzle may wrap the pg error, so check `cause` too)
      const pgErr = ((err as { cause?: unknown }).cause ?? err) as { code?: string; constraint?: string };
      if (pgErr.code === "23505" && (pgErr.constraint ?? "").includes("uid")) continue;
      throw err;
    }
  }
  throw new Error("Could not generate a unique UID");
}

export async function getUserById(id: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row ?? null;
}

export async function getUserByUid(uid: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.uid, uid));
  return row ?? null;
}

export async function getUsersByIds(ids: string[]): Promise<UserRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(users).where(inArray(users.id, ids));
}

/** userIds of all accepted friends of a user. */
export async function getFriendIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({
      friendId: sql<string>`CASE WHEN ${friendships.requesterId} = ${userId} THEN ${friendships.addresseeId} ELSE ${friendships.requesterId} END`,
    })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, "accepted"),
        or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId))
      )
    );
  return rows.map((r) => r.friendId);
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  const rows = await db
    .select({ id: friendships.id })
    .from(friendships)
    .where(
      and(
        eq(friendships.status, "accepted"),
        or(
          and(eq(friendships.requesterId, a), eq(friendships.addresseeId, b)),
          and(eq(friendships.requesterId, b), eq(friendships.addresseeId, a))
        )
      )
    )
    .limit(1);
  return rows.length > 0;
}
