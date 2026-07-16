import { clearSession } from "../api/http";
import { disconnectSocket } from "../api/socket";
import { isMicEnabled, toggleMic } from "../voice/livekit";
import type { User } from "../types";

export interface HudCallbacks {
  onToggleFriends: () => void;
  onLeaveLobby: () => void;
}

export class Hud {
  private root: HTMLElement;
  private lobbyInfo: HTMLElement;
  private leaveBtn: HTMLButtonElement;
  private micBtn: HTMLButtonElement;

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
      <div class="hud-bottom">
        <div class="lobby-info">Solo lobby</div>
        <button class="btn btn-ghost leave-btn hidden">Leave lobby</button>
      </div>
    `;
    document.getElementById("ui-root")!.appendChild(this.root);

    this.root.querySelector(".player-name")!.textContent = user.name;
    this.root.querySelector(".player-uid span")!.textContent = user.uid;
    this.lobbyInfo = this.root.querySelector(".lobby-info")!;
    this.leaveBtn = this.root.querySelector(".leave-btn")!;
    this.micBtn = this.root.querySelector(".mic-btn")!;

    this.root.querySelector<HTMLButtonElement>(".copy-uid")!.onclick = () => {
      void navigator.clipboard.writeText(user.uid);
    };
    this.root.querySelector<HTMLButtonElement>(".friends-btn")!.onclick = callbacks.onToggleFriends;
    this.leaveBtn.onclick = callbacks.onLeaveLobby;
    this.micBtn.onclick = async () => {
      const enabled = await toggleMic();
      this.micBtn.textContent = enabled ? "🎙 On" : "🎙 Off";
      this.micBtn.classList.toggle("muted", !enabled);
    };
    this.micBtn.textContent = isMicEnabled() ? "🎙 On" : "🎙 Off";

    this.root.querySelector<HTMLButtonElement>(".logout-btn")!.onclick = () => {
      clearSession();
      disconnectSocket();
      location.reload();
    };
  }

  setLobby(memberCount: number, isOwnLobby: boolean) {
    if (memberCount <= 1) {
      this.lobbyInfo.textContent = "Solo lobby";
      this.leaveBtn.classList.add("hidden");
    } else {
      this.lobbyInfo.textContent = `Squad · ${memberCount}/4`;
      this.leaveBtn.classList.toggle("hidden", isOwnLobby);
    }
  }
}
