// The lobby half of the game platform: which game the party picked, how far
// every member's download is, and whether START may be pressed.
//
// One instance per session. It owns the pack download for the picked game
// (cancelling it the moment the pick changes), reports the local player's
// progress to the server no faster than PROGRESS_MAX_HZ, mirrors everyone's
// progress onto the lobby name plates, and derives the START button state:
// leader + game picked + every member at 100 % + not already in a match.
import type { Socket } from "socket.io-client";
import { emitAck } from "../api/socket";
import type { LobbyScene } from "../game/lobbyScene";
import type { Hud } from "../ui/hud";
import { openGameSheet } from "../ui/gameSheet";
import { toast } from "../ui/toast";
import type { GameInfo, LobbyState } from "../types";
import { EV, PROGRESS_MAX_HZ } from "../shared/core/protocol";
import { fetchGames } from "./gamesApi";
import { isPackCached, loadPack } from "./packLoader";

export interface LobbyGameDeps {
  hud: Hud;
  lobby: LobbyScene;
  localUid: string;
  socket: Socket;
  /** Shows the "finding players" screen when the server queues the party. */
  onSearching: (size: number, found: number) => void;
}

export class LobbyGameController {
  private selected: string | null = null;
  private info: GameInfo | null = null;
  private members: LobbyState["members"] = [];
  private isLeader = false;
  private leaderName = "";
  private pcts = new Map<string, number>();
  private myPct = 0;
  private failed = false;
  private abort: AbortController | null = null;
  private inMatch = false;
  private starting = false;
  private lastSentAt = 0;
  private sendTimer = 0;
  private pendingPct: number | null = null;

  constructor(private deps: LobbyGameDeps) {
    // Warm the game list while the device is idle so the picker opens instantly.
    void fetchGames().catch(() => {});
  }

  /** The room's state changed (members, pick, progress snapshot). */
  onLobbyState(state: LobbyState): void {
    this.members = state.members;
    this.isLeader = state.lobbyId === `L${this.deps.localUid}`;
    this.leaderName = state.members.find((m) => m.isLeader)?.name ?? "the leader";
    const game = state.game ?? null;
    // Server-side snapshot of everyone's progress. Ours is authoritative here
    // (we know exactly how far we are), theirs comes from the server.
    const seen = new Set<string>();
    for (const [uid, pct] of Object.entries(state.loading ?? {})) {
      if (uid !== this.deps.localUid) this.pcts.set(uid, pct);
      seen.add(uid);
    }
    for (const uid of [...this.pcts.keys()]) {
      if (!state.members.some((m) => m.uid === uid)) this.pcts.delete(uid);
    }
    if (game !== this.selected) this.switchGame(game);
    // A member who joined after we hit 100 % has no idea we're done — the
    // server's snapshot has us, but only if the report landed; re-send cheaply.
    if (game && this.myPct === 100 && !seen.has(this.deps.localUid)) this.sendProgress(100, true);
    this.paint();
  }

  /** Live progress from a squadmate. */
  onLoading(uid: string, pct: number): void {
    if (uid === this.deps.localUid || !this.selected) return;
    this.pcts.set(uid, pct);
    this.deps.lobby.setLoading(uid, pct);
    this.paintStart();
  }

  setInMatch(on: boolean): void {
    this.inMatch = on;
    this.paintStart();
  }

  /** Leader tapped CHOOSE GAME. */
  async openSheet(): Promise<void> {
    let games: GameInfo[];
    try {
      games = await fetchGames(true);
    } catch {
      toast("Couldn't load the game list", true);
      return;
    }
    openGameSheet({
      games,
      selectedId: this.selected,
      canPick: this.isLeader && !this.inMatch,
      isCached: isPackCached,
      onPick: (gameId) => {
        void emitAck(EV.pickGame, { gameId }).then((res) => {
          if (res.error) toast(res.error, true);
        });
      },
    });
  }

