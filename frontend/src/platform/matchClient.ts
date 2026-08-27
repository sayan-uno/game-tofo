// The match half of the platform on the client: from `match:prepare` to the
// results screen and back to the lobby.
//
// It owns the scene switch (the lobby is paused, never disposed — exactly the
// Collections page trick), the curtain, the countdown, clock sync, relaying
// inputs both ways between the socket and the game runtime, the results
// overlay, and the voice room switch (match room while it runs, party room
// again the moment it ends). The game runtime only draws and decides ticks.
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { Socket } from "socket.io-client";
import { api } from "../api/http";
import { emitAck } from "../api/socket";
import { startRenderLoop } from "../game/engine";
import type { LobbyScene } from "../game/lobbyScene";
import { toast } from "../ui/toast";
import { isMicEnabled, joinVoice, onMicChange, toggleMic } from "../voice/livekit";
import { getGameInfo, fetchGames } from "./gamesApi";
import { getLoadedPack, loadPack } from "./packLoader";
import { seedClock, serverToLocal, syncClock } from "./clock";
import type { GameRuntime, GameRuntimeContext } from "./types";
import {
  EV,
  LIVE_EV,
  type LiveClosing,
  type LiveEmote,
  type LivePin,
  type LiveRoster,
  type MatchEnd,
  type MatchGo,
  type MatchInputRelay,
  type MatchPrepare,
  type MatchResume,
  type MatchSearching,
  type MatchAddable,
  type MatchSync,
  type QuickKind,
  type QuickRelay,
  type RosterEntry,
  RESULTS_MS,
} from "../shared/core/protocol";

export interface MatchClientDeps {
  engine: Engine;
  socket: Socket;
  localUid: string;
  lobby: LobbyScene;
  /** Put the lobby's render loop back. */
  restoreLobby: () => void;
  /** The lobby HUD/state hooks: entering hides the lobby chrome, leaving
   *  restores it (and re-evaluates party voice). */
  onEnter: () => void;
  onExit: () => void;
  isPartyLeader: () => boolean;
}

export class MatchClient {
  private runtime: GameRuntime | null = null;
  private matchId: string | null = null;
  private layer: HTMLElement;
  private hudRoot: HTMLElement;
  private curtain: HTMLElement | null = null;
  private countdownEl: HTMLElement | null = null;
  private countdownRaf = 0;
  private resultsEl: HTMLElement | null = null;
  /** Counts the results screen down and then takes everybody home. */
  private resultsTimer = 0;
  private searchEl: HTMLElement | null = null;
  private searchTimer = 0;
  private controls: HTMLElement | null = null;
  private micBtn: HTMLButtonElement | null = null;
  /** Dropped when the controls are rebuilt, so a match does not leave a
   *  listener behind pointing at a button that is no longer on the page. */
  private stopMicWatch: (() => void) | null = null;
  private inputBuffer: MatchInputRelay[] = [];
  /** How many of each runner's inputs the game has actually been given.
   *
   *  A socket that drops for three seconds misses every input relayed in those
   *  three seconds, and nothing replays them: the server pushes a resume
   *  carrying the whole log, but until now the client threw it away whenever it
   *  was for the match it was already in. A runner game survives that (each
   *  player simulates alone, and the server's replay is the result of record);
   *  a game where players share a board does not — its board is simply wrong
   *  from then on, on that one screen, for ever.
   *
   *  Counting per uid is enough to work out what was missed, because a runner's
   *  inputs keep their order both in the server's log and on the wire. */
  private delivered = new Map<string, number>();
  private entering: Promise<void> | null = null;
  /** The last roster a drop-in world sent while the scene was still being
   *  built. Kept rather than dropped: it is the WHOLE roster, so replaying
   *  only the newest one is exactly right, and losing it would leave a world
   *  drawing people who have already walked out. */
  private pendingRoster: { roster: RosterEntry[]; endsAt: number; party: string[] } | null = null;

