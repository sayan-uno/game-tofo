import { clearSession } from "../api/http";
import { disconnectSocket } from "../api/socket";
import { onMicChange, toggleMic } from "../voice/livekit";
import { toast } from "./toast";
import { setAvatar } from "./avatar";
import { setNameView } from "./nameview";
import type { LobbyMode, User } from "../types";

export interface HudCallbacks {
  onToggleFriends: () => void;
  onToggleChat: () => void;
  /** Tapping the player chip opens the career page. */
  onOpenProfile: () => void;
  /** Characters and emotes the player owns. */
  onOpenCollection: () => void;
  /** The list of notices this player has been sent, read back from the
   *  server — a message seen once is a message half of them will say they
   *  never got. */
  onOpenNotices: () => void;
  /** What is on: banners, clips, anything the platform wants seen. */
  onOpenEvents: () => void;
  onLeaveLobby: () => void;
  onChangeMode: (mode: LobbyMode) => void;
  /** Resolves after the server answered (errors already toasted by the caller). */
  onJoinByCode: (code: string) => Promise<void>;
  /** Reveal the party's code (created on first ask); reset=true mints a new one. */
  onTeamCode: (reset: boolean) => Promise<void>;
  /** CHOOSE GAME — opens the game sheet (members can look, leader picks). */
  onChooseGame: () => void;
  /** START — leader only, lit once every member has the game downloaded. */
  onStart: () => void;
  /** A member agreeing (or withdrawing) — the leader cannot press START until
   *  everybody else has. */
  onSayReady: (ready: boolean) => void;
  /** A member asking for a different game, without leaving or typing it into
   *  chat and hoping somebody reads it. */
  onObjectGame: () => void;
}

export interface StartState {
  enabled: boolean;
  /** A request is in flight — keep the button lit but inert. */
  busy?: boolean;
  /** Small line under the button explaining why it isn't lit (or who we wait for). */
  hint: string | null;
  /** When the local download failed: a retry affordance in the hint line. */
  retry?: () => void;
}

/** Free Fire-style lobby HUD: player chip + actions on top, round chat
 *  button bottom-left, party mode card (DUO/SQUAD picker) bottom-right. */
export class Hud {
  private root: HTMLElement;
  private leaveBtn: HTMLButtonElement;
  private micBtn: HTMLButtonElement;
  private chatDot: HTMLElement;
  private modeName: HTMLElement;
  private modeCount: HTMLElement;
  private modePop: HTMLElement;
  private mode: LobbyMode = "solo";
  private codeRow: HTMLElement;
  private codeCard: HTMLButtonElement;
  private codeLabel: HTMLElement;
  private codeValue: HTMLElement;
  private showBtn: HTMLButtonElement;
  private resetBtn: HTMLButtonElement;
  private joinBtn: HTMLButtonElement;
  private joinRow: HTMLElement;
  private codeInput: HTMLInputElement;
  private goBtn: HTMLButtonElement;
  private teamCode: string | null = null;
  private isLeader = false;
  private startBtn: HTMLButtonElement;
  private pickBtn: HTMLButtonElement;
  private pickName: HTMLElement;
  private startHint: HTMLElement;
  private readyRow!: HTMLElement;
  private readyBtn!: HTMLButtonElement;
  private objectBtn!: HTMLButtonElement;

