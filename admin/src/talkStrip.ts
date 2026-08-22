// When was anybody talking?
//
// A density strip under the timeline: the recording cut into equal slices,
// each drawn by HOW MUCH of it was speech. Both studios use it, so a party and
// a match read the same way.
//
// FORM. The question is "when, and how much" across a fixed span of time, so
// this is magnitude over time and the marks are bars on the studio's own
// x-axis — the same axis as the scrubber and the playhead, which is the whole
// point: a strip that does not line up with the timeline above it is worse
// than no strip. Not a line: speech is bursts, not a continuous quantity, and
// joining the bursts would draw talking where there was silence.
//
// GEOMETRY. Bars are POSITIONED, not flowed. The first version laid them out
// with flex and a gap, which drew a row of identical little boxes straight
// across a recording where nobody had said anything — 72 empty marks reading
// as data when the honest answer was "nothing was said". Percent offsets are
// also how the lanes above are drawn, so the two cannot drift apart.
//
// COLOUR. One series, so one hue, light→dark by magnitude — the green that
// already means "voice" everywhere else in these studios, so it needs no
// legend. Three steps, monotonic in lightness, each checked to clear 3:1
// against the console's panel rather than eyeballed. Crimson is deliberately
// absent: it belongs to the playhead, and a strip that shouts competes with
// the one mark that has to be found instantly.
import { esc } from "./ui";

/** Slices across the width. Fine enough that a two-second remark shows up in
 *  an hour-long party, coarse enough that each mark is still a target. */
const BUCKETS = 72;

/** Sequential, light→dark, one hue: quiet → busy. */
const RAMP = ["#48956a", "#63b985", "#7dd3a0"];

export interface TalkStripData {
  label: string;
  spans: [number, number][];
}

/** The strip, as HTML. `endMs` is the studio's full length, so the marks land
 *  on the same axis as everything else on the tape. */
export function talkStrip(data: TalkStripData | null, endMs: number): string {
  const span = Math.max(1, endMs);
  const slice = span / BUCKETS;
  const filled = new Array<number>(BUCKETS).fill(0);
  let total = 0;
  for (const [a, b] of data?.spans ?? []) {
    const from = Math.max(0, Math.min(a, b));
    const to = Math.min(span, Math.max(a, b));
    if (to <= from) continue;
    total += to - from;
    const first = Math.floor(from / slice);
    const last = Math.min(BUCKETS - 1, Math.floor((to - 0.001) / slice));
    for (let i = first; i <= last; i++) {
      // How much of THIS slice was speech, so one long remark and a scatter of
      // short ones read differently instead of both being simply "on".
      filled[i] += Math.max(0, Math.min(to, (i + 1) * slice) - Math.max(from, i * slice));
    }
  }

  // NOTHING TO SHOW IS NOT THE SAME AS SILENCE, and neither is worth 72 marks.
  // Say which it is in words — an empty chart that looks like a full one is
  // the worst thing this could do.
  if (total <= 0) {
    return `<div class="talk-strip">
      <span class="who">🎙 voice</span>
      <div class="tk-plot empty"><span class="tk-none">${
        data ? "nobody spoke in this recording" : "no voice was recorded"
      }</span></div>
    </div>`;
  }

  const marks = filled
    .map((ms, i) => {
      if (ms <= 0) return "";
      const share = Math.min(1, ms / slice); // 0…1 of this slice spent talking
      // Height and shade carry THE SAME number — how much of this slice was
      // speech. Doubling the encoding is deliberate: at a few pixels tall a
      // difference in height alone is not readable.
      //
      // Not normalised to the busiest slice, which is the tempting version and
      // a lie: it would draw a party where somebody muttered twice exactly
      // like one where they argued for an hour, because in both the busiest
      // slice becomes full height. A quiet recording should LOOK quiet.
      const step = share > 0.66 ? 2 : share > 0.33 ? 1 : 0;
      const height = Math.max(14, Math.round(share * 100));
      const at = Math.round(i * slice);
      return `<i class="tk" data-at="${at}"
        style="left:${((i / BUCKETS) * 100).toFixed(3)}%;width:${(100 / BUCKETS).toFixed(3)}%;height:${height}%;background:${RAMP[step]}"
        title="${esc(fmt(at))} · ${Math.round(share * 100)}% talking"></i>`;
    })
    .join("");

  return `<div class="talk-strip">
    <span class="who" title="Tick one microphone to follow just that person">🎙 ${esc(data?.label ?? "voice")}</span>
    <div class="tk-plot" role="img" aria-label="When ${esc(
      data?.label ?? "nobody"
    )} was talking across the recording — ${Math.round(total / 1000)} seconds in total">${marks}</div>
  </div>`;
}

const fmt = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
