// What a player said, to whom.
//
// Direct messages are private, and this is the console reading them — so it is
// gated the way voice is: admin-and-above, and every read is written into the
// audit trail naming whose conversation it was. "Who has read whom" has to
// stay answerable, or an admin console becomes the thing it exists to prevent.
//
// Nothing is kept for this. Chat already expires after fifteen days; this
// reads what is there and adds no retention of its own, so a conversation an
// admin looked at last month is gone on the same schedule as one nobody read.
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { dmMessages, friendships, users } from "../../db/schema.js";
import { requestOrigin } from "../../services/clientIp.js";
import { safeRouter } from "../asyncRouter.js";
import { requireAdmin } from "../guard.js";
import { audit } from "../audit.js";

export const chatsRouter = safeRouter();

/** Everything this player has a conversation with, newest first.
 *
 *  The player's own app splits these into "Friends" and "Recent" by whether
 *  they are friends RIGHT NOW; the same split is computed here so the console
 *  shows what they see. */
chatsRouter.get("/players/:uid/chats", requireAdmin("admin"), async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.uid, req.params.uid));
  if (!user) {
    res.status(404).json({ error: "No player with that UID" });
    return;
  }

  const threads = await db
    .select({
      partner: sql<string>`case when ${dmMessages.senderId} = ${user.id} then ${dmMessages.recipientId} else ${dmMessages.senderId} end`,
      messages: sql<number>`count(*)::int`,
      last: sql<string>`max(${dmMessages.createdAt})`,
      sent: sql<number>`count(*) filter (where ${dmMessages.senderId} = ${user.id})::int`,
    })
    .from(dmMessages)
    .where(or(eq(dmMessages.senderId, user.id), eq(dmMessages.recipientId, user.id)))
    .groupBy(sql`1`)
    .orderBy(desc(sql`max(${dmMessages.createdAt})`))
    .limit(100);

  const partnerIds = threads.map((t) => t.partner);
  const people = partnerIds.length
    ? await db.select({ id: users.id, uid: users.uid, username: users.username }).from(users).where(inArray(users.id, partnerIds))
    : [];
  const person = new Map(people.map((p) => [p.id, p]));

  // Friends now, which is what decides "Friends" vs "Recent" in their app.
  const friends = partnerIds.length
    ? await db
        .select({ a: friendships.requesterId, b: friendships.addresseeId })
        .from(friendships)
        .where(
          and(
            eq(friendships.status, "accepted"),
            or(
              and(eq(friendships.requesterId, user.id), inArray(friendships.addresseeId, partnerIds)),
              and(eq(friendships.addresseeId, user.id), inArray(friendships.requesterId, partnerIds))
            )
          )
        )
    : [];
  const isFriend = new Set(friends.map((f) => (f.a === user.id ? f.b : f.a)));

  res.json({
    threads: threads
      .filter((t) => person.has(t.partner))
      .map((t) => ({
        uid: person.get(t.partner)!.uid,
        username: person.get(t.partner)!.username,
        messages: t.messages,
        sent: t.sent,
        received: t.messages - t.sent,
        last: t.last,
        friend: isFriend.has(t.partner),
      })),
  });
});

/** One conversation. Reading it is the act that gets audited. */
chatsRouter.get("/players/:uid/chats/:partner", requireAdmin("admin"), async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.uid, req.params.uid));
  const [partner] = await db.select().from(users).where(eq(users.uid, req.params.partner));
  if (!user || !partner) {
    res.status(404).json({ error: "No such conversation" });
    return;
  }

  const rows = await db
    .select({
      id: dmMessages.id,
      body: dmMessages.body,
      at: dmMessages.createdAt,
      fromUid: sql<string>`case when ${dmMessages.senderId} = ${user.id} then ${user.uid} else ${partner.uid} end`,
    })
    .from(dmMessages)
    .where(
      or(
        and(eq(dmMessages.senderId, user.id), eq(dmMessages.recipientId, partner.id)),
        and(eq(dmMessages.senderId, partner.id), eq(dmMessages.recipientId, user.id))
      )
    )
    .orderBy(desc(dmMessages.createdAt))
    .limit(500);

  await audit(req.admin!, {
    action: "chat.read",
    targetType: "user",
    targetId: user.uid,
    after: { with: partner.uid, messages: rows.length },
    reason: typeof req.query.reason === "string" ? req.query.reason : null,
    ip: requestOrigin(req).ip,
  });

  res.json({
    with: { uid: partner.uid, username: partner.username },
    // Oldest first: a conversation is read forwards.
    messages: rows.reverse(),
  });
});

// Squad chat deliberately has NO endpoint here. Pulled onto a player's page it
// merges every group they were ever in into one stream, which reads as a
// single conversation and is not one. It belongs to a party, and the party
// studio shows it where it happened — with who else was standing there.

/** Their friends, searchable — a long list is not a list you can use. */
chatsRouter.get("/players/:uid/friends", requireAdmin("support"), async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.uid, req.params.uid));
  if (!user) {
    res.status(404).json({ error: "No player with that UID" });
    return;
  }
  const q = String(req.query.q ?? "").trim().toLowerCase();

  const rows = await db
    .select({
      id: users.id,
      uid: users.uid,
      username: users.username,
      status: friendships.status,
      since: friendships.respondedAt,
      asked: friendships.createdAt,
      // Which way round it was — who asked whom is worth keeping.
      theyAsked: sql<boolean>`${friendships.requesterId} <> ${user.id}`,
    })
    .from(friendships)
    .innerJoin(
      users,
      or(
        and(eq(friendships.requesterId, user.id), eq(users.id, friendships.addresseeId)),
        and(eq(friendships.addresseeId, user.id), eq(users.id, friendships.requesterId))
      )
    )
    .where(
      and(
        or(eq(friendships.requesterId, user.id), eq(friendships.addresseeId, user.id)),
        q ? sql`(lower(${users.username}) like ${"%" + q + "%"} or ${users.uid} like ${"%" + q + "%"})` : sql`true`
      )
    )
    .orderBy(desc(friendships.respondedAt))
    .limit(200);

  res.json({
    friends: rows.map((r) => ({
      uid: r.uid,
      username: r.username,
      status: r.status,
      since: r.since ?? r.asked,
      theyAsked: r.theyAsked,
    })),
  });
});
