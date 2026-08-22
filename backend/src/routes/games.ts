import { Router } from "express";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { listGames } from "../platform/games.js";
import { gameBanReason, heldGames, hiddenGames } from "../platform/gameLocks.js";

export const gamesRouter = Router();
gamesRouter.use(requireAuth);

/** The games a party can pick. Pack URLs are built here from CDN_BASE_URL,
 *  the same way character URLs are — the client never assembles one. */
gamesRouter.get("/", async (req, res) => {
  // A game that is on hold, or that THIS player is barred from, still appears
  // in the picker — greyed, with the reason on it. Hiding it would be worse:
  // a game that silently vanishes reads as a broken client, and a player who
  // has been barred from one deserves to be told rather than left wondering
  // where it went.
  const held = new Map((await heldGames()).map((h) => [h.gameId, h.reason]));
  // Hidden is not held. A held game is still offered, greyed, with the reason
  // on it — hiding is for something that should not be advertised at all while
  // it is dealt with, so it is filtered out before anything else is decided.
  const hidden = new Set(await hiddenGames());
  const mine = req.auth!.userId;
  const games = listGames().filter((g) => !hidden.has(g.id)).map((g) => ({
    id: g.id,
    name: g.name,
    tagline: g.tagline,
    matchSizes: { solo: g.matchSizeFor("solo"), duo: g.matchSizeFor("duo"), squad: g.matchSizeFor("squad") },
    durationSec: Math.round(g.durationTicks / g.tickRate),
    typicalSec: g.typicalSec ? Math.round(g.typicalSec) : null,
    packVersion: g.pack.version,
    packBytes: g.pack.bytes,
    packUrl: config.cdnBaseUrl && g.pack.bytes > 0 ? `${config.cdnBaseUrl}/${g.pack.key}/manifest.json` : null,
    /** Why nobody may start this right now, or null. */
    heldReason: held.get(g.id) ?? null,
  }));
  const barred = await Promise.all(games.map((g) => gameBanReason(g.id, mine)));
  res.json({ games: games.map((g, i) => ({ ...g, bannedReason: barred[i] })) });
});
