import { and, desc, eq, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { friendships, users } from "../db/schema.js";
import { getFriendIds, getUsersByIds, type UserRow } from "./users.js";

/** Accepted friends of a user, sorted by name. */
export async function listFriends(userId: string): Promise<UserRow[]> {
  const ids = await getFriendIds(userId);
  const rows = await getUsersByIds(ids);
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Incoming pending requests with the requester's profile. */
export async function listIncomingRequests(userId: string) {
  return db
    .select({
      requestId: friendships.id,
      uid: users.uid,
      name: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(friendships)
    .innerJoin(users, eq(users.id, friendships.requesterId))
    .where(and(eq(friendships.addresseeId, userId), eq(friendships.status, "pending")))
    .orderBy(desc(friendships.createdAt));
}

/** Any friendship row (pending or accepted) between two users, either direction. */
export async function findFriendshipBetween(a: string, b: string) {
  const [row] = await db
    .select({ id: friendships.id, status: friendships.status, requesterId: friendships.requesterId })
    .from(friendships)
    .where(
      or(
        and(eq(friendships.requesterId, a), eq(friendships.addresseeId, b)),
        and(eq(friendships.requesterId, b), eq(friendships.addresseeId, a))
      )
    )
    .limit(1);
  return row ?? null;
}

export async function createFriendRequest(requesterId: string, addresseeId: string): Promise<string> {
  const [row] = await db.insert(friendships).values({ requesterId, addresseeId }).returning({ id: friendships.id });
  return row.id;
}

/** A pending request by id, only if `addresseeId` is really the addressee. */
export async function getPendingRequest(requestId: string, addresseeId: string) {
  const [row] = await db
    .select({ requesterId: friendships.requesterId })
    .from(friendships)
    .where(
      and(eq(friendships.id, requestId), eq(friendships.addresseeId, addresseeId), eq(friendships.status, "pending"))
    );
  return row ?? null;
}

export async function acceptFriendRequest(requestId: string): Promise<void> {
  await db
    .update(friendships)
    .set({ status: "accepted", respondedAt: new Date() })
    .where(eq(friendships.id, requestId));
}

export async function deleteFriendship(requestId: string): Promise<void> {
  await db.delete(friendships).where(eq(friendships.id, requestId));
}
