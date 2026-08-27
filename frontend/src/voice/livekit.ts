import type { RemoteAudioTrack, RemoteTrackPublication, Room } from "livekit-client";
import { api, ApiError } from "../api/http";

// livekit-client is ~500 kB — it is dynamically imported the first time a
// squad actually forms, so it costs nothing at startup.
let room: Room | null = null;
let currentRoomName: string | null = null;
/** Proximity mode: this room is a PLACE, and you hear the people near you.
 *
 *  Two things change, and the first is the one that matters. Nobody's audio is
 *  subscribed to by default — a voice you are not meant to hear does not
 *  arrive at the device at all, rather than arriving and being turned down,
 *  which is both the honest reading of "out of earshot" and the reason twenty
 *  people in one room costs a phone about four streams instead of nineteen.
 *
 *  The second is that the mix goes through WebAudio. LiveKit's setVolume falls
 *  back to `element.volume` otherwise, and iOS ignores writes to that — so on
 *  an iPhone every distance would sound identical. */
let proximity = false;
let gains = new Map<string, number>();
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
  scope: "party" | "match" = "party",
  opts: { proximity?: boolean } = {}
): Promise<void> {
  if (currentRoomName === roomName && room) return;
  await leaveVoice();
  proximity = opts.proximity === true;
  gains = new Map();

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
    // See `proximity` above: without this, distance is silent on iOS.
    webAudioMix: proximity,
  });

  newRoom.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      document.getElementById("audio-root")?.appendChild(el);
      // A track that arrives after its distance was decided has to be told
      // what that distance was, or the first thing you hear of somebody
      // walking up to you is them at full volume.
      if (proximity) {
        const g = gains.get(participant.identity);
        if (g !== undefined) (track as RemoteAudioTrack).setVolume(g);
      }
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
    // autoSubscribe false is the whole of the proximity guarantee — see above.
    await newRoom.connect(url, token, proximity ? { autoSubscribe: false } : undefined);
    // Browsers will not start audio without a gesture, and by the time a
    // player is in a world they have made several. Best effort: a refusal here
    // is retried by the next tap the page sees.
    void newRoom.startAudio().catch(() => undefined);
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

/** Who this player can hear, and how loudly: identity → gain, 0…1.
 *
 *  Anyone missing from the map, or at zero, is UNSUBSCRIBED — their audio
 *  stops being sent to this device entirely. Called a few times a second by
 *  the world that is drawing everybody; every call is a walk over the handful
 *  of people in the room and two comparisons each, and it only ever touches
 *  LiveKit when something actually changed.
 *
 *  Silently does nothing outside a proximity room, so a caller does not have
 *  to know which kind of room it is in. */
export function setVoiceProximity(next: Map<string, number>): void {
  if (!room || !proximity) return;
  gains = next;
  for (const participant of room.remoteParticipants.values()) {
    const gain = next.get(participant.identity) ?? 0;
    const want = gain > 0.001;
    for (const pub of participant.trackPublications.values()) {
      if (String(pub.kind) !== "audio") continue;
      const rp = pub as RemoteTrackPublication;
      if (rp.isSubscribed !== want) rp.setSubscribed(want);
      if (!want) continue;
      const track = rp.track as RemoteAudioTrack | undefined;
      // A tenth of a decibel is not worth a WebAudio ramp; a step of one part
      // in fifty is what you can hear.
      if (track && Math.abs((track.getVolume() ?? 1) - gain) > 0.02) track.setVolume(gain);
    }
  }
}

/** Is this room a proximity room? The world asks before it starts computing
 *  distances for a room that would ignore them. */
export const isProximityVoice = (): boolean => proximity && room !== null;

export async function leaveVoice(): Promise<void> {
  if (!room) return;
  const r = room;
  room = null;
  currentRoomName = null;
  proximity = false;
  gains = new Map();
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
