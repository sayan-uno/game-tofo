// The control channel between the admin process and the game process.
//
// The console can read everything it needs from the snapshot, but some actions
// have to reach the live match runtime that only exists in THIS process's
// memory — hang up a banned player's socket, end a stuck match, put a message
// on everyone's screen. Those travel as signed messages over Redis pub/sub.
//
// Three properties, all of which matter:
//
//   SIGNED     Every command carries an HMAC over its own contents. Reaching
//              the Redis connection is therefore not the same as being allowed
//              to ban people, which is the difference between one compromised
//              credential and a compromised platform.
//   FRESH      A command older than the replay window is refused, so a message
//              captured today cannot be replayed tomorrow.
//   IDEMPOTENT Every command has an id and an id is honoured once, so a
//              re-delivery is a no-op rather than a second disconnect.
//
// And ADDRESSED, which is less obvious than it sounds: Redis pub/sub is NOT
// scoped by database index, so every process on the same Redis server hears
// every channel no matter which db it selected. A command therefore names the
// instance it is for — matches live in one process's memory, so "end this
// match" is meaningless anywhere else. A command with no instance is a genuine
// broadcast and every instance runs it.
//
// The game process subscribes; the admin process publishes and waits for the
// acknowledgement, so the console can say "applied" rather than "sent".
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Server } from "socket.io";
import { config } from "../config.js";
import { redis, getSocketId } from "../redis.js";
import { logEvent } from "../services/eventLog.js";
import { endMatchById, activeMatchIdForUser } from "./match.js";
import { matchVoiceRoom, silenceInVoice } from "./voice.js";
import { getUserLobby } from "../redis.js";

export const CMD_CHANNEL = "ops:cmd";
export const ACK_CHANNEL = "ops:ack";

/** How far out of date a command may be. Long enough to survive a slow hop,
 *  short enough that a captured message is worthless by the time anyone could
 *  study it. */
const MAX_AGE_MS = 30_000;
/** Ids are remembered for twice the freshness window — past that, a replay is
 *  already refused for being stale, so remembering costs nothing but memory. */
const SEEN_TTL_MS = MAX_AGE_MS * 2;

export type OpsCommandName = "ping" | "disconnect" | "endMatch" | "broadcast" | "silence" | "maintenance" | "noticeGone";

export interface OpsCommand {
  id: string;
  at: number;
  cmd: OpsCommandName;
  /** Which instance should act. Omitted = all of them. */
  instance?: string;
  args: Record<string, unknown>;
  /** Who asked, for the log. Not trusted for authorisation — the signature is. */
  by?: string;
  sig: string;
}