  constructor(private deps: MatchClientDeps) {
    // One DOM layer for everything match-related, above the canvas and the
    // (hidden) lobby HUD. Games get a child of it for their own HUD.
    this.layer = document.createElement("div");
    this.layer.className = "match-layer hidden";
    this.hudRoot = document.createElement("div");
    this.hudRoot.className = "match-hud-root";
    this.layer.appendChild(this.hudRoot);

    // Voice and leaving are PLATFORM concerns, not per-game ones: every game
    // gets a mic toggle and a way out without implementing either. Mic state
    // is the one the lobby left behind (it survives the room switch), so a
    // player who muted in the lobby stays muted into the match.
    this.controls = document.createElement("div");
    // Hidden until a match is actually being played. The layer also carries
    // the matchmaking screen, and these belong to a RUNNING match — showing
    // them while searching put a second mic button over the lobby's own.
    this.controls.className = "match-controls hidden";
    this.controls.innerHTML = `<button class="mx-mic" type="button"></button><button class="mx-leave" type="button">Leave</button>`;
    this.micBtn = this.controls.querySelector<HTMLButtonElement>(".mx-mic")!;
    // Same source as the lobby's button, so the two can never disagree about
    // whether this player is being heard.
    this.stopMicWatch?.();
    this.stopMicWatch = onMicChange(() => this.paintMic());
    this.micBtn.onclick = () => {
      const btn = this.micBtn!;
      btn.disabled = true;
      void toggleMic()
        .catch(() => toast("Couldn't switch your microphone", true))
        .finally(() => {
          btn.disabled = false;
        });
    };
    this.controls.querySelector<HTMLButtonElement>(".mx-leave")!.onclick = () => void this.leave();
    this.layer.appendChild(this.controls);
    document.getElementById("ui-root")!.appendChild(this.layer);

    const s = deps.socket;
    // Every time the transport comes back, settle the one question a client
    // cannot answer on its own: am I still in this match?
    //
    // The server pushes a resume when there IS one, so silence is ambiguous —
    // it means either "not in a match" or "the push has not arrived yet", and
    // a client that assumes the wrong one either drops a player out of a live
    // run or leaves them watching a run they were forfeited from. Asking
    // removes the ambiguity: away long enough and the answer is a plain no.
    s.on("connect", () => void this.resync());
    s.on(EV.searching, (p: MatchSearching | null) => {
      if (p) this.showSearching(p);
    });
    s.on(EV.searchEnded, (p: { reason?: string; by?: { uid: string; name: string } } | null) => {
      this.hideSearching();
      // Say WHO stopped it. A search that vanishes on its own reads as a bug;
      // a search that somebody cancelled reads as a teammate changing their
      // mind, which is the whole point of letting them.
      const by = p?.by;
      if (by && by.uid !== this.deps.localUid) toast(`${by.name} stopped the search`);
    });
    s.on(EV.objection, (p: { uid?: string; name?: string } | null) => {
      if (!p?.name || p.uid === this.deps.localUid) return;
      toast(`${p.name} would rather play something else`);
    });
    s.on(EV.quick, (q: QuickRelay | null) => {
      if (!q || typeof q.uid !== "string") return;
      (this.runtime as (GameRuntime & { onQuick?: (u: string, k: QuickKind, i: string) => void }) | null)
        ?.onQuick?.(q.uid, q.kind, q.id);
    });
    s.on(EV.prepare, (p: MatchPrepare | null) => {
      // Found — the search screen gives way to the match.
      this.hideSearching();
      if (p?.matchId) void this.enter(p);
    });
    s.on(EV.resume, (p: MatchResume | null) => {
      if (p?.matchId) void this.enter(p);
    });
    s.on(EV.go, (g: MatchGo | null) => {
      if (!g || g.matchId !== this.matchId) return;
      seedClock(g.serverNow);
      this.go(g.startAt);
    });
    s.on(EV.input, (i: MatchInputRelay | null) => {
      if (!i || typeof i.uid !== "string") return;
      // Inputs can land while the runtime is still being built (prepare is
      // async); keep them and replay in order once it exists. Only while a
      // match is actually being entered, though — one that arrives after a
      // teardown belongs to a match that is over, and a buffer nothing clears
      // would hand it to the NEXT one.
      if (this.runtime) this.hand(i);
      else if (this.matchId) this.inputBuffer.push(i);
    });
    s.on(EV.left, (p: { uid?: string } | null) => {
      if (p?.uid) this.runtime?.onLeft(p.uid);
    });
    s.on(EV.end, (e: MatchEnd | null) => {
      if (!e || e.matchId !== this.matchId) return;
      this.onEnd(e);
    });

    // ---- drop-in worlds ---------------------------------------------------
    // Three channels a fixed-roster match has no use for and never sees. All
    // of them are handed straight to the game: the platform has no opinion
    // about what a position means.
    s.on(LIVE_EV.snap, (p: unknown) => {
      // No matchId check: a snapshot is ten a second and carries no id, which
      // is the whole reason it is cheap. It is only ever sent to the room of
      // the world you are standing in, and a runtime that has been torn down
      // is null here anyway.
      this.runtime?.onSnap?.(p);
    });
    s.on(LIVE_EV.roster, (p: LiveRoster | null) => {
      if (!p || p.matchId !== this.matchId || !Array.isArray(p.roster)) return;
      const party = Array.isArray(p.party) ? p.party : [];
      if (this.runtime) this.runtime.onRoster?.(p.roster, p.endsAt, party);
      else this.pendingRoster = { roster: p.roster, endsAt: p.endsAt, party };
    });
    s.on(LIVE_EV.pinned, (p: LivePin | null) => {
      if (!p || typeof p.uid !== "string") return;
      this.runtime?.onPin?.(p.uid, typeof p.x === "number" ? p.x : null, typeof p.z === "number" ? p.z : null);
    });
    s.on(LIVE_EV.closing, (p: LiveClosing | null) => {
      if (!p || p.matchId !== this.matchId) return;
      this.runtime?.onClosing?.(p.at);
    });
    s.on(LIVE_EV.emoted, (p: LiveEmote | null) => {
      if (!p || typeof p.uid !== "string") return;
      this.runtime?.onEmote?.(p.uid, String(p.id ?? ""));
    });
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__tofoMatch = this;
  }

