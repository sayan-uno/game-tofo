// A party, replayed.
//
// The match studio loads the game's real client code and drives it from the
// input log. This does the same thing with the LOBBY: it loads the actual
// lobby scene — the same pedestals, characters, outfits and name plates a
// player sees — and drives it from the recorded state log.
//
// So it is not a video and it is not a diagram. It is the lobby, as it was, at
// whatever moment you scrub to: who was standing there, what they were
// wearing, who was leading, what they said. A two-hour party is a few
// kilobytes, because all that was ever stored is what changed.
//
// A party that is still happening is read live and keeps catching up, and you
// can still scrub back through its past while it runs.
import { ApiFailure, call } from "../api";
import { loadStudioAudio, type StudioAudio, type VoiceFile } from "../studioAudio";
import { talkStrip } from "../talkStrip";
import { esc, pill, when } from "../ui";

interface PartyMember {
  uid: string;
  name: string;
  character: string;
  weapon: string | null;
  isLeader: boolean;
  avatarUrl: string | null;
}
type JoinVia = "code" | "invite" | "friend" | "request" | "self";
type PartyEvent =
  | { t: number; k: "state"; mode: string; game: string | null; members: PartyMember[] }
  | { t: number; k: "chat"; uid: string; name: string; body: string }
  | { t: number; k: "emote"; uid: string; name: string; id: string }
  | { t: number; k: "join"; uid: string; name: string; via: JoinVia; by: string | null; byName: string | null }
  | { t: number; k: "match"; phase: "start" | "end"; matchId: string; game: string | null }
  | { t: number; k: "leave"; uid: string; name: string; why: "left" | "kicked" | "quiet" | "dropped" }
  | { t: number; k: "mic"; uid: string; name: string; on: boolean }
  | { t: number; k: "search"; uid: string; name: string; on: boolean; game: string | null }
  | { t: number; k: "ready"; uid: string; name: string; on: boolean }
  | { t: number; k: "pick"; uid: string; name: string; game: string | null }
  | { t: number; k: "end"; why: "empty" | "alone" }
  | {
      t: number;
      k: "leader";
      uid: string;
      name: string;
      fromUid: string | null;
      fromName: string | null;
      why: "handed" | "left";
    };

/** How somebody came to be in the party, in words. The first question about a
 *  group that turns out to matter: being invited reads differently from
 *  walking in with a code. */
const arrival = (e: Extract<PartyEvent, { k: "join" }>): string =>
  e.via === "invite" && e.byName
    ? `invited by ${e.byName}`
    : e.via === "code"
      ? "joined with a team code"
      : e.via === "request"
        ? `asked to join${e.byName ? ` — ${esc(e.byName)} said yes` : ""}`
      : e.via === "friend"
        ? "joined a friend's party"
        : "joined";

/** The stretches this party spent inside a match.
 *
 *  They matter because they are the one kind of gap that looks identical to
 *  "nothing happened": the lobby is not empty, everybody is still a member and
 *  the last state stays on screen, so an admin sees three people standing
 *  perfectly still and has no way to know whether that is a quiet group or a
 *  group that is not there. Marking them turns ten minutes of guessing into a
 *  labelled block that can be skipped — or watched, because somebody who drops
 *  out early can come back and do something while the others are still in. */
interface MatchSpan {
  from: number;
  to: number;
  matchId: string;
  game: string | null;
  /** Still in it — the party has not come back, and this is a live recording. */
  open: boolean;
}

function matchSpans(events: PartyEvent[], endMs: number): MatchSpan[] {
  const spans: MatchSpan[] = [];
  let open: MatchSpan | null = null;
  for (const e of events) {
    if (e.k !== "match") continue;
    if (e.phase === "start") {
      // A second start without an end means the first was never closed — a
      // crash, or a match that outlived the recording. Close it here rather
      // than letting one span swallow the rest of the party.
      if (open) {
        open.to = e.t;
        open.open = false;
      }
      open = { from: e.t, to: endMs, matchId: e.matchId, game: e.game, open: true };
      spans.push(open);
    } else if (open) {
      open.to = e.t;
      open.open = false;
      open = null;
    }
  }
  if (open) open.to = endMs;
  return spans;
}

