import { api } from "../api/http";
import { emitAck } from "../api/socket";
import { actionToast, toast } from "./toast";
import type { ChatMessage, ChatThread, DmHistory, Friend, TeamHistory, User } from "../types";

type Tab = "team" | "friends" | "recent";

export interface ChatCallbacks {
  /** Show/clear the unread dot on the HUD chat button. */
  onUnread: (hasUnread: boolean) => void;
}

interface DmEvent {
  id: string;
  from: { uid: string; name: string };
  body: string;
  at: string;
  isFriend: boolean;
}

/** Free Fire-style chat window.
 *  Team — squad chat, tab only exists while in a squad.
 *  Friends — DMs with current friends.
 *  Recent — DMs with everyone else, UID search, block/unblock.
 *  A conversation moves between Friends and Recent automatically as the
 *  relationship changes; all user text is rendered with textContent. */
export class ChatPanel {
  private panel: HTMLElement;
  private body: HTMLElement;
  private teamTabBtn: HTMLButtonElement;
  private tab: Tab = "friends";
  private open = false;
  private inTeam = false;
  private activeDm: { user: User; isFriend: boolean; blockedByMe: boolean } | null = null;
  private msgsEl: HTMLElement | null = null;
  private renderSeq = 0;
  private unread: Record<Tab, boolean> = { team: false, friends: false, recent: false };
  private vvHandler = () => this.adjustForKeyboard();

  constructor(container: HTMLElement, private me: User, private cb: ChatCallbacks) {
    this.panel = document.createElement("div");
    this.panel.className = "chat-panel hidden";
    this.panel.innerHTML = `
      <div class="chat-tabs">
        <button data-tab="team" class="tab hidden">Team<span class="tab-dot hidden"></span></button>
        <button data-tab="friends" class="tab active">Friends<span class="tab-dot hidden"></span></button>
        <button data-tab="recent" class="tab">Recent<span class="tab-dot hidden"></span></button>
        <button class="tab tab-close" title="Close">✕</button>
      </div>
      <div class="chat-body"></div>
    `;
    container.appendChild(this.panel);
    this.body = this.panel.querySelector(".chat-body")!;
    this.teamTabBtn = this.panel.querySelector<HTMLButtonElement>('[data-tab="team"]')!;

    this.panel.querySelectorAll<HTMLButtonElement>(".tab[data-tab]").forEach((btn) => {
      btn.onclick = () => this.switchTab(btn.dataset.tab as Tab);
    });
    this.panel.querySelector<HTMLButtonElement>(".tab-close")!.onclick = () => this.toggle(false);
  }

  toggle(open?: boolean) {
    this.open = open ?? !this.open;
    this.panel.classList.toggle("hidden", !this.open);
    if (this.open) {
      // In a squad, chat always opens on the Team section (Free Fire style).
      this.switchTab(this.inTeam ? "team" : this.tab);
      this.attachKeyboardWatch();
    } else {
      this.detachKeyboardWatch();
    }
  }

  /** Per-section unread dots; the HUD button dot is their OR. */
  private setUnread(tab: Tab, value: boolean) {
    this.unread[tab] = value;
    const btn = this.panel.querySelector(`.tab[data-tab="${tab}"] .tab-dot`);
    btn?.classList.toggle("hidden", !value);
    this.cb.onUnread(this.unread.team || this.unread.friends || this.unread.recent);
  }

  /** Called on every lobby:members update. */
  setTeam(inTeam: boolean) {
    if (this.inTeam === inTeam) return;
    this.inTeam = inTeam;
    this.teamTabBtn.classList.toggle("hidden", !inTeam);
    if (!inTeam && this.tab === "team") this.switchTab("friends");
  }

  onDmReceived(msg: DmEvent) {
    const section: Tab = msg.isFriend ? "friends" : "recent";
    const viewingThread =
      this.open && this.tab === section && this.activeDm !== null && this.activeDm.user.uid === msg.from.uid;
    const viewingList = this.open && this.tab === section && this.activeDm === null;
    if (viewingThread) {
      this.appendMsg({ id: msg.id, fromMe: false, body: msg.body, at: msg.at });
    } else if (viewingList) {
      this.renderTab(); // refresh previews in place — already looking at it
    } else {
      this.setUnread(section, true);
    }
  }

  onTeamReceived(msg: { id: string; from: { uid: string; name: string }; body: string; at: string }) {
    if (this.open && this.tab === "team") {
      this.appendMsg({
        id: msg.id,
        fromMe: msg.from.uid === this.me.uid,
        fromName: msg.from.name,
        body: msg.body,
        at: msg.at,
      });
    } else if (this.inTeam) {
      this.setUnread("team", true);
    }
  }

