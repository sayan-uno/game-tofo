import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { buildProfile } from "../services/profile.js";
import { getUserById } from "../services/users.js";

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
    res.json(await buildProfile(user));
  } catch (err) {
    console.error("Profile load failed:", err);
    res.status(500).json({ error: "Could not load your profile" });
  }
});
