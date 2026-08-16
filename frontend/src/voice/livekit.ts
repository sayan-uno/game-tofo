import type { Room } from "livekit-client";
import { api, ApiError } from "../api/http";

// livekit-client is ~500 kB — it is dynamically imported the first time a
// squad actually forms, so it costs nothing at startup.
let room: Room | null = null;
let currentRoomName: string | null = null;
// Mic starts OFF — players hear the squad immediately but only transmit after
// deliberately unmuting (which is also when the browser asks mic permission).
let micEnabled = false;

export function isVoiceConnected(): boolean {
  return room !== null;
}

export function isMicEnabled(): boolean {
  return micEnabled;
}

/** Join a voice room. Safe to call repeatedly — reconnects only when the
 *  room actually changed.
 *
 *  Two scopes, mirroring the server: "party" (room = lobby id, the default)
 *  and "match" (room = M<matchId>, everyone in the match roster, for as long
 *  as the match runs). The caller names the room it expects so a stale token
 *  can never put us in the wrong one silently. */
export async function joinVoice(
  roomName: string,
  onStatus: (message: string, isError?: boolean) => void,
  scope: "party" | "match" = "party"
): Promise<void> {
  if (currentRoomName === roomName && room) return;
  await leaveVoice();

  let token: string, url: string;
  try {
    const data = await api.post<{ token: string; url: string; room: string }>("/api/voice/token", { scope });
    if (data.room !== roomName) {
      // The server disagrees about where we belong (a match ended a moment
      // ago, say) — don't join somewhere we didn't ask for; the next lobby or
      // match event re-issues the right join.
      return;
    }
    token = data.token;
    url = data.url;
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) {
      onStatus("Voice chat not configured yet (LiveKit keys missing)", true);
    } else {
      onStatus(err instanceof Error ? err.message : "Voice connection failed", true);
    }
    return;
  }

  const { Room, RoomEvent, Track } = await import("livekit-client");

  const newRoom = new Room({
    adaptiveStream: true,
    dynacast: true,
  });

  newRoom.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      document.getElementById("audio-root")?.appendChild(el);
    }
  });
  newRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
    track.detach().forEach((el) => el.remove());
  });
  newRoom.on(RoomEvent.Disconnected, () => {
    if (room === newRoom) {
      room = null;
      currentRoomName = null;
    }
  });

  try {
    await newRoom.connect(url, token);
    await newRoom.localParticipant.setMicrophoneEnabled(micEnabled);
    room = newRoom;
    currentRoomName = roomName;
    // No success toast — squadding up fires this on every join and the popup
    // got noisy. Failures below still surface.
  } catch (err) {
    onStatus(err instanceof Error ? err.message : "Could not connect voice", true);
  }
}

export async function leaveVoice(): Promise<void> {
  if (!room) return;
  const r = room;
  room = null;
  currentRoomName = null;
  await r.disconnect();
}

/** Flip the mic. The flag is only updated once the room has accepted the
 *  change, so a device that refuses (no microphone, permission denied) leaves
 *  the button showing what is actually true instead of a state the player
 *  does not have. Throws in that case — callers show the failure. */
export async function toggleMic(): Promise<boolean> {
  const next = !micEnabled;
  if (room) await room.localParticipant.setMicrophoneEnabled(next);
  micEnabled = next;
  return micEnabled;
}
