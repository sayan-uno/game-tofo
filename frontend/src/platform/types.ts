// The contract between the platform and a game's client module.
//
// A game is a folder under frontend/src/games/<id>/ exporting `createRuntime`.
// The platform owns everything around it — picking, downloading, the match
// lifecycle, clock sync, voice, results — and hands the game exactly what it
// needs to draw and to speak: the engine, the roster, the seed, its own pack,
// and one function to send an input. Nothing else crosses the line, so a
// change inside a game can't reach another game or the lobby.
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { MatchEnd, MatchInput, MatchInputRelay, QuickKind, RosterEntry, Standing } from "../shared/core/protocol";

/** The game's downloaded pack: files by manifest path, read from the
 *  on-device store (already downloaded by the time a match starts). */
export interface PackAssets {
  version: string;
  /** Bytes of one file (throws if the manifest doesn't list it). */
  get(path: string): Promise<Uint8Array>;
  /** The CDN URL a path resolves to — for Babylon loaders that want a name. */
  url(path: string): string;
  has(path: string): boolean;
}

export interface GameRuntimeContext {
  engine: Engine;
  canvas: HTMLCanvasElement;
  assets: PackAssets;
  roster: RosterEntry[];
  /** The local player's uid. */
  you: string;
  seed: number;
  /** Rule numbers from the server (the game also has its shared copy). */
  rules: Record<string, number>;
  /** Send one of my inputs. Fire-and-forget; the platform stamps nothing —
   *  the game decides the tick. */
  sendInput(input: MatchInput): void;
  /** Say one of the fixed phrases or emotes. The platform relays it; the game
   *  decides where a message appears (over a runner's head, in a feed). */
  sendQuick(kind: QuickKind, id: string): void;
  /** The player wants out (game HUD's leave button). */
  requestLeave(): void;
  /** A DOM layer above the canvas for the game's own HUD. Emptied on dispose. */
  hudRoot: HTMLElement;
  /** Nobody is playing: this runtime is being WATCHED, not driven.
   *
   *  Two things must change, and a game that gets either wrong will show a
   *  replay of something that did not happen:
   *
   *  1. Every input arrives through `onRemoteInput`, INCLUDING the focused
   *     runner's own. In live play a player's own inputs never arrive that way
   *     — they were applied at press time and the server does not relay them
   *     back to the sender — so a game may reasonably ignore them there. Here
   *     that would leave the watched player standing still while everyone else
   *     ran, which is exactly the kind of wrong that gets quoted as evidence.
   *
   *  2. NO player controls may be attached. A key press or a drag over the
   *     canvas must not be able to author an input nobody ever made. A replay
   *     the viewer can edit is not a replay.
   *
   *  Absent during live play, so a game that ignores it behaves exactly as
   *  before — it simply cannot be watched back faithfully. */
  spectator?: boolean;
  /** What the game should treat as "now", in the Date.now() domain.
   *
   *  Optional, and absent during live play — a game that ignores it and calls
   *  Date.now() itself is correct, it simply cannot be watched in slow motion.
   *  The admin console's replay studio supplies a clock it controls, which is
   *  how a recorded match plays at a quarter speed, or eight times, or stops.
   *
   *  Bind it ONCE (`this.now = ctx.now ?? Date.now`) rather than checking on
   *  every frame; it is then one indirect call V8 inlines away. */
  now?: () => number;
}

export interface GameRuntime {
  /** Build the scene and warm what can be warmed. Resolves when a first frame
   *  can be drawn without a stall — the platform answers `match:ready` then. */
  prepare(): Promise<void>;
  /** Tick 0 lands on this LOCAL clock time (Date.now domain, already
   *  converted from the server's). May be in the past when resuming. */
  go(localStartAt: number): void;
  onRemoteInput(input: MatchInputRelay): void;
  /** Inputs that happened before this client joined (resume). */
  seedInputs(inputs: MatchInputRelay[]): void;
  onLeft(uid: string): void;
  /** Someone in this match sent a quick message. */
  onQuick?(uid: string, kind: QuickKind, id: string): void;
  /** The match is over: freeze the world (the platform shows the results). */
  end(result: MatchEnd): void;
  /** How this game words the top of the results card. The platform draws the
   *  table and knows placements; it does NOT know that "everyone's out" means
   *  nothing on a board, or that a runner's "last one running" is a board
   *  game's "all four home". Return null to keep the platform's wording. */
  resultsHeadline?(result: MatchEnd, you: string): { headline: string; sub: string } | null;
  /** The one-line summary of a player's match, for their row in the table.
   *  Reads the game's own `detail` keys, which only the game knows. */
  describeStanding?(standing: Standing): string;
  /** One frame. Installed as the engine's render loop by the platform. */
  render(): void;
  dispose(): void;
}

export interface GameModule {
  createRuntime(ctx: GameRuntimeContext): GameRuntime | Promise<GameRuntime>;
}
