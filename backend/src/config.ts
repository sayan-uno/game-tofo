import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** This file's own directory — backend/src when running from source, backend/
 *  dist when running the build. Used to anchor paths to the PACKAGE rather
 *  than to whatever directory the process happened to be started from. */
const here = path.dirname(fileURLToPath(import.meta.url));

/** What this process is. "game" runs the sockets, the matchmaker and the
 *  matches; "admin" runs the console API and MUST NOT run any of those.
 *
 *  This is not a preference. Two processes pointed at one Redis both run
 *  matchmakers, either can claim a party from the pool, and the one that wins
 *  creates the match in ITS memory and emits to ITS sockets — so the player
 *  waits on FINDING PLAYERS forever while the other log cheerfully reports a
 *  match starting. The role switch is what makes a second process safe. */
export type ProcessRole = "game" | "admin";
const role: ProcessRole = process.env.ROLE === "admin" ? "admin" : "game";

export const config = {
  role,
  /** Distinguishes this process in the ops snapshot, so several game servers
   *  can eventually publish side by side and the console just sums them. */
  instanceId: process.env.INSTANCE_ID || `${role}-${process.pid}`,
  port: Number(process.env.PORT || 4000),
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
  databaseUrl: process.env.DATABASE_URL || "",
  redisUrl: process.env.REDIS_URL || "",
  // Comma-separated list. First one is the web client ID; add the Android
  // and iOS client IDs later when native apps exist — no code change needed.
  googleClientIds: (process.env.GOOGLE_CLIENT_ID || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  jwtSecret: process.env.JWT_SECRET || "",
  // Where the 3D assets live (Cloudflare R2 today). The database and the
  // catalog only ever store PATHS — "characters/male/v1/model.glb" — and this
  // is the one value that turns them into URLs. Moving CDN or putting a custom
  // domain in front is this line and nothing else. Trailing slashes are
  // stripped so joins stay predictable.
  cdnBaseUrl: (process.env.CDN_BASE_URL || "").replace(/\/+$/, ""),
  // ---- admin console (A0) ----
  //
  // How many proxies sit in front of this process. 0 means "believe nothing a
  // header says and use the socket address" — the safe default, because an
  // attacker-controlled IP in an evidence log is worse than no IP at all.
  // Behind Cloudflare (or any single reverse proxy) set it to 1.
  trustedProxyHops: Number(process.env.TRUSTED_PROXY_HOPS || 0),
  // Signs commands the admin process publishes to the game process. Without
  // it the control channel refuses to start — a channel that executes
  // unsigned commands is worse than no channel.
  opsHmacSecret: process.env.OPS_HMAC_SECRET || "",
  admin: {
    // The console is mounted under this path segment and nowhere else;
    // everything off it answers 404, exactly like /ops/bots. Obscurity, not
    // security — assume it leaks eventually and never let it be the only gate.
    path: (process.env.ADMIN_PATH || "").replace(/^\/+|\/+$/g, ""),
    // A DIFFERENT key from the player one, and admin tokens carry aud:"admin".
    // A player token presented here is then a forgery rather than a near-miss,
    // and the same in reverse — the two realms cannot be confused by a mistake.
    jwtSecret: process.env.ADMIN_JWT_SECRET || "",
    // 32 bytes, hex. Encrypts TOTP secrets at rest: whoever holds one can
    // generate that admin's codes for ever, so a database dump must not.
    totpEncKey: process.env.TOTP_ENC_KEY || "",
    // Creates the first owner when admin_users is EMPTY, and never otherwise.
    bootstrapEmail: (process.env.ADMIN_BOOTSTRAP_EMAIL || "").trim().toLowerCase(),
    // Where the console UI is served from — the only origin allowed to call.
    origin: process.env.ADMIN_ORIGIN || "http://localhost:5174",
    // Short, because a stolen access token is the likeliest way in.
    accessTtlMin: Number(process.env.ADMIN_ACCESS_TTL_MIN || 20),
    refreshTtlHours: Number(process.env.ADMIN_REFRESH_TTL_HOURS || 12),
    // How long a fresh code buys you for the irreversible things.
    sudoTtlMin: Number(process.env.ADMIN_SUDO_TTL_MIN || 5),
  },
  // The PRIVATE bucket that holds evidence: match replays, and later voice
  // recordings and archived logs. Deliberately not the bucket the asset packs
  // live in — that one is world-readable and its token is handed to a build
  // script, and neither of those is true of evidence.
  //
  // Unset means replays are written to disk instead, which is right for a
  // development machine and wrong for a server; the process says which it is
  // doing at boot rather than leaving it to be discovered.
  evidence: {
    accountId: process.env.R2_EVIDENCE_ACCOUNT_ID || "",
    bucket: process.env.R2_EVIDENCE_BUCKET || "",
    accessKeyId: process.env.R2_EVIDENCE_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_EVIDENCE_SECRET_ACCESS_KEY || "",
    /** Where the local fallback writes. Git-ignored.
     *
     *  Anchored to backend/ rather than to the current directory: a relative
     *  path means "wherever this was started from", so the server and anything
     *  reading its output would silently disagree the moment one of them was
     *  launched from somewhere else. */
    localDir: process.env.EVIDENCE_DIR || path.resolve(here, "..", ".evidence"),
  },
  // Cloudflare Access, when it is in front. Set both and every admin request
  // must carry a Cloudflare-signed assertion — which is what stops someone who
  // finds the origin IP from walking straight past Access.
  cfAccess: {
    team: (process.env.CF_ACCESS_TEAM || "").trim(),
    aud: (process.env.CF_ACCESS_AUD || "").trim(),
  },
  // Login alerts and lockout alerts. Deliberately NOT email: the point is a
  // channel separate from the one that receives recovery codes.
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID || "",
  },
  livekit: {
    url: process.env.LIVEKIT_URL || "",
    apiKey: process.env.LIVEKIT_API_KEY || "",
    apiSecret: process.env.LIVEKIT_API_SECRET || "",
  },
};

export function assertConfig(): string[] {
  const missing: string[] = [];
  if (!config.databaseUrl) missing.push("DATABASE_URL");
  if (!config.redisUrl) missing.push("REDIS_URL");
  if (config.googleClientIds.length === 0) missing.push("GOOGLE_CLIENT_ID");
  if (!config.jwtSecret) missing.push("JWT_SECRET");
  // The console refuses to start half-configured rather than starting with a
  // gate missing. Every one of these IS a gate.
  if (config.role === "admin") {
    if (!config.admin.path) missing.push("ADMIN_PATH");
    if (!config.admin.jwtSecret) missing.push("ADMIN_JWT_SECRET");
    if (config.admin.jwtSecret === config.jwtSecret) missing.push("ADMIN_JWT_SECRET (must differ from JWT_SECRET)");
    if (!/^[0-9a-f]{64}$/i.test(config.admin.totpEncKey)) missing.push("TOTP_ENC_KEY (64 hex characters)");
    if (!config.opsHmacSecret) missing.push("OPS_HMAC_SECRET");
  }
  return missing;
}