  get active(): boolean {
    return this.matchId !== null;
  }

  /** True while the party is queued — the lobby uses it to keep START busy. */
  get searching(): boolean {
    return this.searchEl !== null;
  }

  /** Called by the lobby when the leader presses START and the server answers
   *  "searching": the screen appears immediately rather than on the first
   *  server tick, so the press feels answered. */
  beginSearch(size: number, found: number): void {
    this.showSearching({ found, size, elapsedMs: 0, deadlineMs: 10_000 });
  }

  cancelSearch(): void {
    this.hideSearching();
    void emitAck(EV.cancel).then((res) => {
      if (res.error) toast(res.error, true);
    });
  }

  /** Dev-only introspection (stripped from production by the DEV guard below):
   *  what the running game says about itself, for headless test harnesses. */
  debug(): unknown {
    const rt = this.runtime as (GameRuntime & { debug?: () => unknown }) | null;
    return { matchId: this.matchId, phase: this.runtime ? "running" : "idle", game: rt?.debug?.() ?? null };
  }

  // ---- lifecycle ----

  /** Give one input to the game, and remember that we did. */
  private hand(i: MatchInputRelay): void {
    this.runtime?.onRemoteInput(i);
    this.delivered.set(i.uid, (this.delivered.get(i.uid) ?? 0) + 1);
  }

  /** A resume for the match we are ALREADY in: play in whatever was relayed
   *  while we were not listening. Everything before that we have had, so only
   *  the tail of each runner's log is new. */
  private catchUp(p: MatchPrepare | MatchResume): void {
    if (!this.runtime || !("inputs" in p)) return;
    const seen = new Map<string, number>();
    let missed = 0;
    for (const i of p.inputs) {
      const n = (seen.get(i.uid) ?? 0) + 1;
      seen.set(i.uid, n);
      if (n <= (this.delivered.get(i.uid) ?? 0)) continue;
      this.hand(i);
      missed++;
    }
    if ("left" in p) for (const uid of p.left) this.runtime.onLeft(uid);
    if (missed) console.info(`[match] caught up on ${missed} input(s) missed while offline`);
  }

  private async enter(p: MatchPrepare | MatchResume): Promise<void> {
    if (this.entering) await this.entering.catch(() => {});
    // Already in this one: not a duplicate prepare to ignore, but a chance to
    // find out what we missed.
    if (this.matchId === p.matchId && this.runtime) {
      this.catchUp(p);
      return;
    }
    if (this.matchId && this.matchId !== p.matchId) this.teardown();
    this.matchId = p.matchId;
    seedClock(p.serverNow);
    this.entering = this.build(p).finally(() => {
      this.entering = null;
    });
    await this.entering;
  }

