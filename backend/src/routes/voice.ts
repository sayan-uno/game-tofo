import { Router } from "express";
import { AccessToken } from "livekit-server-sdk";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { getUserLobby } from "../redis.js";

export const voiceRouter = Router();
voiceRouter.use(requireAuth);

/** Issue a LiveKit token for the caller's current lobby.
 *  Room name == lobby id, so everyone in a lobby shares one voice room. */
voiceRouter.post("/token", async (req, res) => {
  if (!config.livekit.url || !config.livekit.apiKey || !config.livekit.apiSecret) {
    res.status(503).json({ error: "Voice chat is not configured yet" });
    return;
  }
  const lobbyId = await getUserLobby(req.auth!.userId);
  if (!lobbyId) {
    res.status(400).json({ error: "You are not in a lobby" });
    return;
  }
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: req.auth!.uid,
    name: req.auth!.name,
    ttl: "2h",
  });
  at.addGrant({ roomJoin: true, room: lobbyId, canPublish: true, canSubscribe: true });
  res.json({ token: await at.toJwt(), url: config.livekit.url, room: lobbyId });
});
