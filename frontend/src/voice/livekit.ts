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

// ---------------------------------------------------------------------------
// The mic, and who is showing it
//
// Two pieces of UI draw this button — the lobby's and the match's — and each
// used to paint it from a value it read once and then only refreshed when IT
// was clicked. The lobby HUD is built at startup and lives for the whole
// session, so muting inside a match left the lobby still saying "🎙 On" while
// nothing was being transmitted: a player believing they were heard when they
// were not, which is the worst direction for this particular error.
//
// So the state lives here and says when it changes. Nobody paints from memory.
// ---------------------------------------------------------------------------
const micListeners = new Set<(on: boolean) => void>();

/** Paints immediately with what is true now, and again whenever that changes.
 *  Returns the unsubscribe. */
export function onMicChange(fn: (on: boolean) => void): () => void {
  micListeners.add(fn);
  fn(micEnabled);
  return () => {
    micListeners.delete(fn);
  };
}

function setMic(on: boolean): void {
  if (micEnabled === on) return;
  micEnabled = on;
  for (const fn of micListeners) {
    try {
      fn(on);
    } catch (err) {
      console.error("[voice] mic listener failed", err);
    }
  }
}

// ---------------------------------------------------------------------------
// Who is talking
//
// A microphone icon that means "their mic is on" tells a player nothing —
// everyone's mic is on. What is worth showing is who is speaking RIGHT NOW,
// and LiveKit already works that out (it does the level detection server-side
// and tells every client at once, so all four players agree about it).
//
// Kept as a plain set plus a listener rather than a store: the only consumers
// are two pieces of UI, and this file is loaded before either exists.
// ---------------------------------------------------------------------------
const talking = new Set<string>();
const talkingListeners = new Set<(uids: Set<string>) => void>();

export function whoIsTalking(): ReadonlySet<string> {
  return talking;
}

/** Fires whenever the set changes. Returns its own unsubscribe. */
export function onTalkingChange(fn: (uids: Set<string>) => void): () => void {
  talkingListeners.add(fn);
  fn(talking);
  return () => talkingListeners.delete(fn);
}

function setTalking(uids: string[]): void {
  talking.clear();
  for (const uid of uids) talking.add(uid);
  for (const fn of talkingListeners) fn(talking);
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
    const data = await api.post<{ token?: string; url?: string; room: string | null }>("/api/voice/token", {
      scope,
    });
    // No room, or not the room we asked for. Two different situations, one
    // correct answer — say nothing and wait.
    //
    // `room: null` means the server sees nobody to talk to (a party or match
    // whose only other members have no microphone), and a red toast there
    // would be a complaint about something working as intended. A DIFFERENT
    // room means the server has moved on — a match that ended a moment ago —
    // and the next lobby or match event re-issues the right join.
    if (!data.token || !data.url || data.room !== roomName) return;
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
  // The identity on a LiveKit participant IS the player's uid — that is what
  // the token grants — so this maps straight onto the names on screen.
  newRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    if (room !== newRoom && room !== null) return;
    setTalking(speakers.map((p) => p.identity));
  });
  newRoom.on(RoomEvent.Disconnected, () => {
    setTalking([]);
    if (room === newRoom) {
      room = null;
      currentRoomName = null;
    }
  });

  try {
    await newRoom.connect(url, token);
    try {
      await newRoom.localParticipant.setMicrophoneEnabled(micEnabled);
    } catch {
      // No microphone, or permission refused. The player is muted whatever
      // they last chose, and the button below is about to say so.
      onStatus("Your microphone could not be opened", true);
    }
    // What the ROOM ended up with, not what we asked it for. Carrying the
    // intent across rooms is how the button came to disagree with the sound.
    setMic(newRoom.localParticipant.isMicrophoneEnabled);
    room = newRoom;
    currentRoomName = roomName;
    // No success toast — squadding up fires this on every join and the popup
    // got noisy. Failures below still surface.
  } catch (err) {
    onStatus(err instanceof Error ? err.message : "Could not connect voice", true);
  }
}

/** Ask again whether this room is still worth being in, and act on the answer.
 *
 *  Called when a party's membership changes. Already connected and the server
 *  still offers the room → nothing happens, which is the common case and costs
 *  one small request. Already connected and the server now offers NO room —
 *  the last other person left, and whoever is still standing there has no
 *  microphone — → we leave, rather than holding an open connection to silence
 *  for the rest of the evening.
 *
 *  Not connected → `join` runs, which asks the same question again. One extra
 *  request on the path where somebody is joining anyway; worth it to keep this
 *  decision in one place rather than duplicating the "is there a room" rule in
 *  the caller, where it would need to know things the client is not told. */
export async function revalidateVoice(roomName: string, join: () => Promise<void>): Promise<void> {
  if (currentRoomName !== roomName || !room) {
    await join();
    return;
  }
  try {
    const data = await api.post<{ room: string | null }>("/api/voice/token", { scope: "party" });
    if (data.room !== roomName) await leaveVoice();
  } catch {
    // A failed check is not a reason to hang up on a conversation.
  }
}

export async function leaveVoice(): Promise<void> {
  if (!room) return;
  const r = room;
  room = null;
  currentRoomName = null;
  setTalking([]);
  await r.disconnect();
}

/** Flip the mic. The flag is only updated once the room has accepted the
 *  change, so a device that refuses (no microphone, permission denied) leaves
 *  the button showing what is actually true instead of a state the player
 *  does not have. Throws in that case — callers show the failure. */
export async function toggleMic(): Promise<boolean> {
  const next = !micEnabled;
  if (room) {
    await room.localParticipant.setMicrophoneEnabled(next);
    setMic(room.localParticipant.isMicrophoneEnabled);
  } else {
    // Not in a room yet: this is an intent, applied when one is joined.
    setMic(next);
  }
  return micEnabled;
}
