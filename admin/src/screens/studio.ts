// Watching a match again.
//
// There is no video here and nothing was recorded in the ordinary sense. The
// studio loads the game's REAL client code — the same folder players run — and
// drives it from the input log the server archived. Everything on screen is
// re-simulated from the seed, which is why a few kilobytes is a whole match.
//
// The two mechanisms worth knowing:
//
//   THE CLOCK. A game reads `ctx.now()` instead of the wall clock, so the
//   studio can hand it a clock it controls. Speed is a multiplier on how fast
//   that clock advances; pause simply stops advancing it.
//
//   THE SCRUBBER. Seeking is not rewinding — it is the RECONNECT path. Throw
//   the runtime away, build a new one, feed it every input up to the target
//   tick at once, and start its clock in the past so that tick is the present.
//   A player's phone that drops mid-match already does exactly this, which is
//   why the timeline needed no new game code at all.
import { ApiFailure, call } from "../api";
import { ask } from "../modal";
import { withSudo } from "../sudo";
import { duration, esc, num, pill, table, toast, when } from "../ui";
import type { GameRuntime, GameRuntimeContext, GameModule } from "@game/platform/types";

interface ReplayRoster {
  uid: string; seat: number; name: string; character: string; weapon: string | null;
  isBot: boolean; userId: string | null; left: boolean; leftAtTick: number | null;
}
interface ReplayFile {
  v: number; matchKey: string; gameId: string; seed: number; tickRate: number; durationTicks: number;
  createdAt: number; startAt: number | null; endedAt: number; reason: string; endTick: number;
  roster: ReplayRoster[]; kinds: string[];
  inputs: { seat: number[]; tick: number[]; kind: number[] };
  quick: { tick: number[]; seat: number[]; kind: number[]; id: string[] };
  standings: { uid: string; name: string; placement: number; score: number; detail: Record<string, number>; forfeit: boolean }[];
  xp: Record<string, number>;
}
interface GameMeta {
  id: string; name: string; tagline: string; durationSec: number;
  packVersion: string; packBytes: number; packUrl: string | null;
}
interface Answer {
  replay: ReplayFile;
  game: GameMeta | null;
  /** The character/weapon/emote catalog. Not part of a game's pack — the
   *  player client fills this in at sign-in, and without it every runner is a
   *  name plate with nobody under it. */
  catalog: unknown;
  cdnBase: string | null;
  stored: { tier: string; bytes: number; expiresAt: string | null; createdAt: string };
}

/** A fixed base for the virtual clock. Any constant works — what matters is
 *  that the runtime's "now" and its start time come from the same one. */
const T0 = 1_600_000_000_000;
/** Inputs are handed over slightly before their tick, the way the live server
 *  releases a bot's, so a sim never has to rewind to apply one. */
const LEAD_TICKS = 20;
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];

/** In development the CDN refuses this origin, so pack files are fetched
 *  through the dev server instead. In production the console's origin has to be
 *  on the bucket's CORS allowlist and this does nothing. */
function throughProxy(url: string | null): string | null {
  if (!url) return url;
  const prefix = import.meta.env.VITE_CDN_PROXY_PREFIX as string | undefined;
  if (!prefix) return url;
  try {
    return prefix + new URL(url).pathname;
  } catch {
    return url;
  }
}

/** The catalog is full of absolute CDN links — the character models, the
 *  weapons, the emote clips — and the same CORS policy refuses every one of
 *  them. Rewritten wholesale rather than field by field, because the catalog
 *  is a shape this screen has no business knowing. Does nothing in production,
 *  where the console's own origin is on the allowlist instead. */
function catalogThroughProxy(catalog: unknown, cdnBase: string | null): unknown {
  const prefix = import.meta.env.VITE_CDN_PROXY_PREFIX as string | undefined;
  if (!prefix || !cdnBase || !catalog) return catalog;
  return JSON.parse(JSON.stringify(catalog).split(cdnBase).join(prefix));
}

