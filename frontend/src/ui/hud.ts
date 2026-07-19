import { clearSession } from "../api/http";
import { disconnectSocket } from "../api/socket";
import { isMicEnabled, toggleMic } from "../voice/livekit";
import type { LobbyMode, User } from "../types";

export interface HudCallbacks {
  onToggleFriends: () => void;
  onToggleChat: () => void;
  onLeaveLobby: () => void;
  onChangeMode: (mode: LobbyMode) => void;
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
  private mode: LobbyMode = "squad";

  constructor(user: User, callbacks: HudCallbacks) {
    this.root = document.createElement("div");
    this.root.className = "hud";
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="player-chip">
          <div class="player-name"></div>
          <div class="player-uid">UID <span></span> <button class="copy-uid" title="Copy UID">⧉</button></div>
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
          <span class="mode-info"><span class="mode-name">SQUAD</span><span class="mode-count">1/4</span></span>
          <span class="mode-caret">▲</span>
        </button>
      </div>
      <div class="mode-pop hidden">
        <button data-mode="duo" class="mode-opt"><strong>DUO</strong><span>Up to 2 players</span></button>
        <button data-mode="squad" class="mode-opt"><strong>SQUAD</strong><span>Up to 4 players</span></button>
      </div>
    `;
    document.getElementById("ui-root")!.appendChild(this.root);

    this.root.querySelector(".player-name")!.textContent = user.name;
    this.root.querySelector(".player-uid span")!.textContent = user.uid;
    this.leaveBtn = this.root.querySelector(".leave-btn")!;
    this.micBtn = this.root.querySelector(".mic-btn")!;
    this.chatDot = this.root.querySelector(".chat-dot")!;
    this.modeName = this.root.querySelector(".mode-name")!;
    this.modeCount = this.root.querySelector(".mode-count")!;
    this.modePop = this.root.querySelector(".mode-pop")!;

    this.root.querySelector<HTMLButtonElement>(".copy-uid")!.onclick = () => {
      void navigator.clipboard.writeText(user.uid);
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

  setLobby(memberCount: number, _isOwnLobby: boolean, mode: LobbyMode) {
    this.mode = mode;
    const capacity = mode === "duo" ? 2 : 4;
    this.modeName.textContent = mode.toUpperCase();
    this.modeCount.textContent = `${memberCount}/${capacity}`;
    this.modePop.querySelectorAll<HTMLElement>(".mode-opt").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    // Leaders can leave too — the group passes to the longest-present member.
    this.leaveBtn.classList.toggle("hidden", memberCount <= 1);
  }
}
