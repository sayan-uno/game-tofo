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
  bigserial,
  inet,
  char,
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
    // "How many signed up today" is an admin-console question asked on every
    // dashboard load; without this it is a sequential scan of every account.
    index("idx_users_created").on(t.createdAt),
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

// ===========================================================================
// Admin console — A0 foundations
//
// Every table below is COLD. The rules that keep them off a player's hot path
// live with the code that writes them, and are worth restating here because
// the temptation to "just add one more insert" is exactly how that promise
// gets broken:
//
//   * event_log is never written inline. services/eventLog.ts buffers in
//     memory and flushes one multi-row INSERT every couple of seconds, so a
//     socket handshake never waits on Postgres.
//   * sanctions is the record of truth, but nothing on a hot path reads it.
//     Enforcement reads a Redis key (services/sanctions.ts); this table is
//     what that key is rebuilt from.
//   * Neither event_log nor admin_audit carries a foreign key to the row it
//     describes. An audit trail that a DELETE can rewrite is not an audit
//     trail — these rows must outlive the accounts they are about.
// ===========================================================================

/** People who can sign in to the admin console. Deliberately NOT the players
 *  table: a different realm, a different token audience, and no path by which
 *  a player row could ever become an admin one. */
export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique("admin_users_email_key"),
    name: text("name").notNull(),
    /** owner | admin | moderator | support | analyst */
    role: varchar("role", { length: 20 }).notNull().default("moderator"),
    /** active | disabled */
    status: varchar("status", { length: 20 }).notNull().default("active"),
    /** AES-256-GCM ciphertext of the TOTP secret. NULL until enrolment; never
     *  plaintext, because a database dump would otherwise hand over a
     *  permanent code generator. */
    totpSecretEnc: text("totp_secret_enc"),
    /** NULL until one working code has been confirmed — a bad QR scan must
     *  not be able to lock the only admin out of their own console. */
    totpActivatedAt: timestamp("totp_activated_at", { withTimezone: true }),
    /** Highest TOTP time-step already accepted. Replay protection: a code read
     *  over a shoulder must not stay usable for the rest of its 30 seconds. */
    totpLastStep: bigint("totp_last_step", { mode: "number" }),
    /** argon2id. Optional third factor — see the login plan. */
    passwordHash: text("password_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("admin_users_email_lower_key").on(sql`lower(${t.email})`),
    check("admin_users_role_check", sql`role IN ('owner','admin','moderator','support','analyst')`),
    check("admin_users_status_check", sql`status IN ('active','disabled')`),
  ]
);

/** One row per signed-in admin browser. Exists so a session can be revoked
 *  remotely — including from a shell script, for the day the console itself
 *  cannot be reached. */
export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    /** SHA-256 of the refresh token. The token itself is never stored. */
    refreshHash: char("refresh_hash", { length: 64 }).notNull().unique("admin_sessions_refresh_key"),
    ip: inet("ip"),
    ua: text("ua"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("idx_admin_sessions_admin").on(t.adminId, t.createdAt)]
);

/** Ten single-use codes, argon2id-hashed, printed at enrolment and kept
 *  offline. The way back in when the authenticator phone is gone. */
export const adminRecoveryCodes = pgTable(
  "admin_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminId: uuid("admin_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_admin_recovery_admin").on(t.adminId)]
);

/** Every admin action AND every sensitive read (an IP history opened, a voice
 *  recording played). Append-only by design: the console's database role gets
 *  INSERT here and nothing else, and the admin's identity is snapshotted into
 *  the row rather than joined, so deleting an account cannot blank the trail. */
export const adminAudit = pgTable(
  "admin_audit",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** No foreign key on purpose — see the section comment. */
    adminId: uuid("admin_id"),
    adminEmail: text("admin_email").notNull(),
    /** e.g. "sanction.apply", "voice.play", "player.viewIps" */
    action: varchar("action", { length: 60 }).notNull(),
    /** user | match | sanction | recording | admin | platform */
    targetType: varchar("target_type", { length: 30 }),
    targetId: text("target_id"),
    ip: inet("ip"),
    /** Required by the console for anything irreversible. */
    reason: text("reason"),
    before: jsonb("before"),
    after: jsonb("after"),
    requestId: text("request_id"),
  },
  (t) => [
    index("idx_admin_audit_at").on(t.at),
    index("idx_admin_audit_admin").on(t.adminId, t.at),
    index("idx_admin_audit_target").on(t.targetType, t.targetId, t.at),
    index("idx_admin_audit_action").on(t.action, t.at),
  ]
);

