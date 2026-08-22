// The notices this player has been sent, for the list in their lobby.
//
// Read on demand rather than pushed and remembered: a player who wants to
// re-read something from yesterday should not depend on their client having
// kept it, and a notice the admin has since taken back must be gone from here
// the moment they look.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { noticesFor } from "../services/notices.js";

export const noticesRouter = Router();
noticesRouter.use(requireAuth);

noticesRouter.get("/", async (req, res) => {
  const rows = await noticesFor(req.auth!.uid);
  res.json({
    notices: rows.map((n) => ({ id: n.id, body: n.body, sentAt: n.sentAt })),
  });
});
