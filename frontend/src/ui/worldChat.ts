// The World section of the chat panel.
//
// A public room of up to a thousand people, and the one place in TOFO where a
// player meets somebody they have never met. Three things share the space, in
// the order they matter to somebody holding a phone:
//
//   THE BOARD — "we need one more" cards, at the top, because the reason to
//   open this tab is usually to find people rather than to read.
//   THE ROOM — what is being said, filling the middle.
//   THE ASK — one button that puts your own card up and, ten seconds later,
//   guarantees you a group either way.
//
// Nothing here can tell you which of the thousand are people. That is the
// server's promise, not this file's — but this file must not undo it, which is
// why every name, card and line is rendered through exactly the same path.
//
// Cost: the socket only joins the world's broadcast room while this tab is
// open (`world:hello` / `world:leave`), so a player who never opens it
// receives none of this traffic at all.
import { emitAck, getSocket } from "../api/socket";
import { setNameView } from "./nameview";
import { toast } from "./toast";
import {
  WORLD_EV,
  WORLD_MESSAGE_MAX,
  type WorldChatMessage,
  type WorldHello,
  type WorldLfg,
} from "../shared/core/protocol";

export interface WorldCallbacks {
  /** Tapping a name opens that player's card — the same card a squadmate's
   *  pedestal opens, because in a world chat the question "who is this" is the
   *  commonest one there is. */
  onOpenPlayer: (uid: string, name: string) => void;
}

/** Lines kept in the DOM. A public room scrolls fast, and an unbounded list is
 *  a memory leak with a scrollbar. */
const KEEP = 80;

export class WorldSection {
  private host: HTMLElement | null = null;
  private msgsEl: HTMLElement | null = null;
  private boardEl: HTMLElement | null = null;
  private headEl: HTMLElement | null = null;
  private askBtn: HTMLButtonElement | null = null;
  private worldId = "";
  private online = 0;
  private capacity = 0;
  private fillMs = 10_000;
  private blocked = new Set<string>();
  private requests = new Map<string, WorldLfg>();
  /** My own card, while one is up — drives the countdown and the Cancel. */
  private mine: { id: string; until: number } | null = null;
  private countdown: number | null = null;
  private loadSeq = 0;
  /** Sticks to the bottom unless the player has scrolled up to read. */
  private pinned = true;

  constructor(private me: { uid: string }, private cb: WorldCallbacks) {}

  /** Build the section into the panel body and ask the server for the room. */
  mount(host: HTMLElement): void {
    this.host = host;
    const seq = ++this.loadSeq;
    host.innerHTML = `
      <div class="world">
        <div class="world-head"><span class="world-name">Connecting…</span></div>
        <div class="world-board hidden"></div>
        <div class="chat-msgs world-msgs"></div>
        <div class="world-ask">
          <button class="btn btn-ghost btn-small world-ask-btn" disabled>Team up</button>
          <span class="world-ask-note"></span>
        </div>
        <div class="chat-input-row">
          <input type="text" class="chat-input" maxlength="${WORLD_MESSAGE_MAX}"
                 placeholder="Say something to the world…" autocomplete="off" />
          <button class="btn btn-red chat-send">Send</button>
        </div>
      </div>`;

    this.headEl = host.querySelector(".world-name");
    this.boardEl = host.querySelector(".world-board");
    this.msgsEl = host.querySelector(".world-msgs");
    this.askBtn = host.querySelector(".world-ask-btn");

    this.msgsEl?.addEventListener("scroll", () => {
      const el = this.msgsEl;
      if (!el) return;
      // 40px of slack: "near the bottom" is where somebody following along
      // sits, and demanding the exact bottom makes the view fight them.
      this.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    });

    const input = host.querySelector<HTMLInputElement>(".chat-input")!;
    const sendBtn = host.querySelector<HTMLButtonElement>(".chat-send")!;
    const send = async () => {
      const body = input.value.trim();
      if (!body || sendBtn.disabled) return;
      sendBtn.disabled = true;
      try {
        const res = await emitAck<{ ok?: boolean; error?: string }>(WORLD_EV.say, { body });
        if (res.error) toast(res.error, true);
        // No local echo: the server broadcasts to the whole room including us,
        // so echoing here would show every message twice.
        else input.value = "";
      } catch (err) {
        toast(err instanceof Error ? err.message : "Send failed", true);
      } finally {
        sendBtn.disabled = false;
        input.focus();
      }
    };
    sendBtn.onclick = () => void send();
    input.onkeydown = (e) => {
      if (e.key === "Enter") void send();
    };
    this.askBtn!.onclick = () => void this.toggleAsk();

    void this.hello(seq);
  }