interface Answer {
  party: {
    key: string;
    room: string;
    startedAt: string;
    endedAt: string | null;
    live: boolean;
    roster: { uid: string; username: string | null; firstSeen?: number }[];
    expiresAt: string | null;
  };
  events: PartyEvent[];
  voice: VoiceFile[];
  canHear: boolean;
  catalog: unknown;
  cdnBase: string | null;
}

const clock = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h > 0 ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s % 60).padStart(2, "0")}`;
};

/** The console's dev server proxies the asset CDN; production names its own
 *  origin in the bucket's CORS rules. Same rewrite the match studio uses. */
const PROXY = import.meta.env.VITE_CDN_PROXY_PREFIX as string | undefined;
function throughProxy(url: string | null, cdnBase: string | null): string | null {
  if (!url || !PROXY || !cdnBase) return url;
  return url.startsWith(cdnBase) ? PROXY + url.slice(cdnBase.length) : url;
}
function catalogThroughProxy(catalog: unknown, cdnBase: string | null): unknown {
  if (!PROXY || !cdnBase || !catalog) return catalog;
  return JSON.parse(
    JSON.stringify(catalog, (k, v) => (k === "url" && typeof v === "string" ? throughProxy(v, cdnBase) : v))
  );
}

export function mountParty(host: HTMLElement, key: string, go: (h: string) => void, openAt = 0): () => void {
  let stopped = false;
  let raf = 0;
  let deck: StudioAudio | null = null;
  let scene:
    | {
        setMembers(m: unknown[]): void;
        showChatBubble(uid: string, text: string): void;
        /** The green tick beside a name — the same one the squad saw. */
        setReady(uid: string, ready: boolean): void;
        /** The same call the game makes, so an admin sees the animation the
         *  squad saw rather than a note that one happened. */
        playEmote(uid: string, clipId: string): Promise<boolean>;
        /** The Babylon scene. Drawing it is OUR job — the lobby does not run a
         *  loop of its own, exactly like the games in the match studio. */
        scene: { render(): void; animationTimeScale: number };
        dispose(): void;
      }
    | null = null;
  let engine: { dispose(): void; beginFrame(): void; endFrame(): void } | null = null;
  let poll = 0;

  const cleanup = () => {
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    if (poll) clearInterval(poll);
    deck?.dispose();
    deck = null;
    try {
      scene?.dispose();
    } catch {
      /* a half-built scene is still worth throwing away */
    }
    scene = null;
    engine?.dispose();
    engine = null;
  };

  host.innerHTML = `<div class="card"><p class="empty">Loading the party…</p></div>`;

  void (async () => {
    let data: Answer;
    try {
      data = await call<Answer>(`/parties/${encodeURIComponent(key)}`);
    } catch (e) {
      host.innerHTML = `<div class="card"><p class="empty">${esc(
        e instanceof ApiFailure ? e.info.error : "Could not load that party"
      )}</p></div>`;
      return;
    }
    if (stopped) return;

    let events = data.events;
    const endOf = (evs: PartyEvent[]) => Math.max(30_000, evs.length > 0 ? evs[evs.length - 1].t + 5000 : 30_000);
    let endMs = endOf(events);

    host.innerHTML = shell(data, endMs);
    const stage = host.querySelector<HTMLElement>("#stage")!;
    const canvas = host.querySelector<HTMLCanvasElement>("#party-canvas")!;
    const status = host.querySelector<HTMLElement>("#status")!;
    const scrub = host.querySelector<HTMLInputElement>("#scrub")!;
    const playBtn = host.querySelector<HTMLButtonElement>("#play")!;
    const clockEl = host.querySelector<HTMLElement>("#clock")!;
    const feed = host.querySelector<HTMLElement>("#feed")!;
    const mixer = host.querySelector<HTMLElement>("#mixer")!;
    const matchbar = host.querySelector<HTMLElement>("#matchbar")!;
    const matchtext = host.querySelector<HTMLElement>("#matchtext")!;
    const matchSkip = host.querySelector<HTMLButtonElement>("#matchskip")!;
    const matchWatch = host.querySelector<HTMLButtonElement>("#matchwatch")!;

    // Recomputed only when the log actually grows, not every frame: a live
    // party polls every five seconds and draws sixty times a second.
    let spans = matchSpans(events, endMs);
    let spansFor = events.length;
    const spansNow = (): MatchSpan[] => {
      if (spansFor !== events.length) {
        spans = matchSpans(events, endMs);
        spansFor = events.length;
      }
      return spans;
    };
    /** An OPEN span has no end yet, and on a live party nothing is written
     *  while the match runs — so the log stops growing, the end of the
     *  recording stops moving, and the playhead sits exactly on the span's
     *  edge. Compared with `<` that reads as "the match is over", and the
     *  notice blinks off precisely while the group is still playing. */
    const spanAt = (at: number): MatchSpan | null =>
      spansNow().find((sp) => at >= sp.from && (sp.open || at < sp.to)) ?? null;

    // ---- the lobby itself -------------------------------------------------
    try {
      const [{ createEngine }, { LobbyScene }, { setCatalog }] = await Promise.all([
        import("@game/game/engine"),
        import("@game/game/lobbyScene"),
        import("@game/game/assets"),
      ]);
      if (data.catalog) setCatalog(catalogThroughProxy(data.catalog, data.cdnBase) as never);
      const eng = createEngine(canvas);
      engine = eng as unknown as { dispose(): void; beginFrame(): void; endFrame(): void };
      // No local player: nobody is standing in this lobby, we are watching it.
      scene = new LobbyScene(eng, "", (uid: string) => go(`#/players/${uid}`)) as unknown as typeof scene;
      status.textContent = "";
      stage.classList.add("ready");
    } catch (err) {
      console.error("[party] could not build the lobby", err);
      status.textContent = "This console build cannot draw the lobby.";
    }

    // ---- the sound --------------------------------------------------------
    // The voice line is drawn straight away, before anything is known about
    // the audio, and says there is none. Leaving it out entirely would be
    // quieter but worse: an admin cannot tell a party where nobody spoke from
    // one where the line failed to load.
    host.querySelector<HTMLElement>("#talk")!.innerHTML = talkStrip(null, endMs);
    if (data.canHear && data.voice.length > 0) {
      void loadStudioAudio(data.voice, mixer).then((d) => {
        if (stopped || !d) {
          d?.dispose();
          return;
        }
        deck = d;
        const strip = host.querySelector<HTMLElement>("#talk")!;
        const drawStrip = () => {
          strip.innerHTML = talkStrip(d.timeline(), endMs);
          // Click the picture, go to the moment. On the PLOT, not on each
          // mark: an admin aiming at "just before they started shouting" is
          // aiming at the quiet stretch beside it, and a handler that only
          // fires on the bars ignores exactly that click.
          const plot = strip.querySelector<HTMLElement>(".tk-plot:not(.empty)");
          if (plot) {
            plot.onclick = (ev) => {
              const box = plot.getBoundingClientRect();
              if (box.width <= 0) return;
              seek(((ev.clientX - box.left) / box.width) * endMs);
              playing = true;
              last = performance.now();
              d.resume();
            };
          }
        };
        drawStrip();
        d.onSelect(drawStrip);
        mixer.innerHTML = "";
        const controls = document.createElement("div");
        controls.innerHTML = d.render();
        mixer.appendChild(controls);
        d.wire(mixer);
      });
    }

    // ---- the clock --------------------------------------------------------
    // Opened at a moment when a player's history sent us here: the studio
    // starts where they arrived rather than at the beginning of two hours.
    let vTime = Math.max(0, Math.min(endMs, openAt));
    let playing = false;
    let speed = 1;
    let last = performance.now();
    let follow = data.party.live && openAt === 0;
    /** True while a seek is rewinding the point events, so they are counted
     *  past rather than performed. */
    let seeking = false;
    let drawnState = -1;
    let chatCursor = 0;
    /** Who has said they are ready, as at the playhead. Rebuilt on every seek,
     *  because "ready" is a state the recording moves through, not a fact. */
    const readyNow = new Set<string>();
    /** Push that set onto the plates. Called after a seek, and after the state
     *  is redrawn — a member who has just been (re)created has no tick yet. */
    const applyReady = () => {
      const idx = stateIndexAt(vTime);
      const e = idx >= 0 ? (events[idx] as Extract<PartyEvent, { k: "state" }>) : null;
      for (const m of e?.members ?? []) scene?.setReady(m.uid, readyNow.has(m.uid));
    };

    /** The party as it was at `at` — the last state on or before it.
     *
     *  Before the FIRST state there is nothing recorded, but showing an empty
     *  lobby there is worse than useless: the party did not start empty, it
     *  started the moment that state was written. So the first state stands in
     *  for everything before it. */
    const stateIndexAt = (at: number): number => {
      let found = -1;
      let first = -1;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        if (e.k !== "state") continue;
        if (first < 0) first = i;
        if (e.t <= at) found = i;
        else break;
      }
      return found >= 0 ? found : first;
    };

    function paint(): void {
      const idx = stateIndexAt(vTime);
      if (idx !== drawnState) {
        drawnState = idx;
        const e = idx >= 0 ? (events[idx] as Extract<PartyEvent, { k: "state" }>) : null;
        scene?.setMembers(
          (e?.members ?? []).map((m) => ({
            id: m.uid,
            uid: m.uid,
            name: m.name,
            avatarUrl: m.avatarUrl,
            isLeader: m.isLeader,
            character: m.character,
            weapon: m.weapon,
          }))
        );
        applyReady();
        host.querySelector<HTMLElement>("#present")!.innerHTML =
          (e?.members ?? [])
            .map(
              (m) =>
                `<div class="vrow"><div class="vwho"><i class="mic" data-mic="${esc(m.uid)}">🎙</i>${esc(m.name)}${
                  m.isLeader ? " ★" : ""
                }</div><div class="muted mono" style="font-size:11px">${esc(m.uid)}</div></div>`
            )
            .join("") || `<p class="empty">Nobody.</p>`;
      }
    }

    /** Chat, emotes and arrivals are point events: played as they are passed.
     *
     *  Emotes go to the SAME method the game calls, so what an admin sees is
     *  the animation the squad saw, not a note that one happened. */
    const say = (html: string, t: number) =>
      feed.insertAdjacentHTML("afterbegin", `<div class="ev"><span class="mono">${clock(t)}</span> ${html}</div>`);

    /** One line of the written record. Pure, so the same function draws an
     *  event as it is reached AND draws the ones already behind you when the
     *  playhead is dropped into the middle. */
    function lineFor(e: PartyEvent): string | null {
      switch (e.k) {
        case "chat":
          return `<strong>${esc(e.name)}</strong> ${esc(e.body)}`;
        case "emote":
          return `<strong>${esc(e.name)}</strong> ${pill(`emote · ${esc(e.id)}`, "")}`;
        case "join":
          return `<strong>${esc(e.name)}</strong> ${pill(arrival(e), "on")}`;
        case "leave":
          return `<strong>${esc(e.name)}</strong> ${pill(
            e.why === "kicked"
              ? "was removed from the party"
              : e.why === "quiet"
                ? "went quiet and was dropped"
                : e.why === "dropped"
                  ? "lost connection"
                  : "left the party",
            "bad"
          )}`;
        case "search":
          // The run-up to a match, which is what somebody watching a party
          // back is usually looking for — and a search that was cancelled
          // never becomes a match, so this is its only trace here.
          return e.on
            ? `<strong>${esc(e.name)}</strong> ${pill(`went looking for a ${esc(e.game ?? "match")}`, "warn")}`
            : `<strong>${esc(e.name)}</strong> ${pill("stopped the search", "")}`;
        case "ready":
          return `<strong>${esc(e.name)}</strong> ${pill(e.on ? "✓ is ready" : "is not ready any more", e.on ? "on" : "")}`;
        case "pick":
          return `<strong>${esc(e.name)}</strong> ${pill(
            e.game ? `chose ${esc(e.game)}` : "cleared the game",
            "warn"
          )}`;
        case "mic":
          // What was POSSIBLE to hear, which the audio cannot say: a mic
          // opened in silence records nothing, and a mic that was shut is an
          // alibi.
          return `<strong>${esc(e.name)}</strong> ${pill(e.on ? "🎙 opened their mic" : "🎙 closed their mic", e.on ? "warn" : "")}`;
        case "leader":
          // The first question about a party that misbehaves is who was
          // running it at the time, and one recording now covers the whole
          // life of the group — so the answer changes inside it.
          return e.why === "handed"
            ? `<strong>${esc(e.fromName ?? "The leader")}</strong> ${pill("handed the party to", "warn")} <strong>${esc(e.name)}</strong>`
            : `<strong>${esc(e.fromName ?? "The leader")}</strong> left — <strong>${esc(e.name)}</strong> ${pill("now leads", "warn")}`;
        case "match":
          return e.phase === "start"
            ? `${pill("went into a match", "warn")} <span class="muted">${esc(e.game ?? "")}</span>`
            : `${pill("came back from the match", "on")}`;
        case "end":
          return pill(
            e.why === "alone" ? "party ended — only one player left" : "party ended — everybody had gone",
            "bad"
          );
        default:
          // A state change is drawn, not narrated.
          return null;
      }
    }

    function deliverTalk(): void {
      while (chatCursor < events.length && events[chatCursor].t <= vTime) {
        const e = events[chatCursor++];
        if (e.k === "chat") scene?.showChatBubble(e.uid, e.body);
        // The same green tick the squad saw beside the name, at the same
        // moment they saw it.
        if (e.k === "ready") {
          readyNow[e.on ? "add" : "delete"](e.uid);
          scene?.setReady(e.uid, e.on);
        }
        // Only while playing forward: replaying every emote during a scrub
        // would be a fit of dancing, not a replay.
        if (e.k === "emote" && playing && !seeking) void scene?.playEmote(e.uid, e.id);
        const line = lineFor(e);
        if (line) say(line, e.t);
      }
    }

    /** Rebuild the written record for wherever the playhead now is.
     *
     *  It used to throw the feed away and count everything behind the playhead
     *  as consumed WITHOUT drawing it, so an admin who jumped into the middle
     *  of a party — which is the normal way to use this, and exactly what the
     *  "jump to their arrival" buttons do — saw an empty record and had to
     *  watch the whole thing from the beginning to find out what led up to the
     *  moment they came for.
     *
     *  Everything up to this moment is drawn instead. Newest first, matching
     *  the way lines arrive while it plays. */
    function rewindTalk(): void {
      seeking = true;
      chatCursor = 0;
      readyNow.clear();
      const past: string[] = [];
      while (chatCursor < events.length && events[chatCursor].t <= vTime) {
        const e = events[chatCursor++];
        if (e.k === "ready") readyNow[e.on ? "add" : "delete"](e.uid);
        const line = lineFor(e);
        if (line) past.push(`<div class="ev"><span class="mono">${clock(e.t)}</span> ${line}</div>`);
      }
      // Ticks as they stood at THIS moment, not as they were left: a seek that
      // leaves a stale tick on somebody is showing an agreement they had not
      // given yet.
      applyReady();
      feed.innerHTML = past.reverse().join("");
      seeking = false;
    }

    const seek = (to: number) => {
      vTime = Math.max(0, Math.min(endMs, to));
      follow = false;
      rewindTalk();
      drawnState = -1;
      paint();
    };

    // Jumping to the moment a player walked in — the whole reason an admin
    // does not have to scrub through two hours looking for them.
    host.querySelectorAll<HTMLElement>("[data-jump]").forEach((el) => {
      el.onclick = () => {
        seek(Number(el.dataset.jump));
        playing = true;
        last = performance.now();
        deck?.resume();
      };
    });
    host.querySelectorAll<HTMLElement>("[data-open]").forEach((el) => {
      el.onclick = () => go(`#/players/${el.dataset.open}`);
    });

    // Skipping lands just AFTER the return, so the first thing on screen is the
    // party being a party again rather than the last frame of the gap.
    matchSkip.onclick = () => {
      const sp = spanAt(vTime);
      if (!sp || sp.open) return;
      seek(sp.to + 250);
      playing = true;
      last = performance.now();
      deck?.resume();
    };
    matchWatch.onclick = () => {
      const id = matchbar.dataset.matchId;
      if (id) go(`#/matches/${encodeURIComponent(id)}`);
    };

    playBtn.onclick = () => {
      deck?.resume();
      if (vTime >= endMs && !data.party.live) vTime = 0;
      playing = !playing;
      last = performance.now();
    };
    scrub.oninput = () => {
      playing = false;
      seek(Number(scrub.value));
    };
    host.querySelectorAll<HTMLButtonElement>("[data-speed]").forEach((b) => {
      b.onclick = () => {
        speed = Number(b.dataset.speed);
        host.querySelectorAll<HTMLElement>("[data-speed]").forEach((x) => x.classList.toggle("on", x === b));
      };
    });
    host.querySelector<HTMLButtonElement>("#live")?.addEventListener("click", () => {
      follow = true;
      playing = true;
      vTime = endMs;
      last = performance.now();
      rewindTalk();
    });

    // A live party keeps growing. Polled rather than pushed: this is one small
    // request every few seconds on an admin's screen, and it cannot touch the
    // process that serves players.
    if (data.party.live) {
      poll = window.setInterval(() => {
        void call<Answer>(`/parties/${encodeURIComponent(key)}`)
          .then((fresh) => {
            if (stopped) return;
            events = fresh.events;
            endMs = endOf(events);
            scrub.max = String(Math.round(endMs));
            if (!fresh.party.live) {
              host.querySelector<HTMLElement>("#livechip")?.remove();
              if (poll) clearInterval(poll);
            }
          })
          .catch(() => undefined);
      }, 5000);
    }

    const frame = () => {
      if (stopped) return;
      const now = performance.now();
      if (playing) {
        vTime = Math.min(endMs, vTime + (now - last) * speed);
        if (vTime >= endMs && !data.party.live) playing = false;
      }
      if (follow) vTime = endMs;
      last = now;
      // The same clock moves the picture and the sound, in the same frame.
      deck?.sync(vTime, playing, speed);
      paint();
      deliverTalk();
      // Draw LAST, after the state for this moment has been applied — the same
      // ordering the match studio depends on. Without this call the scene is
      // built, correct, and completely black.
      //
      // BETWEEN beginFrame AND endFrame, which is not decoration. Babylon
      // measures the time between frames inside beginFrame, and nothing else
      // ever calls it — the game uses engine.runRenderLoop, which does it for
      // you, while this studio drives its own clock so it can scrub. Calling
      // scene.render() alone left the engine reporting a delta of ZERO for
      // every frame, and three separate things in the lobby read that number:
      //
      //   the walk to a new slot (dt of zero → nobody ever moves, so a third
      //   player joining left the other two standing where they were),
      //   the particle systems (a legendary aura that never advances a frame
      //   is an aura you cannot see), and
      //   every skeletal animation — Babylon floors the step at MinDeltaTime,
      //   one millisecond, so emotes crawled at a sixteenth of their speed.
      //
      // One missing pair of calls, three bugs that looked unrelated.
      try {
        if (scene) {
          // Animations run on the studio's clock, not the wall clock: at 8×
          // an emote that plays at life speed is not the moment being shown.
          scene.scene.animationTimeScale = speed;
          engine?.beginFrame();
          scene.scene.render();
          engine?.endFrame();
        }
      } catch (err) {
        console.error("[party] render failed", err);
      }
      if (!scrub.matches(":active")) scrub.value = String(Math.round(vTime));
      clockEl.textContent = `${clock(vTime)} / ${clock(endMs)}`;
      playBtn.textContent = playing ? "❚❚" : "▶";
      host.querySelectorAll<HTMLElement>("[data-tickmark]").forEach((el) => {
        el.style.setProperty("--p", String(endMs > 0 ? vTime / endMs : 0));
      });
      // Say what this stretch is. The picture underneath is left alone: the
      // lobby still draws, so an admin who wants to watch the gap can — the
      // whole point of a skip button rather than a skipped section.
      const sp = spanAt(vTime);
      if (sp) {
        matchbar.hidden = false;
        matchbar.dataset.matchId = sp.matchId;
        matchtext.textContent = sp.open
          ? `This group is playing${sp.game ? ` ${sp.game}` : ""} right now — the lobby stands still until they are back.`
          : `They were playing${sp.game ? ` ${sp.game}` : ""} for ${clock(sp.to - sp.from)} — nothing happens here until they are all back.`;
        matchSkip.hidden = sp.open;
      } else if (!matchbar.hidden) {
        matchbar.hidden = true;
      }

      const talking = deck?.speaking();
      host.querySelectorAll<HTMLElement>("[data-mic]").forEach((el) => {
        el.classList.toggle("live", !!talking?.has(el.dataset.mic!));
      });
      raf = requestAnimationFrame(frame);
    };
    paint();
    raf = requestAnimationFrame(frame);
  })();

  return cleanup;
}

