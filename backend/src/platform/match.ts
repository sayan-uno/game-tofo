// The match runtime: one in-memory record per live match, holding the roster,
// the phase, and every runner's input log.
//
// Design in one paragraph: the server never simulates in real time to relay
// state — it relays INPUTS. Clients run the shared deterministic sim over
// them; at the end the server runs the same sim over the same logs (via the
// game's rank()) and that replay is the result of record. This keeps the hot
// path to a validate-and-forward per swipe, and keeps the truth on the server.
//
// A match spans parties: the roster is a list of runners each remembering the
// party (lobby) they came from — matchmaking (M3) fills it from several
// parties, and bots (M3) are runners with isBot=true and no user id. Nothing
// here treats "the match" and "a lobby" as the same thing.
//
// Hot state lives in this process (a match is a few KB); the Redis bindings
// (platform/store.ts) only say "user X / party Y is in match Z" so reconnects
// and voice tokens can find it. A restart therefore aborts running matches —
// acceptable for now, and cheap to move behind a Redis-backed runtime later.
import { randomBytes, randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import { getSocketId } from "../redis.js";
import { recordMatch } from "../services/matchResults.js";
import { cadence } from "./signals.js";
import { displayName, type UserRow } from "../services/users.js";
import { resolveCharacter, resolveWeapon } from "../services/catalog.js";
import type {
  GameServerDefinition,
  MatchContext,
  RankMember,
  ServerRunnerSim,
  ServerRunnerView,
} from "./games.js";
import { recordBotOutcome, type BotIdentity } from "./bots.js";
import { bindMatch, unbindMatch } from "./store.js";
import { noteLobbyMatch } from "./partyLog.js";
import { isPartyLobby } from "../redis.js";
import { logEvent } from "../services/eventLog.js";
import { encodeReplay, queueReplay, tierFor, type QuickLogEntry } from "./replay.js";
import { deleteMatchVoiceRoom } from "./voice.js";
import { considerMatch, noteMatchStart, stopForMatch } from "./voiceRecording.js";
import {
  EV,
  type MatchEnd,
  type MatchEndReason,
  type MatchGo,
  type MatchInput,
  type MatchInputRelay,
  type MatchPhase,
  type MatchPrepare,
  type MatchResume,
  QUICK_CHAT,
  QUICK_EMOTE,
  QUICK_MAX,
  QUICK_WINDOW_MS,
  type QuickRelay,
  RESULTS_MS,
  type RosterEntry,
  type Standing,
} from "../shared/core/protocol.js";

/** A client that never says "ready" (crashed, cold shader compile) can't hold
 *  everyone else — the countdown starts without them. */
const PREPARE_TIMEOUT_MS = 10_000;
/** How long a dropped runner has to come back before it counts as leaving.
 *  A game may ask for longer (see GameServerDefinition.disconnectGraceMs); this
 *  is what a game that says nothing gets. */
const DISCONNECT_GRACE_MS = 20_000;
/** Nobody may hold a seat for longer than this, whatever they ask for. */
const DISCONNECT_GRACE_MAX_MS = 5 * 60_000;
const graceFor = (m: Match): number =>
  Math.min(DISCONNECT_GRACE_MAX_MS, Math.max(1000, m.game.disconnectGraceMs ?? DISCONNECT_GRACE_MS));
/** Ended matches linger this long so a late `match:leave`/`ready` finds them
 *  and gets a sane answer instead of "unknown match". */
/** How long a finished match stays in memory after its results go out.
 *
 *  Long enough to outlive the results screen, because that screen asks the
 *  server questions about the match it is showing — who you can add as a
 *  friend, for one — and a match that has already been collected can only
 *  answer "nobody". */
const LINGER_MS = 5 * 60_000;
/** How long the recorder stays in the room AFTER the results window closes.
 *
 *  The clients leave the match's voice room when the results screen takes them
 *  home, which is at exactly RESULTS_MS — so stopping the recorder at
 *  RESULTS_MS is a tie, and a tie is decided by whichever timer fires first on
 *  the day. Losing it means the last words of the match are missing from the
 *  recording, and the last words of a match are the ones most likely to be the
 *  reason somebody is listening.
 *
 *  So the recorder outlasts the players rather than racing them. It costs a
 *  couple of seconds of an empty room, which costs nothing: no microphone is
 *  publishing, so no bytes are written. */
const RECORDER_TAIL_MS = 2000;

/** How often the server advances its own simulations to see whether everyone
 *  is out. Coarse on purpose: a match is decided by the inputs, not by this
 *  timer, and it only has to notice the end within a moment. Cost is a few
 *  hundred trivial steps per runner per tick of it. */
const OUTCOME_POLL_MS = 400;
/** Late inputs may still arrive for the last second, so the sims are kept
 *  deliberately BEHIND real time — otherwise a runner could be declared out
 *  on a tick an input was still allowed to rewrite. */
const OUTCOME_LAG_MS = 1200;

/** How often planned bot inputs are released, and how far ahead of their tick.
 *  Sent slightly EARLY so clients apply them without rewinding — the opposite
 *  end of the window from a human's input, which always arrives a little
 *  late. A touch of jitter keeps the release from being metronomic. */
const BOT_RELEASE_MS = 120;
const BOT_LEAD_MS = 260;

export interface Runner {
  uid: string;
  /** null for bots (M3). */
  userId: string | null;
  name: string;
  character: string;
  weapon: string | null;
  partyLobbyId: string;
  isBot: boolean;
  /** 0…1 for bots, 0 for people — the game's own difficulty dial. */
  skill: number;
  seat: number;
  /** The server's own authoritative simulation of this runner. */
  sim: ServerRunnerSim;
  /** Bots only: the rest of their planned inputs, oldest first. */
  plan: MatchInput[];
  planCursor: number;
  ready: boolean;
  connected: boolean;
  left: boolean;
  leftAtTick: number | null;
  inputs: MatchInput[];
  /** Inputs the server REFUSED, by reason.
   *
   *  Already worked out on every rejection and, until now, thrown away — the
   *  socket layer counted them platform-wide, printed a line and cleared the
   *  map. Per player and per match they are a cheating signal: a client that
   *  sits on the rate ceiling, or sends ticks it cannot have reached yet, is
   *  not a client anybody is playing by hand.
   *
   *  Costs nothing in the normal path: written only when an input is already
   *  being thrown away. */
  rejects: Record<string, number>;
  /** Timestamps of recent inputs, for the per-second ceiling. */
  recent: number[];
  /** Timestamps of recent quick messages — the chat wheel's own rate window. */
  recentQuick: number[];
  graceTimer: NodeJS.Timeout | null;
}

export interface Match {
  id: string;
  game: GameServerDefinition;
  /** What the game was told about this match when its sims were built. */
  ctx: MatchContext;
  seed: number;
  phase: MatchPhase;
  createdAt: number;
  startAt: number | null;
  endedAt: number | null;
  runners: Map<string, Runner>;
  /** Party lobby ids involved, for Redis bindings + un-bindings. */
  lobbyIds: string[];
  room: string;
  /** What was SAID during the match. Not an input — the wheel changes nothing
   *  — but it is the only thing players say to each other while playing, so
   *  without it a replay is silent about the part moderation cares about. */
  quick: QuickLogEntry[];
  timers: {
    prepare: NodeJS.Timeout | null;
    end: NodeJS.Timeout | null;
    linger: NodeJS.Timeout | null;
    outcome: NodeJS.Timeout | null;
    bots: NodeJS.Timeout | null;
  };
}

const matches = new Map<string, Match>();
/** userId → matchId, in memory too (Redis is the cross-connection truth). */
const byUser = new Map<string, string>();

export const getMatch = (id: string): Match | undefined => matches.get(id);

/** The real people in a match, as uid → userId. Bots are simply absent, which
 *  is what keeps them out of every list built from this. */
/** The wall clock at which tick 0 lands — the replay's own zero.
 *
 *  Voice recordings are placed on the studio's timeline by subtracting this,
 *  which is the whole reason the audio and the game agree about when things
 *  happened. Null before the countdown has been set. */
export function matchStartAt(id: string): number | null {
  return matches.get(id)?.startAt ?? null;
}

export function humansIn(id: string): Map<string, string> {
  const m = matches.get(id);
  const out = new Map<string, string>();
  if (!m) return out;
  for (const r of m.runners.values()) if (!r.isBot && r.userId) out.set(r.uid, r.userId);
  return out;
}
export function getMatchForUser(userId: string): Match | undefined {
  const id = byUser.get(userId);
  return id ? matches.get(id) : undefined;
}
export const isActive = (m: Match): boolean => m.phase !== "ended";

export interface PartyInput {
  lobbyId: string;
  users: UserRow[];
}

function rosterEntry(r: Runner): RosterEntry {
  return { uid: r.uid, name: r.name, character: r.character, weapon: r.weapon };
}

function nowTick(m: Match): number {
  if (m.startAt === null) return 0;
  const t = Math.floor(((Date.now() - m.startAt) * m.game.tickRate) / 1000);
  return Math.max(0, Math.min(t, m.game.durationTicks));
}

function humans(m: Match): Runner[] {
  return [...m.runners.values()].filter((r) => !r.isBot);
}
/** Runners the match still waits for / cares about. */
function present(m: Match): Runner[] {
  return humans(m).filter((r) => !r.left);
}

function prepareFor(m: Match, r: Runner): MatchPrepare {
  return {
    matchId: m.id,
    gameId: m.game.id,
    seed: m.seed,
    roster: [...m.runners.values()].sort((a, b) => a.seat - b.seat).map(rosterEntry),
    you: r.uid,
    rules: m.game.rules(),
    serverNow: Date.now(),
  };
}

/** Assemble a match from one or more parties and tell everyone to prepare. */
export async function createMatch(
  io: Server,
  game: GameServerDefinition,
  parties: PartyInput[],
  bots: BotIdentity[] = []
): Promise<Match> {
  const id = randomUUID().slice(0, 12);
  // Every runner's sim is built with the same picture of the match, so a game
  // that keeps one shared board can key it on the id and size the table right
  // the first time it is asked.
  const ctx: MatchContext = {
    id,
    players: parties.reduce((n, p) => n + p.users.length, 0) + bots.length,
  };
  const m: Match = {
    id,
    game,
    ctx,
    seed: randomBytes(4).readUInt32LE(0),
    phase: "prepare",
    createdAt: Date.now(),
    startAt: null,
    endedAt: null,
    runners: new Map(),
    lobbyIds: parties.map((p) => p.lobbyId),
    room: `match:${id}`,
    quick: [],
    timers: { prepare: null, end: null, linger: null, outcome: null, bots: null },
  };
  let seat = 0;
  for (const party of parties) {
    for (const u of party.users) {
      m.runners.set(u.uid, {
        uid: u.uid,
        userId: u.id,
        name: displayName(u),
        character: resolveCharacter(u.equippedCharacter),
        weapon: resolveWeapon(u.equippedWeapon),
        partyLobbyId: party.lobbyId,
        isBot: false,
        skill: 0,
        seat: seat++,
        ready: false,
        connected: true,
        left: false,
        leftAtTick: null,
        inputs: [],
        rejects: {},
        recent: [],
      recentQuick: [],
        graceTimer: null,
        sim: game.createSim(m.seed, seat - 1, ctx),
        plan: [],
        planCursor: 0,
      });
    }
  }
  // Bots take the remaining seats. From here on they are runners like any
  // other: same roster shape, same input stream, same rows in the results.
  for (const bot of bots) {
    const seat2 = seat++;
    let plan: MatchInput[] = [];
    try {
      // Games whose bots must react play through serverInputs instead, and
      // simply have nothing to plan.
      plan = game.planBot ? game.planBot(m.seed, seat2, bot.skill) : [];
    } catch (err) {
      console.error(`[match ${id}] bot plan failed:`, err);
    }
    m.runners.set(bot.uid, {
      uid: bot.uid,
      userId: null,
      name: bot.name,
      character: bot.character,
      weapon: bot.weapon,
      partyLobbyId: "",
      isBot: true,
      skill: bot.skill,
      seat: seat2,
      ready: true, // nothing to download, nothing to wait for
      connected: true,
      left: false,
      leftAtTick: null,
      inputs: [],
      rejects: {},
      recent: [],
      recentQuick: [],
      graceTimer: null,
      sim: game.createSim(m.seed, seat2, ctx),
      plan,
      planCursor: 0,
    });
  }
  matches.set(id, m);
  const userIds = humans(m).map((r) => r.userId!);
  for (const uid of userIds) byUser.set(uid, id);
  await bindMatch(id, m.lobbyIds, userIds);
  // WHO THIS MATCH IS MADE OF, by id, on one line.
  //
  // A match is assembled from whole parties and from players who came on their
  // own, and afterwards there is nothing that says which — the roster is a
  // flat list of people. So it is written down at the moment it is decided: a
  // party by its own id, a solo player by theirs. That is what turns "these
  // four were in a match" into "this group and these two strangers were put
  // together", which is a different question and usually the one being asked.
  logEvent({
    type: "match.created",
    matchKey: id,
    gameId: m.game.id,
    data: {
      from: parties.map((p) => ({
        party: isPartyLobby(p.lobbyId) ? p.lobbyId : null,
        uids: p.users.map((u) => u.uid),
      })),
      bots: bots.length,
    },
  });
  // Mark the gap in every party that just walked out of its lobby. From here
  // until the match ends nothing happens in those lobbies, and an admin
  // watching one back needs to be told that rather than left guessing.
  for (const lobbyId of m.lobbyIds) {
    void noteLobbyMatch(lobbyId, "start", id, m.game.id).catch((err) =>
      console.error(`[party] match start on ${lobbyId}:`, err)
    );
  }
  // Is anyone at this table flagged? Decided once, here, so the webhook that
  // fires when somebody opens their microphone has a straight answer rather
  // than a query to run on the hot path.
  void considerMatch(id, userIds).catch((err) => console.error(`[match ${id}] voice decision failed:`, err));

  // Put every member's socket in the match room and hand each their own
  // prepare payload (it names them, so it is per-recipient).
  for (const r of humans(m)) {
    const socketId = await getSocketId(r.userId!);
    const socket = socketId ? io.sockets.sockets.get(socketId) : null;
    if (socket) socket.join(m.room);
    else r.connected = false;
    io.to(`user:${r.userId}`).emit(EV.prepare, prepareFor(m, r));
  }
  m.timers.prepare = setTimeout(() => void go(io, m), PREPARE_TIMEOUT_MS);
  return m;
}

export function markReady(io: Server, m: Match, uid: string): void {
  const r = m.runners.get(uid);
  if (!r || m.phase !== "prepare") return;
  r.ready = true;
  if (present(m).every((x) => x.ready || !x.connected)) void go(io, m);
}

/** Start the countdown: tick 0 lands on startAt for everyone. */
async function go(io: Server, m: Match): Promise<void> {
  if (m.phase !== "prepare") return;
  if (m.timers.prepare) clearTimeout(m.timers.prepare);
  m.timers.prepare = null;
  if (present(m).length === 0) {
    await end(io, m, "abandoned");
    return;
  }
  m.phase = "countdown";
  m.startAt = Date.now() + m.game.countdownMs;
  // Tick 0 is now known. Any recording of this match is placed relative to it,
  // which is what lets the studio lay the sound over the replay instead of
  // beside it. Never awaited: the countdown is on the path to play.
  void noteMatchStart(m.id, m.startAt).catch((err) => console.error(`[match ${m.id}] anchor:`, err));
  const payload: MatchGo = { matchId: m.id, startAt: m.startAt, serverNow: Date.now() };
  io.to(m.room).emit(EV.go, payload);
  setTimeout(() => {
    if (m.phase === "countdown") m.phase = "running";
  }, m.game.countdownMs);
  const durationMs = (m.game.durationTicks * 1000) / m.game.tickRate;
  m.timers.end = setTimeout(
    () => void end(io, m, "timeout"),
    m.game.countdownMs + durationMs + m.game.inputLateLimitMs
  );
  // Watch for the OTHER ending: everyone crashed before the clock ran out.
  m.timers.outcome = setInterval(() => void checkAllOut(io, m), OUTCOME_POLL_MS);
  // The release timer carries two kinds of traffic: planned bot inputs, and
  // whatever the game itself wants the server to author. A game that uses the
  // second needs the timer whether or not anyone at the table is a bot.
  if (m.game.serverInputs || [...m.runners.values()].some((r) => r.isBot)) {
    m.timers.bots = setInterval(() => releaseServerInputs(io, m), BOT_RELEASE_MS);
  }
}

/** One refusal, attributed to the player it came from.
 *
 *  The platform-wide counter in the socket layer stays as it was — it answers
 *  "is something wrong with the build". This answers "is something wrong with
 *  THIS player", which is a different question and the one an investigation
 *  starts from. Touched only when an input is already being thrown away. */
const refuse = (r: Runner, why: string): string => {
  r.rejects[why] = (r.rejects[why] ?? 0) + 1;
  return why;
};

/** Validate and relay one input. Returns a reason string when dropped (for a
 *  counter/log), never throws — the hot path must stay cheap. */
export function onInput(socket: Socket, m: Match, uid: string, raw: unknown): string | null {
  const r = m.runners.get(uid);
  if (!r || r.left) return "not-in-match";
  if (m.phase !== "countdown" && m.phase !== "running") return refuse(r, "phase");
  const { tick, kind } = (raw ?? {}) as { tick?: unknown; kind?: unknown };
  if (typeof tick !== "number" || !Number.isInteger(tick) || tick < 1 || tick > m.game.durationTicks) {
    return refuse(r, "tick");
  }
  if (typeof kind !== "string" || !m.game.isValidInputKind(kind)) return refuse(r, "kind");
  const now = Date.now();
  const tickAt = m.startAt! + (tick * 1000) / m.game.tickRate;
  // Not from the past beyond the rewind window, and not from the future
  // (a little skew is normal — clocks are synced to within a few ms, but a
  // frame of latency in the client's stamping is fine).
  if (tickAt < now - m.game.inputLateLimitMs) return refuse(r, "late");
  if (tickAt > now + 250) return refuse(r, "early");
  // Rate ceiling: sliding one-second window.
  const cutoff = now - 1000;
  while (r.recent.length && r.recent[0] < cutoff) r.recent.shift();
  if (r.recent.length >= m.game.inputMaxPerSec) return refuse(r, "rate");
  r.recent.push(now);

  const input: MatchInput = { tick, kind };
  r.inputs.push(input);
  // The server plays the match too — that is what makes the ending, the
  // scores and the crashes ours rather than the client's.
  r.sim.addInput(input);
  const relay: MatchInputRelay = { uid, tick, kind };
  socket.to(m.room).emit(EV.input, relay);
  return null;
}

/** Relay one quick message to the rest of the match.
 *
 *  Server-checked on both axes a client cannot be trusted with: the id has to
 *  be one this build actually offers (so nobody injects text into other
 *  players' screens through the message channel), and the rate has to be a
 *  human one. Over the ceiling the message is dropped, not queued — a late
 *  "watch out!" is worse than none.
 *
 *  Returns a reason when dropped, for the same counter the input path uses. */
export function onQuick(io: Server, m: Match, uid: string, raw: unknown): string | null {
  const r = m.runners.get(uid);
  if (!r || r.left) return "not-in-match";
  if (m.phase !== "countdown" && m.phase !== "running") return "phase";
  const { kind, id } = (raw ?? {}) as { kind?: unknown; id?: unknown };
  if (typeof id !== "string" || (kind !== "chat" && kind !== "emote")) return "shape";
  const known =
    kind === "chat" ? QUICK_CHAT.some((q) => q.id === id) : (QUICK_EMOTE as readonly string[]).includes(id);
  if (!known) return "unknown";
  const now = Date.now();
  const cutoff = now - QUICK_WINDOW_MS;
  while (r.recentQuick.length && r.recentQuick[0] < cutoff) r.recentQuick.shift();
  if (r.recentQuick.length >= QUICK_MAX) return "rate";
  r.recentQuick.push(now);
  // One array push, after the rate ceiling — so a flood costs the log nothing.
  m.quick.push({ tick: nowTick(m), seat: r.seat, kind, id });
  const relay: QuickRelay = { uid, kind, id };
  io.to(m.room).emit(EV.quick, relay);
  return null;
}

/** A runner walks out (button, party leave, or a dropped socket past its
 *  grace). Their log stops here; ranking treats it as a forfeit. */
export async function leave(io: Server, m: Match, uid: string): Promise<void> {
  const r = m.runners.get(uid);
  if (!r || r.left) return;
  r.left = true;
  r.leftAtTick = nowTick(m);
  if (r.graceTimer) clearTimeout(r.graceTimer);
  r.graceTimer = null;
  if (r.userId) {
    byUser.delete(r.userId);
    const socketId = await getSocketId(r.userId);
    const socket = socketId ? io.sockets.sockets.get(socketId) : null;
    socket?.leave(m.room);
    await unbindMatch(m.id, [], [r.userId]);
  }
  // …AND THE PARTY THEY CAME FROM, once its last member is out.
  //
  // A match is assembled from several parties and strangers, and it ends when
  // the LAST of them is done — which for a party that finished early meant
  // being held "in a match" by people they have never met. They could not
  // start another, could not change the mode, and the leader could not even
  // remove the member who was still playing, because every one of those asks
  // whether the party is in a match.
  //
  // A party is in a match while one of ITS OWN is still in it. Not a moment
  // longer.
  await releaseLobbyIfDone(m, r.partyLobbyId);
  io.to(m.room).emit(EV.left, { uid });
  if (m.phase === "ended") return;
  if (present(m).length === 0) {
    await end(io, m, "abandoned");
  } else if (m.phase === "prepare") {
    markReadyCheck(io, m);
  }
}

/** Is anybody from this lobby still in this match? If not, the lobby is free.
 *
 *  Left deliberately silent when somebody remains: the check is cheap, runs
 *  only when a player leaves, and being wrong in the other direction would
 *  free a party that is still playing. */
async function releaseLobbyIfDone(m: Match, lobbyId: string): Promise<void> {
  if (!lobbyId) return;
  const stillIn = [...m.runners.values()].some(
    (x) => !x.left && !x.isBot && x.partyLobbyId === lobbyId
  );
  if (stillIn) return;
  await unbindMatch(m.id, [lobbyId], []);
}

function markReadyCheck(io: Server, m: Match): void {
  if (present(m).every((x) => x.ready || !x.connected)) void go(io, m);
}

/** Socket dropped: keep their seat for a grace period. */
export function onDisconnect(io: Server, userId: string): void {
  const m = getMatchForUser(userId);
  if (!m || !isActive(m)) return;
  const r = [...m.runners.values()].find((x) => x.userId === userId);
  if (!r || r.left) return;
  r.connected = false;
  if (r.graceTimer) clearTimeout(r.graceTimer);
  r.graceTimer = setTimeout(() => void leave(io, m, r.uid), graceFor(m));
  // Nobody left to wait for during prepare → start (or abandon) now.
  if (m.phase === "prepare") markReadyCheck(io, m);
}

/** A socket (re)connected for a user who is in a live match: put it back in
 *  the room and hand it everything needed to catch up. */
export function onReconnect(socket: Socket, userId: string): MatchResume | null {
  const m = getMatchForUser(userId);
  if (!m || !isActive(m)) return null;
  const r = [...m.runners.values()].find((x) => x.userId === userId);
  if (!r || r.left) return null;
  r.connected = true;
  if (r.graceTimer) clearTimeout(r.graceTimer);
  r.graceTimer = null;
  socket.join(m.room);
  const inputs: MatchInputRelay[] = [];
  for (const x of m.runners.values()) for (const i of x.inputs) inputs.push({ uid: x.uid, ...i });
  return {
    ...prepareFor(m, r),
    phase: m.phase,
    startAt: m.startAt,
    inputs,
    left: [...m.runners.values()].filter((x) => x.left).map((x) => x.uid),
  };
}

/** End every match this process is running.
 *
 *  Used when the platform goes down for maintenance. "aborted" rather than a
 *  reason of its own: it is what the results screen already knows how to say,
 *  and inventing a new one would mean every game had to learn a word for
 *  something that is not about the game. Nobody is left mid-match wondering
 *  why the socket went quiet. */
export async function endAllMatches(io: Server, why: string): Promise<number> {
  const live = [...matches.values()].filter((m) => isActive(m));
  for (const m of live) {
    await end(io, m, "aborted").catch((err) => console.error(`[match ${m.id}] ${why} end failed:`, err));
  }
  if (live.length > 0) console.log(`✔ Ended ${live.length} match(es) for ${why}`);
  return live.length;
}

export async function end(io: Server, m: Match, reason: MatchEndReason): Promise<void> {
  if (m.phase === "ended") return;
  m.phase = "ended";
  m.endedAt = Date.now();
  if (m.timers.outcome) clearInterval(m.timers.outcome);
  m.timers.outcome = null;
  if (m.timers.bots) clearInterval(m.timers.bots);
  m.timers.bots = null;
  for (const t of Object.values(m.timers)) if (t) clearTimeout(t);
  const endTick = reason === "timeout" ? m.game.durationTicks : nowTick(m);
  const members: RankMember[] = [...m.runners.values()].map((r) => ({
    uid: r.uid,
    name: r.name,
    seat: r.seat,
    inputs: r.inputs,
    left: r.left,
    leftAtTick: r.leftAtTick,
    isBot: r.isBot,
  }));
  let standings;
  try {
    standings = m.game.rank(members, endTick, m.seed);
  } catch (err) {
    console.error(`[match ${m.id}] rank failed:`, err);
    standings = members.map((x) => ({ uid: x.uid, name: x.name, placement: 1, score: 0, detail: {}, forfeit: x.left }));
  }
  // Record it BEFORE telling anyone: the results screen then shows the XP the
  // database actually granted, rather than a number the client hoped for. The
  // write is idempotent and never throws, so a database wobble delays the
  // screen slightly instead of losing the match.
  const recorded = await recordMatch({
    matchKey: m.id,
    gameId: m.game.id,
    seed: m.seed,
    reason,
    ticks: endTick,
    tickRate: m.game.tickRate,
    standings,
    runners: [...m.runners.values()].map((r) => ({
      uid: r.uid,
      userId: r.userId,
      isBot: r.isBot,
      inputs: r.inputs.length,
      rejects: r.rejects,
      // Only where the player's own timing IS the input. A game the server
      // authors moves for is turn-based by construction, and "regular" there
      // means the rules are working, not that somebody is scripting.
      cadence: m.game.serverInputs ? null : cadence(r.inputs.map((i) => i.tick)),
    })),
  });
  // Difficulty tuning needs evidence, not guesswork: how often bots win, and
  // how far they got in the games that measure such a thing. Recorded against
  // THIS game, so one game's numbers never colour another's.
  recordBotOutcome(
    m.game.id,
    standings.map((st) => {
      const d = (st.detail as Record<string, number>).distance;
      return {
        isBot: m.runners.get(st.uid)?.isBot ?? false,
        placement: st.placement,
        distance: typeof d === "number" ? d : null,
      };
    })
  );
  const payload: MatchEnd = { matchId: m.id, reason, standings, ticks: endTick, xp: recorded.xp };
  io.to(m.room).emit(EV.end, payload);

  // Archive it. AFTER the results are on their way, and never awaited: a slow
  // upload must not hold up anybody's results screen. Everything it needs is
  // already in memory — the input logs the ranking was just computed from.
  void archive(m, reason, endTick, standings, recorded.xp).catch((err) =>
    console.error(`[match ${m.id}] could not queue the replay:`, err)
  );

  // Release everyone: bindings, sockets, voice.
  const userIds = humans(m).map((r) => r.userId!);
  for (const id of userIds) if (byUser.get(id) === m.id) byUser.delete(id);
  await unbindMatch(m.id, m.lobbyIds, userIds);
  // ...and close the gap. The party is a lobby again.
  for (const lobbyId of m.lobbyIds) {
    void noteLobbyMatch(lobbyId, "end", m.id, m.game.id).catch((err) =>
      console.error(`[party] match end on ${lobbyId}:`, err)
    );
  }
  for (const r of humans(m)) {
    if (r.graceTimer) clearTimeout(r.graceTimer);
    const socketId = await getSocketId(r.userId!);
    const socket = socketId ? io.sockets.sockets.get(socketId) : null;
    socket?.leave(m.room);
  }
  // KEEP RECORDING THROUGH THE RESULTS.
  //
  // The scoreboard is up for RESULTS_MS and everybody is still in the match's
  // voice room for all of it — and what is said over a scoreboard is routinely
  // the most telling thing in the whole match, because it is what follows
  // losing. Stopping at the final tick threw exactly that away.
  //
  // Then un-register BEFORE the room goes away: the recorder finishes its
  // files on the way out, and deleting the room first cuts them off
  // mid-sentence.
  void new Promise((r) => setTimeout(r, RESULTS_MS + RECORDER_TAIL_MS))
    .then(() => stopForMatch(m.id))
    .then(() => new Promise((r) => setTimeout(r, 2000)))
    .then(() => deleteMatchVoiceRoom(m.id))
    .catch((err) => console.error(`[match ${m.id}] could not stop recording:`, err));
  m.timers.linger = setTimeout(() => matches.delete(m.id), LINGER_MS);
}

/** Serialize the match and hand it to the archive queue.
 *
 *  There is nothing to capture here — a match is completely described by its
 *  game, its seed, its roster and its inputs, and all four have been sitting in
 *  this object the whole time. This is a serialization, which is why it costs
 *  a player nothing. */
async function archive(
  m: Match,
  reason: MatchEndReason,
  endTick: number,
  standings: Standing[],
  xp: Record<string, number>
): Promise<void> {
  const runners = [...m.runners.values()];
  const inputsBySeat = new Map<number, MatchInput[]>();
  for (const r of runners) inputsBySeat.set(r.seat, r.inputs);
  const tier = await tierFor(runners.filter((r) => r.userId).map((r) => r.userId!));
  const file = encodeReplay({
    matchKey: m.id,
    gameId: m.game.id,
    seed: m.seed,
    tickRate: m.game.tickRate,
    durationTicks: m.game.durationTicks,
    createdAt: m.createdAt,
    startAt: m.startAt,
    endedAt: m.endedAt ?? Date.now(),
    reason,
    endTick,
    roster: runners
      .map((r) => ({
        uid: r.uid,
        seat: r.seat,
        name: r.name,
        character: r.character,
        weapon: r.weapon,
        isBot: r.isBot,
        userId: r.userId,
        left: r.left,
        leftAtTick: r.leftAtTick,
      }))
      .sort((a, b) => a.seat - b.seat),
    inputsBySeat,
    quick: m.quick,
    standings,
    xp,
  });
  await queueReplay(file, tier);
}

/** Everything the SERVER puts on the wire on a runner's behalf: the planned bot
 *  inputs whose tick is nearly here, and whatever the game itself asks to
 *  author this instant.
 *
 *  Each one goes onto that runner's own log and sim exactly like a human's, so
 *  the end-of-match replay treats them identically and a bot's score is
 *  computed by the same code as everyone else's. */
function releaseServerInputs(io: Server, m: Match): void {
  if (m.phase !== "countdown" && m.phase !== "running") return;
  if (m.startAt === null) return;
  const horizon = Date.now() + BOT_LEAD_MS - m.startAt;
  for (const r of m.runners.values()) {
    if (!r.isBot || r.left) continue;
    while (r.planCursor < r.plan.length) {
      const input = r.plan[r.planCursor];
      if ((input.tick * 1000) / m.game.tickRate > horizon) break;
      r.planCursor++;
      emitServerInput(io, m, r, input);
    }
  }
  if (!m.game.serverInputs) return;
  // Left runners are included: a game may need to be told that a chair is
  // empty, and only the platform knows it.
  const runners: ServerRunnerView[] = [...m.runners.values()].map((r) => ({
    uid: r.uid,
    seat: r.seat,
    isBot: r.isBot,
    skill: r.skill,
    left: r.left,
  }));
  let authored: { uid: string; input: MatchInput }[] = [];
  try {
    authored = m.game.serverInputs(m.ctx, m.seed, nowTick(m), runners);
  } catch (err) {
    console.error(`[match ${m.id}] serverInputs failed:`, err);
    return;
  }
  for (const { uid, input } of authored) {
    const r = m.runners.get(uid);
    if (!r) continue;
    // The same shape check the client path applies, minus the kind: these are
    // the kinds only the server may write, so isValidInputKind refuses them
    // on the way IN and cannot be asked about them here.
    if (!Number.isInteger(input.tick) || input.tick < 1 || input.tick > m.game.durationTicks) continue;
    emitServerInput(io, m, r, input);
  }
}

function emitServerInput(io: Server, m: Match, r: Runner, input: MatchInput): void {
  r.inputs.push(input);
  r.sim.addInput(input);
  const relay: MatchInputRelay = { uid: r.uid, tick: input.tick, kind: input.kind };
  io.to(m.room).emit(EV.input, relay);
}

/** Everyone crashed? Then the match is over now rather than at the clock.
 *
 *  The sims are advanced to a tick slightly BEHIND real time so a late input
 *  can still rewrite the last moment; without that lag a player who dodged at
 *  the last instant could be declared dead by a packet that had not landed
 *  yet. Runners who left count as out — a match nobody is playing is over. */
async function checkAllOut(io: Server, m: Match): Promise<void> {
  if (m.phase !== "running" && m.phase !== "countdown") return;
  if (m.startAt === null) return;
  const tick = Math.floor(((Date.now() - m.startAt - OUTCOME_LAG_MS) * m.game.tickRate) / 1000);
  if (tick <= 0) return;
  const upTo = Math.min(tick, m.game.durationTicks);
  let anyRunning = false;
  for (const r of m.runners.values()) {
    if (r.left) continue;
    r.sim.advanceTo(upTo);
    if (!r.sim.isOut()) anyRunning = true;
  }
  if (!anyRunning) await end(io, m, "all-out");
}

/** For the voice token route: is this user in a live match, and which. */
export function activeMatchIdForUser(userId: string): string | null {
  const m = getMatchForUser(userId);
  return m && isActive(m) ? m.id : null;
}

/** A compact picture of every live match, for the ops snapshot the admin
 *  console reads. Built on demand from what is already in memory — no extra
 *  bookkeeping, and nothing here is retained. Ended matches linger in the map
 *  so late events find them; they are deliberately not reported as live. */
export interface MatchSnapshotEntry {
  id: string;
  gameId: string;
  phase: MatchPhase;
  tick: number;
  players: number;
  bots: number;
  createdAt: number;
  startAt: number | null;
  uids: string[];
}

export function liveMatchSnapshot(): MatchSnapshotEntry[] {
  const out: MatchSnapshotEntry[] = [];
  for (const m of matches.values()) {
    if (m.phase === "ended") continue;
    const runners = [...m.runners.values()];
    out.push({
      id: m.id,
      gameId: m.game.id,
      phase: m.phase,
      tick: nowTick(m),
      players: runners.filter((r) => !r.isBot).length,
      bots: runners.filter((r) => r.isBot).length,
      createdAt: m.createdAt,
      startAt: m.startAt,
      uids: runners.filter((r) => !r.isBot).map((r) => r.uid),
    });
  }
  return out;
}

/** Force a match to end from outside the socket path — the console's
 *  "end this stuck match" button, arriving over the ops command channel. */
export async function endMatchById(io: Server, matchId: string, reason: MatchEndReason): Promise<boolean> {
  const m = matches.get(matchId);
  if (!m || m.phase === "ended") return false;
  await end(io, m, reason);
  return true;
}