  private async build(p: MatchPrepare | MatchResume): Promise<void> {
    this.deps.onEnter();
    this.layer.classList.remove("hidden");
    this.controls?.classList.remove("hidden");
    this.paintMic();
    this.showCurtain("Preparing match…");
    // Clock samples run alongside scene construction — both take a moment.
    const clockDone = syncClock(5);
    try {
      // The pack is normally already here (START required it) — this is a
      // guard for the resume path and for a leader who won a race.
      let pack = getLoadedPack(p.gameId);
      if (!pack) {
        const info = getGameInfo(p.gameId) ?? (await fetchGames(true)).find((g) => g.id === p.gameId);
        if (!info) throw new Error("This game isn't available in this version");
        pack = await loadPack(info, { onProgress: (pct) => this.showCurtain(`Downloading… ${pct}%`) });
      }
      const canvas = this.deps.engine.getRenderingCanvas() as HTMLCanvasElement;
      this.deps.lobby.scene.detachControl();
      const ctx: GameRuntimeContext = {
        engine: this.deps.engine,
        canvas,
        matchId: p.matchId,
        assets: pack.assets,
        roster: p.roster,
        you: p.you,
        seed: p.seed,
        rules: p.rules,
        sendInput: (input) => {
          this.deps.socket.emit(EV.input, input);
          // Counted as delivered: a game that predicts its own input has
          // already applied it, so a later catch-up must not hand it back.
          const uid = this.deps.localUid;
          this.delivered.set(uid, (this.delivered.get(uid) ?? 0) + 1);
        },
        sendQuick: (kind, id) => this.deps.socket.emit(EV.quick, { kind, id }),
        // Fire-and-forget by design: a position that failed to send is
        // replaced by the next one a tenth of a second later, and a retry
        // would deliver a place the player is no longer standing in.
        sendState: (payload) => this.deps.socket.emit(LIVE_EV.state, payload),
        sendEmote: (id) => emitAck<{ ok?: boolean; error?: string }>(LIVE_EV.emote, { id }),
        sendPin: (at) => this.deps.socket.emit(LIVE_EV.pin, at ?? {}),
        requestLeave: () => void this.leave(),
        hudRoot: this.hudRoot,
      };
      const runtime = await pack.module.createRuntime(ctx);
      this.runtime = runtime;
      await runtime.prepare();
      // Resume: everything that happened before we arrived.
      if ("inputs" in p && p.inputs.length) {
        runtime.seedInputs(p.inputs);
        for (const i of p.inputs) this.delivered.set(i.uid, (this.delivered.get(i.uid) ?? 0) + 1);
      }
      for (const i of this.inputBuffer) this.hand(i);
      this.inputBuffer = [];
      if (this.pendingRoster) {
        runtime.onRoster?.(this.pendingRoster.roster, this.pendingRoster.endsAt, this.pendingRoster.party);
        this.pendingRoster = null;
      }
      if ("left" in p) for (const uid of p.left) runtime.onLeft(uid);
      startRenderLoop(this.deps.engine, () => runtime.render());
      await clockDone;
      this.hideCurtain();
      // Voice follows the match: everyone in the roster shares one room now.
      // A game may ask for that room to be a PLACE instead — see GameModule.
      const proximity = pack.module.voice === "proximity";
      void joinVoice(`M${p.matchId}`, (msg, isError) => toast(msg, isError), "match", { proximity });
      if ("startAt" in p && p.startAt !== null) {
        this.go(p.startAt);
      } else {
        void emitAck(EV.ready).then((res) => {
          if (res.error) toast(res.error, true);
        });
      }
    } catch (err) {
      console.error("[match] could not enter", err);
      toast(err instanceof Error ? err.message : "Couldn't join the match", true);
      await this.leave();
    }
  }

  private go(serverStartAt: number): void {
    const local = serverToLocal(serverStartAt);
    this.runtime?.go(local);
    this.runCountdown(local);
  }

  private onEnd(e: MatchEnd): void {
    this.stopCountdown();
    this.runtime?.end(e);
    this.showResults(e);
  }

  /** Player chose to leave (or the entry failed): tell the server, go home. */
  private async leave(): Promise<void> {
    try {
      await emitAck(EV.leave);
    } catch {
      /* the socket is gone; the server's grace timer will do the rest */
    }
    this.exit();
  }