/** The session/activity trail: signed in, connected, entered a match, dropped,
 *  banned. One row per durable fact, written by the buffered logger.
 *
 *  Not partitioned. Declarative partitioning is the right answer at tens of
 *  millions of rows and pure overhead below that — it needs a job creating next
 *  month's partition and it cannot be expressed in this schema file. Retention
 *  is an archive-then-DELETE sweep instead; the indexes below are what make
 *  both the sweep and every console query cheap. Revisit when the table is
 *  genuinely large, not before. */
export const eventLog = pgTable(
  "event_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** session.start | session.end | auth.login | match.join | match.end |
     *  sanction.applied | sanction.lifted | … */
    type: varchar("type", { length: 40 }).notNull(),
    /** No foreign key — this row is evidence and must survive the account. */
    userId: uuid("user_id"),
    uid: varchar("uid", { length: 12 }),
    ip: inet("ip"),
    ipCountry: char("ip_country", { length: 2 }),
    ua: text("ua"),
    deviceHash: char("device_hash", { length: 32 }),
    matchKey: text("match_key"),
    gameId: varchar("game_id", { length: 40 }),
    lobbyId: text("lobby_id"),
    data: jsonb("data").notNull().default({}),
  },
  (t) => [
    index("idx_event_log_at").on(t.at),
    index("idx_event_log_user").on(t.userId, t.at),
    index("idx_event_log_type").on(t.type, t.at),
    index("idx_event_log_ip").on(t.ip, t.at),
    index("idx_event_log_device").on(t.deviceHash, t.at),
  ]
);

/** Which devices an account has been seen on. Not tracking for its own sake:
 *  this is what makes ban evasion visible — one device hash, three accounts,
 *  one of them banned. */
export const userDevices = pgTable(
  "user_devices",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceHash: char("device_hash", { length: 32 }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    seenCount: integer("seen_count").notNull().default(1),
    ua: text("ua"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.deviceHash] }),
    // The reverse lookup is the whole point: given a device, who else is on it.
    index("idx_user_devices_hash").on(t.deviceHash),
  ]
);

/** Bans and mutes. The record of truth — but nothing on a hot path reads it.
 *  Applying a sanction also writes `ban:<userId>` to Redis with a TTL, and THAT
 *  is what the socket handshake and requireAuth check. */
export const sanctions = pgTable(
  "sanctions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** ban | match | voice | chat | shadow-chat */
    type: varchar("type", { length: 20 }).notNull(),
    /** Shown to the player. */
    reason: text("reason").notNull(),
    /** Internal only, never leaves the console. */
    note: text("note"),
    createdBy: uuid("created_by").references(() => adminUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** NULL = permanent. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by").references(() => adminUsers.id, { onDelete: "set null" }),
    /** Replay keys, recording ids, report ids — whatever justified it. */
    evidence: jsonb("evidence").notNull().default({}),
  },
  (t) => [
    index("idx_sanctions_user").on(t.userId, t.createdAt),
    index("idx_sanctions_expiry").on(t.expiresAt),
    check("sanctions_type_check", sql`type IN ('ban','match','voice','chat','shadow-chat')`),
  ]
);

/** Where a finished match's input log was archived. Keyed on the runtime match
 *  id rather than a foreign key to `matches`, because the replay is written by
 *  the match runtime and must land even if recording the result did not. */
