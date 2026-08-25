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
import { loadStudioAudio } from "../studioAudio";
import { talkStrip } from "../talkStrip";
import type { VoiceFile } from "../studioAudio";
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
  /** What was said while this was played, if anyone at the table was flagged.
   *  Each file knows how far into the match it starts, which is what lets the
   *  studio lay it over the replay instead of beside it. */
  voice?: VoiceFile[];
  /** Microphones opened and closed during the match, in wall-clock ms.
   *  Separate from `voice` on purpose: that is what was HEARD, and only for
   *  players who were flagged; this is what was POSSIBLE to hear, for
   *  everybody. A mic opened in silence leaves no audio at all. */
  mics?: { at: number; uid: string | null; on: boolean }[];
  /** Which parties and which lone players were put together to make this
   *  match. Afterwards the roster is a flat list and cannot answer it. */
  madeFrom?: { from?: { party?: string | null; uids?: string[] }[]; bots?: number } | null;
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

let audioDeck: import("../studioAudio").StudioAudio | null = null;

export function mountStudio(host: HTMLElement, matchKey: string, go: (h: string) => void): () => void {
  let stopped = false;
  let raf = 0;
  let runtime: GameRuntime | null = null;
  let engineHandle: { dispose(): void; beginFrame(): void; endFrame(): void } | null = null;
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
    audioDeck?.dispose();
    audioDeck = null;
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
    const voice: VoiceFile[] = data.voice ?? [];
    const rate = file.tickRate;
    // WHERE THE MATCH STOPS, AND WHERE THE RECORDING DOES — two different
    // moments, and conflating them silently threw away the most interesting
    // part of the audio.
    //
    // The game ends on its last tick. The players do not: the scoreboard is up
    // for five seconds afterwards, everybody is still in the match's voice
    // room, and what is said over a scoreboard is exactly what somebody
    // listens to a match for. That audio was being recorded correctly and was
    // simply unreachable — the timeline ended at the final tick, so the
    // scrubber could not be dragged to it and playback stopped before it.
    //
    // The timeline runs to whichever ends later. Past the final tick the
    // picture holds on its last frame, which is right: the match is over and
    // the scoreboard is what was on screen.
    const endTick = Math.max(1, file.endTick);
    const matchEndMs = (endTick * 1000) / rate;
    const voiceEndMs = voice.reduce(
      (last, v) => Math.max(last, v.offsetMs + (v.durationSec ?? 0) * 1000),
      0
    );
    const endMs = Math.max(matchEndMs, voiceEndMs);
    /** The last position the scrubber may reach — the match's own end, or the
     *  end of what was recorded, whichever is later. */
    // Derived from the VOICE, not from endMs — converting the match's own end
    // back into ticks round-trips through floating point and can land a tick
    // past itself, which would put every match into a one-tick "results"
    // stretch that never happened.
    const endOfTape = Math.max(endTick, Math.ceil((voiceEndMs * rate) / 1000));
    const roster = [...file.roster].sort((a, b) => a.seat - b.seat);
    const seatOf = new Map(roster.map((r) => [r.seat, r]));

    // Mic events arrive as wall-clock moments; the studio thinks in ticks. The
    // match's own start time is the bridge, and it is in the replay file — so
    // a mic opening lands on the same timeline as the input that fired at the
    // same instant.
    const nameOfUid = new Map(roster.map((r) => [r.uid, r.name]));
    const matchStartedAt = file.startAt ?? file.createdAt;
    const micTicks = (data.mics ?? [])
      .map((m) => ({
        tick: Math.max(0, Math.round(((m.at - matchStartedAt) * rate) / 1000)),
        name: nameOfUid.get(m.uid ?? "") ?? m.uid ?? "?",
        on: m.on,
      }))
      .sort((a, b) => a.tick - b.tick);

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
    const nowline = host.querySelector<HTMLElement>("#nowline")!;
    const scrub = host.querySelector<HTMLInputElement>("#scrub")!;
    const playBtn = host.querySelector<HTMLButtonElement>("#play")!;
    const clock = host.querySelector<HTMLElement>("#clock")!;
    const afterChip = host.querySelector<HTMLElement>("#afterchip")!;
    const feed = host.querySelector<HTMLElement>("#feed")!;
    scrub.max = String(endOfTape);

    // ---- the sound -------------------------------------------------------
    // Fetched after the shell paints and never awaited by the render path: a
    // replay with no audio must still play, and audio that is slow to arrive
    // must not hold the picture back.
    const mixer = host.querySelector<HTMLElement>("#mixer");
    // Present from the start, saying there is no voice, so a match with none
    // cannot be mistaken for a line that failed to load.
    host.querySelector<HTMLElement>("#talk")!.innerHTML = talkStrip(null, endMs);
    if (voice.length > 0 && mixer) {
      void loadStudioAudio(voice, mixer).then((deck) => {
        if (stopped || !deck) {
          deck?.dispose();
          if (mixer) mixer.innerHTML = `<p class="muted" style="font-size:12.5px">The recordings for this match could not be loaded.</p>`;
          return;
        }
        audioDeck = deck;
        const strip = host.querySelector<HTMLElement>("#talk")!;
        const drawStrip = () => {
          strip.innerHTML = talkStrip(deck.timeline(), endMs);
          // Click the picture, go to the moment — the same gesture as in the
          // party studio, because it is the same picture. On the plot rather
          // than the marks, so the quiet stretch beside a burst is aimable at.
          const plot = strip.querySelector<HTMLElement>(".tk-plot:not(.empty)");
          if (plot) {
            plot.onclick = (ev) => {
              const box = plot.getBoundingClientRect();
              if (box.width <= 0) return;
              // The strip speaks in milliseconds; this studio thinks in ticks.
              const ms = ((ev.clientX - box.left) / box.width) * endMs;
              void seek(Math.round((ms * rate) / 1000));
            };
          }
        };
        drawStrip();
        deck.onSelect(drawStrip);
        // The audio elements were mounted here; keep them and add the controls.
        const controls = document.createElement("div");
        controls.innerHTML = deck.render();
        mixer.querySelectorAll(":scope > p").forEach((n) => n.remove());
        mixer.appendChild(controls);
        deck.wire(mixer);
      });
    }

    // ---- the virtual clock ----------------------------------------------
    let vTime = 0;
    let playing = false;
    let speed = 1;
    let lastReal = performance.now();
    let cursor = 0;
    let quickCursor = 0;
    /** How far through the microphone log the playhead is. Its own cursor, and
     *  reset on every seek like the others, so scrubbing to a moment shows the
     *  mics as they stood at that moment rather than as they were left. */
    let micCursor = 0;
    let focus = roster.find((r) => !r.isBot)?.uid ?? roster[0]?.uid ?? "";
    let seeking = false;

    // THE GAME'S clock, which stops when the game does. The studio's own clock
    // carries on past it — the scoreboard stretch, where the sound is still
    // moving and the picture is not — and letting the simulation follow it
    // would keep running a match that had already finished.
    const now = () => T0 + Math.min(vTime, matchEndMs);
    // The STUDIO's position, which may be past the final tick: that is where
    // the results are, and where the last of the audio lives.
    const tickNow = () => Math.max(0, Math.min(endOfTape, Math.floor((vTime * rate) / 1000)));

    // ---- load the game ---------------------------------------------------
    if (!data.game) {
      status.textContent = `This console build cannot run "${file.gameId}".`;
      return;
    }
    let pack: { assets: GameRuntimeContext["assets"]; module: GameModule };
    /** The game's own words for one of its inputs, once its module is loaded. */
    let describe: ((kind: string) => string | null) | undefined;
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
      // ---- what THIS game can tell a watcher ---------------------------
      //
      // Three optional hooks (see GameModule). A game that declares none of
      // them gets the tape it always got. Wrapped, and deliberately: they are a
      // game's COSMETICS, and a game that throws in one of them must not be
      // able to stop a replay from playing. The studio is evidence first.
      describe = pack.module.describeInput?.bind(pack.module);
      try {
        applyGameHooks(host, pack.module, flat, roster, file.endTick, rate, file.seed, file.durationTicks);
      } catch (err) {
        console.warn("[studio] this game's input descriptions failed; the plain tape stands", err);
      }
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
      vTime = (Math.max(0, Math.min(endOfTape, target)) * 1000) / rate;
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
      micCursor = micTicks.findIndex((m) => m.tick > at);
      if (micCursor < 0) micCursor = micTicks.length;
      for (const r of roster) {
        if (r.left && r.leftAtTick !== null && r.leftAtTick <= at) next.onLeft(r.uid);
      }
      next.go(T0);
      seeking = false;
      status.textContent = "";
      nowline.innerHTML = "";
      drawFeed();
    }

    function deliverDue(): void {
      const at = tickNow();
      // Microphones FIRST, and outside the runtime guard. These are not
      // inputs — nothing in the game reacts to them — so they must not wait
      // for a runtime to exist, and they have to redraw the feed themselves:
      // hanging that off a quick message meant a mic only appeared in the
      // record when somebody happened to send chat after it, which for most
      // matches is never.
      let micMoved = false;
      while (micCursor < micTicks.length && micTicks[micCursor].tick <= at) {
        micCursor++;
        micMoved = true;
      }
      if (micMoved) drawFeed();

      if (!runtime) return;
      const horizon = at + LEAD_TICKS;
      while (cursor < flat.length && flat[cursor].tick <= horizon) {
        const i = flat[cursor++];
        runtime.onRemoteInput({ uid: i.uid, tick: i.tick, kind: i.kind });
        // ONE LINE, not a feed. Every input described would bury the chat this
        // console came for; the most recent one, under the tape, answers "what
        // just happened" without pushing anything else off the screen.
        let said: string | null = null;
        try {
          said = describe?.(i.kind) ?? null;
        } catch {
          said = null;
        }
        if (said) {
          nowline.innerHTML = `<span class="at">${esc(fmtTick(i.tick, rate))}</span> <b>${esc(
            nameOfUid.get(i.uid) ?? i.uid
          )}</b> ${esc(said)}`;
        }
      }
      while (quickCursor < quick.length && quick[quickCursor].tick <= at) {
        const q = quick[quickCursor++];
        runtime.onQuick?.(q.uid, q.kind, q.id);
        drawFeed();
      }
      for (const r of roster) {
        if (r.left && r.leftAtTick !== null && r.leftAtTick === at) runtime.onLeft(r.uid);
      }
    }

    /** The opening line of the record: what this match was made of. Always
     *  first, at tick zero, because it is the one thing that is true before
     *  anything happens. */
    const madeFromLine = (): string => {
      const from = data.madeFrom?.from ?? [];
      if (from.length === 0) return "";
      const parts = from.map((f) =>
        f.party
          ? `party <b class="mono">${esc(f.party)}</b>${f.uids && f.uids.length > 1 ? ` (${f.uids.length})` : ""}`
          : `<b class="mono">${esc((f.uids ?? []).join(", "))}</b>`
      );
      const bots = Number(data.madeFrom?.bots ?? 0);
      return `<div class="said"><span class="at">0:00</span> match <b class="mono">${esc(
        file.matchKey
      )}</b> made from ${parts.join(" + ")}${bots > 0 ? ` + ${bots} bot${bots === 1 ? "" : "s"}` : ""}</div>`;
    };

    function drawFeed(): void {
      // Two kinds of line, one record. Quick chat is what was sent; a mic
      // opening or closing is what could be heard, which the audio cannot
      // answer for the players nobody was recording.
      const said = [
        ...quick.slice(0, quickCursor).map((q) => ({
          tick: q.tick,
          html: `<b>${esc(seatOf.get(q.seat)?.name ?? "?")}</b> ${esc(q.id)}`,
        })),
        ...micTicks.slice(0, micCursor).map((m) => ({
          tick: m.tick,
          html: `<b>${esc(m.name)}</b> ${m.on ? "🎙 opened their mic" : "🎙 closed their mic"}`,
        })),
      ]
        .sort((a, b) => a.tick - b.tick)
        .slice(-8)
        .reverse();
      feed.innerHTML = said.length
        ? said
            .map((q) => `<div class="said"><span class="at">${fmtTick(q.tick, rate)}</span> ${q.html}</div>`)
            .join("") + madeFromLine()
        : // Even a silent match opens with what it was made of — that line is
          // true from tick zero, and it is the one an admin came for.
          madeFromLine() || `<p class="empty" style="padding:10px">Nothing said yet.</p>`;
    }

    function chrome(): void {
      const at = tickNow();
      if (!scrub.matches(":active")) scrub.value = String(at);
      // Past the final tick the picture is frozen on the scoreboard and only
      // the sound is still moving. Said in a chip BESIDE the clock rather than
      // inside it: the clock is "position / length" and something reads it as
      // exactly that pair — putting a word in there changes what the clock
      // means to everything that consumes it.
      afterChip.hidden = at <= endTick;
      clock.textContent = `${fmtTick(at, rate)} / ${fmtTick(endOfTape, rate)}`;
      playBtn.textContent = playing ? "❚❚" : "▶";
      playBtn.title = playing ? "Pause" : "Play";
      // A fraction, not a percentage: the stylesheet knows how much width the
      // name column and the padding take, and this does not have to.
      host.querySelectorAll<HTMLElement>("[data-tickmark]").forEach((el) => {
        el.style.setProperty("--p", String(at / endOfTape));
      });
      // A microphone lights only while somebody is actually talking — not
      // while their mic is merely open, which tells a viewer nothing.
      const talking = audioDeck?.speaking();
      host.querySelectorAll<HTMLElement>("[data-mic]").forEach((el) => {
        el.classList.toggle("live", !!talking?.has(el.dataset.mic!));
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
      // The sound is moved by the SAME clock as the game, in the same frame,
      // before anything draws. Give audio its own timer and the two drift.
      audioDeck?.sync(vTime, playing && !seeking, speed);
      deliverDue();
      // Draw last. Never before deliverDue.
      if (!seeking) {
        try {
          // Inside beginFrame/endFrame. Babylon measures the gap between
          // frames in beginFrame, and nothing else calls it — the game uses
          // engine.runRenderLoop, which does it for you; this studio drives
          // its own clock so it can scrub. Without the pair the engine reports
          // a delta of ZERO on every frame, and a game's between-tick
          // smoothing is fed that zero: the simulation still advances, because
          // that runs on ticks, but nothing interpolates between them and
          // every skeletal animation crawls at Babylon's one-millisecond
          // floor. Same fault, same fix, as the party studio.
          engineHandle?.beginFrame();
          runtime?.render();
          engineHandle?.endFrame();
        } catch (err) {
          console.error("[studio] render failed", err);
        }
      }
      chrome();
      raf = requestAnimationFrame(frame);
    }

    // ---- controls --------------------------------------------------------
    playBtn.onclick = () => {
      // A browser will not start audio without a gesture; this is that gesture.
      audioDeck?.resume();
      if (tickNow() >= endOfTape) void seek(0);
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
    // Watching IS the investigation, so the moment goes onto a case from here
    // rather than being written down and typed in somewhere else. Attaching it
    // also holds the replay, because evidence that expires under an open case
    // is not evidence.
    host.querySelector<HTMLButtonElement>("#tocase")!.onclick = () => void flagMoment(matchKey, Math.round(vTime));
    host.querySelector<HTMLButtonElement>("#back")!.onclick = () => go("#/matches");

    // Space to play, arrows to nudge — the keys anybody expects on a player.
    const keys = (e: KeyboardEvent) => {
      // Anything somebody can type into is off limits — a TEXTAREA as much as
      // an INPUT. Space is a playback shortcut here and preventDefault on it
      // means a space that never reaches whatever is being written, which
      // reads as "I cannot type in this box" rather than as a stolen key.
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement)?.isContentEditable) return;
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

async function flagMoment(matchKey: string, atMs: number): Promise<void> {
  let open: { id: string; ref: string; subjectUid: string; subjectName: string | null }[] = [];
  try {
    open = (await call<{ cases: typeof open }>("/cases?status=open")).cases;
  } catch {
    toast("Could not read the open cases");
    return;
  }
  if (!open.length) {
    toast("No case is open. Open one from Reports first.");
    return;
  }
  const at = `${Math.floor(atMs / 60000)}:${String(Math.floor((atMs % 60000) / 1000)).padStart(2, "0")}`;
  const answer = await ask({
    title: `Flag ${at} into a case`,
    intro: "The case gets a link straight back to this moment, and this replay stops being swept.",
    confirm: "Flag it",
    fields: [
      {
        name: "caseId",
        label: "Which case",
        type: "select",
        value: open[0].id,
        options: open.map((c) => ({ value: c.id, label: `${c.ref} — ${c.subjectName ?? c.subjectUid}` })),
      },
      { name: "body", label: "What it shows", type: "textarea", placeholder: "e.g. walks through the wall" },
    ],
    async onSubmit(v) {
      try {
        await call(`/cases/${v.caseId}/items`, {
          method: "POST",
          body: JSON.stringify({ kind: "moment", refId: matchKey, atMs, body: v.body }),
        });
        return null;
      } catch (e) {
        return e instanceof ApiFailure ? e.info.error : "That did not work";
      }
    },
  });
  if (answer) toast("Flagged onto the case.");
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

/** Redraw the tape and the per-player lines using whatever the GAME is willing
 *  to say about its own inputs.
 *
 *  A mark's HEIGHT is the effort the game reports for that input, so a lane
 *  becomes a bar chart of how somebody played rather than a row of identical
 *  ticks — which is what makes "who winds it right up every time" answerable at
 *  a glance. An input the game gives no weight to still gets a mark, a short
 *  faint one: it happened, and a tape that hid it would be lying by omission. */
function applyGameHooks(
  host: HTMLElement,
  module: GameModule,
  flat: { tick: number; uid: string; seat: number; kind: string }[],
  roster: ReplayRoster[],
  endTick: number,
  rate: number,
  seed: number,
  durationTicks: number
): void {
  const weigh = module.inputWeight;
  if (weigh) {
    host.querySelectorAll<HTMLElement>(".marks[data-seat]").forEach((lane) => {
      const seat = Number(lane.dataset.seat);
      lane.innerHTML = flat
        .filter((i) => i.seat === seat)
        .map((i) => {
          const w = weigh(i.kind);
          const h = w === null ? 0.18 : 0.25 + 0.75 * Math.max(0, Math.min(1, w));
          const left = ((i.tick / Math.max(1, endTick)) * 100).toFixed(3);
          const title = module.describeInput?.(i.kind) ?? i.kind;
          const cls = w === null ? "faint" : "";
          return `<i class="${cls}" style="left:${left}%;height:${(h * 100).toFixed(0)}%" title="${esc(
            fmtTick(i.tick, rate)
          )} · ${esc(title)}"></i>`;
        })
        .join("");
    });
  }
  const summarise = module.summarise;
  if (!summarise) return;
  // The whole log, seat-tagged, for the games whose interesting numbers cannot
  // be worked out from one player's moves — see GameModule.summarise.
  const all = flat.map((i) => ({ tick: i.tick, seat: i.seat, kind: i.kind }));
  for (const r of roster) {
    const box = host.querySelector<HTMLElement>(`.how[data-how="${CSS.escape(r.uid)}"]`);
    if (!box) continue;
    const stats = summarise(
      flat.filter((i) => i.uid === r.uid).map((i) => ({ tick: i.tick, kind: i.kind })),
      { seat: r.seat, players: roster.length, seed, durationTicks, all }
    );
    box.innerHTML = stats.map((x) => `<span><b>${esc(x.value)}</b>${esc(x.label)}</span>`).join("");
  }
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
      // `data-seat` so these can be redrawn once the GAME's module is in hand:
      // a game that can say how much effort each input carried gets a tape of
      // BARS rather than one of ticks, and "who hits everything as hard as they
      // can" stops being something a viewer has to count by hand.
      return `<div class="lane"><span class="who"><i class="mic" data-mic="${esc(r.uid)}">🎙</i>${esc(
        r.name
      )}</span><div class="marks" data-seat="${r.seat}">${marks}</div></div>`;
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
        <span class="after-chip" id="afterchip" hidden>results</span>
        <input type="range" id="scrub" min="0" value="0" step="1" />
        <span class="speeds">${SPEEDS.map(
          (s) => `<button data-speed="${s}" class="${s === 1 ? "on" : ""}">${s}×</button>`
        ).join("")}</span>
      </div>

      <div class="tape"><div id="talk"></div>${tape}<div class="playhead" data-tickmark></div></div>
      <div class="nowline" id="nowline"></div>

      <div id="mixer" class="mixerslot">${
        data.voice && data.voice.length > 0
          ? `<p class="muted" style="font-size:12.5px">Loading what was said…</p>`
          : `<p class="muted" style="font-size:12.5px">No voice was recorded for this match.</p>`
      }</div>

      <div class="grid2" style="margin-top:18px">
        <div>
          <div class="card">
            <header><h2>At the table</h2><span class="spacer"></span><span class="count">${roster.length}</span></header>
            ${table(
              ["Player", "Place", "Score", "Focus"].map((h) => `<th>${h}</th>`),
              roster.map((r) => {
                const st = place.get(r.uid);
                return `<tr>
                  <td><i class="mic" data-mic="${esc(r.uid)}">🎙</i><strong>${esc(r.name)}</strong> ${
                    r.isBot ? pill("bot") : ""
                  } ${r.left ? pill("left", "warn") : ""}</td>
                  <td class="mono">${st ? (st.placement === 1 ? "<strong>1st</strong>" : st.placement) : "—"}</td>
                  <td class="mono">${num(st?.score)}</td>
                  <td><button class="btn ghost" data-focus="${esc(r.uid)}">Watch</button></td>
                </tr>
                <tr class="howrow"><td colspan="4"><div class="how" data-how="${esc(r.uid)}"></div></td></tr>`;
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
              <button class="btn ghost" id="tocase">Flag this moment</button>
              <button class="btn ghost" id="back">All matches</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}
