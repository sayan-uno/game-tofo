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
import { emitAck } from "../api/socket";
import { startRenderLoop } from "../game/engine";
import type { LobbyScene } from "../game/lobbyScene";
import { toast } from "../ui/toast";
import { isMicEnabled, joinVoice, toggleMic } from "../voice/livekit";
import { getGameInfo, fetchGames } from "./gamesApi";
import { getLoadedPack, loadPack } from "./packLoader";
import { seedClock, serverToLocal, syncClock } from "./clock";
import type { GameRuntime, GameRuntimeContext } from "./types";
import {
  EV,
  type MatchEnd,
  type MatchGo,
  type MatchInputRelay,
  type MatchPrepare,
  type MatchResume,
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
  private controls: HTMLElement | null = null;
  private micBtn: HTMLButtonElement | null = null;
  private inputBuffer: MatchInputRelay[] = [];
  private entering: Promise<void> | null = null;

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
    this.controls.className = "match-controls";
    this.controls.innerHTML = `<button class="mx-mic" type="button"></button><button class="mx-leave" type="button">Leave</button>`;
    this.micBtn = this.controls.querySelector<HTMLButtonElement>(".mx-mic")!;
    this.paintMic();
    this.micBtn.onclick = () => {
      const btn = this.micBtn!;
      btn.disabled = true;
      void toggleMic()
        .catch(() => toast("Couldn't switch your microphone", true))
        .finally(() => {
          btn.disabled = false;
          this.paintMic();
        });
    };
    this.controls.querySelector<HTMLButtonElement>(".mx-leave")!.onclick = () => void this.leave();
    this.layer.appendChild(this.controls);
    document.getElementById("ui-root")!.appendChild(this.layer);

    const s = deps.socket;
    s.on(EV.prepare, (p: MatchPrepare | null) => {
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
      // async); keep them and replay in order once it exists.
      if (this.runtime) this.runtime.onRemoteInput(i);
      else this.inputBuffer.push(i);
    });
    s.on(EV.left, (p: { uid?: string } | null) => {
      if (p?.uid) this.runtime?.onLeft(p.uid);
    });
    s.on(EV.end, (e: MatchEnd | null) => {
      if (!e || e.matchId !== this.matchId) return;
      this.onEnd(e);
    });
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__tofoMatch = this;
  }

  get active(): boolean {
    return this.matchId !== null;
  }

  /** Dev-only introspection (stripped from production by the DEV guard below):
   *  what the running game says about itself, for headless test harnesses. */
  debug(): unknown {
    const rt = this.runtime as (GameRuntime & { debug?: () => unknown }) | null;
    return { matchId: this.matchId, phase: this.runtime ? "running" : "idle", game: rt?.debug?.() ?? null };
  }

  // ---- lifecycle ----

  private async enter(p: MatchPrepare | MatchResume): Promise<void> {
    if (this.entering) await this.entering.catch(() => {});
    if (this.matchId === p.matchId && this.runtime) return; // duplicate prepare
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
        assets: pack.assets,
        roster: p.roster,
        you: p.you,
        seed: p.seed,
        rules: p.rules,
        sendInput: (input) => this.deps.socket.emit(EV.input, input),
        requestLeave: () => void this.leave(),
        hudRoot: this.hudRoot,
      };
      const runtime = await pack.module.createRuntime(ctx);
      this.runtime = runtime;
      await runtime.prepare();
      // Resume: everything that happened before we arrived.
      if ("inputs" in p && p.inputs.length) runtime.seedInputs(p.inputs);
      for (const i of this.inputBuffer) runtime.onRemoteInput(i);
      this.inputBuffer = [];
      if ("left" in p) for (const uid of p.left) runtime.onLeft(uid);
      startRenderLoop(this.deps.engine, () => runtime.render());
      await clockDone;
      this.hideCurtain();
      // Voice follows the match: everyone in the roster shares one room now.
      void joinVoice(`M${p.matchId}`, (msg, isError) => toast(msg, isError), "match");
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
  private exit(): void {
    this.teardown();
    this.deps.onExit();
  }

  private teardown(): void {
    this.stopCountdown();
    this.hideCurtain();
    this.resultsEl?.remove();
    this.resultsEl = null;
    this.runtime?.dispose();
    this.runtime = null;
    this.hudRoot.replaceChildren();
    this.inputBuffer = [];
    this.matchId = null;
    this.layer.classList.add("hidden");
    this.deps.lobby.scene.attachControl();
    this.deps.restoreLobby();
  }

  // ---- overlays ----

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
    const headline =
      e.reason === "aborted"
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
          : "Match over";
    const rows = e.standings
      .map((s) => {
        const d = s.detail;
        const bits: string[] = [];
        if (typeof d.distance === "number") bits.push(`${d.distance} m`);
        if (typeof d.coins === "number" && d.coins > 0) bits.push(`🪙 ${d.coins}`);
        if (d.survived === 1) bits.push("finished");
        const xp = e.xp?.[s.uid] ?? 0;
        return `<tr class="${s.uid === this.deps.localUid ? "me" : ""}${s.forfeit ? " forfeit" : ""}">
          <td class="mr-place">${s.placement}</td>
          <td class="mr-name"></td>
          <td class="mr-score">${s.score}</td>
          <td class="mr-detail">${s.forfeit ? "left" : bits.join(" · ")}</td>
          <td class="mr-xp">${xp > 0 ? `+${xp} XP` : ""}</td>
        </tr>`;
      })
      .join("");
    el.innerHTML = `
      <div class="mr-card">
        <div class="mr-kicker">// Results</div>
        <h2 class="mr-title">${headline}</h2>
        <div class="mr-sub">${e.reason === "timeout" ? "Time's up" : e.reason === "all-out" ? "Everyone's out" : ""}</div>
        <table class="mr-table"><thead><tr><th>#</th><th>Runner</th><th>Score</th><th>Run</th><th></th></tr></thead><tbody>${rows}</tbody></table>
        <div class="mr-actions">
          <button class="btn btn-ghost mr-lobby">Back to lobby</button>
          ${this.deps.isPartyLeader() ? '<button class="btn btn-red mr-again">Play again</button>' : ""}
        </div>
      </div>`;
    // Names through textContent — never innerHTML — a username is user input.
    const nameCells = el.querySelectorAll<HTMLElement>(".mr-name");
    e.standings.forEach((s, i) => (nameCells[i].textContent = s.name));
    el.querySelector<HTMLButtonElement>(".mr-lobby")!.onclick = () => this.exit();
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
