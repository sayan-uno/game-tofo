// What a lobby name plate says — the one rule a squad reads at a glance.
//
//   npm run check:lobbyui
//
// Small, but worth pinning: the tick answers "who are we waiting for", and it
// only answers it if it never appears on somebody who was never asked.
import { plateText } from "../../frontend/src/game/plate.js";

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) fails++;
};

console.log("\nthe name on a plate");
ok(plateText("Ana", false, false) === "Ana", "a member who has not readied up is just their name");
ok(plateText("Ana", false, true) === "✓ Ana", "a tick goes BESIDE the name, in front of it");
ok(plateText("Ana", true, false) === "Ana ★", "the leader keeps their star");

console.log("\nand what it never says");
// The leader is not asked — pressing START is how they say it — so a tick on
// their plate claims an agreement nobody sought, and makes the one question
// the tick exists to answer unreadable.
ok(plateText("Ana", true, true) === "Ana ★", "the leader is never ticked, even if a stale ready-up says so");
ok(!plateText("Ana", true, true).includes("✓"), "so a squad can read the ticks as exactly the people being waited on");

// ---------------------------------------------------------------------------
// The studios' frame contract
//
// A structural check, deliberately, because the bug it guards was invisible by
// construction and cost three separate-looking symptoms.
//
// Babylon measures the time between frames inside engine.beginFrame(). The
// game never calls it by hand — engine.runRenderLoop does — but both admin
// studios drive their own clock so they can scrub, and a scene.render() on its
// own leaves getDeltaTime() reporting ZERO for ever. Three things read that
// number: the walk to a new pedestal slot (nobody ever moves), particle
// systems (a legendary aura that never advances is one you cannot see), and
// every skeletal animation — floored at Scene.MinDeltaTime, one millisecond,
// so emotes crawl at a sixteenth speed.
//
// None of that throws, nothing logs, and a screenshot still looks like a
// lobby. Somebody tidying the render call would put it all back without a
// single test going red, so the pairing is asserted here.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";

console.log("\nthe studios drive their own frames");
for (const [name, file] of [
  ["the party studio", "admin/src/screens/party.ts"],
  ["the match studio", "admin/src/screens/studio.ts"],
] as const) {
  const src = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
  ok(/beginFrame\(\)/.test(src) && /endFrame\(\)/.test(src),
     `${name} opens and closes the engine frame around its render`);
}

// ---------------------------------------------------------------------------
// The voice line
//
// Tested here rather than in the browser because the browser has no voice to
// test WITH: recording needs a flagged player, a live LiveKit room and the
// recorder bot, none of which a console test stands up. The maths is a pure
// function, so it can be asked directly — and the maths is where this went
// wrong the first time.
// ---------------------------------------------------------------------------
import { talkStrip } from "../../admin/src/talkStrip.js";

const marks = (html: string) => (html.match(/class="tk"/g) ?? []).length;

console.log("\nthe voice line");
{
  const nothing = talkStrip(null, 60_000);
  ok(marks(nothing) === 0, "no recording draws no marks at all");
  ok(nothing.includes("no voice was recorded"), "and says so in words");

  // THE BUG THIS EXISTS FOR. An empty chart that looks like a full one is the
  // worst thing a chart can do, and the first version drew an identical mark
  // in every slot of a recording where nobody had said anything.
  const silent = talkStrip({ label: "everyone", spans: [] }, 60_000);
  ok(marks(silent) === 0, "a recording nobody spoke in draws no marks either");
  ok(silent.includes("nobody spoke"), "and says which of the two it is");

  // One ten-second remark in a minute: marks over that stretch and nowhere
  // else. Seventy-two slices of sixty seconds is one slice per 833ms.
  const one = talkStrip({ label: "Ana", spans: [[0, 10_000]] }, 60_000);
  const n = marks(one);
  ok(n > 0 && n <= 14, `ten seconds of a minute covers about a sixth of the line (${n} of 72)`);
  ok(one.includes("Ana"), "and the line is labelled with whose voice it is");

  // Density, not merely presence: a slice that is entirely speech must not
  // read the same as one with a word in it.
  const busy = talkStrip({ label: "x", spans: [[0, 60_000]] }, 60_000);
  ok(marks(busy) === 72, "a recording of solid talking fills the line");
  ok(busy.includes("#7dd3a0"), "at the top of the ramp");
  // …and a slice with only a word in it sits at the BOTTOM of the ramp. The
  // shade is how much of that slice was speech, not how it compares with the
  // busiest slice — normalising to the busiest would draw a party where
  // somebody muttered twice exactly like one where they argued for an hour.
  const murmur = talkStrip({ label: "x", spans: [[0, 150]] }, 60_000);
  ok(murmur.includes("#48956a"), "while a slice with a word in it sits at the bottom of the ramp");
  ok(!murmur.includes("#7dd3a0"), "and never reaches the top just for being the loudest thing there");

  // A span running past the end of the recording must not fall off the axis.
  const over = talkStrip({ label: "x", spans: [[50_000, 999_000]] }, 60_000);
  ok(marks(over) > 0 && marks(over) <= 72, "a span that overruns the recording is clamped to it");
}

console.log(fails === 0 ? "\nPLATE PROVEN" : `\n${fails} check(s) failed`);
process.exit(fails === 0 ? 0 : 1);
