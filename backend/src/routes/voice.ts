import { Router } from "express";
import { AccessToken } from "livekit-server-sdk";
import { config } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { getLobbyMembers, getUserLobby } from "../redis.js";
import { activeMatchIdForUser, humansIn } from "../platform/match.js";
import { activeIslandIdForUser, humansOnIsland } from "../platform/island.js";
import { matchVoiceRoom } from "../platform/voice.js";
import { getSanctions } from "../services/sanctions.js";

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
    // A match and a drop-in world are the same thing here: one room, named
    // after the thing everybody is standing in, deleted when it ends.
    const matchId = activeMatchIdForUser(req.auth!.userId);
    const islandId = matchId ? null : activeIslandIdForUser(req.auth!.userId);
    if (!matchId && !islandId) {
      res.status(400).json({ error: "You are not in a match" });
      return;
    }
    const id = (matchId ?? islandId)!;
    // Nobody to talk to → no room. See the party branch below; the reasoning
    // is the same and a match of one person and three bots is the commonest
    // case of it.
    const heads = matchId ? humansIn(matchId).size : humansOnIsland(id).size;
    if (heads < 2) {
      res.json({ room: null, reason: "alone" });
      return;
    }
    room = matchVoiceRoom(id);
    // A match is minutes and an island is forty of them. A leaked token must
    // not outlive the thing it lets you into by much, so they differ.
    ttl = islandId ? "45m" : "20m";
  } else {
    const lobbyId = await getUserLobby(req.auth!.userId);
    if (!lobbyId) {
      res.status(400).json({ error: "You are not in a lobby" });
      return;
    }
    // NOBODY TO TALK TO → NO ROOM, and no token.
    //
    // The client asks for one whenever its party has more than one member, and
    // since W3 a party's members can include teammates from the server
    // population — who have no microphone and never will. Left alone, a player
    // who pressed "team up" and got three of them would hold an open LiveKit
    // participant for the rest of the evening, at real cost, to hear silence.
    //
    // Decided HERE rather than on the client on purpose: the client is not
    // told which of its teammates are people, and telling it — even as a
    // count — is exactly the leak the whole design avoids. `getLobbyMembers`
    // returns people, so this is one read and no new state.
    //
    // Answered as an ordinary success with no room, not an error: the client
    // already declines silently when the room it is offered is not the one it
    // asked for, and a red toast saying "voice failed" would be both wrong and
    // a tell of its own.
    const people = await getLobbyMembers(lobbyId);
    if (people.length < 2) {
      res.json({ room: null, reason: "alone" });
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
  // A voice mute is applied HERE rather than in the client: the token itself
  // carries no permission to speak, so a modified client gains nothing.
  const active = await getSanctions(req.auth!.userId);
  const canPublish = !active.voice;
  at.addGrant({ roomJoin: true, room, canPublish, canSubscribe: true });
  res.json({ token: await at.toJwt(), url: config.livekit.url, room, canPublish });
});