  /** Back to the lobby: dispose the game, restore the lobby scene + chrome. */
  /** Reconcile with the server after the socket comes back. */
  private async resync(): Promise<void> {
    if (!this.matchId) return;
    const mine = this.matchId;
    try {
      const res = await emitAck<MatchSync>(EV.sync);
      if (this.matchId !== mine) return; // moved on while we asked
      if (res.in) {
        // Still ours — and `enter` knows the difference between the match we
        // are in (catch up on what we missed) and a new one the party started
        // while we were away (take that one instead).
        void this.enter(res.resume);
        return;
      }
      toast("You were offline too long — the match went on without you", true);
      this.exit();
    } catch {
      // No answer at all: the connection is still unhealthy. Leave the match
      // on screen and try again on the next connect rather than throwing a
      // player out of a run over one failed round trip.
    }
  }

  /** Put an "Add" button next to the people from this match you could befriend.
   *
   *  Asked after the table is drawn rather than before, so the results appear
   *  the instant the match ends and the buttons arrive a moment later —
   *  waiting on a round trip to show a scoreboard would be the wrong trade.
   *  Nothing is shown at all if the answer is empty, which is also the answer
   *  for a lobby full of bots. */
  /** A report button on every row except your own.
   *
   *  Offered for EVERY other player, including the ones no friend request is
   *  offered for. Bots look exactly like people on this table by design, and a
   *  button that quietly vanished for three of six rows would announce which
   *  three. The server takes a report about a bot, answers the same sentence,
   *  and writes nothing.
   *
   *  The sheet deliberately outlives the results screen: the countdown takes
   *  everybody back to the lobby on its own clock, and losing what somebody
   *  was typing because a timer fired would be a worse bug than a dialog
   *  sitting over the lobby for a moment.
   */
  private offerReports(el: HTMLElement, e: MatchEnd): void {
    for (const s of e.standings) {
      if (s.uid === this.deps.localUid) continue;
      const cell = el.querySelector<HTMLElement>(`tr[data-uid="${CSS.escape(s.uid)}"] .mr-add`);
      if (!cell) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mr-report-btn";
      btn.textContent = "⚑";
      btn.title = `Report ${s.name}`;
      btn.setAttribute("aria-label", `Report ${s.name}`);
      btn.onclick = () => {
        void import("../ui/report").then(({ openReport }) =>
          openReport({ uid: s.uid, name: s.name, matchId: e.matchId })
        );
      };
      cell.appendChild(btn);
    }
  }

  private offerFriendRequests(el: HTMLElement, matchId: string): void {
    void emitAck<MatchAddable>(EV.addable, { matchId })
      .then(({ uids }) => {
        for (const uid of uids ?? []) {
          const cell = el.querySelector<HTMLElement>(`tr[data-uid="${CSS.escape(uid)}"] .mr-add`);
          if (!cell) continue;
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "mr-add-btn";
          btn.textContent = "+ Add";
          btn.onclick = () => {
            btn.disabled = true;
            btn.textContent = "…";
            void api
              .post("/api/friends/request", { uid })
              .then(() => {
                btn.textContent = "Sent";
                btn.classList.add("sent");
              })
              .catch((err: unknown) => {
                btn.remove();
                toast(err instanceof Error ? err.message : "Could not send the request", true);
              });
          };
          cell.appendChild(btn);
        }
      })
      .catch(() => {
        // No answer: leave the table as it is. A missing button is a
        // non-event; a broken results screen is not.
      });
  }

  private exit(): void {
    this.teardown();
    this.deps.onExit();
  }

  private teardown(): void {
    this.hideSearching();
    this.controls?.classList.add("hidden");
    this.stopCountdown();
    this.hideCurtain();
    window.clearInterval(this.resultsTimer);
    this.resultsTimer = 0;
    this.resultsEl?.remove();
    this.resultsEl = null;
    this.runtime?.dispose();
    this.runtime = null;
    this.hudRoot.replaceChildren();
    this.inputBuffer = [];
    this.pendingRoster = null;
    this.delivered.clear();
    this.matchId = null;
    this.layer.classList.add("hidden");
    this.deps.lobby.scene.attachControl();
    this.deps.restoreLobby();
  }

  // ---- overlays ----

