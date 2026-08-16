// The contract between the platform and a game's client module.
//
// A game is a folder under frontend/src/games/<id>/ exporting `createRuntime`.
// The platform owns everything around it — picking, downloading, the match
// lifecycle, clock sync, voice, results — and hands the game exactly what it
// needs to draw and to speak: the engine, the roster, the seed, its own pack,
// and one function to send an input. Nothing else crosses the line, so a
// change inside a game can't reach another game or the lobby.
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { MatchEnd, MatchInput, MatchInputRelay, QuickKind, RosterEntry } from "../shared/core/protocol";

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
  /** One frame. Installed as the engine's render loop by the platform. */
  render(): void;
  dispose(): void;
}

export interface GameModule {
  createRuntime(ctx: GameRuntimeContext): GameRuntime | Promise<GameRuntime>;
}
