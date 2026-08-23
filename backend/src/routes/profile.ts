import { Router } from "express";
import { logEvent } from "../services/eventLog.js";
import { requestOrigin } from "../services/clientIp.js";
import { requireAuth } from "../middleware/auth.js";
import { buildBotProfile, buildProfile } from "../services/profile.js";
import { getBotByUid } from "../platform/botAccounts.js";
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
    // Looking at another player is a deliberate act, and one an investigation
    // asks about. Their OWN profile is not logged: opening your own page says
    // nothing about anybody.
    if (req.params.uid !== req.auth!.uid) {
      logEvent({
        type: "profile.view",
        userId: req.auth!.userId,
        uid: req.auth!.uid,
        ip: requestOrigin(req).ip,
        data: { viewed: req.params.uid },
      });
    }
  try {
    const wanted = req.params.uid.trim();
    const target = await getUserByUid(wanted);
    if (!target) {
      // Not a player. It may still be somebody standing in a world chat or in
      // this party — a member of the server population, whose card is built
      // from its own real match history (W1). Checked here rather than in
      // getUserByUid so nothing that authenticates, friends or messages an
      // account can ever resolve one by accident.
      const bot = getBotByUid(wanted);
      if (bot) {
        res.json(await buildBotProfile(bot));
        return;
      }
      res.status(404).json({ error: "No player found with that UID" });
      return;
    }
    res.json(await buildProfile(target, req.auth!.userId));
  } catch (err) {
    console.error("Profile load failed:", err);
    res.status(500).json({ error: "Could not load that profile" });
  }
});