  /** Friend added/removed — threads may switch section, headers may change. */
  onRelationshipChanged() {
    if (!this.open) return;
    if (this.activeDm) void this.openDm(this.activeDm.user);
    else this.renderTab();
  }

  // ---------- internals ----------

  private stale(seq: number) {
    return seq !== this.renderSeq || !this.open;
  }

  private switchTab(tab: Tab) {
    this.tab = tab;
    this.setUnread(tab, false); // viewing a section reads it
    this.panel.querySelectorAll<HTMLElement>(".tab[data-tab]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    this.renderTab();
  }

  // --- keyboard handling: the game view NEVER shrinks (overlays-content);
  // --- we lift the panel above the on-screen keyboard ourselves instead.
  private attachKeyboardWatch() {
    window.visualViewport?.addEventListener("resize", this.vvHandler);
    window.visualViewport?.addEventListener("scroll", this.vvHandler);
  }

  private detachKeyboardWatch() {
    window.visualViewport?.removeEventListener("resize", this.vvHandler);
    window.visualViewport?.removeEventListener("scroll", this.vvHandler);
    this.panel.style.bottom = "";
    this.panel.style.maxHeight = "";
  }

  private adjustForKeyboard() {
    const vv = window.visualViewport;
    if (!vv || !window.matchMedia("(max-width: 640px), (max-height: 520px)").matches) return;
    const keyboard = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    if (keyboard > 60) {
      this.panel.style.bottom = `${keyboard + 8}px`;
      this.panel.style.maxHeight = `${Math.max(220, vv.height - 64)}px`;
      this.msgsEl?.scrollTo({ top: this.msgsEl.scrollHeight });
    } else {
      this.panel.style.bottom = "";
      this.panel.style.maxHeight = "";
    }
  }

  private renderTab() {
    const seq = ++this.renderSeq;
    this.activeDm = null;
    this.msgsEl = null;
    if (this.tab === "team") void this.renderTeam(seq);
    else if (this.tab === "friends") void this.renderFriends(seq);
    else void this.renderRecent(seq);
  }

  private async renderFriends(seq: number) {
    this.body.innerHTML = `<p class="chat-note">Loading…</p>`;
    try {
      const [{ friends }, { threads }] = await Promise.all([
        api.get<{ friends: Friend[] }>("/api/friends"),
        api.get<{ threads: ChatThread[] }>("/api/chat/threads"),
      ]);
      if (this.stale(seq)) return;
      const previews = new Map(threads.map((t) => [t.user.uid, t]));
      const withChat = friends
        .filter((f) => previews.has(f.uid))
        .sort((a, b) => previews.get(b.uid)!.lastAt.localeCompare(previews.get(a.uid)!.lastAt));
      const withoutChat = friends.filter((f) => !previews.has(f.uid));
      const ordered = [...withChat, ...withoutChat];

      this.body.innerHTML = "";
      const list = document.createElement("div");
      list.className = "chat-list";
      if (ordered.length === 0) {
        list.innerHTML = `<p class="chat-note">No friends yet — add players in the Friends panel, then chat with them here.</p>`;
      }
      for (const friend of ordered) {
        list.appendChild(this.buildRow(friend, previews.get(friend.uid), friend.online));
      }
      this.body.appendChild(list);
    } catch {
      if (!this.stale(seq)) this.body.innerHTML = `<p class="chat-note">Couldn't load chats. Try again.</p>`;
    }
  }

  private async renderRecent(seq: number) {
    this.body.innerHTML = "";
    const search = document.createElement("div");
    search.className = "chat-search";
    search.innerHTML = `
      <input type="text" inputmode="numeric" maxlength="12" placeholder="Search player by UID…" class="uid-input" />
      <button class="btn btn-red btn-small">Search</button>
    `;
    const listWrap = document.createElement("div");
    listWrap.className = "chat-list";
    listWrap.innerHTML = `<p class="chat-note">Loading…</p>`;
    this.body.append(search, listWrap);

    const input = search.querySelector<HTMLInputElement>("input")!;
    const searchBtn = search.querySelector<HTMLButtonElement>("button")!;
    const doSearch = async () => {
      const uid = input.value.trim();
      if (!uid) return;
      searchBtn.disabled = true;
      try {
        const { user } = await api.get<{ user: User }>(`/api/friends/search/${uid}`);
        void this.openDm(user);
      } catch (err) {
        toast(err instanceof Error ? err.message : "No player found", true);
      } finally {
        searchBtn.disabled = false;
      }
    };
    searchBtn.onclick = () => void doSearch();
    input.onkeydown = (e) => {
      if (e.key === "Enter") void doSearch();
    };

    try {
      const { threads } = await api.get<{ threads: ChatThread[] }>("/api/chat/threads");
      if (this.stale(seq)) return;
      const recent = threads.filter((t) => !t.isFriend);
      listWrap.innerHTML = "";
      if (recent.length === 0) {
        listWrap.innerHTML = `<p class="chat-note">No recent chats. Search a UID above to message anyone.</p>`;
        return;
      }
      const actions = document.createElement("div");
      actions.className = "chat-recent-actions";
      const clearAllBtn = document.createElement("button");
      clearAllBtn.className = "btn btn-ghost btn-small btn-danger";
      clearAllBtn.textContent = "Clear all";
      clearAllBtn.onclick = () => {
        actionToast(
          "Clear all recent chats? They only disappear for you.",
          () => {
            void (async () => {
              try {
                await api.post("/api/chat/clear-recent");
                toast("Recent chats cleared");
                this.renderTab();
              } catch (err) {
                toast(err instanceof Error ? err.message : "Failed to clear", true);
              }
            })();
          },
          () => {}
        );
      };
      actions.appendChild(clearAllBtn);
      listWrap.appendChild(actions);
      for (const t of recent) listWrap.appendChild(this.buildRow(t.user, t, undefined, true));
    } catch {
      if (!this.stale(seq)) listWrap.innerHTML = `<p class="chat-note">Couldn't load chats. Try again.</p>`;
    }
  }

  private buildRow(user: User, thread?: ChatThread, online?: boolean, clearable = false): HTMLElement {
    const row = document.createElement("div");
    row.className = "chat-row";
    row.innerHTML = `
      ${online === undefined ? "" : `<span class="status-dot ${online ? "online" : ""}"></span>`}
      <div class="chat-row-info">
        <div class="chat-row-name"><span class="chat-row-title"></span>${
          thread?.blockedByMe ? '<span class="chat-blocked-tag">Blocked</span>' : ""
        }</div>
        <div class="chat-row-preview"></div>
      </div>
      <span class="chat-chevron">›</span>
    `;
    row.querySelector(".chat-row-title")!.textContent = user.name;
    row.querySelector(".chat-row-preview")!.textContent = thread
      ? `${thread.lastFromMe ? "You: " : ""}${thread.lastBody}`
      : `UID ${user.uid}`;
    row.onclick = () => void this.openDm(user);
    if (clearable) {
      const clearBtn = document.createElement("button");
      clearBtn.className = "chat-row-clear";
      clearBtn.title = "Clear this chat (only for you)";
      clearBtn.textContent = "✕";
      clearBtn.onclick = (e) => {
        e.stopPropagation();
        void (async () => {
          try {
            await api.post("/api/chat/clear", { uid: user.uid });
            toast("Chat cleared");
            this.renderTab();
          } catch (err) {
            toast(err instanceof Error ? err.message : "Failed to clear", true);
          }
        })();
      };
      row.appendChild(clearBtn);
    }
    return row;
  }

  private async openDm(user: User) {
    const seq = ++this.renderSeq;
    this.body.innerHTML = `<p class="chat-note">Loading…</p>`;
    try {
      const data = await api.get<DmHistory>(`/api/chat/dm/${user.uid}`);
      if (this.stale(seq)) return;
      this.activeDm = { user: data.user, isFriend: data.isFriend, blockedByMe: data.blockedByMe };
      this.renderDmThread(data);
    } catch (err) {
      if (this.stale(seq)) return;
      toast(err instanceof Error ? err.message : "Couldn't open chat", true);
      this.renderTab();
    }
  }

  private renderDmThread(data: DmHistory) {
    this.body.innerHTML = "";
    const thread = document.createElement("div");
    thread.className = "chat-thread";

    const head = document.createElement("div");
    head.className = "chat-thread-head";
    head.innerHTML = `
      <button class="chat-back" title="Back">‹</button>
      <div class="chat-row-info">
        <div class="chat-row-name"><span class="chat-row-title"></span></div>
        <div class="chat-row-preview">UID ${data.user.uid}</div>
      </div>
    `;
    head.querySelector(".chat-row-title")!.textContent = data.user.name;
    head.querySelector<HTMLButtonElement>(".chat-back")!.onclick = () => this.renderTab();
    if (!data.isFriend) {
      const blockBtn = document.createElement("button");
      blockBtn.className = "btn btn-ghost btn-small btn-danger";
      blockBtn.textContent = data.blockedByMe ? "Unblock" : "Block";
      blockBtn.onclick = () => this.toggleBlock();
      head.appendChild(blockBtn);
    }

    const msgs = document.createElement("div");
    msgs.className = "chat-msgs";
    if (data.messages.length === 0) {
      msgs.innerHTML = `<p class="chat-note chat-empty-hint">No messages yet — say hi! Chats are kept for 15 days.</p>`;
    }
    for (const m of data.messages) msgs.appendChild(this.buildMsgEl(m));
    this.msgsEl = msgs;

    thread.append(head, msgs);
    if (data.blockedByMe) {
      const banner = document.createElement("div");
      banner.className = "chat-banner";
      banner.textContent = "You blocked this player. Unblock to chat.";
      thread.appendChild(banner);
    } else {
      thread.appendChild(this.buildInputRow((text) => this.sendDm(text)));
    }
    this.body.appendChild(thread);
    msgs.scrollTop = msgs.scrollHeight;
  }

  private async renderTeam(seq: number) {
    this.body.innerHTML = `<p class="chat-note">Loading…</p>`;
    try {
      const data = await api.get<TeamHistory>("/api/chat/team");
      if (this.stale(seq)) return;
      this.body.innerHTML = "";
      if (!data.inTeam) {
        this.body.innerHTML = `<p class="chat-note">Squad up to unlock team chat.</p>`;
        return;
      }
      const thread = document.createElement("div");
      thread.className = "chat-thread";
      const msgs = document.createElement("div");
      msgs.className = "chat-msgs";
      if (data.messages.length === 0) {
        msgs.innerHTML = `<p class="chat-note chat-empty-hint">Say hi to your squad! Only players in the squad right now can see these messages.</p>`;
      }
      for (const m of data.messages) msgs.appendChild(this.buildMsgEl(m));
      this.msgsEl = msgs;
      thread.append(msgs, this.buildInputRow((text) => this.sendTeam(text)));
      this.body.appendChild(thread);
      msgs.scrollTop = msgs.scrollHeight;
    } catch {
      if (!this.stale(seq)) this.body.innerHTML = `<p class="chat-note">Couldn't load team chat. Try again.</p>`;
    }
  }

  private buildInputRow(onSend: (text: string) => Promise<boolean>): HTMLElement {
    const row = document.createElement("div");
    row.className = "chat-input-row";
    row.innerHTML = `
      <input type="text" class="chat-input" maxlength="500" placeholder="Type a message…" autocomplete="off" />
      <button class="btn btn-red chat-send">Send</button>
    `;
    const input = row.querySelector<HTMLInputElement>("input")!;
    const sendBtn = row.querySelector<HTMLButtonElement>("button")!;
    const send = async () => {
      const text = input.value.trim();
      if (!text || sendBtn.disabled) return;
      sendBtn.disabled = true;
      try {
        if (await onSend(text)) input.value = "";
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    };
    sendBtn.onclick = () => void send();
    input.onkeydown = (e) => {
      if (e.key === "Enter") void send();
    };
    return row;
  }

  private async sendDm(text: string): Promise<boolean> {
    const dm = this.activeDm;
    if (!dm) return false;
    try {
      const res = await emitAck<{ ok?: boolean; error?: string; id?: string; at?: string }>("chat:dm", {
        toUid: dm.user.uid,
        body: text,
      });
      if (res.error) {
        toast(res.error, true);
        return false;
      }
      this.appendMsg({ id: res.id ?? "", fromMe: true, body: text, at: res.at ?? new Date().toISOString() });
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : "Send failed", true);
      return false;
    }
  }

  private async sendTeam(text: string): Promise<boolean> {
    try {
      const res = await emitAck("chat:team", { body: text });
      if (res.error) {
        toast(res.error, true);
        return false;
      }
      // Our own message comes back through the room broadcast — no local echo.
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : "Send failed", true);
      return false;
    }
  }