  /** "Searching for players" — a count that fills, an honest clock, and a way
   *  out. No mention of bots: the seats simply fill. */
  private showSearching(p: MatchSearching): void {
    if (this.matchId) return; // already in a match; a stale tick, ignore
    this.layer.classList.remove("hidden");
    if (!this.searchEl) {
      const el = document.createElement("div");
      el.className = "match-search";
      el.innerHTML = `
        <div class="ms-card">
          <div class="ms-kicker">// Matchmaking</div>
          <h2 class="ms-title">FINDING PLAYERS</h2>
          <div class="ms-dots"></div>
          <div class="ms-count"><span class="ms-found">1</span><span class="ms-of">/</span><span class="ms-size">4</span></div>
          <div class="ms-elapsed">0:00</div>
          <button class="btn btn-ghost ms-cancel" type="button">Cancel</button>
          ${this.deps.isPartyLeader() ? "" : '<div class="ms-note">Anyone can stop the search</div>'}
        </div>`;
      this.layer.appendChild(el);
      this.searchEl = el;
      el.querySelector<HTMLButtonElement>(".ms-cancel")?.addEventListener("click", () => this.cancelSearch());
      // The clock runs locally between server ticks so it never looks stuck.
      const startedAt = Date.now() - p.elapsedMs;
      this.searchTimer = window.setInterval(() => {
        const secs = Math.floor((Date.now() - startedAt) / 1000);
        const t = el.querySelector<HTMLElement>(".ms-elapsed");
        if (t) t.textContent = `0:${String(secs).padStart(2, "0")}`;
      }, 250);
    }
    const el = this.searchEl;
    el.querySelector<HTMLElement>(".ms-found")!.textContent = String(p.found);
    el.querySelector<HTMLElement>(".ms-size")!.textContent = String(p.size);
    const dots = el.querySelector<HTMLElement>(".ms-dots")!;
    if (dots.childElementCount !== p.size) {
      dots.replaceChildren();
      for (let i = 0; i < p.size; i++) {
        const d = document.createElement("span");
        d.className = "ms-dot";
        dots.appendChild(d);
      }
    }
    dots.querySelectorAll<HTMLElement>(".ms-dot").forEach((d, i) => d.classList.toggle("on", i < p.found));
  }

  private hideSearching(): void {
    clearInterval(this.searchTimer);
    this.searchTimer = 0;
    this.searchEl?.remove();
    this.searchEl = null;
    if (!this.matchId) this.layer.classList.add("hidden");
  }

  private paintMic(): void {
    const btn = this.micBtn;
    if (!btn) return;
    const on = isMicEnabled();
    btn.textContent = on ? "🎙 On" : "🎙 Off";
    btn.classList.toggle("muted", !on);
    btn.title = on ? "Mute your microphone" : "Unmute your microphone";
  }

  private showCurtain(text: string): void {
    if (!this.curtain) {
      this.curtain = document.createElement("div");
      this.curtain.className = "match-curtain";
      this.curtain.innerHTML = `<img src="/logo-red.png" alt="" width="56" height="56" /><div class="mc-text"></div>`;
      this.layer.appendChild(this.curtain);
    }
    this.curtain.querySelector(".mc-text")!.textContent = text;
  }

  private hideCurtain(): void {
    this.curtain?.remove();
    this.curtain = null;
  }