export function mountStudio(host: HTMLElement, matchKey: string, go: (h: string) => void): () => void {
  let stopped = false;
  let raf = 0;
  let runtime: GameRuntime | null = null;
  let engineHandle: { dispose(): void } | null = null;
  let releaseKeys: (() => void) | null = null;

  const cleanup = () => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    releaseKeys?.();
    releaseKeys = null;
    try {
      runtime?.dispose();
    } catch {
      /* a half-built runtime is still worth throwing away */
    }
    runtime = null;
    engineHandle?.dispose();
    engineHandle = null;
  };

  host.innerHTML = `<div class="card"><p class="empty">Loading the replay…</p></div>`;

  void (async () => {
    let data: Answer;
    try {
      data = await call<Answer>(`/replays/${encodeURIComponent(matchKey)}`);
    } catch (e) {
      const why = e instanceof ApiFailure ? e.info.error : "Could not load that replay";
      host.innerHTML = `<div class="card"><p class="empty">${esc(why)}</p></div>`;
      return;
    }
    if (stopped) return;

    const file = data.replay;
    const rate = file.tickRate;
    const endTick = Math.max(1, file.endTick);
    const endMs = (endTick * 1000) / rate;
    const roster = [...file.roster].sort((a, b) => a.seat - b.seat);
    const seatOf = new Map(roster.map((r) => [r.seat, r]));

    // The input log, flattened and put in tick order — which is the order a
    // viewer watching from the start would have seen them in.
    const flat = file.inputs.tick
      .map((tick, i) => ({
        tick,
        uid: seatOf.get(file.inputs.seat[i])?.uid ?? "",
        seat: file.inputs.seat[i],
        kind: file.kinds[file.inputs.kind[i]],
      }))
      .sort((a, b) => a.tick - b.tick);
    const quick = file.quick.tick
      .map((tick, i) => ({
        tick,
        uid: seatOf.get(file.quick.seat[i])?.uid ?? "",
        seat: file.quick.seat[i],
        kind: file.quick.kind[i] === 0 ? ("chat" as const) : ("emote" as const),
        id: file.quick.id[i],
      }))
      .sort((a, b) => a.tick - b.tick);

    // ---- chrome ----------------------------------------------------------
    host.innerHTML = shell(file, data, roster);
    const stage = host.querySelector<HTMLElement>("#stage")!;
    const canvas = host.querySelector<HTMLCanvasElement>("#studio-canvas")!;
    const hudRoot = host.querySelector<HTMLElement>("#studio-hud")!;
    const status = host.querySelector<HTMLElement>("#status")!;
    const scrub = host.querySelector<HTMLInputElement>("#scrub")!;
    const playBtn = host.querySelector<HTMLButtonElement>("#play")!;
    const clock = host.querySelector<HTMLElement>("#clock")!;
    const feed = host.querySelector<HTMLElement>("#feed")!;
    scrub.max = String(endTick);

    // ---- the virtual clock ----------------------------------------------
    let vTime = 0;
    let playing = false;
    let speed = 1;
    let lastReal = performance.now();
    let cursor = 0;
    let quickCursor = 0;
    let focus = roster.find((r) => !r.isBot)?.uid ?? roster[0]?.uid ?? "";
    let seeking = false;

    const now = () => T0 + vTime;
    const tickNow = () => Math.max(0, Math.min(endTick, Math.floor((vTime * rate) / 1000)));

    // ---- load the game ---------------------------------------------------
    if (!data.game) {
      status.textContent = `This console build cannot run "${file.gameId}".`;
      return;
    }
    let pack: { assets: GameRuntimeContext["assets"]; module: GameModule };
    let babylon: GameRuntimeContext["engine"];
    try {
      status.textContent = data.game.packBytes > 0 ? "Downloading the game's files…" : "Loading the game…";
      const [{ loadPack }, { createEngine }, { setCatalog }] = await Promise.all([
        import("@game/platform/packLoader"),
        import("@game/game/engine"),
        import("@game/game/assets"),
      ]);
      // Before anything builds a runner: the rigs are resolved through this.
      if (data.catalog) setCatalog(catalogThroughProxy(data.catalog, data.cdnBase) as never);
      const info = { ...data.game, packUrl: throughProxy(data.game.packUrl) } as never;
      pack = await loadPack(info, { onProgress: (pct) => (status.textContent = `Downloading… ${pct}%`) });
      if (stopped) return;
      const engine = createEngine(canvas);
      engineHandle = engine;
      babylon = engine;
      // NOTE: the engine's own render loop is deliberately NOT started. The
      // studio drives render() from its single frame loop instead — see
      // frame() for why that ordering is not optional.
    } catch (e) {
      status.textContent =
        e instanceof Error && /CORS|fetch|network/i.test(e.message)
          ? "Could not fetch the game's files. In development the console proxies the CDN; in production its origin must be on the bucket's CORS allowlist."
          : `Could not load the game: ${e instanceof Error ? e.message : "unknown error"}`;
      return;
    }

    const context = (): GameRuntimeContext => ({
      engine: babylon,
      canvas,
      assets: pack.assets,
      roster: roster.map((r) => ({ uid: r.uid, name: r.name, character: r.character, weapon: r.weapon })),
      you: focus,
      seed: file.seed,
      rules: { tickRate: rate, durationTicks: file.durationTicks },
      // Nobody is playing. These exist because the contract has them.
      sendInput: () => undefined,
      sendQuick: () => undefined,
      requestLeave: () => undefined,
      hudRoot,
      now,
      // Nobody is playing. This is what stops the watched runner's own inputs
      // being discarded as duplicates, and stops the viewer's keyboard from
      // authoring inputs that never happened. See GameRuntimeContext.
      spectator: true,
    });

    /** THE seek. Not a rewind — the reconnect path, run against a clock that
     *  is allowed to start in the past. */
    async function seek(target: number): Promise<void> {
      if (seeking) return;
      seeking = true;
      try {
        runtime?.dispose();
      } catch {
        /* ignore */
      }
      hudRoot.replaceChildren();
      vTime = (Math.max(0, Math.min(endTick, target)) * 1000) / rate;
      const at = tickNow();
      const next = await pack.module.createRuntime(context());
      if (stopped) return;
      runtime = next;
      await next.prepare();
      const before = flat.filter((i) => i.tick <= at);
      next.seedInputs(before.map((i) => ({ uid: i.uid, tick: i.tick, kind: i.kind })));
      cursor = before.length;
      quickCursor = quick.findIndex((q) => q.tick > at);
      if (quickCursor < 0) quickCursor = quick.length;
      for (const r of roster) {
        if (r.left && r.leftAtTick !== null && r.leftAtTick <= at) next.onLeft(r.uid);
      }
      next.go(T0);
      seeking = false;
      status.textContent = "";
      drawFeed();
    }

    function deliverDue(): void {
      if (!runtime) return;
      const horizon = tickNow() + LEAD_TICKS;
      while (cursor < flat.length && flat[cursor].tick <= horizon) {
        const i = flat[cursor++];
        runtime.onRemoteInput({ uid: i.uid, tick: i.tick, kind: i.kind });
      }
      const at = tickNow();
      while (quickCursor < quick.length && quick[quickCursor].tick <= at) {
        const q = quick[quickCursor++];
        runtime.onQuick?.(q.uid, q.kind, q.id);
        drawFeed();
      }
      for (const r of roster) {
        if (r.left && r.leftAtTick !== null && r.leftAtTick === at) runtime.onLeft(r.uid);
      }
    }

    function drawFeed(): void {
      const said = quick.slice(0, quickCursor).slice(-8).reverse();
      feed.innerHTML = said.length
        ? said
            .map(
              (q) =>
                `<div class="said"><span class="at">${fmtTick(q.tick, rate)}</span> <b>${esc(
                  seatOf.get(q.seat)?.name ?? "?"
                )}</b> ${esc(q.id)}</div>`
            )
            .join("")
        : `<p class="empty" style="padding:10px">Nothing said yet.</p>`;
    }

    function chrome(): void {
      const at = tickNow();
      if (!scrub.matches(":active")) scrub.value = String(at);
      clock.textContent = `${fmtTick(at, rate)} / ${fmtTick(endTick, rate)}`;
      playBtn.textContent = playing ? "❚❚" : "▶";
      playBtn.title = playing ? "Pause" : "Play";
      // A fraction, not a percentage: the stylesheet knows how much width the
      // name column and the padding take, and this does not have to.
      host.querySelectorAll<HTMLElement>("[data-tickmark]").forEach((el) => {
        el.style.setProperty("--p", String(at / endTick));
      });
    }

    /** ONE loop, and the order inside it is the whole correctness argument.
     *
     *  Advance the clock, hand over every input the new time has reached, and
     *  only THEN let the game draw — because drawing is when a game steps its
     *  simulation to the current tick. Run those on two independent loops (the
     *  studio's and the engine's, which is how this was first written) and
     *  their order is undefined: on a slow frame the simulation steps past a
     *  tick before that tick's input has been handed over, the input is lost,
     *  and the runner crashes in the replay having not crashed in reality.
     *
     *  It showed up as a replay that scored 255 where the server recorded
     *  4155 — and only sometimes, which is the worst way for it to show up. */
    function frame(): void {
      if (stopped) return;
      const real = performance.now();
      if (playing && !seeking) {
        vTime = Math.min(endMs, vTime + (real - lastReal) * speed);
        if (vTime >= endMs) playing = false;
      }
      lastReal = real;
      deliverDue();
      // Draw last. Never before deliverDue.
      if (!seeking) {
        try {
          runtime?.render();
        } catch (err) {
          console.error("[studio] render failed", err);
        }
      }
      chrome();
      raf = requestAnimationFrame(frame);
    }

    // ---- controls --------------------------------------------------------
    playBtn.onclick = () => {
      if (tickNow() >= endTick) void seek(0);
      playing = !playing;
      lastReal = performance.now();
    };
    scrub.oninput = () => {
      playing = false;
      void seek(Number(scrub.value));
    };
    host.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((b) => {
      b.onclick = () => {
        speed = Number(b.dataset.speed);
        host.querySelectorAll<HTMLElement>("[data-speed]").forEach((x) => x.classList.toggle("on", x === b));
      };
    });
    host.querySelectorAll<HTMLElement>("[data-focus]").forEach((b) => {
      b.onclick = () => {
        focus = b.dataset.focus!;
        host.querySelectorAll<HTMLElement>("[data-focus]").forEach((x) => x.classList.toggle("on", x === b));
        void seek(tickNow());
      };
    });
    host.querySelector<HTMLButtonElement>("#hold")!.onclick = () => void holdReplay(matchKey, data.stored.tier);
    host.querySelector<HTMLButtonElement>("#back")!.onclick = () => go("#/matches");

    // Space to play, arrows to nudge — the keys anybody expects on a player.
    const keys = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "Space") {
        e.preventDefault();
        playBtn.click();
      }
      if (e.key === "ArrowRight") void seek(tickNow() + rate * 5);
      if (e.key === "ArrowLeft") void seek(Math.max(0, tickNow() - rate * 5));
    };
    document.addEventListener("keydown", keys);
    releaseKeys = () => document.removeEventListener("keydown", keys);

    status.textContent = "Building the first frame…";
    await seek(0);
    if (stopped) return;
    stage.classList.add("ready");
    raf = requestAnimationFrame(frame);
  })();

  return cleanup;
}

