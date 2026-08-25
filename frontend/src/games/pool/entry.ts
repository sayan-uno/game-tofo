// 8-Ball Pool — client entry. The platform imports this lazily (its own chunk)
// and calls createRuntime once per match. Everything about the game lives under
// this folder; nothing outside it knows a stripe from a solid, and nothing in
// here reaches the lobby, the runner, the other four games, or any game added
// after it.
import "./pool.css";
import type { GameModule, GameRuntimeContext } from "../../platform/types";
import { EIGHT, PER_GROUP, ballName, parseInput, remaining, replay, speedFor, teamOf } from "../../shared/games/pool/index";
import { PoolRuntime } from "./runtime";
import { weightWord } from "./theme";

export const createRuntime: GameModule["createRuntime"] = (ctx: GameRuntimeContext) => new PoolRuntime(ctx);

/** ---------------------------------------------------------------------------
 *  What the replay studio is told. See GameModule for why these live here.
 *
 *  A pool input is five integers and tells a watcher nothing at all on its own;
 *  every one of these turns it back into the thing a person did. The weight is
 *  the interesting one — see below.
 * ------------------------------------------------------------------------- */

export const describeInput: GameModule["describeInput"] = (kind) => {
  const p = parseInput(kind);
  if (!p) return null;
  switch (p.type) {
    case "shot":
      return `played the shot ${weightWord(p.shot.p)}`;
    case "ask":
      return `asked to shoot ${weightWord(p.shot.p)}`;
    case "aim":
      return `lining up ${weightWord(p.shot.p)}`;
    case "nudge":
      return "touched the table";
    case "quit":
      return "left the table";
    case "away":
      return p.gone ? "stopped answering" : "came back";
  }
};

/** How tall a mark on the tape is.
 *
 *  THE WEIGHT OF THE SHOT, which is the one thing about a pool match a tape can
 *  show that a list of moves cannot. A rack has a shape — the break at the top,
 *  a run of gentle pots through the middle, and a hard safety when somebody is
 *  snookered — and drawn this way that shape is visible at a glance without a
 *  single ball being rendered. Everything that is not a struck ball is a
 *  thought and gets no mark at all.
 *
 *  Scaled by the SPEED rather than the slider, for the reason above: a tape of
 *  slider positions would put a soft roll two thirds as tall as a break. */
export const inputWeight: GameModule["inputWeight"] = (kind) => {
  const p = parseInput(kind);
  if (!p || p.type !== "shot") return null;
  const v = speedFor(p.shot.p / 1000);
  const w = v / 5.4;
  return w < 0.12 ? 0.12 : w > 1 ? 1 : w;
};

/** What a watcher actually wants to know about a player of this game, and most
 *  of it cannot be read off their own inputs.
 *
 *  Which balls somebody potted, how long their best run was and how often they
 *  fouled are all properties of the TABLE, which both sides played on together
 *  — a shot's worth depends entirely on where fifteen balls were lying when it
 *  was struck. So the whole rack is replayed here from the match's own log and
 *  the numbers read off the table it produces. That is what `match` is for.
 *
 *  It is not free the way dots' eighty-four integers were: this is a physics
 *  replay of a few dozen shots. Measured on this machine it is a handful of
 *  milliseconds, it happens once when a row is opened rather than per frame,
 *  and the alternative — the server shipping a second copy of the numbers — is
 *  a second thing that can disagree with the table. */
export const summarise: GameModule["summarise"] = (mine, match) => {
  let asks = 0;
  let hardest = 0;
  for (const i of mine) {
    const p = parseInput(i.kind);
    if (!p) continue;
    if (p.type === "ask") asks++;
    if ((p.type === "ask" || p.type === "shot") && p.shot.p > hardest) hardest = p.shot.p;
  }
  if (!match) return asks > 0 ? [{ label: "Shots asked", value: String(asks) }] : [];
  const s = replay(
    match.seed,
    match.players,
    match.all.map((i) => ({ tick: i.tick, seat: i.seat, kind: i.kind })),
    match.durationTicks,
    match.durationTicks
  );
  const seat = match.seat;
  if (seat < 0 || seat >= s.players) return [];
  const team = teamOf(seat, s.players);
  const group = s.group[team];

  // The longest unbroken run of shots this seat took. A pool player's whole
  // ability is whether they can go again, and nothing else here says it.
  let best = 0;
  let run = 0;
  let last = -1;
  for (const i of match.all) {
    const p = parseInput(i.kind);
    if (!p || p.type !== "shot") continue;
    if (i.seat === seat) {
      run = last === seat ? run + 1 : 1;
      if (run > best) best = run;
    }
    last = i.seat;
  }

  const out = [
    { label: "Balls potted", value: String(s.potted[seat]) },
    { label: "Best run", value: best > 0 ? `${best} shot${best === 1 ? "" : "s"}` : "—" },
    { label: "Fouls", value: String(s.fouls[seat]) },
    {
      label: "Side left",
      value: group < 0 ? `${PER_GROUP} (open)` : String(remaining(s, group)),
    },
  ];
  // Only when it happened, because "the black: no" on every row of every table
  // is four wasted characters and one wasted question.
  if (s.finisher === seat) out.push({ label: "Finished on", value: ballName(EIGHT) });
  return out;
};
