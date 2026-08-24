// The store, from a player's side.
//
// Four routes and nothing clever: what is for sale, what I hold, open a
// payment, is it done yet. Every price comes from the server — the client
// sends a pack id and is told what to pay, never the other way round, because
// a client that names its own price is a client that names ₹1.
//
// Cold path throughout. A player opens this by deliberately tapping the gem
// chip, and the only repeated call is a status poll that runs while a QR is on
// screen and stops the moment it is not.
import { Router } from "express";
import type { Server } from "socket.io";
import { requireAuth } from "../middleware/auth.js";
import { getUserById } from "../services/users.js";
import { logEvent } from "../services/eventLog.js";
import { getBalance, ledger } from "../services/wallet.js";
import { cancelSession, getOwnSession, openSession, PACKS, WINDOW_MS, GRACE_MS } from "../services/payments.js";

export function storeRouter(_io: Server) {
  const router = Router();
  router.use(requireAuth);

  /** The shelf, plus this player's balance — one call, because the store
   *  cannot be drawn without both and two requests would only be two chances
   *  to render half of it. */
  router.get("/", async (req, res) => {
    try {
      const balance = await getBalance(req.auth!.userId);
      res.json({
        balance,
        packs: PACKS.map((p) => ({ id: p.id, gems: p.gems, pricePaise: p.pricePaise, art: p.art, tag: p.tag })),
        windowMs: WINDOW_MS,
        graceMs: GRACE_MS,
      });
    } catch (err) {
      console.error("[store] shelf:", err);
      res.status(500).json({ error: "Could not open the store" });
    }
  });

  router.get("/wallet", async (req, res) => {
    try {
      res.json({ balance: await getBalance(req.auth!.userId), ledger: await ledger(req.auth!.userId, 30) });
    } catch (err) {
      console.error("[store] wallet:", err);
      res.status(500).json({ error: "Could not read your wallet" });
    }
  });

  /** Press Buy.
   *
   *  Every press opens a NEW payment, one paise above the last — see the note
   *  on `openSession`. Closing the window leaves the previous one running, so
   *  a code somebody screenshotted before is still payable; they simply never
   *  see a stale timer counting down on a QR they have come back to. */
  router.post("/buy", async (req, res) => {
    const packId = String((req.body ?? {}).packId ?? "");
    try {
      const user = await getUserById(req.auth!.userId);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      const result = await openSession({
        userId: user.id,
        uid: user.uid,
        username: user.username ?? user.name,
        packId,
      });
      if (!result.ok) {
        // 409 for BUSY and TOO_MANY: nothing is wrong with the request, the
        // world is simply not ready for it, and a client that can tell those
        // apart can say "try again" instead of "something went wrong".
        res.status(result.code === "NO_PACK" ? 400 : 409).json({ error: result.error, code: result.code });
        return;
      }
      logEvent({
        type: "store.open",
        userId: user.id,
        uid: user.uid,
        data: { packId, amountPaise: result.session.amountPaise, offset: result.session.collisionOffset },
      });
      res.json(result);
    } catch (err) {
      console.error("[store] buy:", err);
      res.status(500).json({ error: "Could not start that payment" });
    }
  });

  /** The poll behind the QR. Scoped to the caller's own sessions, so a session
   *  id is never a way to watch somebody else's purchase. */
  router.get("/session/:id", async (req, res) => {
    try {
      const session = await getOwnSession(String(req.params.id), req.auth!.userId);
      if (!session) {
        res.status(404).json({ error: "No such payment" });
        return;
      }
      res.json({ session, balance: await getBalance(req.auth!.userId) });
    } catch (err) {
      console.error("[store] session:", err);
      res.status(500).json({ error: "Could not check that payment" });
    }
  });

  /** Giving up on a payment — an EXPLICIT "I am not paying this", never the
   *  popup merely being closed.
   *
   *  Closing used to call this, and it was wrong in the way that costs a real
   *  player real money: the flow this store asks for is to screenshot the code
   *  and pay somewhere else, so the popup is closed on the way to paying far
   *  more often than instead of it. Releasing the amount there meant the bank
   *  SMS arrived with nothing holding it, and the payment could only be put
   *  right by hand. */
  router.post("/session/:id/cancel", async (req, res) => {
    try {
      res.json({ cancelled: await cancelSession(String(req.params.id), req.auth!.userId) });
    } catch (err) {
      console.error("[store] cancel:", err);
      res.status(500).json({ error: "Could not cancel that payment" });
    }
  });

  return router;
}