  constructor(user: User, callbacks: HudCallbacks) {
    this.root = document.createElement("div");
    this.root.className = "hud";
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="hud-left">
          <div class="player-chip" role="button" tabindex="0" title="View your profile">
            <span class="chip-av"></span>
            <div class="chip-body">
              <div class="player-name"></div>
              <div class="player-uid">UID <span></span> <button class="copy-uid" title="Copy UID">⧉</button></div>
            </div>
            <span class="chip-caret" aria-hidden="true">›</span>
          </div>
          <div class="tc-card-row hidden">
            <button class="team-code-card" title="Tap to copy">
              <span class="tc-label">TEAM CODE</span>
              <span class="tc-value"></span>
            </button>
            <button class="btn btn-ghost btn-small tc-reset hidden" title="Reset team code">↻</button>
          </div>
          <button class="btn tc-btn tc-show-btn hidden">🎟 Show team code</button>
          <button class="btn tc-btn tc-join-btn hidden">🎟 Join with team code</button>
          <div class="tc-join-row hidden">
            <input class="tc-input" type="text" inputmode="numeric" maxlength="6" placeholder="6-digit code" />
            <button class="btn btn-primary btn-small tc-go" disabled>Join</button>
            <button class="btn btn-ghost btn-small tc-cancel">✕</button>
          </div>
        </div>
        <div class="hud-actions">
          <button class="btn btn-ghost mic-btn" title="Toggle microphone">🎙 On</button>
          <button class="btn btn-ghost events-btn" title="What is on">★</button>
          <button class="btn btn-ghost notices-btn" title="Notices from TOFO">✉</button>
          <button class="btn btn-ghost collection-btn">Collection</button>
          <button class="btn btn-ghost friends-btn">Friends</button>
          <button class="btn btn-ghost logout-btn" title="Log out">⎋</button>
        </div>
      </div>
      <button class="chat-fab" title="Chat">💬<span class="chat-dot hidden"></span></button>
      <div class="hud-bottom">
        <div class="game-stack">
          <button class="game-start-btn is-blur" type="button" disabled>START</button>
          <div class="ready-row hidden">
            <button class="btn ready-btn" type="button">I'M READY</button>
            <button class="btn btn-ghost object-btn" type="button" title="Ask the leader for a different game">Change game?</button>
          </div>
          <div class="game-start-hint"></div>
          <button class="game-pick-btn" type="button" title="Choose game">
            <span class="gp-label">GAME</span>
            <span class="gp-name">Choose game</span>
            <span class="gp-caret">▸</span>
          </button>
        </div>
        <div class="hud-party-row">
          <button class="btn btn-ghost leave-btn hidden">Leave</button>
          <button class="mode-card" title="Change party mode">
            <span class="mode-info"><span class="mode-name">SOLO</span><span class="mode-count">1/1</span></span>
            <span class="mode-caret">▲</span>
          </button>
        </div>
      </div>
      <div class="mode-pop hidden">
        <button data-mode="solo" class="mode-opt"><strong>SOLO</strong><span>Play on your own</span></button>
        <button data-mode="duo" class="mode-opt"><strong>DUO</strong><span>Up to 2 players</span></button>
        <button data-mode="squad" class="mode-opt"><strong>SQUAD</strong><span>Up to 4 players</span></button>
      </div>
    `;
    document.getElementById("ui-root")!.appendChild(this.root);

    setNameView(this.root.querySelector<HTMLElement>(".player-name")!, user.name);
    this.root.querySelector(".player-uid span")!.textContent = user.uid;
    this.leaveBtn = this.root.querySelector(".leave-btn")!;
    this.micBtn = this.root.querySelector(".mic-btn")!;
    this.chatDot = this.root.querySelector(".chat-dot")!;
    this.modeName = this.root.querySelector(".mode-name")!;
    this.modeCount = this.root.querySelector(".mode-count")!;
    this.modePop = this.root.querySelector(".mode-pop")!;
    this.startBtn = this.root.querySelector(".game-start-btn")!;
    this.pickBtn = this.root.querySelector(".game-pick-btn")!;
    this.pickName = this.root.querySelector(".gp-name")!;
    this.startHint = this.root.querySelector(".game-start-hint")!;
    this.readyRow = this.root.querySelector(".ready-row")!;
    this.readyBtn = this.root.querySelector(".ready-btn")!;
    this.objectBtn = this.root.querySelector(".object-btn")!;
    this.readyBtn.onclick = () => callbacks.onSayReady(!this.readyBtn.classList.contains("on"));
    this.objectBtn.onclick = () => callbacks.onObjectGame();
    this.pickBtn.onclick = callbacks.onChooseGame;
    this.startBtn.onclick = () => {
      if (!this.startBtn.disabled) callbacks.onStart();
    };

    // The whole chip is the door to the profile; the copy button inside it
    // keeps its own job (a nested <button> would be invalid markup, hence
    // role/tabindex on the chip and a stopped click on the copy).
    const chip = this.root.querySelector<HTMLElement>(".player-chip")!;
    setAvatar(chip.querySelector<HTMLElement>(".chip-av")!, user.name, user.avatarUrl);
    chip.onclick = callbacks.onOpenProfile;
    chip.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        callbacks.onOpenProfile();
      }
    };
    this.root.querySelector<HTMLButtonElement>(".copy-uid")!.onclick = (e) => {
      e.stopPropagation();
      void navigator.clipboard.writeText(user.uid);
    };

    // Team code slot, under the player chip. One place, three states: a
    // join-by-code flow while solo, a "Show team code" reveal while grouped
    // (codes are minted on first ask, not on group creation), and the
    // shareable card once revealed — with a leader-only reset beside it.
    this.codeRow = this.root.querySelector<HTMLElement>(".tc-card-row")!;
    this.codeCard = this.root.querySelector<HTMLButtonElement>(".team-code-card")!;
    this.codeLabel = this.codeCard.querySelector<HTMLElement>(".tc-label")!;
    this.codeValue = this.codeCard.querySelector<HTMLElement>(".tc-value")!;
    this.showBtn = this.root.querySelector<HTMLButtonElement>(".tc-show-btn")!;
    this.resetBtn = this.root.querySelector<HTMLButtonElement>(".tc-reset")!;
    this.joinBtn = this.root.querySelector<HTMLButtonElement>(".tc-join-btn")!;
    this.joinRow = this.root.querySelector<HTMLElement>(".tc-join-row")!;
    this.codeInput = this.joinRow.querySelector<HTMLInputElement>(".tc-input")!;
    this.goBtn = this.joinRow.querySelector<HTMLButtonElement>(".tc-go")!;

    const requestCode = async (btn: HTMLButtonElement, reset: boolean) => {
      btn.disabled = true; // no double-fire while the server thinks
      try {
        await callbacks.onTeamCode(reset);
      } finally {
        btn.disabled = false;
      }
    };
    this.showBtn.onclick = () => void requestCode(this.showBtn, false);
    this.resetBtn.onclick = () => void requestCode(this.resetBtn, true);
    this.codeCard.onclick = () => {
      if (!this.teamCode) return;
      void navigator.clipboard.writeText(this.teamCode);
      this.codeLabel.textContent = "COPIED ✓";
      setTimeout(() => (this.codeLabel.textContent = "TEAM CODE"), 1200);
    };
    this.joinBtn.onclick = () => {
      this.joinBtn.classList.add("hidden");
      this.joinRow.classList.remove("hidden");
      this.codeInput.focus();
    };
    this.joinRow.querySelector<HTMLButtonElement>(".tc-cancel")!.onclick = () => {
      this.closeJoinRow();
      if (this.mode === "solo") this.joinBtn.classList.remove("hidden");
    };
    // Digits only, and Join only lights up on a complete code — bad input is
    // impossible to submit instead of being an error to explain.
    this.codeInput.oninput = () => {
      this.codeInput.value = this.codeInput.value.replace(/\D/g, "").slice(0, 6);
      this.goBtn.disabled = this.codeInput.value.length !== 6;
    };
    const submit = async () => {
      if (this.goBtn.disabled) return;
      this.goBtn.disabled = true; // no double-fire while the server thinks
      try {
        await callbacks.onJoinByCode(this.codeInput.value);
      } finally {
        this.goBtn.disabled = this.codeInput.value.length !== 6;
      }
    };
    this.goBtn.onclick = () => void submit();
    this.codeInput.onkeydown = (e) => {
      if (e.key === "Enter") void submit();
    };
    this.root.querySelector<HTMLButtonElement>(".events-btn")!.onclick = callbacks.onOpenEvents;
    this.root.querySelector<HTMLButtonElement>(".notices-btn")!.onclick = callbacks.onOpenNotices;
    this.root.querySelector<HTMLButtonElement>(".collection-btn")!.onclick = callbacks.onOpenCollection;
    this.root.querySelector<HTMLButtonElement>(".friends-btn")!.onclick = callbacks.onToggleFriends;
    this.root.querySelector<HTMLButtonElement>(".chat-fab")!.onclick = callbacks.onToggleChat;
    this.leaveBtn.onclick = callbacks.onLeaveLobby;
    this.micBtn.onclick = () => {
      this.micBtn.disabled = true;
      void toggleMic()
        .catch(() => toast("Couldn't switch your microphone", true))
        .finally(() => {
          this.micBtn.disabled = false;
        });
    };
    // Painted by the voice module, not from a value read here once. This HUD
    // is built at startup and never rebuilt, so muting inside a match used to
    // leave it saying "On" for the rest of the session.
    onMicChange((on) => {
      this.micBtn.textContent = on ? "🎙 On" : "🎙 Off";
      this.micBtn.classList.toggle("muted", !on);
    });

    // Party mode picker.
    this.root.querySelector<HTMLButtonElement>(".mode-card")!.onclick = (e) => {
      e.stopPropagation();
      this.modePop.classList.toggle("hidden");
    };
    this.modePop.querySelectorAll<HTMLButtonElement>(".mode-opt").forEach((btn) => {
      btn.onclick = () => {
        this.modePop.classList.add("hidden");
        const mode = btn.dataset.mode as LobbyMode;
        if (mode !== this.mode) callbacks.onChangeMode(mode);
      };
    });
    // Tap anywhere else closes the picker.
    document.addEventListener("pointerdown", (e) => {
      if (!this.modePop.classList.contains("hidden") && !this.modePop.contains(e.target as Node)) {
        this.modePop.classList.add("hidden");
      }
    });

    this.root.querySelector<HTMLButtonElement>(".logout-btn")!.onclick = () => {
      clearSession();
      disconnectSocket();
      location.reload();
    };
  }

  /** Which game the party picked (null = none). Members see the pick too;
   *  only the leader's button reads as pressable. */
  setGame(state: { name: string | null; isLeader: boolean }) {
    this.pickName.textContent = state.name ?? "Choose game";
    this.pickBtn.classList.toggle("picked", state.name !== null);
    this.pickBtn.classList.toggle("readonly", !state.isLeader);
    this.pickBtn.title = state.isLeader ? "Choose game" : "The party leader picks the game";
  }

  /** A member's half of starting: agree to the game, or say you would rather
   *  not. Null for the leader and for anybody on their own — START is the
   *  leader's own consent, and there is nobody to agree with alone. */
  setReadyUp(state: { ready: boolean; canObject: boolean } | null) {
    this.readyRow.classList.toggle("hidden", state === null);
    if (!state) return;
    this.readyBtn.classList.toggle("on", state.ready);
    this.readyBtn.textContent = state.ready ? "READY ✓" : "I'M READY";
    this.objectBtn.classList.toggle("hidden", !state.canObject);
  }

  /** START: blurred and inert until the leader may press it. */
  setStart(state: StartState) {
    const lit = state.enabled || !!state.busy;
    this.startBtn.disabled = !state.enabled;
    this.startBtn.classList.toggle("is-blur", !lit);
    this.startBtn.classList.toggle("busy", !!state.busy);
    this.startBtn.textContent = state.busy ? "STARTING…" : "START";
    this.startHint.replaceChildren();
    if (state.hint) {
      const span = document.createElement("span");
      span.textContent = state.hint;
      this.startHint.appendChild(span);
      if (state.retry) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "game-retry";
        retry.textContent = "Retry";
        retry.onclick = state.retry;
        this.startHint.appendChild(retry);
      }
    }
    this.startHint.classList.toggle("hidden", !state.hint);
  }

  setChatUnread(show: boolean) {
    this.chatDot.classList.toggle("hidden", !show);
  }

  private closeJoinRow() {
    this.joinRow.classList.add("hidden");
    this.codeInput.value = "";
    this.goBtn.disabled = true;
  }

  /** Sync the team-code slot to (mode, teamCode, leadership). */
  private applyCodeSlot() {
    const grouped = this.mode !== "solo";
    const revealed = grouped && this.teamCode !== null;
    this.codeRow.classList.toggle("hidden", !revealed);
    if (this.teamCode) this.codeValue.textContent = this.teamCode;
    this.resetBtn.classList.toggle("hidden", !this.isLeader);
    this.showBtn.classList.toggle("hidden", !grouped || revealed);
    if (grouped) {
      this.joinBtn.classList.add("hidden");
      this.closeJoinRow();
    } else if (this.joinRow.classList.contains("hidden")) {
      // Show the join entry unless the input is already open mid-typing.
      this.joinBtn.classList.remove("hidden");
    }
  }

  /** Live update from the room when any member reveals or resets the code. */
  setTeamCode(code: string) {
    this.teamCode = code;
    this.applyCodeSlot();
  }

  setLobby(memberCount: number, isOwnLobby: boolean, mode: LobbyMode, teamCode: string | null) {
    this.mode = mode;
    this.teamCode = teamCode;
    this.isLeader = isOwnLobby;
    this.applyCodeSlot();
    const capacity = mode === "solo" ? 1 : mode === "duo" ? 2 : 4;
    this.modeName.textContent = mode.toUpperCase();
    this.modeCount.textContent = `${memberCount}/${capacity}`;
    this.modePop.querySelectorAll<HTMLElement>(".mode-opt").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    // Leave is available whenever a party is open — even for an owner left
    // alone in it (leaving drops them back to solo). Leaders with teammates
    // can leave too; the group passes to the longest-present member.
    this.leaveBtn.classList.toggle("hidden", mode === "solo");
  }
}