async function holdReplay(matchKey: string, tier: string): Promise<void> {
  const keeping = tier !== "hold";
  const answer = await ask({
    title: keeping ? "Keep this replay?" : "Release this replay?",
    intro: keeping
      ? "Retention will never sweep it. Use this before opening a case on it."
      : "It goes back to the ordinary 30-day retention.",
    confirm: keeping ? "Keep it" : "Release it",
    fields: [{ name: "reason", label: "Why (optional)", placeholder: "e.g. reported for cheating" }],
    async onSubmit(v) {
      try {
        const done = await withSudo(() =>
          call(`/replays/${encodeURIComponent(matchKey)}/hold`, {
            method: "POST",
            body: JSON.stringify({ hold: keeping, reason: v.reason }),
          })
        );
        return done === null ? "Cancelled." : null;
      } catch (e) {
        return e instanceof ApiFailure ? e.info.error : "That did not work";
      }
    },
  });
  if (answer) toast(keeping ? "Kept — retention will not sweep it." : "Released back to normal retention.");
}

const fmtTick = (tick: number, rate: number): string => {
  const s = Math.floor(tick / rate);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function shell(file: ReplayFile, data: Answer, roster: ReplayRoster[]): string {
  const place = new Map(file.standings.map((s) => [s.uid, s]));
  const tape = roster
    .map((r) => {
      const marks = file.inputs.tick
        .map((t, i) => (file.inputs.seat[i] === r.seat ? t : -1))
        .filter((t) => t >= 0)
        .map((t) => `<i style="left:${((t / Math.max(1, file.endTick)) * 100).toFixed(3)}%"></i>`)
        .join("");
      return `<div class="lane"><span class="who">${esc(r.name)}</span><div class="marks">${marks}</div></div>`;
    })
    .join("");

  return `
    <div class="studio">
      <div class="stage" id="stage">
        <canvas id="studio-canvas"></canvas>
        <div id="studio-hud" class="hud"></div>
        <div class="status" id="status"></div>
      </div>

      <div class="bar">
        <button class="btn" id="play" title="Play">▶</button>
        <span class="clock" id="clock">0:00</span>
        <input type="range" id="scrub" min="0" value="0" step="1" />
        <span class="speeds">${SPEEDS.map(
          (s) => `<button data-speed="${s}" class="${s === 1 ? "on" : ""}">${s}×</button>`
        ).join("")}</span>
      </div>

      <div class="tape">${tape}<div class="playhead" data-tickmark></div></div>

      <div class="grid2" style="margin-top:18px">
        <div>
          <div class="card">
            <header><h2>At the table</h2><span class="spacer"></span><span class="count">${roster.length}</span></header>
            ${table(
              ["Player", "Place", "Score", "Focus"].map((h) => `<th>${h}</th>`),
              roster.map((r) => {
                const st = place.get(r.uid);
                return `<tr>
                  <td><strong>${esc(r.name)}</strong> ${r.isBot ? pill("bot") : ""} ${r.left ? pill("left", "warn") : ""}</td>
                  <td class="mono">${st ? (st.placement === 1 ? "<strong>1st</strong>" : st.placement) : "—"}</td>
                  <td class="mono">${num(st?.score)}</td>
                  <td><button class="btn ghost" data-focus="${esc(r.uid)}">Watch</button></td>
                </tr>`;
              }),
              "Nobody was at this table."
            )}
          </div>
          <div class="card">
            <header><h2>Said during the match</h2><span class="spacer"></span><span class="count">${file.quick.id.length}</span></header>
            <div id="feed" class="feed"></div>
          </div>
        </div>
        <div>
          <div class="card">
            <header><h2>The match</h2></header>
            <div class="pad"><dl class="kv">
              <dt>Game</dt><dd>${esc(data.game?.name ?? file.gameId)}</dd>
              <dt>Match</dt><dd class="mono">${esc(file.matchKey)}</dd>
              <dt>Played</dt><dd>${when(new Date(file.endedAt).toISOString())}</dd>
              <dt>Lasted</dt><dd class="mono">${duration(Math.round(file.endTick / file.tickRate))}</dd>
              <dt>Ended</dt><dd>${esc(file.reason)}</dd>
              <dt>Seed</dt><dd class="mono">${file.seed}</dd>
              <dt>Inputs</dt><dd class="mono">${num(file.inputs.tick.length)}</dd>
              <dt>Archive</dt><dd class="mono">${num(data.stored.bytes)} bytes · ${esc(data.stored.tier)}</dd>
              <dt>Kept until</dt><dd>${data.stored.expiresAt ? when(data.stored.expiresAt) : "kept indefinitely"}</dd>
            </dl></div>
            <div class="actions">
              <button class="btn ghost" id="hold">${data.stored.tier === "hold" ? "Release" : "Keep this replay"}</button>
              <button class="btn ghost" id="back">All matches</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}
