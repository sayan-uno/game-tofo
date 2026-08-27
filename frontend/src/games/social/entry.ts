// Social Space — client entry. The platform imports this lazily (its own
// chunk) and calls createRuntime once per island. Everything about the place
// lives under this folder.
import "./social.css";
import type { GameModule, GameRuntimeContext } from "../../platform/types";
import { SocialRuntime } from "./runtime";
import { readTrack, surfaceAt, TICK_RATE, TRACK_LEFT } from "../../shared/games/social/index";

export const createRuntime: GameModule["createRuntime"] = (ctx: GameRuntimeContext) => new SocialRuntime(ctx);

// ---------------------------------------------------------------------------
// What a WATCHER can be told about the track
//
// A match's tape is a row of things somebody DID. An island's is a row of
// where somebody WAS, which sounds less useful and is not: the question asked
// of a social space is almost always "where was this player and who were they
// standing with", and a tape of positions answers it directly. The three hooks
// below are the same three every other game declares — nothing in the studio
// knows this game has no inputs.
// ---------------------------------------------------------------------------

const WHERE = (p: { x: number; z: number }): string => `${Math.round(p.x)}, ${Math.round(p.z)}`;
const DOING = ["standing", "walking", "running"];

export const describeInput: GameModule["describeInput"] = (kind: string) => {
  if (kind === TRACK_LEFT) return "left the island";
  const pose = readTrack(kind);
  if (!pose) return null;
  return `${DOING[pose.anim] ?? "?"} · ${WHERE(pose)} · ${surfaceAt(pose.x, pose.z)}`;
};

/** How much EFFORT the mark carries — which for a walk is simply how fast.
 *  Drawn as the mark's height, so a whole session's tape shows at a glance
 *  when somebody was running about and when they stood in one place, without
 *  a single frame being rendered. */
export const inputWeight: GameModule["inputWeight"] = (kind: string) => {
  if (kind === TRACK_LEFT) return 1;
  const pose = readTrack(kind);
  if (!pose) return null;
  return pose.anim === 2 ? 1 : pose.anim === 1 ? 0.45 : 0.12;
};

/** Numbers worth printing beside a player. All of them come from their own
 *  track, so this needs nothing about anybody else. */
export const summarise: GameModule["summarise"] = (inputs) => {
  let metres = 0;
  let running = 0;
  let samples = 0;
  let first = -1;
  let last = -1;
  let prev: { x: number; z: number } | null = null;
  for (const i of inputs) {
    if (i.kind === TRACK_LEFT) continue;
    const pose = readTrack(i.kind);
    if (!pose) continue;
    samples++;
    if (first < 0) first = i.tick;
    last = i.tick;
    if (prev) {
      const d = Math.hypot(pose.x - prev.x, pose.z - prev.z);
      // A jump larger than anybody can walk in a sample is a gap in the track
      // — somebody left and came back — not a distance they covered.
      if (d < 12) metres += d;
    }
    if (pose.anim === 2) running++;
    prev = pose;
  }
  const minutes = first < 0 ? 0 : Math.max(0, Math.round((last - first) / (TICK_RATE * 60)));
  return [
    { label: "here", value: `${minutes} min` },
    { label: "walked", value: `${Math.round(metres)} m` },
    { label: "running", value: samples ? `${Math.round((running / samples) * 100)}%` : "—" },
  ];
};

/** This world's voice room is a PLACE: you hear the people near you, and the
 *  audio of anybody further off is not subscribed to at all. The platform
 *  reads this when it joins the room — see voice/livekit.ts. */
export const voice = "proximity";