function shell(data: Answer, endMs: number): string {
  const { party } = data;
  // A lane per person: the stretch they were in the party, and — where there
  // is audio — the moments they were actually speaking.
  const speechOf = new Map<string, [number, number][]>();
  for (const f of data.voice) {
    if (f.kind === "track" && f.speech) speechOf.set(f.uid, [...(speechOf.get(f.uid) ?? []), ...f.speech]);
  }
  const spansOf = (uid: string): [number, number][] => {
    const spans: [number, number][] = [];
    let from: number | null = null;
    for (const e of data.events) {
      if (e.k !== "state") continue;
      const here = e.members.some((m) => m.uid === uid);
      if (here && from === null) from = e.t;
      if (!here && from !== null) {
        spans.push([from, e.t]);
        from = null;
      }
    }
    if (from !== null) spans.push([from, endMs]);
    return spans;
  };
  const pct = (v: number) => `${((v / Math.max(1, endMs)) * 100).toFixed(3)}%`;
  // One lane above the people, so the gaps are visible before anything is
  // played: the shape of the hour at a glance, matches included.
  const gaps = matchSpans(data.events, endMs);
  const matchLane =
    gaps.length === 0
      ? ""
      : `<div class="lane">
          <span class="who" title="Stretches this group spent in a match">in a match</span>
          <div class="marks party">${gaps
            .map(
              (g) =>
                // The drawn width has a floor so a short match is still
                // visible, which makes the mark WIDER than the gap. The real
                // bounds ride along so nothing has to measure pixels to know
                // when the party started again.
                `<i class="mgap" data-from="${Math.round(g.from)}" data-to="${Math.round(g.to)}"
                    style="left:${pct(g.from)};width:${pct(Math.max(2000, g.to - g.from))}" title="${esc(
                      `${g.game ?? "match"} · ${clock(g.to - g.from)}`
                    )}"></i>`
            )
            .join("")}</div>
        </div>`;
  const lanes = party.roster
    .map((p) => {
      const present = spansOf(p.uid)
        .map(([a, b]) => `<i class="span" style="left:${pct(a)};width:${pct(Math.max(2000, b - a))}"></i>`)
        .join("");
      const talk = (speechOf.get(p.uid) ?? [])
        .map(([a, b]) => `<i class="talk" style="left:${pct(a)};width:${pct(Math.max(400, b - a))}"></i>`)
        .join("");
      return `<div class="lane">
        <span class="who click" data-jump="${p.firstSeen ?? 0}" title="Jump to when they arrived">
          <i class="mic" data-mic="${esc(p.uid)}">🎙</i>${esc(p.username ?? p.uid)}
        </span>
        <div class="marks party">${present}${talk}</div>
      </div>`;
    })
    .join("");

  return `
    <div class="studio">
      <div class="stage" id="stage">
        <canvas id="party-canvas"></canvas>
        <div class="status" id="status">Building the lobby…</div>
        <div class="matchbar" id="matchbar" hidden>
          <span class="mtag">IN A MATCH</span>
          <span class="mtext" id="matchtext"></span>
          <button class="btn ghost" id="matchwatch">Watch the match</button>
          <button class="btn" id="matchskip">Skip to their return ⏭</button>
        </div>
      </div>

      <div class="bar">
        <button class="btn" id="play" title="Play">▶</button>
        <span class="clock" id="clock">0:00</span>
        <input type="range" id="scrub" min="0" max="${Math.round(endMs)}" value="0" step="100" />
        ${party.live ? `<button class="btn ghost" id="live" title="Jump to now">● LIVE</button>` : ""}
        <span class="speeds">${[1, 2, 4, 8]
          .map((s) => `<button data-speed="${s}" class="${s === 1 ? "on" : ""}">${s}×</button>`)
          .join("")}</span>
      </div>

      <div class="tape"><div id="talk"></div>${matchLane}${lanes}<div class="playhead" data-tickmark></div></div>
      <div id="mixer" class="mixerslot">${
        !data.canHear
          ? `<p class="muted" style="font-size:12.5px">Voice is for admins and owners.</p>`
          : data.voice.length > 0
            ? `<p class="muted" style="font-size:12.5px">Loading what was said…</p>`
            : `<p class="muted" style="font-size:12.5px">No voice was recorded for this party — nobody in it was flagged.</p>`
      }</div>

      <div class="grid2" style="margin-top:18px">
        <div class="card">
          <header><h2>In the party now</h2>${
            party.live ? `<span class="spacer"></span><span id="livechip">${pill("live", "on")}</span>` : ""
          }</header>
          <div class="pad" id="present"></div>
        </div>
        <div class="card">
          <header><h2>Everyone who was here</h2><span class="spacer"></span><span class="count">${party.roster.length}</span></header>
          <div class="pad">
            ${party.roster
              .map((p) => {
                const how = data.events.find((e) => e.k === "join" && e.uid === p.uid) as
                  | Extract<PartyEvent, { k: "join" }>
                  | undefined;
                return `<div class="vrow">
                  <div class="vwho click" data-open="${esc(p.uid)}">${esc(p.username ?? p.uid)}</div>
                  <div class="muted" style="font-size:11.5px">${how ? esc(arrival(how)) : "was already here"}</div>
                  <button class="btn ghost" data-jump="${p.firstSeen ?? 0}">Jump to their arrival</button>
                </div>`;
              })
              .join("")}
          </div>
        </div>
      </div>

      <div class="card">
        <header><h2>What was said</h2></header>
        <div id="feed" class="feed pad"></div>
      </div>

      <p class="muted" style="font-size:12px;margin-top:10px">
        Party ${esc(party.key)} · started ${when(party.startedAt)}${
          party.expiresAt ? ` · kept until ${when(party.expiresAt)}` : ""
        }
      </p>
    </div>`;
}

/** Rows for the lists on the Voice screen and a player's page. */
export const partyRow = (p: {
  key: string;
  room?: string;
  startedAt: string;
  live: boolean;
  members: number;
  voiceFiles: number;
  seconds: number;
  joinedAt?: number;
  roster: { uid: string; username: string | null }[];
}) =>
  `<tr class="click" data-key="${esc(p.key)}"${p.joinedAt ? ` data-at="${p.joinedAt}"` : ""}>
    <td><strong class="mono">${esc(p.room ?? p.key)}</strong></td>
    <td class="muted">${esc(p.roster.map((r) => r.username ?? r.uid).slice(0, 3).join(", "))}${
      p.roster.length > 3 ? ` +${p.roster.length - 3}` : ""
    }</td>
    <td class="muted">${when(p.startedAt)}</td>
    <td>${p.live ? pill("live", "on") : ""}</td>
    <td class="num">${p.members}</td>
    <td class="num muted">${Math.round(p.seconds / 60)}m</td>
    <td>${p.voiceFiles > 0 ? pill("voice", "warn") : ""}</td>
  </tr>`;

export async function loadParties(uid?: string, q?: string): Promise<Parameters<typeof partyRow>[0][]> {
  const params = new URLSearchParams();
  if (uid) params.set("uid", uid);
  if (q) params.set("q", q);
  const { parties } = await call<{ parties: Parameters<typeof partyRow>[0][] }>(
    `/parties${params.toString() ? `?${params}` : ""}`
  );
  return parties;
}
