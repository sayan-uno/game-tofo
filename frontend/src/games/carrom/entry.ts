// Carrom — client entry. The platform imports this lazily (its own chunk) and
// calls createRuntime once per match. Everything about the game lives under
// this folder; nothing outside it knows a striker from a queen, and nothing in
// here reaches the lobby, the runner, the board next door, or any game added
// after it.
import "./carrom.css";
import type { GameModule, GameRuntimeContext } from "../../platform/types";
import { parseInput } from "../../shared/games/carrom/index";
import { CarromRuntime } from "./runtime";

export const createRuntime: GameModule["createRuntime"] = (ctx: GameRuntimeContext) => new CarromRuntime(ctx);

/** ---------------------------------------------------------------------------
 *  What the replay studio is told. See GameModule for why these live here.
 *
 *  A carrom input is four numbers a watcher cannot read; every one of these
 *  turns them back into the thing a person did.
 * ------------------------------------------------------------------------- */

const pct = (n: number): string => `${Math.round(n / 10)}%`;
/** Where on the base line, in the words a player would use. */
const place = (t: number): string =>
  Math.abs(t) < 60 ? "centre" : `${Math.abs(Math.round(t / 10))}% ${t < 0 ? "left" : "right"}`;

export const describeInput: GameModule["describeInput"] = (kind) => {
  const p = parseInput(kind);
  if (!p) return null;
  switch (p.type) {
    case "shot":
      return `flick · ${pct(p.shot.p)} power · from ${place(p.shot.t)}`;
    case "ask":
      return `took the shot · ${pct(p.shot.p)} power`;
    case "aim":
      return `lining up · ${pct(p.shot.p)} power · from ${place(p.shot.t)}`;
    case "nudge":
      return "touched the board";
    case "quit":
      return "left the table";
    case "away":
      return p.gone ? "stopped answering" : "came back";
  }
};

/** Only a SHOT carries a weight worth drawing. An aim is a thought, and a tape
 *  of thoughts at full height would bury the shots they led to. */
export const inputWeight: GameModule["inputWeight"] = (kind) => {
  const p = parseInput(kind);
  return p && p.type === "shot" ? p.shot.p / 1000 : null;
};

export const summarise: GameModule["summarise"] = (inputs) => {
  const powers: number[] = [];
  let aims = 0;
  for (const i of inputs) {
    const p = parseInput(i.kind);
    if (!p) continue;
    if (p.type === "shot") powers.push(p.shot.p / 1000);
    else if (p.type === "aim") aims++;
  }
  if (powers.length === 0) return [];
  const sum = powers.reduce((a, b) => a + b, 0);
  const hard = powers.filter((v) => v >= 0.8).length;
  return [
    { label: "Shots", value: String(powers.length) },
    { label: "Avg power", value: `${Math.round((sum / powers.length) * 100)}%` },
    { label: "Softest", value: `${Math.round(Math.min(...powers) * 100)}%` },
    { label: "Hardest", value: `${Math.round(Math.max(...powers) * 100)}%` },
    // The number that says how somebody plays: a table full of these is a
    // basher, none of them is somebody placing every coin.
    { label: "Full-blooded", value: `${hard} of ${powers.length}` },
    { label: "Aim changes", value: String(aims) },
  ];
};