  /** The tab was left, or the panel closed. Leaves the broadcast room — the
   *  player stays IN the world (that belongs to being online), they simply
   *  stop being sent it. */
  unmount(): void {
    this.stopCountdown();
    // Unconditionally, even if the answer to `hello` never came back: the
    // socket may already have been put in the room by a reply that landed
    // while this section was being torn down, and the server treats a leave it
    // was not expecting as the no-op it is.
    this.loadSeq++;
    getSocket().emit(WORLD_EV.leave);
    this.host = null;
    this.msgsEl = null;
    this.boardEl = null;
    this.headEl = null;
    this.askBtn = null;
  }

  private async hello(seq: number): Promise<void> {
    try {
      const res = await emitAck<WorldHello & { error?: string }>(WORLD_EV.hello, {});
      if (seq !== this.loadSeq || !this.host) return;
      if (res.error) {
        if (this.headEl) this.headEl.textContent = "World chat is unavailable";
        return;
      }
      this.worldId = res.worldId;
      this.online = res.online;
      this.capacity = res.capacity;
      this.fillMs = res.fillMs;
      this.blocked = new Set(res.blocked);
      this.requests = new Map(res.requests.map((r) => [r.id, r]));
      this.mine = null;
      const own = res.requests.find((r) => this.isMine(r));
      if (own) this.mine = { id: own.id, until: own.at + this.fillMs };
      if (this.askBtn) this.askBtn.disabled = false;
      this.renderHead();
      this.renderBoard();
      if (this.msgsEl) {
        this.msgsEl.innerHTML = "";
        if (res.messages.length === 0) {
          this.msgsEl.innerHTML = `<p class="chat-note chat-empty-hint">Nobody has said anything yet — go on.</p>`;
        }
        for (const m of res.messages) this.append(m, false);
        this.msgsEl.scrollTop = this.msgsEl.scrollHeight;
        this.pinned = true;
      }
      if (this.mine) this.startCountdown();
    } catch {
      if (seq === this.loadSeq && this.headEl) this.headEl.textContent = "Couldn't reach world chat";
    }
  }

  // ---- live events (routed in from main.ts) ------------------------------

  onMessage(msg: WorldChatMessage): void {
    if (this.blocked.has(msg.uid)) return;
    this.append(msg, true);
  }

  onRequest(req: WorldLfg): void {
    this.requests.set(req.id, req);
    if (this.isMine(req)) {
      this.mine = { id: req.id, until: req.at + this.fillMs };
      this.startCountdown();
    }
    this.renderBoard();
  }

  /** A card carries no "mine" flag — it is one broadcast to a whole room, so
   *  the answer has to be worked out here, where the viewer is known. */
  private isMine = (req: WorldLfg): boolean => req.uid === this.me.uid;

  onRequestGone(id: string): void {
    this.requests.delete(id);
    if (this.mine?.id === id) {
      this.mine = null;
      this.stopCountdown();
    }
    this.renderBoard();
  }

  onPopulation(online: number, capacity: number): void {
    this.online = online;
    this.capacity = capacity;
    this.renderHead();
  }

  // ---- rendering ---------------------------------------------------------

  private renderHead(): void {
    if (!this.headEl) return;
    this.headEl.textContent = this.worldId
      ? `${this.worldId} · ${this.online.toLocaleString()} online`
      : "Connecting…";
    this.headEl.title = this.capacity ? `Up to ${this.capacity.toLocaleString()} players per world` : "";
  }