export interface OpsAck {
  id: string;
  instanceId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Key order must not change the signature, so the payload is serialised
 *  deterministically rather than with plain JSON.stringify. */
function canonical(c: Omit<OpsCommand, "sig">): string {
  const args = Object.keys(c.args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(c.args[k])}`)
    .join("&");
  return `${c.id}|${c.at}|${c.cmd}|${args}|${c.by ?? ""}|${c.instance ?? ""}`;
}

function sign(c: Omit<OpsCommand, "sig">): string {
  return createHmac("sha256", config.opsHmacSecret).update(canonical(c)).digest("hex");
}

function signatureMatches(c: OpsCommand): boolean {
  const expected = Buffer.from(sign(c), "utf8");
  const given = Buffer.from(String(c.sig ?? ""), "utf8");
  // timingSafeEqual throws on a length mismatch, which is itself a leak-free
  // answer — but it must not throw out of the handler.
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const seen = new Map<string, number>();
function alreadyHandled(id: string): boolean {
  const now = Date.now();
  if (seen.size > 500) for (const [k, t] of seen) if (t < now) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now + SEEN_TTL_MS);
  return false;
}

// ---------------------------------------------------------------------------
// Game process: listen and execute
// ---------------------------------------------------------------------------

let subscriber: ReturnType<typeof redis.duplicate> | null = null;

async function execute(io: Server, c: OpsCommand): Promise<unknown> {
  switch (c.cmd) {
    case "ping":
      return { pong: true, instanceId: config.instanceId };

    case "disconnect": {
      // Applying a ban writes Redis; this is what makes it felt NOW rather
      // than at the player's next reconnect.
      const userId = String(c.args.userId ?? "");
      if (!userId) throw new Error("userId required");
      const socketId = await getSocketId(userId);
      const socket = socketId ? io.sockets.sockets.get(socketId) : null;
      if (socket) {
        socket.emit("session:revoked", { reason: String(c.args.reason ?? "Your session was ended") });
        socket.disconnect(true);
      }
      return { disconnected: Boolean(socket) };
    }

    case "endMatch": {
      const matchId = String(c.args.matchId ?? "");
      if (!matchId) throw new Error("matchId required");
      const ended = await endMatchById(io, matchId, "aborted");
      return { ended };
    }

    case "silence": {
      // A voice mute has just been written; this makes it felt by someone who
      // is already talking rather than at their next token request.
      const userId = String(c.args.userId ?? "");
      const uid = String(c.args.uid ?? "");
      if (!userId || !uid) throw new Error("userId and uid required");
      const rooms: string[] = [];
      const lobbyId = await getUserLobby(userId);
      if (lobbyId) rooms.push(lobbyId);
      const matchId = activeMatchIdForUser(userId);
      if (matchId) rooms.push(matchVoiceRoom(matchId));
      return { silencedIn: await silenceInVoice(uid, rooms) };
    }

    case "broadcast": {
      const message = String(c.args.message ?? "").slice(0, 300);
      if (!message) throw new Error("message required");
      const level = String(c.args.level ?? "info");
      // Everyone, or named people. A notice to one player goes to their user
      // room, which is where every other per-player message already goes, so
      // it reaches every tab they have open and nobody else's.
      const uids = Array.isArray(c.args.uids) ? (c.args.uids as string[]) : null;
      if (!uids || uids.length === 0) {
        io.emit("platform:notice", { message, level });
        return { sockets: io.sockets.sockets.size };
      }
      const { getUserByUid } = await import("../services/users.js");
      let sent = 0;
      for (const uid of uids.slice(0, 200)) {
        const user = await getUserByUid(String(uid).trim());
        if (!user) continue;
        io.to(`user:${user.id}`).emit("platform:notice", { message, level });
        sent++;
      }
      return { sent, of: uids.length };
    }

    case "noticeGone": {
      // Off every list that is open right now. The stored row already stops it
      // reaching anybody who has not seen it; this is for the people who are
      // looking at it as the admin takes it back.
      io.emit("platform:noticeGone", { id: String(c.args.noticeId ?? "") });
      return { sockets: io.sockets.sockets.size };
    }

    case "maintenance": {
      // Push the state, whatever it is: scheduled, happening, or over. The
      // client decides what that looks like — a line in the corner of a match,
      // a notice nobody can close, or nothing at all.
      const active = c.args.active === true;
      const at = Number(c.args.at ?? 0) || 0;
      const message = String(c.args.message ?? "").slice(0, 300);
      io.emit("platform:maintenance", { active, at, message });
      const { setGate } = await import("./flags.js");
      setGate(active, message);
      if (active) {
        // Everything stops, AT THE SERVER.
        //
        // The notice is a courtesy; this is the enforcement. Matches are
        // ended so nobody is left mid-run, and then every socket is closed —
        // because a client that keeps its connection keeps its handlers, and
        // anybody can delete a notice from the page with dev tools and carry
        // on playing over a socket that still answers. With the socket gone
        // and the handshake refusing, there is nothing left to talk to.
        const { endAllMatches } = await import("./match.js");
        const ended = await endAllMatches(io, "maintenance");
        const open = io.sockets.sockets.size;
        // A beat, so the notice and the results reach the page before its
        // connection goes. Losing the socket first would leave people staring
        // at a game that simply stopped.
        setTimeout(() => {
          for (const s of io.sockets.sockets.values()) s.disconnect(true);
        }, 1500);
        return { sockets: open, matchesEnded: ended, disconnecting: open };
      }
      return { sockets: io.sockets.sockets.size };
    }
  }
}

/** Start listening. No-ops with a loud warning when no secret is configured —
 *  a channel that would execute unsigned commands must not exist at all. */
export function startOpsCommands(io: Server): void {
  if (subscriber) return;
  if (!config.opsHmacSecret) {
    console.warn("⚠ OPS_HMAC_SECRET is not set — the admin control channel is disabled.");
    return;
  }
  subscriber = redis.duplicate();
  subscriber.on("error", (err) => console.error("[ops] subscriber error:", err));
  void subscriber.subscribe(CMD_CHANNEL, (err) => {
    if (err) console.error("[ops] could not subscribe:", err);
    else console.log(`✔ Admin control channel listening on ${CMD_CHANNEL}`);
  });

  subscriber.on("message", (channel, raw) => {
    if (channel !== CMD_CHANNEL) return;
    void (async () => {
      let c: OpsCommand | null = null;
      try {
        c = JSON.parse(raw) as OpsCommand;
        if (!c?.id || typeof c.at !== "number" || !c.cmd) return;
        // Addressed elsewhere: not ours, and not our business to log either.
        if (c.instance && c.instance !== config.instanceId) return;
        if (Math.abs(Date.now() - c.at) > MAX_AGE_MS) {
          console.warn(`[ops] refused stale command ${c.cmd}`);
          return;
        }
        if (!signatureMatches(c)) {
          console.warn(`[ops] refused command ${c.cmd} — bad signature`);
          return;
        }
        if (alreadyHandled(c.id)) return;
        const result = await execute(io, c);
        logEvent({ type: "ops.command", data: { cmd: c.cmd, args: c.args, by: c.by ?? null, result } });
        await redis.publish(
          ACK_CHANNEL,
          JSON.stringify({ id: c.id, instanceId: config.instanceId, ok: true, result } satisfies OpsAck)
        );
      } catch (err) {
        console.error("[ops] command failed:", err);
        if (c?.id) {
          await redis
            .publish(
              ACK_CHANNEL,
              JSON.stringify({
                id: c.id,
                instanceId: config.instanceId,
                ok: false,
                error: err instanceof Error ? err.message : "failed",
              } satisfies OpsAck)
            )
            .catch(() => {});
        }
      }
    })();
  });
}

export async function stopOpsCommands(): Promise<void> {
  if (!subscriber) return;
  await subscriber.quit().catch(() => {});
  subscriber = null;
}

// ---------------------------------------------------------------------------
// Admin process: publish and wait for the acknowledgement
// ---------------------------------------------------------------------------

let ackSubscriber: ReturnType<typeof redis.duplicate> | null = null;
/** Resolves when the ack channel is actually subscribed. Awaited before the
 *  first publish — subscribing is not instant, and a command sent into the gap
 *  is executed by the game process but never acknowledged, so the console
 *  reports "no server answered" for something that in fact happened. That is a
 *  worse failure than not sending it at all, and it only ever bites the FIRST
 *  command, which makes it the kind of bug that ships. */
let ackReady: Promise<unknown> | null = null;
const waiting = new Map<string, (ack: OpsAck) => void>();

function ensureAckListener(): Promise<unknown> {
  if (ackReady) return ackReady;
  const sub = redis.duplicate();
  ackSubscriber = sub;
  sub.on("error", (err) => console.error("[ops] ack subscriber error:", err));
  sub.on("message", (channel, raw) => {
    if (channel !== ACK_CHANNEL) return;
    try {
      const ack = JSON.parse(raw) as OpsAck;
      waiting.get(ack.id)?.(ack);
    } catch {
      /* a malformed ack is not worth a stack trace */
    }
  });
  ackReady = sub.subscribe(ACK_CHANNEL);
  return ackReady;
}

/** Send a command and wait for the game process to say it did it. Resolves
 *  null on timeout, which the console shows as "no server answered" rather
 *  than pretending it worked. */
export async function sendOpsCommand(
  cmd: OpsCommandName,
  args: Record<string, unknown> = {},
  opts: { by?: string; timeoutMs?: number; instance?: string } = {}
): Promise<OpsAck | null> {
  if (!config.opsHmacSecret) throw new Error("OPS_HMAC_SECRET is not set");
  await ensureAckListener();
  const base = { id: randomUUID(), at: Date.now(), cmd, args, by: opts.by, instance: opts.instance };
  const message: OpsCommand = { ...base, sig: sign(base) };
  return new Promise<OpsAck | null>((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(message.id);
      resolve(null);
    }, opts.timeoutMs ?? 3000);
    waiting.set(message.id, (ack) => {
      clearTimeout(timer);
      waiting.delete(message.id);
      resolve(ack);
    });
    void redis.publish(CMD_CHANNEL, JSON.stringify(message));
  });
}

export async function stopOpsPublisher(): Promise<void> {
  if (!ackSubscriber) return;
  await ackSubscriber.quit().catch(() => {});
  ackSubscriber = null;
  ackReady = null;
  waiting.clear();
}
