// LiveKit room bookkeeping for matches. Voice follows the match while it runs
// (every human in the roster shares `M<matchId>`) and snaps back to the party
// room the moment it ends — deleting the match room server-side is what makes
// "the others can't hear you anymore" a guarantee rather than a hope.
import { RoomServiceClient } from "livekit-server-sdk";
import { config } from "../config.js";

export const matchVoiceRoom = (matchId: string) => `M${matchId}`;

let client: RoomServiceClient | null = null;
function service(): RoomServiceClient | null {
  const { url, apiKey, apiSecret } = config.livekit;
  if (!url || !apiKey || !apiSecret) return null;
  // The room service talks HTTPS to the same host the ws:// URL points at.
  const httpUrl = url.replace(/^wss?:\/\//, (m) => (m === "wss://" ? "https://" : "http://"));
  return (client ??= new RoomServiceClient(httpUrl, apiKey, apiSecret));
}

/** Best effort: a failure here only means a straggler could linger until
 *  their token expires. */
export async function deleteMatchVoiceRoom(matchId: string): Promise<void> {
  const svc = service();
  if (!svc) return;
  try {
    await svc.deleteRoom(matchVoiceRoom(matchId));
  } catch {
    /* room never created (nobody unmuted) or already gone — fine */
  }
}
