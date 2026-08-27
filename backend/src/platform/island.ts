// A drop-in world, and the four things that make it not a match.
//
// A match is assembled from a fixed set of people, played, ranked and thrown
// away. An ISLAND is a place: it opens, it stays open for forty minutes, people
// walk in and out of it the whole time, and when its clock runs out everybody
// on it is sent home together and a fresh one opens for the next arrivals.
//
// Four consequences, and every one of them is why this is its own runtime
// rather than a flag on match.ts:
//
//   1. THE ROSTER CHANGES. A seat nobody real is standing in is held by
//      somebody from the server population; a person arriving takes one of
//      those seats and that bot walks off; a person leaving hands theirs back.
//      The island is always twenty, so it always feels the same size — and
//      because seats are handed round rather than appended, seat numbers stay
//      inside 0…19 and the position channel can name one in a single byte.
//
//   2. THERE IS NOTHING TO SIMULATE. Nobody wins, so there is no authoritative
//      outcome to protect and no reason to keep an input log. Positions are
//      relayed and forgotten. Forty minutes of twenty people walking would
//      otherwise be half a million logged inputs and a replay nobody wants.
//
//   3. THE POPULATION COSTS NOTHING. A bot's walk is a pure function of the
//      island's seed, the bot's uid and the milliseconds since it opened, so
//      every client works out where all nineteen of them are without a single
//      byte crossing the wire. See shared/games/social/life.ts.
//
//   4. VOICE IS THE POINT. Everybody shares one LiveKit room and hears only
//      the people within twenty metres, which the client does by SUBSCRIBING
//      to nobody else — so a voice you are not meant to hear is not merely
//      turned down, it never arrives.
//
// What it deliberately reuses: the match wire (prepare / resume / end / leave),
// the Redis bindings that say who is busy, the voice room naming, the
// recording decision, and the friend-request offer on the way out. All of that
// is already right and already tested, and a second copy of any of it would be
// a second thing to get wrong.
import { randomBytes, randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import { getSocketId, isPartyLobby } from "../redis.js";
import { displayName, type UserRow } from "../services/users.js";
import { resolveCharacter, resolveWeapon } from "../services/catalog.js";
import type { GameServerDefinition } from "./games.js";
import { buildBots, type BotIdentity } from "./bots.js";
import { releaseBots } from "./botAccounts.js";
import { bindMatch, unbindMatch } from "./store.js";
import { noteLobbyMatch } from "./partyLog.js";
import { listFriends } from "../services/friends.js";
import { logEvent } from "../services/eventLog.js";
import { deleteMatchVoiceRoom } from "./voice.js";
import { encodeReplay, queueReplay, tierFor, type QuickLogEntry, type ReplayRosterEntry } from "./replay.js";
import { recordSession } from "../services/matchResults.js";
import { considerRoom, noteMatchStart, stopForMatch } from "./voiceRecording.js";
import {
  EV,
  LIVE_EV,
  QUICK_EMOTE,
  QUICK_MAX,
  QUICK_WINDOW_MS,
  RESULTS_MS,
  type LiveClosing,
  type LivePin,
  type LiveRoster,
  type MatchEnd,
  type MatchEndReason,
  type MatchInput,
  type MatchResume,
  type RosterEntry,
  type Standing,
} from "../shared/core/protocol.js";
import {
  BUBBLE_WINDOW_MS,
  bubbleWindow,
  keyOf,
  Wanderer,
  CAPACITY,
  CLOSING_MS,
  DISCONNECT_GRACE_MS,
  EMPTY_CLOSE_MS,
  REPORT_HZ,
  RUN_SPEED,
  SESSION_MS,
  SNAPSHOT_HZ,
  SPEED_TOLERANCE,
  TOUCH_RANGE_M,
  HEAR_MAX_M,
  EMOTE_COOLDOWN_MS,
  heightAt,
  MAX_POSE_AGE_MS,
  MAX_POSE_AHEAD_MS,
  packWire,
  readReport,
  SNAPSHOT_RANGE_M,
  resolveMove,
  spawnPoint,
  packTrack,
  TRACK_IDLE_MS,
  TRACK_LEFT,
  TRACK_MIN_MS,
  TRACK_MOVE_M,
  type Anim,
  type Pose,
  type PoseWire,
} from "../shared/games/social/index.js";

/** How long a closed island stays in memory: long enough for the results
 *  screen it just put on twenty phones to ask it questions. */
const LINGER_MS = 3 * 60_000;
/** The recorder outlasts the players rather than racing them — same reasoning
 *  as a match's, and the last thing said on an island is the most likely
 *  reason anybody is listening. */
const RECORDER_TAIL_MS = 2000;
/** Who is standing near whom, recomputed this often. Once a second: it feeds
 *  the "people you met" line and the console's map, and neither needs to know
 *  within a tenth of a second. */
const NEAR_MS = 1000;
/** The most a single position report may move somebody, however long they have
 *  been silent.
 *
 *  ONE second of running, not two. The bucket exists to absorb packets
 *  arriving in a bunch — a few hundred milliseconds of walking turning up at
 *  once — and a second covers any of that with room to spare. Two seconds let
 *  one message move somebody seventeen metres, which is most of the way into a
 *  stranger's earshot, and the whole reason the limit exists is that walking
 *  there should be the only way to get there. A backgrounded tab does not need
 *  the headroom either: a phone with the screen off is not moving. */
const SLACK_MAX_M = RUN_SPEED * SPEED_TOLERANCE;
/** A map marker is a deliberate act; twice a second is somebody leaning on it. */
const PIN_COOLDOWN_MS = 500;

/** One person's whole time on the island, kept for the archive.
 *
 *  A seat is not a person here — over forty minutes seat 3 might hold a bot,
 *  then Alice, then a bot again, then Bob — so the replay's seats are
 *  OCCUPANCIES in arrival order rather than the live seat index. That is what
 *  lets a format with one roster row per seat describe a roster that changed
 *  thirty times. */
interface Occupancy {
  uid: string;
  userId: string | null;
  botId: string | null;
  name: string;
  character: string;
  weapon: string | null;
  isBot: boolean;
  /** Where they sit in the REPLAY, which is the order they arrived. */
  seat: number;
  joinedTick: number;
  leftTick: number | null;
  /** Their track: {tick, kind} exactly like a match's input log, so the studio
   *  plays it with no idea it is not one. */
  track: MatchInput[];
  /** The last pose written, for the change test. */
  atX: number;
  atZ: number;
  atAnim: number;
  atMs: number;
}

/** Track samples one island may hold before it stops recording.
 *
 *  Twenty people for forty minutes at two a second is about a hundred
 *  thousand, and this is comfortably past that — it is a ceiling on the
 *  pathological case (a full island of people who never stand still), not a
 *  budget anybody reaches. Past it the recording stops and says so, rather
 *  than the process growing until something else fails. */
const TRACK_MAX = 160_000;

export interface Islander {
  uid: string;
  /** Exactly one of these is set, and which one is the only place in this
   *  runtime that knows whether a seat is a person. */
  userId: string | null;
  botId: string | null;
  name: string;
  character: string;
  weapon: string | null;
  /** The party they walked in with; "" for a bot the island itself seated. */
  partyLobbyId: string;
  isBot: boolean;
  seat: number;
  joinedAt: number;
  connected: boolean;
  left: boolean;
  graceTimer: NodeJS.Timeout | null;
  /** Where the server believes they are. For a person this is what they last
   *  reported (clamped); for a bot it is where their walk has got to. */
  pose: Pose;
  /** WHEN that pose was true, on the server's clock.
   *
   *  Not when the packet arrived — that is jittery, and stamping a snapshot
   *  with it is what made every remote player stutter. It is advanced by the
   *  spacing the SENDER measured between its own two frames, so a run of
   *  reports rebuilds the sender's own timeline however unevenly they
   *  happened to land. Clamped to a window around real time so a client whose
   *  clock runs fast or slow cannot drift it away. */
  poseTime: number;
  /** Bots only: the walk. See shared/games/social/life.ts — a graph of routes
   *  through the park whose every edge has been checked clear, so a bot can
   *  never end up inside a tree or stuck against the fountain. */
  walk: Wanderer | null;
  /** Bots only: the last flourish window shown, so one is never shown twice. */
  lastBubble: number;
  poseAt: number;
  /** Report timestamps, for the per-second ceiling. */
  recent: number[];
  /** Metres this player is allowed to have moved but has not yet used.
   *
   *  A token bucket rather than a per-packet clamp, and the difference is
   *  visible: two reports that arrive four milliseconds apart carry two
   *  hundred milliseconds of walking between them, and a clamp measured on
   *  ARRIVAL times refuses the second one — so everybody else watching sees
   *  them snap backwards. Packets bunch on every mobile connection. The
   *  bucket fills at the speed a running player is allowed and is spent by
   *  the distance actually claimed, so a burst is fine and a sustained lie is
   *  not, which is the only thing the limit is for. */
  slack: number;
  /** …and the chat wheel's own, slower window. */
  recentQuick: number[];
  /** When they last marked the map. */
  pinAt: number;
  emoteAt: number;
  /** Reports the server refused, by reason — the same cheating signal a
   *  match's rejected inputs are. */
  rejects: Record<string, number>;
  /** Everyone they have stood next to. */
  met: Set<string>;
  /** The uids on their friend list who might also be here.
   *
   *  Loaded once when they walk in, and used for one thing: a friend is in
   *  your snapshot however far away they are. Everybody else is cut at
   *  SNAPSHOT_RANGE_M, which is what stops a client being used to find a
   *  stranger — but "where has my friend got to" is the question a map on a
   *  hundred-and-fifty-metre island exists to answer, and cutting them at
   *  seventy metres makes it unanswerable exactly when it matters. */
  friends: Set<string>;
  /** Their row in the archive. */
  rec: Occupancy;
}

export interface Island {
  id: string;
  game: GameServerDefinition;
  seed: number;
  openedAt: number;
  endsAt: number;
  phase: "open" | "closing" | "ended";
  /** Fixed length CAPACITY. A null is a seat that could not be filled — the
   *  bot pool was empty — and the island simply runs one lighter. */
  seats: (Islander | null)[];
  byUid: Map<string, Islander>;
  lobbyIds: Set<string>;
  /** The spot each party has marked, by lobby id. Kept rather than relayed and
   *  forgotten so that a teammate who opens the map a minute later — or who
   *  walked in after the tap — sees the same mark everybody else is walking
   *  towards. */
  pins: Map<string, LivePin>;
  room: string;
  /** True once the recorder has been asked to sit in this room. */
  recording: boolean;
  /** Everybody who has ever been on it, in arrival order — the replay roster. */
  log: Occupancy[];
  /** What was SAID. Not a position and not an input; the only record of the
   *  part moderation actually reads. */
  quick: QuickLogEntry[];
  /** Track samples written so far, against TRACK_MAX. */
  samples: number;
  timers: {
    snap: NodeJS.Timeout | null;
    near: NodeJS.Timeout | null;
    closing: NodeJS.Timeout | null;
    end: NodeJS.Timeout | null;
    linger: NodeJS.Timeout | null;
    empty: NodeJS.Timeout | null;
  };
}

const islands = new Map<string, Island>();
/** userId → island id, so a socket can find its world in one lookup. */
const byUser = new Map<string, string>();

export const getIsland = (id: string): Island | undefined => islands.get(id);
export const isLive = (i: Island): boolean => i.phase !== "ended";

export function getIslandForUser(userId: string): Island | undefined {
  const id = byUser.get(userId);
  return id ? islands.get(id) : undefined;
}

/** For the voice token route: is this user standing in a live world? */
export function activeIslandIdForUser(userId: string): string | null {
  const i = getIslandForUser(userId);
  return i && isLive(i) ? i.id : null;
}

/** The real people on an island, as uid → userId. Bots are simply absent,
 *  which is what keeps them out of every list built from this. */
export function humansOnIsland(id: string): Map<string, string> {
  const out = new Map<string, string>();
  const i = islands.get(id);
  if (!i) return out;
  for (const p of i.byUid.values()) if (!p.isBot && p.userId && !p.left) out.set(p.uid, p.userId);
  return out;
}

/** Wall clock → the replay's own tick. An island has no simulation, so this is
 *  purely the timeline the studio scrubs along. */
const tickOf = (i: Island, at: number): number =>
  Math.max(0, Math.min(i.game.durationTicks, Math.round(((at - i.openedAt) / 1000) * i.game.tickRate)));

const people = (i: Island): Islander[] => [...i.byUid.values()].filter((p) => !p.isBot && !p.left);
const occupants = (i: Island): Islander[] => i.seats.filter((s): s is Islander => s !== null && !s.left);

function rosterOf(i: Island): RosterEntry[] {
  return occupants(i)
    .sort((a, b) => a.seat - b.seat)
    .map((p) => ({ uid: p.uid, name: p.name, character: p.character, weapon: p.weapon, seat: p.seat }));
}

// ---------------------------------------------------------------------------
// Opening one
// ---------------------------------------------------------------------------

type IslanderSeed = Omit<
  Islander,
  | "seat"
  | "pose"
  | "poseAt"
  | "poseTime"
  | "recent"
  | "slack"
  | "recentQuick"
  | "pinAt"
  | "emoteAt"
  | "rejects"
  | "met"
  | "friends"
  | "joinedAt"
  | "graceTimer"
  | "walk"
  | "lastBubble"
  | "rec"
>;

function newIslander(seat: number, seed: number, base: IslanderSeed, island: Island): Islander {
  const spawn = spawnPoint(seed, seat);
  const now = Date.now();
  const rec: Occupancy = {
    uid: base.uid,
    userId: base.userId,
    botId: base.botId,
    name: base.name,
    character: base.character,
    weapon: base.weapon,
    isBot: base.isBot,
    seat: island.log.length,
    joinedTick: tickOf(island, now),
    leftTick: null,
    track: [],
    atX: spawn.x,
    atZ: spawn.z,
    atAnim: -1,
    atMs: -1e9,
  };
  island.log.push(rec);
  return {
    rec,
    ...base,
    seat,
    joinedAt: Date.now(),
    graceTimer: null,
    pose: { x: spawn.x, z: spawn.z, ry: spawn.ry, anim: 0 },
    poseAt: Date.now(),
    poseTime: Date.now(),
    recent: [],
    slack: 0,
    recentQuick: [],
    pinAt: 0,
    emoteAt: 0,
    rejects: {},
    met: new Set(),
    friends: new Set(),
    // A bot's walk is keyed on the ACCOUNT, not the seat: seats are handed
    // round as people arrive and leave, and a regular who teleported every
    // time somebody else left would be the one tell nothing else gives away.
    walk: base.isBot ? new Wanderer(seed, keyOf(base.uid)) : null,
    lastBubble: -1,
  };
}

async function openIsland(io: Server, game: GameServerDefinition): Promise<Island> {
  const id = randomUUID().slice(0, 12);
  const now = Date.now();
  const island: Island = {
    id,
    game,
    seed: randomBytes(4).readUInt32LE(0),
    openedAt: now,
    endsAt: now + SESSION_MS,
    phase: "open",
    seats: new Array(CAPACITY).fill(null),
    byUid: new Map(),
    lobbyIds: new Set(),
    pins: new Map(),
    room: `match:${id}`,
    recording: false,
    log: [],
    quick: [],
    samples: 0,
    timers: { snap: null, near: null, closing: null, end: null, linger: null, empty: null },
  };
  islands.set(id, island);
  // Every seat starts held by the population, so the first person through the
  // door walks into a place with people in it rather than an empty park.
  await fillWithBots(island);
  island.timers.snap = setInterval(() => broadcastSnapshot(io, island), Math.round(1000 / SNAPSHOT_HZ));
  island.timers.near = setInterval(() => {
    noteNeighbours(island);
    botFlourishes(io, island);
  }, NEAR_MS);
  island.timers.closing = setTimeout(() => announceClosing(io, island), Math.max(0, SESSION_MS - CLOSING_MS));
  island.timers.end = setTimeout(() => void close(io, island, "timeout"), SESSION_MS);
  // A safety net rather than a case that happens: an island is only ever
  // opened to put somebody on it, and joinIsland clears this the moment they
  // arrive. If they never do — the party vanished between the decision and the
  // seating — it closes itself instead of running for forty minutes with
  // nobody real in it and a timer nobody is watching.
  island.timers.empty = setTimeout(() => {
    if (people(island).length === 0) void close(io, island, "abandoned");
  }, EMPTY_CLOSE_MS);
  // The island's own zero. Any recording of it is placed relative to this, so
  // the console can lay the audio over the map rather than beside it.
  void noteMatchStart(id, now).catch((err) => console.error(`[island ${id}] anchor:`, err));
  logEvent({ type: "island.opened", matchKey: id, gameId: game.id, data: { seed: island.seed } });
  console.info(`[island] opened ${id} (${game.id}) — closes in ${Math.round(SESSION_MS / 60000)} min`);
  return island;
}

/** Take every empty seat with somebody from the population. */
async function fillWithBots(island: Island): Promise<void> {
  const empty = island.seats.reduce((n, s) => n + (s === null ? 1 : 0), 0);
  if (empty <= 0) return;
  const held = new Set([...island.byUid.values()].filter((p) => p.botId).map((p) => p.botId!));
  let bots: BotIdentity[] = [];
  try {
    bots = await buildBots(island.game, empty, held);
  } catch (err) {
    console.error(`[island ${island.id}] could not draw bots:`, err);
    return;
  }
  for (const bot of bots) {
    const seat = island.seats.indexOf(null);
    if (seat < 0) {
      releaseBots([bot.botId]);
      continue;
    }
    seatBot(island, seat, bot, "");
  }
}

function seatBot(island: Island, seat: number, bot: BotIdentity, lobbyId: string): Islander {
  const p = newIslander(seat, island.seed, {
    uid: bot.uid,
    userId: null,
    botId: bot.botId,
    name: bot.name,
    character: bot.character,
    weapon: bot.weapon,
    partyLobbyId: lobbyId,
    isBot: true,
    connected: true,
    left: false,
  }, island);
  island.seats[seat] = p;
  island.byUid.set(p.uid, p);
  return p;
}

// ---------------------------------------------------------------------------
// Arriving
// ---------------------------------------------------------------------------

export interface IslandParty {
  lobbyId: string;
  users: UserRow[];
  /** Teammates the party already holds — they walk in and take seats too. */
  bots?: BotIdentity[];
}

/** Which island a party should walk into.
 *
 *  Preference, in order: an island with room that is not about to close, then
 *  the one with the MOST people already on it — because a social space is only
 *  social if the real players end up in the same one rather than spread thinly
 *  over four. Falling back to an island in its last minutes is deliberate and
 *  is what the spec asks for: arriving at minute thirty-five gets you five
 *  minutes, which is better than being told to come back later. */
function pickIsland(gameId: string, need: number): Island | null {
  const now = Date.now();
  let best: Island | null = null;
  let bestKey = -Infinity;
  for (const i of islands.values()) {
    if (i.phase !== "open" || i.game.id !== gameId) continue;
    const free = i.seats.reduce((n, s) => n + (s === null || s.isBot ? 1 : 0), 0);
    if (free < need) continue;
    const roomy = i.endsAt - now > 5 * 60_000 ? 1 : 0;
    const humans = people(i).length;
    // Roomy islands beat closing ones; among equals, the busier one; among
    // those, the one with longer left.
    const key = roomy * 1e9 + humans * 1e6 + (i.endsAt - now) / 1000;
    if (key > bestKey) {
      bestKey = key;
      best = i;
    }
  }
  return best;
}

/** A bot stands down so a person can have its seat. The newest one goes: the
 *  regulars who have been walking around since the island opened stay, which
 *  is both cheaper (their walk is already computed on every client) and the
 *  right reading of "a placeholder for somebody who has not arrived yet". */
function evictBot(island: Island): number {
  let seat = -1;
  let newest = -1;
  for (let s = 0; s < island.seats.length; s++) {
    const p = island.seats[s];
    if (p === null) return s; // an empty seat is better than evicting anybody
    if (!p.isBot || p.left) continue;
    if (p.joinedAt > newest) {
      newest = p.joinedAt;
      seat = s;
    }
  }
  if (seat < 0) return -1;
  const bot = island.seats[seat]!;
  island.byUid.delete(bot.uid);
  island.seats[seat] = null;
  // Only ones the island drew itself go back to the pool; a bot that walked in
  // with a party is that party's teammate and stays held until it leaves.
  if (bot.botId && !bot.partyLobbyId) releaseBots([bot.botId]);
  return seat;
}

/** Put a party on an island — the existing one if there is a suitable one,
 *  otherwise a new one. This is what pressing START does for a drop-in game. */
export async function joinIsland(
  io: Server,
  game: GameServerDefinition,
  party: IslandParty
): Promise<{ id: string } | { error: string }> {
  const partyBots = party.bots ?? [];
  const need = party.users.length + partyBots.length;
  if (need === 0) return { error: "Nobody to go with" };
  if (need > CAPACITY) return { error: "Your party is too big for this" };

  const island = pickIsland(game.id, need) ?? (await openIsland(io, game));
  const arrived: Islander[] = [];

  for (const u of party.users) {
    const seat = evictBot(island);
    if (seat < 0) break; // island filled up between the pick and here
    const p = newIslander(seat, island.seed, {
      uid: u.uid,
      userId: u.id,
      botId: null,
      name: displayName(u),
      character: resolveCharacter(u.equippedCharacter),
      weapon: resolveWeapon(u.equippedWeapon),
      partyLobbyId: party.lobbyId,
      isBot: false,
      connected: true,
      left: false,
    }, island);
    island.seats[seat] = p;
    island.byUid.set(p.uid, p);
    byUser.set(u.id, island.id);
    arrived.push(p);
  }
  if (arrived.length === 0) return { error: "That island filled up — try again" };

  // The party's own bot teammates come too, and keep their party id so a
  // forfeit, the party log and the seat accounting all agree about them.
  for (const bot of partyBots) {
    const seat = evictBot(island);
    if (seat < 0) break;
    seatBot(island, seat, bot, party.lobbyId);
  }

  island.lobbyIds.add(party.lobbyId);
  await bindMatch(island.id, [party.lobbyId], arrived.map((p) => p.userId!));
  if (island.timers.empty) {
    clearTimeout(island.timers.empty);
    island.timers.empty = null;
  }

  logEvent({
    type: "island.join",
    matchKey: island.id,
    gameId: game.id,
    data: {
      party: isPartyLobby(party.lobbyId) ? party.lobbyId : null,
      uids: arrived.map((p) => p.uid),
      humans: people(island).length,
    },
  });
  void noteLobbyMatch(party.lobbyId, "start", island.id, game.id).catch((err) =>
    console.error(`[party] island start on ${party.lobbyId}:`, err)
  );

  // Is anybody who just walked in flagged? Asked on EVERY arrival rather than
  // once at creation, because unlike a match this roster is not final when it
  // opens — the flagged player may be the fourteenth person through the door.
  void armRecording(island).catch((err) => console.error(`[island ${island.id}] voice decision:`, err));
  // Who each arrival already knows. One read per person walking in, never on
  // the hot path, and a failure only costs them the wider view of their
  // friends — everything else works exactly as before.
  for (const p of arrived) {
    void loadFriends(p).catch((err) => console.error(`[island ${island.id}] friends for ${p.uid}:`, err));
  }

  // Everyone gets a RESUME rather than a prepare: the island is already
  // running, which is exactly the case resume exists for. It carries startAt,
  // so no client shows a countdown into a place that has been open for half an
  // hour.
  for (const p of arrived) {
    const socketId = await getSocketId(p.userId!);
    const socket = socketId ? io.sockets.sockets.get(socketId) : null;
    if (socket) socket.join(island.room);
    else p.connected = false;
    io.to(`user:${p.userId}`).emit(EV.resume, resumeFor(island, p));
    // Whatever their group is already heading towards.
    const pin = island.pins.get(p.partyLobbyId);
    if (pin) io.to(`user:${p.userId}`).emit(LIVE_EV.pinned, pin);
  }
  broadcastRoster(io, island);
  return { id: island.id };
}

/** Their friend list, as uids, for the snapshot filter. */
async function loadFriends(p: Islander): Promise<void> {
  if (!p.userId) return;
  const rows = await listFriends(p.userId);
  if (p.left) return;
  p.friends = new Set(rows.map((r) => r.uid));
}

function resumeFor(island: Island, p: Islander): MatchResume {
  return {
    matchId: island.id,
    gameId: island.game.id,
    seed: island.seed,
    roster: rosterOf(island),
    you: p.uid,
    rules: { ...island.game.rules(), endsAt: island.endsAt, openedAt: island.openedAt, seat: p.seat },
    serverNow: Date.now(),
    phase: "running",
    startAt: island.openedAt,
    inputs: [],
    left: [],
  };
}

/** Tell everybody who is here — one message each, not one to the room.
 *
 *  The roster itself is the same for everyone. What is not is `party`: who the
 *  RECIPIENT walked in with. Folding that into a single serialisation could
 *  only mean shipping everybody's affiliations to everybody, which hands a
 *  stranger the shape of the room. Sent a handful of times in forty minutes,
 *  so twenty small messages instead of one costs nothing worth counting. */
function broadcastRoster(io: Server, island: Island): void {
  if (island.phase === "ended") return;
  const roster = rosterOf(island);
  for (const me of people(island)) {
    const payload: LiveRoster = {
      matchId: island.id,
      roster,
      endsAt: island.endsAt,
      party: partyOf(island, me),
    };
    io.to(`user:${me.userId}`).emit(LIVE_EV.roster, payload);
  }
}

/** The people this player walked in with, in seat order so a map can number
 *  them the same way twice. Their own uid is not in it.
 *
 *  Party BOTS are in it. A duo whose second seat was filled by the server is
 *  still a duo as far as the player is concerned, and a teammate who is not on
 *  the map is the one way that stops being true. Ambient island bots carry no
 *  lobby id, so the same test excludes them. */
function partyOf(island: Island, me: Islander): string[] {
  if (!me.partyLobbyId) return [];
  return occupants(island)
    .filter((p) => p !== me && p.partyLobbyId === me.partyLobbyId)
    .sort((a, b) => a.seat - b.seat)
    .map((p) => p.uid);
}

/** Mark a spot for the people you arrived with.
 *
 *  Clamped onto the island rather than refused when it is off it: a thumb on a
 *  map is not precise, and "as close to there as you can get" is what somebody
 *  tapping the sea actually means. */
export function onIslandPin(io: Server, island: Island, uid: string, raw: unknown): string | null {
  const p = island.byUid.get(uid);
  if (!p || p.left || p.isBot) return "not-here";
  if (island.phase === "ended") return "closed";
  const now = Date.now();
  if (now < p.pinAt + PIN_COOLDOWN_MS) return "rate";
  p.pinAt = now;
  const { x, z } = (raw ?? {}) as { x?: unknown; z?: unknown };
  let payload: LivePin;
  if (typeof x !== "number" || typeof z !== "number" || !Number.isFinite(x) || !Number.isFinite(z)) {
    payload = { uid, x: null, z: null };
  } else {
    const m = resolveMove(x, z);
    // A decimetre is as precise as a marker on a map can honestly be — but
    // rounded TOWARDS THE MIDDLE, never away from it. A tap out at sea comes
    // back on the shore to the millimetre, and ordinary rounding then puts it
    // back in the water by six centimetres, where the client's own isClear
    // disagrees with the server that just produced it.
    const inward = (v: number) => Math.trunc(v * 10) / 10;
    payload = { uid, x: inward(m.x), z: inward(m.z) };
  }
  if (payload.x === null) island.pins.delete(p.partyLobbyId);
  else island.pins.set(p.partyLobbyId, payload);
  // The sender and the people they came with, and nobody else.
  const to = [p, ...occupants(island).filter((q) => q !== p && !q.isBot && q.partyLobbyId === p.partyLobbyId)];
  for (const q of to) if (q.userId) io.to(`user:${q.userId}`).emit(LIVE_EV.pinned, payload);
  return null;
}

// ---------------------------------------------------------------------------
// Walking about
// ---------------------------------------------------------------------------

/** One position report. Returns a reason when dropped, never throws — this is
 *  the hot path and runs ten times a second per person. */
export function onReport(island: Island, uid: string, raw: unknown): string | null {
  const p = island.byUid.get(uid);
  if (!p || p.left || p.isBot) return "not-here";
  if (island.phase === "ended") return "closed";
  const now = Date.now();
  // Rate ceiling, sliding one-second window. Generous by the tolerance, so a
  // phone whose timer drifts is not punished for it.
  const cutoff = now - 1000;
  while (p.recent.length && p.recent[0] < cutoff) p.recent.shift();
  if (p.recent.length >= Math.ceil(REPORT_HZ * 1.8)) return refuse(p, "rate");
  p.recent.push(now);

  const pose = readReport(raw);
  if (!pose) return refuse(p, "shape");

  // Not further than a running person could have got. This is not anti-cheat
  // theatre: the ONLY thing a lie about position buys here is standing inside
  // somebody's twenty-metre voice range without walking there, and a speed cap
  // is exactly what makes that impossible.
  //
  // Measured out of a BUCKET, not against the gap between two arrivals — see
  // the note on `slack`. The ceiling on the bucket is what keeps a burst from
  // becoming a teleport: however long somebody has been quiet, the furthest
  // one report can move them is SLACK_MAX metres.
  const dt = Math.min(2, Math.max(0, (now - p.poseAt) / 1000));
  p.slack = Math.min(SLACK_MAX_M, p.slack + RUN_SPEED * SPEED_TOLERANCE * dt);
  let x = pose.x;
  let z = pose.z;
  const dx = x - p.pose.x;
  const dz = z - p.pose.z;
  const d2 = dx * dx + dz * dz;
  const dist = Math.sqrt(d2);
  if (dist > p.slack) {
    const k = p.slack / dist;
    x = p.pose.x + dx * k;
    z = p.pose.z + dz * k;
    p.slack = 0;
    refuse(p, "speed");
  } else {
    p.slack -= dist;
  }
  // …and on the island, and not inside a tree. The same shared function the
  // client walks with, so the two agree about where a fountain is.
  const m = resolveMove(x, z);
  p.pose.x = m.x;
  p.pose.z = m.z;
  p.pose.ry = pose.ry;
  p.pose.anim = pose.anim;
  p.poseAt = now;
  // Advance the sender's own timeline by the gap THEY measured, then pull it
  // back inside a window around real time. See `poseTime`.
  p.poseTime = Math.min(now + MAX_POSE_AHEAD_MS, Math.max(now - MAX_POSE_AGE_MS, (p.poseTime || now) + pose.dt));
  return null;
}

const refuse = (p: Islander, why: string): string => {
  p.rejects[why] = (p.rejects[why] ?? 0) + 1;
  return why;
};

/** Where everybody is, sent to everybody — but only the part of it each
 *  person could plausibly see.
 *
 *  Three decisions are folded into this one function and each of them was a
 *  real choice:
 *
 *  BOTS ARE IN IT. The obvious optimisation is to leave them out and let each
 *  client compute their walk from the seed — it is deterministic, so it would
 *  work, and it would cost nothing. It is also the one thing on this platform
 *  that would let a client tell a bot from a person: a seat that never appears
 *  in a snapshot is a seat with nobody behind it, and no amount of care in the
 *  payload shapes survives that. So the walk runs HERE, and a bot is a row in
 *  the snapshot exactly like everybody else.
 *
 *  IT IS SENT PER PERSON, not to the room. Everybody past SNAPSHOT_RANGE_M is
 *  left out of yours — they are further away than the island draws anybody, so
 *  it costs you nothing to see, and it means a client cannot be used to find
 *  out where somebody it has never met is standing. On a busy island it also
 *  roughly halves what is sent.
 *
 *  IT IS BUILT ONCE. The poses are computed for the whole island, then each
 *  recipient's list is filtered out of that array — twenty distance checks per
 *  person per tick, which at ten ticks a second is four thousand comparisons
 *  and nothing else. */
function broadcastSnapshot(io: Server, island: Island): void {
  if (island.phase === "ended") return;
  const now = Date.now();
  const ms = now - island.openedAt;
  const here = occupants(island);
  for (const p of here) {
    if (!p.walk) continue;
    const w = p.walk.poseAt(ms);
    p.pose.x = w.x;
    p.pose.z = w.z;
    p.pose.ry = w.ry;
    p.pose.anim = w.anim;
    p.poseAt = now;
    // A bot's pose is computed AT this instant, so it is exactly this old.
    p.poseTime = now;
  }
  for (const p of here) trackSample(island, p, now);
  const wires: { p: Islander; w: PoseWire }[] = here.map((p) => ({
    p,
    w: packWire(p.seat, p.pose, now - p.poseTime),
  }));
  const R2 = SNAPSHOT_RANGE_M * SNAPSHOT_RANGE_M;
  for (const me of here) {
    if (me.isBot || me.left || !me.connected || !me.userId) continue;
    const mine: PoseWire[] = [];
    for (const other of wires) {
      if (other.p === me) continue;
      const dx = other.p.pose.x - me.pose.x;
      const dz = other.p.pose.z - me.pose.z;
      // Out of range AND not somebody you know. A friend is always in it — see
      // `friends`.
      if (dx * dx + dz * dz > R2 && !me.friends.has(other.p.uid)) continue;
      mine.push(other.w);
    }
    io.to(`user:${me.userId}`).emit(LIVE_EV.snap, { t: now, p: mine });
  }
}

/** Write one person's position into the archive, if it is worth writing.
 *
 *  Runs on the snapshot tick — ten times a second — and writes at most twice,
 *  and only when something changed. A person standing still costs one sample
 *  every three seconds, which is what turns "everybody's position for forty
 *  minutes" from a megabyte an island into a couple of hundred kilobytes.
 *
 *  Cheap by construction: two subtractions and a compare on the path that
 *  usually returns. */
function trackSample(island: Island, p: Islander, now: number): void {
  const rec = p.rec;
  const since = now - rec.atMs;
  if (since < TRACK_MIN_MS) return;
  const dx = p.pose.x - rec.atX;
  const dz = p.pose.z - rec.atZ;
  const moved = dx * dx + dz * dz >= TRACK_MOVE_M * TRACK_MOVE_M;
  if (!moved && p.pose.anim === rec.atAnim && since < TRACK_IDLE_MS) return;
  if (island.samples >= TRACK_MAX) {
    if (island.samples === TRACK_MAX) {
      island.samples++;
      console.warn(`[island ${island.id}] track full at ${TRACK_MAX} samples — the rest is not recorded`);
    }
    return;
  }
  island.samples++;
  rec.atX = p.pose.x;
  rec.atZ = p.pose.z;
  rec.atAnim = p.pose.anim;
  rec.atMs = now;
  rec.track.push({ tick: tickOf(island, now), kind: packTrack(p.pose) });
}

/** The population's small gestures — a wave, a laugh, something over a head.
 *
 *  Windowed rather than scheduled: each minute or so of a bot's life either has
 *  one in it or does not, decided by a hash of (bot, window), so there is no
 *  queue to keep and a bot that was seated ten minutes ago is already in the
 *  right place in its own rhythm. Sent on the same channel a person's emoji
 *  goes out on, so nothing about it reads differently. */
function botFlourishes(io: Server, island: Island): void {
  if (island.phase === "ended") return;
  const ms = Date.now() - island.openedAt;
  for (const p of island.seats) {
    if (!p || !p.isBot || p.left) continue;
    const w = bubbleWindow(keyOf(p.uid), island.seed, ms);
    if (!w || w.window === p.lastBubble) continue;
    p.lastBubble = w.window;
    // Only worth showing if somebody is close enough to read it.
    const seen = people(island).some((h) => {
      const dx = h.pose.x - p.pose.x;
      const dz = h.pose.z - p.pose.z;
      return dx * dx + dz * dz <= SNAPSHOT_RANGE_M * SNAPSHOT_RANGE_M;
    });
    if (!seen) continue;
    const id = QUICK_EMOTE[w.slot % QUICK_EMOTE.length];
    island.quick.push({ tick: tickOf(island, Date.now()), seat: p.rec.seat, kind: "emote", id });
    io.to(island.room).emit(EV.quick, { uid: p.uid, kind: "emote", id });
  }
}

/** One emoji from a person, on the same channel and with the same ceiling the
 *  rest of the platform applies to the chat wheel. */
export function onIslandQuick(io: Server, island: Island, uid: string, raw: unknown): string | null {
  const p = island.byUid.get(uid);
  if (!p || p.left || p.isBot) return "not-here";
  if (island.phase === "ended") return "closed";
  const { kind, id } = (raw ?? {}) as { kind?: unknown; id?: unknown };
  if (kind !== "emote" || typeof id !== "string") return "shape";
  if (!(QUICK_EMOTE as readonly string[]).includes(id)) return "unknown";
  const now = Date.now();
  const cutoff = now - QUICK_WINDOW_MS;
  while (p.recentQuick.length && p.recentQuick[0] < cutoff) p.recentQuick.shift();
  if (p.recentQuick.length >= QUICK_MAX) return "rate";
  p.recentQuick.push(now);
  island.quick.push({ tick: tickOf(island, now), seat: p.rec.seat, kind: "emote", id });
  io.to(island.room).emit(EV.quick, { uid, kind: "emote", id });
  return null;
}

/** Who has stood next to whom. Cheap on purpose: twenty people is 190 pairs
 *  and this runs once a second. */
function noteNeighbours(island: Island): void {
  const here = people(island);
  for (let a = 0; a < here.length; a++) {
    for (let b = a + 1; b < here.length; b++) {
      const dx = here[a].pose.x - here[b].pose.x;
      const dz = here[a].pose.z - here[b].pose.z;
      if (dx * dx + dz * dz > TOUCH_RANGE_M * TOUCH_RANGE_M) continue;
      here[a].met.add(here[b].uid);
      here[b].met.add(here[a].uid);
    }
  }
}

/** Perform an emote. The catalog check is the caller's — this is the relay and
 *  the floor under how often. */
export function onEmote(io: Server, island: Island, uid: string, id: string): string | null {
  const p = island.byUid.get(uid);
  if (!p || p.left || p.isBot) return "not-here";
  if (island.phase === "ended") return "closed";
  const now = Date.now();
  if (now < p.emoteAt + EMOTE_COOLDOWN_MS) return "rate";
  p.emoteAt = now;
  island.quick.push({ tick: tickOf(island, now), seat: p.rec.seat, kind: "emote", id });
  io.to(island.room).emit(LIVE_EV.emoted, { uid, id });
  return null;
}

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------

/** Somebody walks out — the button, a party leaving, or a socket that stayed
 *  dark past its grace. Their seat goes back to the population immediately, so
 *  the island stays twenty and nobody sees a gap where a person was. */
export async function leaveIsland(io: Server, island: Island, uid: string): Promise<void> {
  const p = island.byUid.get(uid);
  if (!p || p.left) return;
  p.left = true;
  // A departure has a MOMENT, so it goes on the tape as its own mark rather
  // than as a gap the studio has to infer from a track that stops.
  p.rec.leftTick = tickOf(island, Date.now());
  if (island.samples < TRACK_MAX) {
    island.samples++;
    p.rec.track.push({ tick: p.rec.leftTick, kind: TRACK_LEFT });
  }
  if (p.graceTimer) clearTimeout(p.graceTimer);
  p.graceTimer = null;
  island.byUid.delete(uid);
  if (island.seats[p.seat] === p) island.seats[p.seat] = null;

  if (p.userId) {
    if (byUser.get(p.userId) === island.id) byUser.delete(p.userId);
    const socketId = await getSocketId(p.userId);
    const socket = socketId ? io.sockets.sockets.get(socketId) : null;
    socket?.leave(island.room);
    await unbindMatch(island.id, [], [p.userId]);
    await releaseLobbyIfDone(island, p.partyLobbyId);
  } else if (p.botId && !p.partyLobbyId) {
    releaseBots([p.botId]);
  }
  io.to(island.room).emit(EV.left, { uid });

  if (island.phase === "ended") return;
  if (people(island).length === 0) {
    // The last person left a park with nineteen bots in it. Nothing is served
    // by keeping that running, but it is not closed instantly either: somebody
    // whose socket blinked is about to come back, and a place that vanishes
    // under them is worse than one that waits twenty seconds.
    if (!island.timers.empty) {
      island.timers.empty = setTimeout(() => {
        if (people(island).length === 0) void close(io, island, "abandoned");
      }, EMPTY_CLOSE_MS);
    }
    return;
  }
  // A seat is never left empty while the island is open.
  void fillWithBots(island).then(() => broadcastRoster(io, island));
}

async function releaseLobbyIfDone(island: Island, lobbyId: string): Promise<void> {
  if (!lobbyId) return;
  const stillIn = [...island.byUid.values()].some((x) => !x.left && !x.isBot && x.partyLobbyId === lobbyId);
  if (stillIn) return;
  island.lobbyIds.delete(lobbyId);
  await unbindMatch(island.id, [lobbyId], []);
  void noteLobbyMatch(lobbyId, "end", island.id, island.game.id).catch((err) =>
    console.error(`[party] island end on ${lobbyId}:`, err)
  );
}

/** The socket dropped. Ten seconds and no longer — see the note on
 *  DISCONNECT_GRACE_MS: a seat here is a body standing in front of somebody. */
export function onIslandDisconnect(io: Server, userId: string): void {
  const island = getIslandForUser(userId);
  if (!island || !isLive(island)) return;
  const p = [...island.byUid.values()].find((x) => x.userId === userId);
  if (!p || p.left) return;
  p.connected = false;
  if (p.graceTimer) clearTimeout(p.graceTimer);
  p.graceTimer = setTimeout(() => void leaveIsland(io, island, p.uid), DISCONNECT_GRACE_MS);
}

/** A socket came back inside its grace: put it back in the room and hand it
 *  everything it needs to carry on standing where it was. */
export function onIslandReconnect(socket: Socket, userId: string): MatchResume | null {
  const island = getIslandForUser(userId);
  if (!island || !isLive(island)) return null;
  const p = [...island.byUid.values()].find((x) => x.userId === userId);
  if (!p || p.left) return null;
  p.connected = true;
  if (p.graceTimer) clearTimeout(p.graceTimer);
  p.graceTimer = null;
  socket.join(island.room);
  return resumeFor(island, p);
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

function announceClosing(io: Server, island: Island): void {
  if (island.phase !== "open") return;
  island.phase = "closing";
  const payload: LiveClosing = { matchId: island.id, at: island.endsAt };
  io.to(island.room).emit(LIVE_EV.closing, payload);
}

/** What everybody is shown on the way out.
 *
 *  It is not a scoreboard and must not read like one: every placement is 1,
 *  because nobody came first at standing in a park. What is worth telling
 *  somebody is how long they were there and how many people they actually
 *  stood next to — which is also what makes the friend-request offer on the
 *  results screen mean something. */
function standingsOf(island: Island, at: number): Standing[] {
  return occupants(island)
    .sort((a, b) => a.seat - b.seat)
    .map((p) => rowFor(island, p.rec, p.joinedAt, at, p.met.size, false));
}

/** The same row, for the archive, covering everybody who was EVER here — the
 *  people who left an hour into the session included, because they are exactly
 *  the ones a report is usually about. */
function archiveStandings(island: Island, at: number): Standing[] {
  return island.log.map((o) => {
    const live = island.byUid.get(o.uid);
    const joinedAt = island.openedAt + (o.joinedTick * 1000) / island.game.tickRate;
    const until = o.leftTick === null ? at : island.openedAt + (o.leftTick * 1000) / island.game.tickRate;
    return rowFor(island, o, joinedAt, until, live?.met.size ?? 0, o.leftTick !== null);
  });
}

function rowFor(
  island: Island,
  o: Occupancy,
  from: number,
  until: number,
  met: number,
  left: boolean
): Standing {
  const seconds = Math.max(0, Math.round((until - from) / 1000));
  return {
    uid: o.uid,
    name: o.name,
    // Nobody came first at standing in a park — every placement is 1, and the
    // results card is worded to match.
    placement: 1,
    score: Math.round(seconds / 60),
    detail: { minutes: Math.round(seconds / 60), seconds, met },
    forfeit: left,
  };
}

export async function close(io: Server, island: Island, reason: MatchEndReason): Promise<void> {
  if (island.phase === "ended") return;
  island.phase = "ended";
  const at = Date.now();
  if (island.timers.snap) clearInterval(island.timers.snap);
  if (island.timers.near) clearInterval(island.timers.near);
  for (const t of [island.timers.closing, island.timers.end, island.timers.empty]) if (t) clearTimeout(t);
  island.timers = { snap: null, near: null, closing: null, end: null, linger: null, empty: null };

  const standings = standingsOf(island, at);
  const payload: MatchEnd = { matchId: island.id, reason, standings, ticks: 0 };
  io.to(island.room).emit(EV.end, payload);

  logEvent({
    type: "island.closed",
    matchKey: island.id,
    gameId: island.game.id,
    data: {
      reason,
      minutes: Math.round((at - island.openedAt) / 60000),
      people: standings.length,
      met: standings.reduce((n, s) => n + (s.detail.met ?? 0), 0),
    },
  });

  // Hand the population back.
  releaseBots(
    [...island.byUid.values()].filter((p) => p.isBot && !p.partyLobbyId && p.botId).map((p) => p.botId!)
  );

  const userIds = [...island.byUid.values()].filter((p) => !p.isBot && p.userId).map((p) => p.userId!);
  for (const id of userIds) if (byUser.get(id) === island.id) byUser.delete(id);
  await unbindMatch(island.id, [...island.lobbyIds], userIds);
  for (const lobbyId of island.lobbyIds) {
    void noteLobbyMatch(lobbyId, "end", island.id, island.game.id).catch((err) =>
      console.error(`[party] island end on ${lobbyId}:`, err)
    );
  }
  for (const p of island.byUid.values()) {
    if (p.graceTimer) clearTimeout(p.graceTimer);
    if (!p.userId) continue;
    const socketId = await getSocketId(p.userId);
    io.sockets.sockets.get(socketId ?? "")?.leave(island.room);
  }

  // The recorder stays through the results screen and a little past it — what
  // is said as a place closes is the part worth having.
  if (island.recording) {
    void new Promise((r) => setTimeout(r, RESULTS_MS + RECORDER_TAIL_MS))
      .then(() => stopForMatch(island.id))
      .then(() => new Promise((r) => setTimeout(r, 2000)))
      .then(() => deleteMatchVoiceRoom(island.id))
      .catch((err) => console.error(`[island ${island.id}] could not stop recording:`, err));
  } else {
    void new Promise((r) => setTimeout(r, RESULTS_MS + RECORDER_TAIL_MS))
      .then(() => deleteMatchVoiceRoom(island.id))
      .catch(() => undefined);
  }

  // Archive it. AFTER the results are on their way and never awaited: a slow
  // upload must not hold up anybody's screen. Everything it needs has been
  // sitting in this object the whole time.
  void archive(island, reason, at, archiveStandings(island, at)).catch((err) =>
    console.error(`[island ${island.id}] could not queue the replay:`, err)
  );

  island.timers.linger = setTimeout(() => islands.delete(island.id), LINGER_MS);
  console.info(`[island] closed ${island.id} (${reason}) after ${Math.round((at - island.openedAt) / 60000)} min`);
}

/** Hand the session to the archive, so the console can watch it back.
 *
 *  The trick — and it is the whole reason this file needs nothing from the
 *  studio — is that a track IS an input log as far as the format is concerned:
 *  {tick, kind} per person, grouped by seat. The studio builds its tape from
 *  those, seeds a runtime with the ones before the playhead and hands over the
 *  rest as its clock reaches them, and the social runtime reads a pose out of
 *  each `kind` instead of a swipe. Nothing in the studio knows the difference.
 *
 *  Two rows go alongside it, and deliberately only two: `matches` and
 *  `match_players`, so the list can say how long it ran and a player's history
 *  can find it. Nothing touches anybody's career — see recordSession. */
async function archive(island: Island, reason: MatchEndReason, at: number, standings: Standing[]): Promise<void> {
  const roster: ReplayRosterEntry[] = island.log.map((o) => ({
    uid: o.uid,
    seat: o.seat,
    name: o.name,
    character: o.character,
    weapon: o.weapon,
    isBot: o.isBot,
    userId: o.userId,
    left: o.leftTick !== null,
    leftAtTick: o.leftTick,
    joinedAtTick: o.joinedTick,
  }));
  const trackBySeat = new Map<number, MatchInput[]>();
  for (const o of island.log) trackBySeat.set(o.seat, o.track);
  const endTick = tickOf(island, at);
  const tier = await tierFor(island.log.filter((o) => o.userId).map((o) => o.userId!));
  const file = encodeReplay({
    matchKey: island.id,
    gameId: island.game.id,
    seed: island.seed,
    tickRate: island.game.tickRate,
    durationTicks: island.game.durationTicks,
    createdAt: island.openedAt,
    startAt: island.openedAt,
    endedAt: at,
    reason,
    endTick,
    roster,
    inputsBySeat: trackBySeat,
    quick: island.quick,
    standings,
    xp: {},
  });
  await queueReplay(file, tier);

  // ONE ROW PER PERSON, not per occupancy.
  //
  // The replay keeps every visit as its own seat — it has to, or a viewer
  // could not tell somebody's second arrival from their first. The DATABASE
  // cannot: `match_players` is unique on (match, user), because for a match
  // "was this player in it" is one fact and being asked twice is a bug. On an
  // island a player can genuinely be there twice, so the visits are added up
  // here instead. Found the honest way: the first island that recorded
  // somebody leaving and coming back failed its insert.
  const byUid = new Map(standings.map((st) => [st.uid, st]));
  const merged = new Map<string, {
    uid: string; name: string; userId: string | null; botId: string | null; isBot: boolean;
    score: number; detail: Record<string, number>; left: boolean; samples: number; rejects: Record<string, number>;
  }>();
  for (const o of island.log) {
    const st = byUid.get(o.uid);
    const key = o.userId ?? o.botId ?? o.uid;
    const have = merged.get(key);
    if (have) {
      have.score += st?.score ?? 0;
      have.samples += o.track.length;
      have.detail.minutes = (have.detail.minutes ?? 0) + (st?.detail.minutes ?? 0);
      have.detail.seconds = (have.detail.seconds ?? 0) + (st?.detail.seconds ?? 0);
      have.detail.visits = (have.detail.visits ?? 1) + 1;
      have.detail.met = Math.max(have.detail.met ?? 0, st?.detail.met ?? 0);
      // Still on it at the end beats having walked out earlier.
      have.left = have.left && o.leftTick !== null;
      continue;
    }
    merged.set(key, {
      uid: o.uid,
      name: o.name,
      userId: o.userId,
      botId: o.botId,
      isBot: o.isBot,
      score: st?.score ?? 0,
      detail: { ...(st?.detail ?? {}), visits: 1 },
      left: o.leftTick !== null,
      samples: o.track.length,
      rejects: {},
    });
  }
  await recordSession({
    matchKey: island.id,
    gameId: island.game.id,
    seed: island.seed,
    reason,
    ticks: endTick,
    members: [...merged.values()],
  });
  console.info(
    `[island ${island.id}] archived — ${island.log.length} occupancies, ${island.samples} samples, ` +
      `${island.quick.length} thing(s) said`
  );
}

/** Shut every island this process is running — maintenance, deploys. */
export async function closeAllIslands(io: Server, why: string): Promise<number> {
  const live = [...islands.values()].filter(isLive);
  for (const i of live) await close(io, i, "aborted").catch((err) => console.error(`[island ${i.id}] ${why}:`, err));
  if (live.length > 0) console.log(`✔ Closed ${live.length} island(s) for ${why}`);
  return live.length;
}

/** The console's "close this stuck island" button, over the ops channel. */
export async function closeIslandById(io: Server, id: string, reason: MatchEndReason): Promise<boolean> {
  const i = islands.get(id);
  if (!i || i.phase === "ended") return false;
  await close(io, i, reason);
  return true;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** Is anybody standing here flagged? Asked on every arrival, and the answer
 *  can change from no to yes at minute thirty — which is the whole difference
 *  between this and a match, where the roster is settled before it starts.
 *
 *  Once armed it stays armed for the life of the island: everybody in the room
 *  is being recorded because of who they are standing with, and somebody
 *  leaving does not un-say what was said. */
async function armRecording(island: Island): Promise<void> {
  if (island.phase === "ended") return;
  const userIds = people(island).map((p) => p.userId!);
  if (userIds.length === 0) return;
  const armed = await considerRoom(island.id, userIds, { already: island.recording, anchor: island.openedAt });
  if (armed) island.recording = true;
}

// ---------------------------------------------------------------------------
// What the console sees
// ---------------------------------------------------------------------------

export interface IslandWatchEntry {
  uid: string;
  name: string;
  seat: number;
  /** Server-only. Never leaves the admin API. */
  isBot: boolean;
  connected: boolean;
  x: number;
  z: number;
  ry: number;
  anim: Anim;
  /** Metres above sea level, so the console can say "up on the knoll". */
  y: number;
  /** Minutes they have been here. */
  mins: number;
  /** How many people are inside their voice range right now. */
  near: number;
  met: number;
  joinedAt: number;
  rejects: Record<string, number>;
}

export interface IslandSnapshotEntry {
  id: string;
  gameId: string;
  phase: Island["phase"];
  openedAt: number;
  endsAt: number;
  humans: number;
  bots: number;
  recording: boolean;
  who: IslandWatchEntry[];
}

/** A complete picture of every live island, built on demand from what is
 *  already in memory. This is what makes "what is each player actually doing"
 *  answerable in the console without a single extra byte crossing the wire
 *  during play — the positions are already here, because voice needed them. */
export function liveIslandSnapshot(): IslandSnapshotEntry[] {
  const now = Date.now();
  const out: IslandSnapshotEntry[] = [];
  for (const island of islands.values()) {
    if (island.phase === "ended") continue;
    const here = occupants(island);
    const humans = here.filter((p) => !p.isBot);
    const who: IslandWatchEntry[] = humans.map((p) => {
      let near = 0;
      for (const q of humans) {
        if (q === p) continue;
        const dx = q.pose.x - p.pose.x;
        const dz = q.pose.z - p.pose.z;
        if (dx * dx + dz * dz <= HEAR_MAX_M * HEAR_MAX_M) near++;
      }
      return {
        uid: p.uid,
        name: p.name,
        seat: p.seat,
        isBot: false,
        connected: p.connected,
        x: Math.round(p.pose.x * 10) / 10,
        z: Math.round(p.pose.z * 10) / 10,
        ry: Math.round(p.pose.ry * 100) / 100,
        anim: p.pose.anim,
        y: Math.round(heightAt(p.pose.x, p.pose.z) * 10) / 10,
        mins: Math.max(0, Math.round((now - p.joinedAt) / 60000)),
        near,
        met: p.met.size,
        joinedAt: p.joinedAt,
        rejects: p.rejects,
      };
    });
    out.push({
      id: island.id,
      gameId: island.game.id,
      phase: island.phase,
      openedAt: island.openedAt,
      endsAt: island.endsAt,
      humans: humans.length,
      bots: here.length - humans.length,
      recording: island.recording,
      who,
    });
  }
  return out;
}