export const matchReplays = pgTable(
  "match_replays",
  {
    matchKey: text("match_key").primaryKey(),
    gameId: varchar("game_id", { length: 40 }).notNull(),
    r2Key: text("r2_key").notNull(),
    bytes: integer("bytes").notNull(),
    formatVersion: integer("format_version").notNull().default(1),
    /** standard (30d) | extended (365d, a flagged player was in it) | hold
     *  (attached to an open case — never swept). */
    tier: varchar("tier", { length: 12 }).notNull().default("standard"),
    /** NULL for hold. The nightly sweeper deletes by this and nothing else, so
     *  no one can quietly remove an inconvenient match. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_match_replays_expiry").on(t.tier, t.expiresAt),
    index("idx_match_replays_created").on(t.createdAt),
  ]
);

/** An open flag on a player: record their voice, or keep their replays longer.
 *  Budgeted on purpose — egress is billed per participant-minute, so a flag
 *  that never expires is a bill that never stops. */
export const recordingTargets = pgTable(
  "recording_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** voice | replay-extended */
    kind: varchar("kind", { length: 20 }).notNull(),
    reason: text("reason").notNull(),
    createdBy: uuid("created_by").references(() => adminUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Hard stop, always set. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    maxMatches: integer("max_matches").notNull().default(20),
    matchesUsed: integer("matches_used").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_recording_targets_user").on(t.userId),
    check("recording_targets_kind_check", sql`kind IN ('voice','replay-extended')`),
  ]
);

/** One minute of the platform, written down.
 *
 *  The live snapshot in Redis answers "what is happening"; it expires in
 *  seconds and answers nothing about last night. This is the same numbers kept
 *  on a minute's cadence so the console can go BACK — how many were online at
 *  03:14, and what was running.
 *
 *  The absence of rows is the most valuable thing in the table: a minute with
 *  no row is a minute the server was not writing one, which is how an outage
 *  that happened while everyone was asleep becomes visible instead of being
 *  something to guess about later.
 */
export const platformHistory = pgTable(
  "platform_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** Which process wrote it — several may, and each is its own line. */
    instance: text("instance").notNull(),
    online: integer("online").notNull(),
    sockets: integer("sockets").notNull(),
    matches: integer("matches").notNull(),
    matchPlayers: integer("match_players").notNull(),
    matchBots: integer("match_bots").notNull(),
    queued: integer("queued").notNull(),
    rssMb: integer("rss_mb").notNull(),
    byGame: jsonb("by_game").notNull().default({}),
  },
  (t) => [index("idx_platform_history_at").on(t.at), unique("platform_history_at_instance_key").on(t.at, t.instance)]
);

/** A stretch of time during which one party was recorded.
 *
 *  A party has no identity of its own in the platform: its room is named after
 *  whoever leads it (`L<uid>`), so the same three people appear under two
 *  different names depending on who is leader, and a name is reused by a
 *  different group later. That is fine for routing voice and useless as a
 *  record — "what was said in that party" cannot be answered by a name that
 *  means different things on different days.
 *
 *  So a recorded party gets an id of its own, and this row is what that id
 *  means: which room, when it ran, and every arrival and departure while it
 *  did. It is also what makes the party studio possible — a match has a replay
 *  to lay voices over, and a party has this.
 */
export const partySessions = pgTable(
  "party_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Matches `voice_recordings.match_key` for this session's audio. */
    key: text("key").notNull().unique("party_sessions_key_key"),
    /** The LiveKit room, which is the lobby id at the time. */
    room: text("room").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Everyone who was ever in it, with the name they had at the time. */
    roster: jsonb("roster").notNull().default([]),
    /** Kept only while the session is live and small; the finished log lives
     *  in the evidence bucket, exactly like a match replay. */
    events: jsonb("events").notNull().default([]),
    /** Where the packed simulation is. Null while the party is still running. */
    r2Key: text("r2_key"),
    bytes: integer("bytes"),
    eventCount: integer("event_count"),
    /** Ten days, then it goes — the same promise as everything else here. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_party_sessions_room").on(t.room, t.startedAt),
    index("idx_party_sessions_started").on(t.startedAt),
    index("idx_party_sessions_expiry").on(t.expiresAt),
  ]
);

/** One audio file per participant per recorded match. The bytes live in the
 *  private evidence bucket; this row is how the console finds them. */
export const voiceRecordings = pgTable(
  "voice_recordings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The room this belongs to: a match id, or a lobby id when `scope` says
     *  lobby. Named for matches because they came first. */
    matchKey: text("match_key").notNull(),
    /** match | lobby — shown in the console, because a recording made in a
     *  party is not evidence about a match and must never read as one. */
    scope: varchar("scope", { length: 8 }).notNull().default("match"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    uid: varchar("uid", { length: 12 }).notNull(),
    r2Key: text("r2_key").notNull(),
    /** The published microphone this file is. One per track, not per player:
     *  turning the mic off and on publishes a second one. The room mix uses
     *  the sentinel "mix", so the unique index below dedupes it too. */
    trackSid: text("track_sid"),
    /** track = one person's microphone; mix = everyone in the room, together.
     *  Both are kept: the mix is how a conversation is understood, the tracks
     *  are how "who said it" is answered. */
    kind: varchar("kind", { length: 8 }).notNull().default("track"),
    /** Where this file starts on the session's timeline, in milliseconds.
     *  For a match that timeline is the REPLAY's — 0 is tick 0 — which is what
     *  lets the studio play the audio in step with the game. */
    offsetMs: integer("offset_ms"),
    /** When this person was actually talking: [startMs, endMs] pairs on the
     *  session's own timeline. Measured while recording, from the audio
     *  itself — something an external recorder could never hand back. It is
     *  what lets the console light a microphone from fact and jump a moderator
     *  straight to where somebody spoke. */
    speech: jsonb("speech"),
    /** Parties only: who was in the group. Matches keep their roster in
     *  match_players, but a party is not persisted anywhere else, so without
     *  this "who were they with" is unanswerable a week later. */
    roster: jsonb("roster"),
    egressId: text("egress_id"),
    /** starting | active | complete | failed */
    status: varchar("status", { length: 16 }).notNull().default("starting"),
    /** Why it failed, in LiveKit's words. Kept because a console that says
     *  only "failed" makes somebody read a database to find out. */
    error: text("error"),
    bytes: bigint("bytes", { mode: "number" }),
    durationSec: integer("duration_sec"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_voice_recordings_match").on(t.matchKey),
    index("idx_voice_recordings_user").on(t.userId, t.startedAt),
    index("idx_voice_recordings_expiry").on(t.expiresAt),
    // One live recording per published microphone, enforced by the database
    // rather than by a check-then-act in application code. LiveKit retries
    // webhooks, so the same "track published" can arrive twice within
    // milliseconds; without this both pass the check, both start an egress,
    // and the two files overwrite each other at the same key while both rows
    // claim to be the recording. Failed attempts are excluded so a retry can
    // still claim the track.
    uniqueIndex("voice_recordings_live_track_key")
      .on(t.matchKey, t.trackSid)
      .where(sql`status <> 'failed'`),
    check("voice_recordings_status_check", sql`status IN ('starting','active','complete','failed')`),
    check("voice_recordings_scope_check", sql`scope IN ('match','lobby')`),
    check("voice_recordings_kind_check", sql`kind IN ('track','mix')`),
  ]
);

/** Notices sent to players from the console.
 *
 *  A record rather than a fire-and-forget broadcast, for three reasons an
 *  admin runs into within a week of using it:
 *
 *    A notice sent by mistake has to be REMOVABLE. Deleting one takes it off
 *    every player's list and stops it reaching anybody who was offline when it
 *    went out — which is the only window in which "undo" means anything.
 *
 *    A player wants to read it again. A message that appears once and is gone
 *    is a message half of them will say they never got.
 *
 *    And one send is ONE row, whoever it went to. A notice to the whole
 *    platform must not become forty thousand rows an admin has to tidy.
 */
export const notices = pgTable(
  "notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    body: text("body").notNull(),
    /** everyone — including people who have not connected yet.
     *  online   — whoever was connected at the moment it was sent.
     *  players  — named accounts. */
    audience: varchar("audience", { length: 12 }).notNull(),
    /** Who it actually went to, for the two audiences that name people. Empty
     *  for `everyone`, which is defined by the absence of a list rather than
     *  by a snapshot of it — a notice for everybody should reach the player
     *  who signs up tomorrow. */
    uids: jsonb("uids").notNull().default(sql`'[]'::jsonb`),
    sentBy: text("sent_by"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    /** Deleted, not destroyed: an admin taking a notice back is itself a thing
     *  that happened, and the audit trail refers to this row. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: text("deleted_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_notices_sent").on(t.sentAt),
    index("idx_notices_expiry").on(t.expiresAt),
    check("notices_audience_check", sql`audience IN ('everyone','online','players')`),
  ]
);

/** Events: something the platform wants a player to SEE.
 *
 *  A notice is a sentence; an event is a picture, a clip, or a piece of
 *  markup — a new weapon, a season, a tournament. The difference that matters
 *  in the code is that an event can be PINNED, which means it is put in front
 *  of a player the next time they arrive rather than waiting to be found.
 *
 *  "The next time they arrive" is deliberately narrow: a fresh sign-in or a
 *  reload, not coming back from another tab. Something that reappears every
 *  time somebody glances away is not an announcement, it is a nuisance — and
 *  the fastest way to teach people to close it without reading.
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    /** image | video | html — what `body` means. */
    kind: varchar("kind", { length: 8 }).notNull(),
    /** A URL for image and video; the markup itself for html. */
    body: text("body").notNull(),
    /** Shown on arrival, not just in the list. */
    pinned: boolean("pinned").notNull().default(false),
    /** Catalog item this event is about. Clicking the event opens the
     *  collection with it selected — an advert for a weapon that does not take
     *  you to the weapon is an advert that wastes everybody's time. */
    itemId: varchar("item_id", { length: 40 }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_events_created").on(t.createdAt),
    check("events_kind_check", sql`kind IN ('image','video','html')`),
  ]
);
