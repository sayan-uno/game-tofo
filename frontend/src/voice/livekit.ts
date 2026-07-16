import type { Room } from "livekit-client";
import { api, ApiError } from "../api/http";

// livekit-client is ~500 kB — it is dynamically imported the first time a
// squad actually forms, so it costs nothing at startup.
let room: Room | null = null;
let currentRoomName: string | null = null;
let micEnabled = true;

export function isVoiceConnected(): boolean {
  return room !== null;
}

export function isMicEnabled(): boolean {
  return micEnabled;
}

/** Join the voice room for the current lobby. Safe to call repeatedly —
 *  reconnects only when the lobby actually changed. */
export async function joinVoice(
  lobbyId: string,
  onStatus: (message: string, isError?: boolean) => void
): Promise<void> {
  if (currentRoomName === lobbyId && room) return;
  await leaveVoice();

  let token: string, url: string;
  try {
    const data = await api.post<{ token: string; url: string; room: string }>("/api/voice/token");
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
    currentRoomName = lobbyId;
    onStatus("Voice chat connected");
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

export async function toggleMic(): Promise<boolean> {
  micEnabled = !micEnabled;
  if (room) await room.localParticipant.setMicrophoneEnabled(micEnabled);
  return micEnabled;
}
