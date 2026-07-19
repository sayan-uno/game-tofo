// Single source of truth for the database schema.
// Schema changes: edit here, then
//   1. `npm run db:generate` — writes a versioned SQL migration into drizzle/ (commit it)
//   2. review the generated SQL (especially anything that drops/renames with data)
//   3. `npm run db:migrate` — applies pending migrations to the database
import { sql } from "drizzle-orm";
import { pgTable, primaryKey, uuid, varchar, text, timestamp, index, unique, check } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    uid: varchar("uid", { length: 12 }).notNull().unique("users_uid_key"),
    googleId: text("google_id").notNull().unique("users_google_id_key"),
    email: text("email").notNull().unique("users_email_key"),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_users_uid").on(t.uid)]
);

// Direct messages between two players. One thread per pair — whether it shows
// in the "Friends" or "Recent" chat section is decided at read time from the
// CURRENT friendship status, so history follows the relationship.
// Retention: rows older than 15 days are swept hourly (see startChatRetention).
export const dmMessages = pgTable(
  "dm_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: varchar("body", { length: 500 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_dm_sender_recipient").on(t.senderId, t.recipientId, t.createdAt),
    index("idx_dm_recipient_sender").on(t.recipientId, t.senderId, t.createdAt),
    index("idx_dm_created").on(t.createdAt),
  ]
);

// Squad chat. A "session" starts when a lobby grows past 1 member and is
// wiped when it shrinks back — a new squad always gets a blank chat.
// visible_to snapshots who was in the squad at send time, so players who
// join later never see older messages.
export const teamMessages = pgTable(
  "team_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    lobbyId: text("lobby_id").notNull(),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: varchar("body", { length: 500 }).notNull(),
    visibleTo: uuid("visible_to").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_team_session").on(t.sessionId, t.createdAt),
    index("idx_team_created").on(t.createdAt),
  ]
);

// "Clear chat" markers: hides messages up to cleared_at from THIS user's view
// only. Nothing is deleted here — actual deletion is the 15-day retention
// sweep. New messages after the clear revive the thread naturally.
export const dmClears = pgTable(
  "dm_clears",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clearedAt: timestamp("cleared_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.partnerId] })]
);

// blocker never receives DMs from blocked (and vice versa until unblocked).
export const blocks = pgTable(
  "blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    blockerId: uuid("blocker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedId: uuid("blocked_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("blocks_blocker_blocked_key").on(t.blockerId, t.blockedId),
    index("idx_blocks_blocked").on(t.blockedId),
    check("blocks_check", sql`blocker_id <> blocked_id`),
  ]
);

export const friendships = pgTable(
  "friendships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requesterId: uuid("requester_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addresseeId: uuid("addressee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (t) => [
    unique("friendships_requester_id_addressee_id_key").on(t.requesterId, t.addresseeId),
    index("idx_friendships_addressee").on(t.addresseeId, t.status),
    index("idx_friendships_requester").on(t.requesterId, t.status),
    check("friendships_status_check", sql`status IN ('pending', 'accepted')`),
    check("friendships_check", sql`requester_id <> addressee_id`),
  ]
);
