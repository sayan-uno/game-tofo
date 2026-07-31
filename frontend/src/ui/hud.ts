import { clearSession } from "../api/http";
import { disconnectSocket } from "../api/socket";
import { isMicEnabled, toggleMic } from "../voice/livekit";
import { setAvatar } from "./avatar";
import { setNameView } from "./nameview";
import type { LobbyMode, User } from "../types";

export interface HudCallbacks {
  onToggleFriends: () => void;
  onToggleChat: () => void;
  /** Tapping the player chip opens the career page. */
  onOpenProfile: () => void;
  onLeaveLobby: () => void;
  onChangeMode: (mode: LobbyMode) => void;
  /** Resolves after the server answered (errors already toasted by the caller). */
  onJoinByCode: (code: string) => Promise<void>;
  /** Reveal the party's code (created on first ask); reset=true mints a new one. */
  onTeamCode: (reset: boolean) => Promise<void>;
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
          <button class="btn btn-ghost friends-btn">Friends</button>
          <button class="btn btn-ghost logout-btn" title="Log out">⎋</button>
        </div>
      </div>
      <button class="chat-fab" title="Chat">💬<span class="chat-dot hidden"></span></button>
      <div class="hud-bottom">
        <button class="btn btn-ghost leave-btn hidden">Leave</button>
        <button class="mode-card" title="Change party mode">
          <span class="mode-info"><span class="mode-name">SOLO</span><span class="mode-count">1/1</span></span>
          <span class="mode-caret">▲</span>
        </button>
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
    this.root.querySelector<HTMLButtonElement>(".friends-btn")!.onclick = callbacks.onToggleFriends;
    this.root.querySelector<HTMLButtonElement>(".chat-fab")!.onclick = callbacks.onToggleChat;
    this.leaveBtn.onclick = callbacks.onLeaveLobby;
    this.micBtn.onclick = async () => {
      const enabled = await toggleMic();
      this.micBtn.textContent = enabled ? "🎙 On" : "🎙 Off";
      this.micBtn.classList.toggle("muted", !enabled);
    };
    this.micBtn.textContent = isMicEnabled() ? "🎙 On" : "🎙 Off";
    this.micBtn.classList.toggle("muted", !isMicEnabled());

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