  private toggleBlock() {
    const dm = this.activeDm;
    if (!dm) return;
    const apply = async (block: boolean) => {
      try {
        await api.post(`/api/chat/${block ? "block" : "unblock"}`, { uid: dm.user.uid });
        toast(block ? `${dm.user.name} blocked` : `${dm.user.name} unblocked`);
        void this.openDm(dm.user);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Failed", true);
      }
    };
    if (dm.blockedByMe) {
      void apply(false);
    } else {
      actionToast(
        `Block ${dm.user.name}? You won't receive each other's messages.`,
        () => void apply(true),
        () => {}
      );
    }
  }

  private buildMsgEl(m: ChatMessage): HTMLElement {
    const el = document.createElement("div");
    el.className = `msg ${m.fromMe ? "mine" : "theirs"}`;
    if (!m.fromMe && m.fromName) {
      const sender = document.createElement("span");
      sender.className = "msg-sender";
      sender.textContent = m.fromName;
      el.appendChild(sender);
    }
    const body = document.createElement("span");
    body.className = "msg-body";
    body.textContent = m.body;
    el.appendChild(body);
    const time = document.createElement("span");
    time.className = "msg-time";
    time.textContent = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    el.appendChild(time);
    return el;
  }

  private appendMsg(m: ChatMessage) {
    if (!this.msgsEl) return;
    this.msgsEl.querySelector(".chat-empty-hint")?.remove();
    this.msgsEl.appendChild(this.buildMsgEl(m));
    this.msgsEl.scrollTop = this.msgsEl.scrollHeight;
  }
}
