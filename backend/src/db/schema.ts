// Single source of truth for the database schema.
// Schema changes: edit here, then
//   1. `npm run db:generate` — writes a versioned SQL migration into drizzle/ (commit it)
//   2. review the generated SQL (especially anything that drops/renames with data)
//   3. `npm run db:migrate` — applies pending migrations to the database
import { sql } from "drizzle-orm";
import {
  pgTable,
  primaryKey,
  uuid,
  varchar,
  text,
  timestamp,
  index,
  uniqueIndex,
  unique,
  check,
  integer,
  boolean,
  jsonb,
  bigint,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    uid: varchar("uid", { length: 12 }).notNull().unique("users_uid_key"),
    googleId: text("google_id").notNull().unique("users_google_id_key"),
    email: text("email").notNull().unique("users_email_key"),
    name: text("name").notNull(),
    // The in-game identity, claimed once on the post-signup screen (or
    // auto-generated on Skip). Everything player-facing shows THIS, never the
    // Google name. varchar(15) counts code points — same unit the app-side
    // validation uses. NULL = hasn't passed the claim screen yet; those
    // accounts are turned away at the socket handshake until they do.
    username: varchar("username", { length: 15 }),
    avatarUrl: text("avatar_url"),
    // Catalog id of the character the player wears in the lobby. NULL means
    // "never chose one" and reads as the catalog's default, so existing rows
    // need no backfill and a retired character can't leave anyone invisible.
    // Ownership lives in the catalog for now (both starters are free); when
    // paid characters ship this gets checked against a user_items table.
    equippedCharacter: varchar("equipped_character", { length: 40 }),
    // Catalog id of the weapon held in the lobby. NULL means empty-handed,
    // which — unlike a character — is a legitimate resting state and the
    // default, so nothing is backfilled and a retired weapon simply leaves the
    // hand empty rather than falling back to some other blade.
    equippedWeapon: varchar("equipped_weapon", { length: 40 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_users_uid").on(t.uid),
    // Case-insensitive uniqueness: "Titan" also blocks "TITAN". The index is
    // the referee for claim races — the loser gets a 23505 and a clean
    // "taken" answer. Also serves the availability probe's lower() lookup.
    uniqueIndex("users_username_lower_key").on(sql`lower(${t.username})`),
  ]
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

// ---------------------------------------------------------------------------
// Matches
//
// One row per finished match, written ONCE by the server from its own replay
// of the input logs — never from anything a client reported. `match_key` is
// the runtime match id and is unique, which is what makes the write
// idempotent: a retry (or a double "match ended") cannot double-count a win.
//
// Nothing game-specific gets a column. Per-game numbers live in
// match_players.detail as JSON, so a second game adds no migration.
// ---------------------------------------------------------------------------
export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchKey: text("match_key").notNull().unique("matches_match_key_key"),
    gameId: varchar("game_id", { length: 40 }).notNull(),
    // The course seed. 32-bit unsigned, so it does not fit `integer`.
    seed: bigint("seed", { mode: "number" }).notNull(),
    /** timeout | all-out | abandoned | aborted */
    reason: text("reason").notNull(),
    /** Simulation ticks the match ran for. */
    ticks: integer("ticks").notNull(),
    playerCount: integer("player_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_matches_created").on(t.createdAt), index("idx_matches_game").on(t.gameId, t.createdAt)]
);

// One row per runner in a match. user_id is NULL for server bots (M3), which
// is why the name is snapshotted here rather than joined — a bot has no user
// row, and a real player's tag at the time of the match is what the history
// should show.
export const matchPlayers = pgTable(
  "match_players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    isBot: boolean("is_bot").notNull().default(false),
    name: text("name").notNull(),
    /** 1 = first. Equal results share a placement, so several rows can be 1. */
    placement: integer("placement").notNull(),
    score: integer("score").notNull(),
    forfeit: boolean("forfeit").notNull().default(false),
    /** Per-game numbers (distance, coins, near misses…). */
    detail: jsonb("detail").notNull().default({}),
  },
  (t) => [
    index("idx_match_players_match").on(t.matchId),
    index("idx_match_players_user").on(t.userId),
    unique("match_players_match_user_key").on(t.matchId, t.userId),
  ]
);

// Pre-aggregated career totals: the profile page is opened by a deliberate tap
// and must stay ONE primary-key read, so the aggregate is maintained at write
// time rather than computed from match_players on every open.
export const playerStats = pgTable("player_stats", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  matches: integer("matches").notNull().default(0),
  wins: integer("wins").notNull().default(0),
  losses: integer("losses").notNull().default(0),
  draws: integer("draws").notNull().default(0),
  /** Best (lowest) placement ever reached. */
  bestPlacement: integer("best_placement"),
  totalScore: bigint("total_score", { mode: "number" }).notNull().default(0),
  coins: bigint("coins", { mode: "number" }).notNull().default(0),
  distanceMetres: bigint("distance_metres", { mode: "number" }).notNull().default(0),
  playtimeSeconds: integer("playtime_seconds").notNull().default(0),
  xp: bigint("xp", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
