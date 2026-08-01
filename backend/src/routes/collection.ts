import { Router } from "express";
import type { Server } from "socket.io";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { canEquip, publicCatalog, resolveCharacter } from "../services/catalog.js";
import { getUserById } from "../services/users.js";
import { getUserLobby } from "../redis.js";
import { broadcastLobby } from "../sockets/index.js";

/** The player's collection: everything the catalog offers plus what they own
 *  and wear. Cold path — opened by a deliberate tap, never during play. */
export function collectionRouter(io: Server) {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req, res) => {
    try {
      const user = await getUserById(req.auth!.userId);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json({ ...publicCatalog(), equippedCharacter: resolveCharacter(user.equippedCharacter) });
    } catch (err) {
      console.error("Collection load failed:", err);
      res.status(500).json({ error: "Could not load your collection" });
    }
  });

  router.post("/equip", async (req, res) => {
    try {
      const characterId = String((req.body ?? {}).characterId ?? "");
      // Server decides what's equippable — the client only names a candidate.
      if (!canEquip(characterId)) {
        res.status(400).json({ error: "You don't own that character" });
        return;
      }
      await db.update(users).set({ equippedCharacter: characterId }).where(eq(users.id, req.auth!.userId));

      // Squadmates are looking at this character right now — push the change to
      // whichever lobby the player is standing in. Best-effort: a failed
      // broadcast must never fail the equip that already committed.
      try {
        const lobbyId = await getUserLobby(req.auth!.userId);
        if (lobbyId) await broadcastLobby(io, lobbyId);
      } catch (err) {
        console.error("Equip broadcast failed:", err);
      }

      res.json({ equippedCharacter: characterId });
    } catch (err) {
      console.error("Equip failed:", err);
      res.status(500).json({ error: "Could not equip that character" });
    }
  });

  return router;
}
