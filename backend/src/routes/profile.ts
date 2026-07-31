import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { buildProfile } from "../services/profile.js";
import { getUserById, getUserByUid } from "../services/users.js";

export const profileRouter = Router();
profileRouter.use(requireAuth);

/** The signed-in player's own career card. Read live from the users row (never
 *  the JWT) so a name claimed on another device shows up here immediately. */
profileRouter.get("/me", async (req, res) => {
  try {
    const user = await getUserById(req.auth!.userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(await buildProfile(user, req.auth!.userId));
  } catch (err) {
    console.error("Profile load failed:", err);
    res.status(500).json({ error: "Could not load your profile" });
  }
});

/** Any player's card, by UID — squadmates tap each other in the lobby, and
 *  UIDs are already the public handle everywhere else (friend search, invites).
 *  buildProfile blanks the owner-only fields for a viewer who isn't them.
 *  Declared after /me so that stays a route, not a UID. */
profileRouter.get("/:uid", async (req, res) => {
  try {
    const target = await getUserByUid(req.params.uid.trim());
    if (!target) {
      res.status(404).json({ error: "No player found with that UID" });
      return;
    }
    res.json(await buildProfile(target, req.auth!.userId));
  } catch (err) {
    console.error("Profile load failed:", err);
    res.status(500).json({ error: "Could not load that profile" });
  }
});
