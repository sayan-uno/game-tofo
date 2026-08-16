// The match protocol every game shares: Socket.IO event names and payload
// shapes for the lobby → match → results lifecycle. Game-specific content
// (inputs, rules) travels inside these envelopes as opaque data the platform
// never interprets — only the game's own sim (shared/games/<id>) does.
//
// Pure types + a few constants. No runtime dependencies on either side.

/** Party modes already used by the lobby; a game maps each to a match size. */
export type PartyMode = "solo" | "duo" | "squad";

/** What the client sees of a runner in a match. Deliberately contains nothing
 *  that could tell a bot from a person. */
export interface RosterEntry {
  uid: string;
  name: string;
  /** Catalog id of the character model. */
  character: string;
  /** Catalog id of the held weapon, or null. */
  weapon: string | null;
}

export type MatchPhase = "prepare" | "countdown" | "running" | "ended";

/** Sent to every participant when a match has been assembled. Clients build
 *  their scene on it and answer with `match:ready`. */
export interface MatchPrepare {
  matchId: string;
  gameId: string;
  /** Seed for the deterministic course — identical on every device. */
  seed: number;
  roster: RosterEntry[];
  /** Local player's uid, so the client never has to guess its own row. */
  you: string;
  /** Sent through as-is from the game's server definition (durations, sizes…). */
  rules: Record<string, number>;
  /** Server clock at send time — a first sample for clock sync. */
  serverNow: number;
}

/** The countdown starts: everybody's sim tick 0 lands on `startAt`
 *  (server clock). Clients convert with their measured clock offset. */
export interface MatchGo {
  matchId: string;
  startAt: number;
  serverNow: number;
}

/** A game input, timestamped in sim ticks. `kind` is game-defined. */
export interface MatchInput {
  tick: number;
  kind: string;
}

export interface MatchInputRelay extends MatchInput {
  uid: string;
}

export interface Standing {
  uid: string;
  name: string;
  /** 1 = first. Equal placements are shared (a draw). */
  placement: number;
  score: number;
  /** Extra per-game numbers for the results screen (distance, coins…). */
  detail: Record<string, number>;
  /** Left the match before it ended (forfeit). */
  forfeit: boolean;
}

export type MatchEndReason = "timeout" | "all-out" | "abandoned" | "aborted";

export interface MatchEnd {
  matchId: string;
  reason: MatchEndReason;
  standings: Standing[];
  /** Ticks the match ran for. */
  ticks: number;
  /** XP granted per uid, as actually written to the database. */
  xp?: Record<string, number>;
}

/** Everything a client needs to (re)join a match already in flight — a page
 *  reload, a dropped socket. The input log lets the deterministic sim
 *  fast-forward without ever having seen the match run. */
export interface MatchResume extends MatchPrepare {
  phase: MatchPhase;
  startAt: number | null;
  inputs: MatchInputRelay[];
  /** Runners who forfeited so far. */
  left: string[];
}

/** Answer to `match:sync`. A client that has been away asks this the moment
 *  its socket comes back: either here is the match you are still in, or you
 *  are not in one any more and here is why.
 *
 *  Without it, a player whose signal died for longer than the grace period
 *  reconnects into a lobby that thinks they are fine while their screen still
 *  shows a run the server forfeited minutes ago — they watch a match they
 *  cannot affect and nothing ever tells them. */
export type MatchSync = { in: true; resume: MatchResume } | { in: false; reason: "gone" };

/** Talking during a run, without a keyboard.
 *
 *  A fixed menu rather than free text, for three reasons that all matter here:
 *  a runner has one thumb and no time to type; a closed set needs no
 *  moderation, so strangers can be matched together safely; and an id costs a
 *  dozen bytes on a wire that is otherwise carrying nothing but inputs.
 *
 *  The server checks every id against these lists, so adding a line here is
 *  the only way to make one sendable. */
export const QUICK_CHAT = [
  { id: "gg", text: "Good game!" },
  { id: "nice", text: "Nice run!" },
  { id: "close", text: "So close!" },
  { id: "watch", text: "Watch out!" },
  { id: "follow", text: "Follow me!" },
  { id: "oops", text: "My bad" },
] as const;

export const QUICK_EMOTE = ["👍", "🔥", "😂", "😱", "🫡", "💀"] as const;

/** Answer to `match:addable`: which runners from the match just finished the
 *  asker may send a friend request to.
 *
 *  Asked rather than broadcast with the result, and computed PER ASKER, so the
 *  payload cannot be used to work out who was a bot: a uid is missing from the
 *  list whether it belonged to a bot, to someone already on your friend list,
 *  or to someone you already have a request with. */
export interface MatchAddable {
  uids: string[];
}

export type QuickKind = "chat" | "emote";
export interface QuickSend {
  kind: QuickKind;
  /** A QUICK_CHAT id, or the emoji itself for an emote. */
  id: string;
}
export interface QuickRelay extends QuickSend {
  uid: string;
}

/** Quick messages a runner may send per QUICK_WINDOW_MS. Low on purpose: this
 *  is a wheel of six phrases, and anyone hitting the ceiling is spamming. */
export const QUICK_MAX = 3;
export const QUICK_WINDOW_MS = 5000;

/** Progress while a party waits for a match to fill. */
export interface MatchSearching {
  /** Humans found so far, including your own party. */
  found: number;
  /** Runners the match needs. */
  size: number;
  elapsedMs: number;
  /** After this long the empty seats are filled and the match starts. */
  deadlineMs: number;
}

/** Server-side clock probe answer for offset estimation. */
export interface TimePong {
  serverNow: number;
}

/** Event names, in one place so a typo can't split the two sides. */
export const EV = {
  // lobby ↔ game selection + loading (party scope)
  pickGame: "lobby:pickGame", // client→server {gameId: string|null}
  progress: "game:progress", // client→server {pct}
  loading: "lobby:loading", // server→room {uid, pct}
  start: "lobby:start", // client→server (leader)
  cancel: "lobby:cancelSearch", // client→server (leader)
  searching: "match:searching", // server→room  MatchSearching
  searchEnded: "match:searchEnded", // server→room {reason}
  // match lifecycle (match scope)
  prepare: "match:prepare", // server→participants  MatchPrepare
  ready: "match:ready", // client→server
  go: "match:go", // server→participants  MatchGo
  input: "match:input", // both ways  MatchInput / MatchInputRelay
  end: "match:end", // server→participants  MatchEnd
  leave: "match:leave", // client→server
  left: "match:left", // server→participants {uid}
  resume: "match:resume", // server→client  MatchResume
  sync: "match:sync", // client→server (ack: MatchSync) — "am I still in one?"
  quick: "match:quick", // both ways  QuickSend / QuickRelay
  addable: "match:addable", // client→server (ack: {uids}) — who can I add?
  ping: "time:ping", // client→server (ack: TimePong)
} as const;

/** How often a client may report download progress. The server ignores
 *  anything faster; the client throttles itself to the same rate. */
export const PROGRESS_MAX_HZ = 4;
