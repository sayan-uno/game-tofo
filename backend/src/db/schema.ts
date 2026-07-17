// Single source of truth for the database schema.
// Schema changes: edit here, then
//   1. `npm run db:generate` — writes a versioned SQL migration into drizzle/ (commit it)
//   2. review the generated SQL (especially anything that drops/renames with data)
//   3. `npm run db:migrate` — applies pending migrations to the database
import { sql } from "drizzle-orm";
import { pgTable, uuid, varchar, text, timestamp, index, unique, check } from "drizzle-orm/pg-core";

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
