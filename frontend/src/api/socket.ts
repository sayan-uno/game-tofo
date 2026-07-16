import { io, type Socket } from "socket.io-client";
import { API_URL } from "../config";
import { getToken } from "./http";

let socket: Socket | null = null;

export function connectSocket(): Socket {
  if (socket?.connected) return socket;
  socket = io(API_URL, {
    auth: { token: getToken() },
    transports: ["websocket"],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
  });
  return socket;
}

export function getSocket(): Socket {
  if (!socket) throw new Error("Socket not connected yet");
  return socket;
}

export function disconnectSocket() {
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
