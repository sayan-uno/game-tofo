import { Router } from "express";
import { logEvent } from "../services/eventLog.js";
import { requestOrigin } from "../services/clientIp.js";
import type { Server } from "socket.io";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { canEquip, canEquipWeapon, publicCatalog, resolveCharacter, resolveWeapon } from "../services/catalog.js";
import { getUserById } from "../services/users.js";
import { withdrawnItems } from "../platform/gameLocks.js";
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
      // Withdrawn items are not sent at all. Filtering here rather than in the
      // catalog module keeps the game's own idea of what exists intact — the
      // thing still resolves for anybody already wearing it, it is simply no
      // longer offered.
      const gone = new Set(await withdrawnItems());
      const cat = publicCatalog();
      res.json({
        ...cat,
        characters: cat.characters.filter((c) => !gone.has(c.id)),
        weapons: cat.weapons.filter((w) => !gone.has(w.id)),
        emotes: cat.emotes.filter((e) => !gone.has(e.id)),
        equippedCharacter: resolveCharacter(user.equippedCharacter),
        equippedWeapon: resolveWeapon(user.equippedWeapon),
      });
    } catch (err) {
      console.error("Collection load failed:", err);
      res.status(500).json({ error: "Could not load your collection" });
    }
  });

  // Equips a character, a weapon, or both. A weapon is the one slot that can
  // legitimately be emptied, so `weaponId: null` is a real request ("put it
  // away") rather than a missing field — which is why the two are told apart
  // by whether the KEY is present, not by whether the value is truthy.
  router.post("/equip", async (req, res) => {
    try {
      const body = (req.body ?? {}) as { characterId?: unknown; weaponId?: unknown };
      const wantsCharacter = body.characterId !== undefined;
      const wantsWeapon = body.weaponId !== undefined;
      if (!wantsCharacter && !wantsWeapon) {
        res.status(400).json({ error: "Nothing to equip" });
        return;
      }

      const characterId = String(body.characterId ?? "");
      // Server decides what's equippable — the client only names a candidate.
      if (wantsCharacter && !canEquip(characterId)) {
        res.status(400).json({ error: "You don't own that character" });
        return;
      }
      const weaponId = body.weaponId === null || body.weaponId === "" ? null : String(body.weaponId);
      if (wantsWeapon && !canEquipWeapon(weaponId)) {
        res.status(400).json({ error: "You don't own that weapon" });
        return;
      }
      // AND it must not be withdrawn. Leaving it out of the list is not a
      // rule — a client can ask for anything, and the one that asks for a
      // withdrawn item is exactly the client this is meant to stop.
      const withdrawn = new Set(await withdrawnItems());
      if ((wantsCharacter && withdrawn.has(characterId)) || (wantsWeapon && weaponId && withdrawn.has(weaponId))) {
        res.status(400).json({ error: "That is not available any more" });
        return;
      }

      // Returning the row rather than echoing the request: a call that equips
      // only a weapon must still answer with the character the player is
      // wearing, because the client patches its cached collection from this.
      // What they changed into. The GET above is not logged — it returns the
      // same catalog every time and says nothing about anyone.
      const [row] = await db
        .update(users)
        .set({
          ...(wantsCharacter ? { equippedCharacter: characterId } : {}),
          ...(wantsWeapon ? { equippedWeapon: weaponId } : {}),
        })
        .where(eq(users.id, req.auth!.userId))
        .returning();
      logEvent({
        type: "collection.equip",
        userId: req.auth!.userId,
        uid: req.auth!.uid,
        ip: requestOrigin(req).ip,
        data: {
          ...(wantsCharacter ? { character: characterId } : {}),
          ...(wantsWeapon ? { weapon: weaponId } : {}),
        },
      });

      // Squadmates are looking at this character right now — push the change to
      // whichever lobby the player is standing in. Best-effort: a failed
      // broadcast must never fail the equip that already committed.
      try {
        const lobbyId = await getUserLobby(req.auth!.userId);
        if (lobbyId) await broadcastLobby(io, lobbyId);
      } catch (err) {
        console.error("Equip broadcast failed:", err);
      }

      res.json({
        equippedCharacter: resolveCharacter(row?.equippedCharacter),
        equippedWeapon: resolveWeapon(row?.equippedWeapon),
      });
    } catch (err) {
      console.error("Equip failed:", err);
      res.status(500).json({ error: "Could not equip that" });
    }
  });

  return router;
}
