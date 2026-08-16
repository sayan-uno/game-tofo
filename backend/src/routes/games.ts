import { Router } from "express";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { listGames } from "../platform/games.js";

export const gamesRouter = Router();
gamesRouter.use(requireAuth);

/** The games a party can pick. Pack URLs are built here from CDN_BASE_URL,
 *  the same way character URLs are — the client never assembles one. */
gamesRouter.get("/", (_req, res) => {
  const games = listGames().map((g) => ({
    id: g.id,
    name: g.name,
    tagline: g.tagline,
    matchSizes: { solo: g.matchSizeFor("solo"), duo: g.matchSizeFor("duo"), squad: g.matchSizeFor("squad") },
    durationSec: Math.round(g.durationTicks / g.tickRate),
    packVersion: g.pack.version,
    packBytes: g.pack.bytes,
    packUrl: config.cdnBaseUrl && g.pack.bytes > 0 ? `${config.cdnBaseUrl}/${g.pack.key}/manifest.json` : null,
  }));
  res.json({ games });
});
