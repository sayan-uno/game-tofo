// Dots & Boxes — client entry. The platform imports this lazily (its own chunk)
// and calls createRuntime once per match. Everything about the game lives under
// this folder; nothing outside it knows a chain from a box, and nothing in here
// reaches the lobby, the runner, the other three boards, or any game added
// after it.
import "./dots.css";
import type { GameModule, GameRuntimeContext } from "../../platform/types";
import { lineName, parseInput, replay } from "../../shared/games/dots/index";
import { DotsRuntime } from "./runtime";

export const createRuntime: GameModule["createRuntime"] = (ctx: GameRuntimeContext) => new DotsRuntime(ctx);

/** ---------------------------------------------------------------------------
 *  What the replay studio is told. See GameModule for why these live here.
 *
 *  A dots input is a bare number, which tells a watcher nothing at all; every
 *  one of these turns it back into the thing a person did.
 * ------------------------------------------------------------------------- */

export const describeInput: GameModule["describeInput"] = (kind) => {
  const p = parseInput(kind);
  if (!p) return null;
  switch (p.type) {
    case "draw":
      return `drew the line ${lineName(p.line)}`;
    case "ask":
      return `chose the line ${lineName(p.line)}`;
    case "hover":
      return `looking at ${lineName(p.line)}`;
    case "nudge":
      return "touched the grid";
    case "quit":
      return "left the table";
    case "away":
      return p.gone ? "stopped answering" : "came back";
  }
};

/** A move is a move: they all cost the same and there is no such thing as a
 *  harder one, so every drawn line is full height and everything else is a
 *  thought. What the tape shows here is RHYTHM — a run of marks close together
 *  is somebody eating a chain, and that is the shape of the whole game. */
export const inputWeight: GameModule["inputWeight"] = (kind) => {
  const p = parseInput(kind);
  return p && p.type === "draw" ? 1 : null;
};

/** What a watcher actually wants to know about a player of this game, and none
 *  of it can be read off their own moves.
 *
 *  How many boxes somebody ended up with, how long their best run was and how
 *  often they had to hand one over are all properties of the GRID, which every
 *  seat played on together. So the whole match is replayed here — eighty-four
 *  integers, well under a millisecond — and the numbers read off the board it
 *  produces. That is what `match` is for. */
export const summarise: GameModule["summarise"] = (mine, match) => {
  let asks = 0;
  for (const i of mine) if (parseInput(i.kind)?.type === "ask") asks++;
  if (!match) return asks > 0 ? [{ label: "Moves", value: String(asks) }] : [];
  const s = replay(
    match.seed,
    match.players,
    match.all.map((i) => ({ tick: i.tick, seat: i.seat, kind: i.kind })),
    match.durationTicks,
    match.durationTicks
  );
  const seat = match.seat;
  if (seat < 0 || seat >= s.players) return [];
  // Four numbers, and no fifth. The obvious candidate was how often somebody
  // changed their mind before moving — the difference between their hovers and
  // their lines — and it had to go: a bot hovers exactly twice a turn by
  // construction, so the column read "changed mind nineteen times" for a player
  // who had never hesitated in its life. A number that means two different
  // things for two rows of the same table is worse than no number.
  return [
    { label: "Boxes", value: String(s.score[seat]) },
    { label: "Lines", value: String(s.moves[seat]) },
    { label: "Best run", value: String(s.best[seat]) },
    // The one that says how WELL somebody played: every line that leaves a box
    // on three sides is a box handed to whoever moves next.
    { label: "Given away", value: String(s.gifts[seat]) },
  ];
};