  private renderBoard(): void {
    const board = this.boardEl;
    if (!board) return;
    const cards = [...this.requests.values()].sort((a, b) => b.at - a.at).slice(0, 12);
    board.classList.toggle("hidden", cards.length === 0);
    board.innerHTML = "";
    for (const req of cards) {
      const mine = this.isMine(req);
      const card = document.createElement("div");
      card.className = `world-card${mine ? " mine" : ""}`;
      card.innerHTML = `
        <div class="world-card-info">
          <span class="world-card-name"></span>
          <span class="world-card-need">${req.mode === "duo" ? "Duo" : "Squad"} · needs ${req.need}</span>
        </div>`;
      setNameView(card.querySelector<HTMLElement>(".world-card-name")!, req.name);
      if (!mine) {
        const join = document.createElement("button");
        join.className = "btn btn-red btn-small";
        join.textContent = "Join";
        join.onclick = () => void this.join(req.id, join);
        card.appendChild(join);
      } else {
        const tag = document.createElement("span");
        tag.className = "world-card-mine";
        tag.textContent = "Yours";
        card.appendChild(tag);
      }
      board.appendChild(card);
    }
    this.renderAsk();
  }

  private renderAsk(): void {
    const btn = this.askBtn;
    const note = this.host?.querySelector<HTMLElement>(".world-ask-note");
    if (!btn || !note) return;
    if (this.mine) {
      btn.textContent = "Cancel";
      const left = Math.max(0, Math.ceil((this.mine.until - Date.now()) / 1000));
      note.textContent = left > 0 ? `Looking for players… ${left}s` : "Filling your group…";
    } else {
      btn.textContent = "Team up";
      note.textContent = "Ask the world for teammates";
    }
  }

  private startCountdown(): void {
    this.stopCountdown();
    this.countdown = window.setInterval(() => {
      if (!this.mine || !this.host) return this.stopCountdown();
      this.renderAsk();
      // The card comes down server-side when it is filled; this only stops the
      // clock ticking past zero if that message is slow to arrive.
      if (Date.now() > this.mine.until + 5000) this.stopCountdown();
    }, 500);
  }

  private stopCountdown(): void {
    if (this.countdown !== null) window.clearInterval(this.countdown);
    this.countdown = null;
    this.renderAsk();
  }

  private async toggleAsk(): Promise<void> {
    const btn = this.askBtn;
    if (!btn) return;
    btn.disabled = true;
    try {
      if (this.mine) {
        const res = await emitAck<{ error?: string }>(WORLD_EV.unseek, {});
        if (res.error) toast(res.error, true);
        else {
          this.mine = null;
          this.stopCountdown();
          this.renderBoard();
        }
        return;
      }
      const res = await emitAck<{ ok?: boolean; error?: string; id?: string; fillMs?: number }>(
        WORLD_EV.seek,
        {}
      );
      if (res.error) {
        toast(res.error, true);
        return;
      }
      if (res.id) {
        this.fillMs = res.fillMs ?? this.fillMs;
        this.mine = { id: res.id, until: Date.now() + this.fillMs };
        this.startCountdown();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't post that", true);
    } finally {
      btn.disabled = false;
      this.renderAsk();
    }
  }

  private async join(id: string, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      const res = await emitAck<{ ok?: boolean; error?: string }>(WORLD_EV.accept, { id });
      if (res.error) toast(res.error, true);
      else toast("You're in the group");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Join failed", true);
    } finally {
      btn.disabled = false;
    }
  }

  private append(msg: WorldChatMessage, live: boolean): void {
    const list = this.msgsEl;
    if (!list) return;
    list.querySelector(".chat-empty-hint")?.remove();
    const mine = msg.uid === this.me.uid;
    const el = document.createElement("div");
    el.className = `world-msg${mine ? " mine" : ""}`;
    const who = document.createElement("button");
    who.className = "world-msg-who";
    who.type = "button";
    setNameView(who, msg.name);
    who.onclick = () => this.cb.onOpenPlayer(msg.uid, msg.name);
    const body = document.createElement("span");
    body.className = "world-msg-body";
    body.textContent = msg.body;
    el.append(who, body);
    list.appendChild(el);
    while (list.childElementCount > KEEP) list.firstElementChild?.remove();
    // Only follow the conversation if they were already at the bottom —
    // yanking the view while somebody is reading back is the one thing a busy
    // public chat must not do. Your OWN message always scrolls into view.
    if (!live || this.pinned || mine) {
      list.scrollTop = list.scrollHeight;
      this.pinned = true;
    }
  }
}
