import { io, type Socket } from "socket.io-client";
import { API_URL } from "../config";
import { getToken } from "./http";
import { deviceHashNow } from "./device";

let socket: Socket | null = null;

export function connectSocket(): Socket {
  if (socket?.connected) return socket;
  socket = io(API_URL, {
    // A function rather than an object: socket.io calls it on every connection
    // attempt, so a reconnect carries a refreshed token — and the device hash
    // once it has finished computing.
    auth: (cb: (data: Record<string, unknown>) => void) => cb({ token: getToken(), deviceHash: deviceHashNow() }),
    transports: ["websocket"],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
  });
  startHeartbeat(socket);
  return socket;
}

// ---------------------------------------------------------------------------
// "I am still here"
//
// A connected socket is not a player. A phone in a pocket, a tab behind six
// others, a laptop lid closed on a train — all of those hold the socket open
// for minutes, and a friends list built on "is the socket up?" shows those
// people as online and ready to be invited when nobody is there at all.
//
// So the page says so itself, and only while it is VISIBLE. Stop looking and
// the beat stops; about ten seconds later the server marks the player away.
// Come back and the first beat fires immediately, so returning is instant
// rather than something you wait out.
//
// One tiny event every four seconds, no acknowledgement and no payload.
// ---------------------------------------------------------------------------
const BEAT_MS = 4000;
let beatTimer = 0;

function beat(): void {
  if (document.visibilityState !== "visible") return;
  socket?.emit("presence:beat");
}

function startHeartbeat(s: Socket): void {
  if (beatTimer) return;
  // On connect, on every reconnect, and the moment the page is looked at
  // again — each of those is a point where the server's idea of this player
  // may be out of date, and waiting up to four seconds to correct it is four
  // seconds of a friend seeing the wrong thing.
  s.on("connect", beat);
  document.addEventListener("visibilitychange", beat);
  beatTimer = window.setInterval(beat, BEAT_MS);
  beat();
}

export function getSocket(): Socket {
  if (!socket) throw new Error("Socket not connected yet");
  return socket;
}

export function disconnectSocket() {
  if (beatTimer) {
    clearInterval(beatTimer);
    beatTimer = 0;
  }
  document.removeEventListener("visibilitychange", beat);
  socket?.disconnect();
  socket = null;
}

/** emit with an acknowledgement, promisified. */
export function emitAck<T = { ok?: boolean; error?: string }>(event: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const s = getSocket();
    const timer = setTimeout(() => reject(new Error("Server did not respond")), 8000);
    if (payload === undefined) {
      s.emit(event, (response: T) => {
        clearTimeout(timer);
        resolve(response);
      });
    } else {
      s.emit(event, payload, (response: T) => {
        clearTimeout(timer);
        resolve(response);
      });
    }
  });
}