  /** 3 · 2 · 1 · GO on the synced clock — one rAF loop that repaints only when
   *  the number changes, gone a moment after GO. */
  private runCountdown(localStartAt: number): void {
    this.stopCountdown();
    const el = document.createElement("div");
    el.className = "match-countdown";
    el.innerHTML = `<div class="mcd-num"></div>`;
    this.layer.appendChild(el);
    this.countdownEl = el;
    const num = el.querySelector<HTMLElement>(".mcd-num")!;
    let shown = "";
    const tick = () => {
      const remain = localStartAt - Date.now();
      let text: string;
      if (remain > 0) text = String(Math.ceil(remain / 1000));
      else if (remain > -900) text = "GO";
      else {
        this.stopCountdown();
        return;
      }
      if (text !== shown) {
        shown = text;
        num.textContent = text;
        num.classList.remove("pop");
        void num.offsetWidth; // restart the pop animation
        num.classList.add("pop");
      }
      this.countdownRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  private stopCountdown(): void {
    cancelAnimationFrame(this.countdownRaf);
    this.countdownRaf = 0;
    this.countdownEl?.remove();
    this.countdownEl = null;
  }

  private showResults(e: MatchEnd): void {
    this.resultsEl?.remove();
    const el = document.createElement("div");
    el.className = "match-results";
    const me = e.standings.find((s) => s.uid === this.deps.localUid);
    // The game gets first refusal on the wording: the platform knows who came
    // where, but only the game knows what winning looked like.
    const own = this.runtime?.resultsHeadline?.(e, this.deps.localUid) ?? null;
    const headline =
      own?.headline ??
      (e.reason === "aborted"
        ? "Match aborted"
        : e.reason === "all-out" && me?.placement === 1 && e.standings.filter((s) => s.placement === 1).length === 1
          ? "Last one running"
        : me
          ? me.forfeit
            ? "You left the match"
            : me.placement === 1
              ? e.standings.filter((s) => s.placement === 1).length > 1
                ? "Draw"
                : "You win!"
              : `#${me.placement}`
          : "Match over");
    const sub = own?.sub ?? (e.reason === "timeout" ? "Time's up" : e.reason === "all-out" ? "Everyone's out" : "");
    const rows = e.standings
      .map((s) => {
        const d = s.detail;
        const bits: string[] = [];
        if (typeof d.distance === "number") bits.push(`${d.distance} m`);
        if (typeof d.coins === "number" && d.coins > 0) bits.push(`🪙 ${d.coins}`);
        if (d.survived === 1) bits.push("finished");
        // A game may describe its own row; the runner-shaped bits above are
        // the fallback for one that does not.
        const detail = this.runtime?.describeStanding?.(s) ?? bits.join(" · ");
        const xp = e.xp?.[s.uid] ?? 0;
        return `<tr class="${s.uid === this.deps.localUid ? "me" : ""}${s.forfeit ? " forfeit" : ""}" data-uid="${s.uid}">
          <td class="mr-place">${s.placement}</td>
          <td class="mr-name"></td>
          <td class="mr-score">${s.score}</td>
          <td class="mr-detail">${s.forfeit ? "left" : detail}</td>
          <td class="mr-xp">${xp > 0 ? `+${xp} XP` : ""}</td>
          <td class="mr-add"></td>
        </tr>`;
      })
      .join("");
    el.innerHTML = `
      <div class="mr-card">
        <div class="mr-kicker">// Results</div>
        <h2 class="mr-title">${headline}</h2>
        <div class="mr-sub">${sub}</div>
        <table class="mr-table"><thead><tr><th>#</th><th>Player</th><th>Score</th><th></th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>
        <div class="mr-actions">
          <span class="mr-countdown"></span>
          <button class="btn btn-ghost mr-lobby">Back to lobby</button>
          ${this.deps.isPartyLeader() ? '<button class="btn btn-red mr-again">Play again</button>' : ""}
        </div>
      </div>`;
    // Names through textContent — never innerHTML — a username is user input.
    const nameCells = el.querySelectorAll<HTMLElement>(".mr-name");
    e.standings.forEach((s, i) => (nameCells[i].textContent = s.name));
    this.offerFriendRequests(el, e.matchId);
    this.offerReports(el, e);
    el.querySelector<HTMLButtonElement>(".mr-lobby")!.onclick = () => this.exit();

    // EVERYBODY GOES BACK, on a clock they can see.
    //
    // A scoreboard left up until somebody presses a button is a match that
    // never ends: the party cannot start another one while a member is still
    // sitting on it, and — for a table with a flagged player at it — the
    // recording has to be closed at a moment the server can predict rather
    // than whenever the last person gets bored. Counted down out loud so it
    // does not read as the game throwing them out.
    const back = el.querySelector<HTMLElement>(".mr-countdown");
    let left = Math.ceil(RESULTS_MS / 1000);
    const tick = () => {
      if (back) back.textContent = `Back to the lobby in ${left}…`;
      if (left <= 0) {
        window.clearInterval(this.resultsTimer);
        this.resultsTimer = 0;
        this.exit();
        return;
      }
      left--;
    };
    window.clearInterval(this.resultsTimer);
    tick();
    this.resultsTimer = window.setInterval(tick, 1000);
    el.querySelector<HTMLButtonElement>(".mr-again")?.addEventListener("click", () => {
      this.exit();
      void emitAck(EV.start).then((res) => {
        if (res.error) toast(res.error, true);
      });
    });
    this.layer.appendChild(el);
    this.resultsEl = el;
  }
}