  /** Leader tapped START. */
  async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.paintStart();
    try {
      const res = await emitAck<{ ok?: boolean; error?: string; searching?: boolean; size?: number }>(EV.start);
      if (res.error) toast(res.error, true);
      else if (res.searching) this.deps.onSearching(res.size ?? 0, this.members.length);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not start", true);
    } finally {
      this.starting = false;
      this.paintStart();
    }
  }

  // ---- internals ----

  private switchGame(gameId: string | null): void {
    this.abort?.abort();
    this.abort = null;
    this.selected = gameId;
    this.info = null;
    this.failed = false;
    this.myPct = 0;
    this.pcts.clear();
    if (!gameId) {
      for (const m of this.members) this.deps.lobby.setLoading(m.uid, null);
      return;
    }
    void this.download(gameId);
  }

  private async download(gameId: string): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    this.failed = false;
    try {
      const games = await fetchGames();
      const info = games.find((g) => g.id === gameId) ?? (await fetchGames(true)).find((g) => g.id === gameId);
      if (abort.signal.aborted) return;
      if (!info) throw new Error("This game isn't available in this version");
      this.info = info;
      this.paint();
      this.setMyPct(0);
      await loadPack(info, {
        signal: abort.signal,
        onProgress: (pct) => {
          if (!abort.signal.aborted) this.setMyPct(pct);
        },
      });
      if (abort.signal.aborted) return;
      this.setMyPct(100);
    } catch (err) {
      if (abort.signal.aborted) return;
      this.failed = true;
      console.warn("[pack] download failed", err);
      this.deps.lobby.setLoading(this.deps.localUid, -1);
      this.paintStart();
    }
  }

  private setMyPct(pct: number): void {
    this.myPct = pct;
    this.deps.lobby.setLoading(this.deps.localUid, pct);
    this.sendProgress(pct, pct === 100 || pct === 0);
    this.paintStart();
  }

  /** ≤ PROGRESS_MAX_HZ on the wire; 0 and 100 go out immediately (100 is what
   *  unblocks the leader's START, so it must never sit in a throttle). */
  private sendProgress(pct: number, urgent: boolean): void {
    const minGap = 1000 / PROGRESS_MAX_HZ;
    const now = Date.now();
    const emit = () => {
      this.lastSentAt = Date.now();
      this.pendingPct = null;
      this.deps.socket.emit(EV.progress, { pct });
    };
    if (urgent || now - this.lastSentAt >= minGap) {
      clearTimeout(this.sendTimer);
      this.sendTimer = 0;
      emit();
      return;
    }
    this.pendingPct = pct;
    if (!this.sendTimer) {
      this.sendTimer = window.setTimeout(() => {
        this.sendTimer = 0;
        if (this.pendingPct !== null) {
          const p = this.pendingPct;
          this.lastSentAt = Date.now();
          this.pendingPct = null;
          this.deps.socket.emit(EV.progress, { pct: p });
        }
      }, minGap - (now - this.lastSentAt));
    }
  }

  private allReady(): { ready: number; total: number } {
    let ready = 0;
    for (const m of this.members) {
      const pct = m.uid === this.deps.localUid ? this.myPct : (this.pcts.get(m.uid) ?? 0);
      if (pct >= 100) ready++;
    }
    return { ready, total: this.members.length };
  }

  private paint(): void {
    this.deps.hud.setGame({ name: this.selected ? (this.info?.name ?? "…") : null, isLeader: this.isLeader });
    for (const m of this.members) {
      if (!this.selected) this.deps.lobby.setLoading(m.uid, null);
      else if (m.uid === this.deps.localUid) this.deps.lobby.setLoading(m.uid, this.failed ? -1 : this.myPct);
      else this.deps.lobby.setLoading(m.uid, this.pcts.get(m.uid) ?? 0);
    }
    this.paintStart();
  }

  private paintStart(): void {
    const { ready, total } = this.allReady();
    const everyoneReady = this.selected !== null && total > 0 && ready === total;
    let hint: string | null = null;
    let retry: (() => void) | undefined;
    if (this.inMatch) hint = "Match in progress";
    else if (!this.selected) hint = this.isLeader ? "Choose a game to start" : "Leader picks the game";
    else if (this.failed) {
      hint = "Download failed";
      retry = () => {
        if (this.selected) void this.download(this.selected);
      };
    } else if (!everyoneReady) hint = `Downloading… ${ready}/${total} ready`;
    else if (!this.isLeader) hint = `Waiting for ${this.leaderName} to start`;
    this.deps.hud.setStart({
      enabled: this.isLeader && everyoneReady && !this.inMatch && !this.starting,
      busy: this.starting,
      hint,
      retry,
    });
  }
}
