import "dotenv/config";

export const config = {
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
  return missing;
}
