import { Router } from "express";
import { AccessToken } from "livekit-server-sdk";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { getUserLobby } from "../redis.js";
import { activeMatchIdForUser } from "../platform/match.js";
import { matchVoiceRoom } from "../platform/voice.js";

export const voiceRouter = Router();
voiceRouter.use(requireAuth);

/** Issue a LiveKit token for the caller's current voice room.
 *
 *  Two scopes, never both at once on a client:
 *   - "party" (default): room == lobby id — everyone in a party shares it.
 *   - "match": room == M<matchId> — every human in the match roster shares it
 *     while the match runs; the room is deleted server-side when it ends, so
 *     the parties are separate rooms again the moment the results show. */
voiceRouter.post("/token", async (req, res) => {
  if (!config.livekit.url || !config.livekit.apiKey || !config.livekit.apiSecret) {
    res.status(503).json({ error: "Voice chat is not configured yet" });
    return;
  }
  const scope = (req.body as { scope?: unknown } | undefined)?.scope === "match" ? "match" : "party";
  let room: string;
  let ttl: string;
  if (scope === "match") {
    const matchId = activeMatchIdForUser(req.auth!.userId);
    if (!matchId) {
      res.status(400).json({ error: "You are not in a match" });
      return;
    }
    room = matchVoiceRoom(matchId);
    ttl = "20m"; // a match is minutes; a leaked token must not outlive it by much
  } else {
    const lobbyId = await getUserLobby(req.auth!.userId);
    if (!lobbyId) {
      res.status(400).json({ error: "You are not in a lobby" });
      return;
    }
    room = lobbyId;
    ttl = "2h";
  }
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: req.auth!.uid,
    name: req.auth!.name,
    ttl,
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  res.json({ token: await at.toJwt(), url: config.livekit.url, room });
});
