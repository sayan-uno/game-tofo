// Drop-in worlds, for the console.
//
// Everything on this screen was already in the game server's memory: proximity
// voice has to know where everybody is standing, so a moderator asking "what
// is this player actually doing" is a read of something that was computed
// anyway. Nothing is written on the hot path for it, and nothing is written
// per player per tick.
//
// It arrives here the same way live matches do — the game process publishes a
// snapshot to Redis every two seconds under a key with a short TTL, and the
// console reads that. The console is a different process with no view of the
// game's memory, cannot call into it, and cannot occupy the event loop that
// serves the people walking around.
//
// Like the Worlds screen, this is one of the few places the platform's own
// rule is deliberately broken: a bot is labelled. A moderator reading a park
// has to know which half of it can be moderated.
import { redis } from "../../redis.js";
import { safeRouter } from "../asyncRouter.js";
import { requireAdmin } from "../guard.js";

export const islandsRouter = safeRouter();

const PREFIX = "ops:live:islands:";

interface IslandBlob {
  id: string;
  gameId: string;
  phase: string;
  openedAt: number;
  endsAt: number;
  humans: number;
  bots: number;
  recording: boolean;
  who: unknown[];
}

async function readAll(): Promise<{ island: IslandBlob; instanceId: string }[]> {
  const out: { island: IslandBlob; instanceId: string }[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${PREFIX}*`, "COUNT", 100);
    cursor = next;
    for (const k of keys) {
      const raw = await redis.get(k);
      const instanceId = k.slice(PREFIX.length);
      try {
        for (const island of JSON.parse(raw ?? "[]") as IslandBlob[]) out.push({ island, instanceId });
      } catch {
        /* a half-written snapshot is not worth failing the screen for */
      }
    }
  } while (cursor !== "0");
  return out;
}

/** Every live island, with everybody on it. Small by construction — twenty
 *  rows an island — so there is no paging and no second request for detail. */
islandsRouter.get("/islands", requireAdmin("support"), async (_req, res) => {
  const found = await readAll();
  res.json({
    at: Date.now(),
    islands: found
      .map(({ island, instanceId }) => ({ ...island, instanceId }))
      .sort((a, b) => b.humans - a.humans || a.openedAt - b.openedAt),
  });
});

/** One island. Answered from the same snapshot rather than a second source, so
 *  the list and the map can never disagree about who is standing where. */
islandsRouter.get("/islands/:id", requireAdmin("support"), async (req, res) => {
  const found = await readAll();
  const hit = found.find((f) => f.island.id === req.params.id);
  if (!hit) {
    res.status(404).json({ error: "That island is not running" });
    return;
  }
  res.json({ at: Date.now(), ...hit.island, instanceId: hit.instanceId });
});
