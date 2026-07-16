import { api } from "../api/http";
import { emitAck } from "../api/socket";
import { toast } from "./toast";
import type { Friend, FriendRequest } from "../types";

type Tab = "friends" | "requests" | "add";

/** The Free Fire-style friends panel: friend list with online dots and
 *  invite buttons, incoming requests, and add-by-UID search. */
export class FriendsPanel {
  private panel: HTMLElement;
  private body: HTMLElement;
  private badge: HTMLElement;
  private tab: Tab = "friends";
  private open = false;
  private friends: Friend[] = [];
  private requests: FriendRequest[] = [];

  constructor(private container: HTMLElement) {
    this.panel = document.createElement("div");
    this.panel.className = "friends-panel hidden";
    this.panel.innerHTML = `
      <div class="friends-tabs">
        <button data-tab="friends" class="tab active">Friends</button>
        <button data-tab="requests" class="tab">Requests <span class="badge hidden"></span></button>
        <button data-tab="add" class="tab">Add</button>
        <button class="tab tab-close">✕</button>
      </div>
      <div class="friends-body"></div>
    `;
    container.appendChild(this.panel);
    this.body = this.panel.querySelector(".friends-body")!;
    this.badge = this.panel.querySelector(".badge")!;

    this.panel.querySelectorAll<HTMLButtonElement>(".tab[data-tab]").forEach((btn) => {
      btn.onclick = () => this.switchTab(btn.dataset.tab as Tab);
    });
    this.panel.querySelector<HTMLButtonElement>(".tab-close")!.onclick = () => this.toggle(false);
  }

  toggle(open?: boolean) {
    this.open = open ?? !this.open;
    this.panel.classList.toggle("hidden", !this.open);
    if (this.open) void this.refresh();
  }

  async refresh() {
    try {
      const [friendsRes, requestsRes] = await Promise.all([
        api.get<{ friends: Friend[] }>("/api/friends"),
        api.get<{ requests: FriendRequest[] }>("/api/friends/requests"),
      ]);
      this.friends = friendsRes.friends;
      this.requests = requestsRes.requests;
      this.updateBadge();
      this.render();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to load friends", true);
    }
  }

  setFriendOnline(uid: string, online: boolean) {
    const friend = this.friends.find((f) => f.uid === uid);
    if (friend) {
      friend.online = online;
      if (this.tab === "friends") this.render();
    }
  }

  private updateBadge() {
    this.badge.textContent = String(this.requests.length);
    this.badge.classList.toggle("hidden", this.requests.length === 0);
  }

  private switchTab(tab: Tab) {
    this.tab = tab;
    this.panel.querySelectorAll(".tab[data-tab]").forEach((b) => {
      b.classList.toggle("active", (b as HTMLElement).dataset.tab === tab);
    });
    this.render();
  }

  private render() {
    this.body.innerHTML = "";
    if (this.tab === "friends") this.renderFriends();
    else if (this.tab === "requests") this.renderRequests();
    else this.renderAdd();
  }

  private renderFriends() {
    if (this.friends.length === 0) {
      this.body.innerHTML = `<p class="empty-note">No friends yet. Use the Add tab to find players by UID.</p>`;
      return;
    }
    const sorted = [...this.friends].sort((a, b) => Number(b.online) - Number(a.online));
    for (const friend of sorted) {
      const row = document.createElement("div");
      row.className = "friend-row";
      row.innerHTML = `
        <span class="status-dot ${friend.online ? "online" : ""}"></span>
        <div class="friend-info">
          <div class="friend-name"></div>
          <div class="friend-uid">UID ${friend.uid}</div>
        </div>
      `;
      row.querySelector(".friend-name")!.textContent = friend.name;
      if (friend.online) {
        const inviteBtn = document.createElement("button");
        inviteBtn.className = "btn btn-primary btn-small";
        inviteBtn.textContent = "Invite";
        inviteBtn.onclick = async () => {
          inviteBtn.disabled = true;
          try {
            const res = await emitAck("lobby:invite", { friendUid: friend.uid });
            if (res.error) toast(res.error, true);
            else toast(`Invite sent to ${friend.name}`);
          } catch (err) {
            toast(err instanceof Error ? err.message : "Invite failed", true);
          } finally {
            inviteBtn.disabled = false;
          }
        };
        row.appendChild(inviteBtn);
      }
      this.body.appendChild(row);
    }
  }

  private renderRequests() {
    if (this.requests.length === 0) {
      this.body.innerHTML = `<p class="empty-note">No pending requests.</p>`;
      return;
    }
    for (const request of this.requests) {
      const row = document.createElement("div");
      row.className = "friend-row";
      row.innerHTML = `
        <div class="friend-info">
          <div class="friend-name"></div>
          <div class="friend-uid">UID ${request.uid}</div>
        </div>
      `;
      row.querySelector(".friend-name")!.textContent = request.name;
      const respond = async (accept: boolean) => {
        try {
          await api.post("/api/friends/respond", { requestId: request.requestId, accept });
          toast(accept ? `You and ${request.name} are now friends!` : "Request declined");
          await this.refresh();
        } catch (err) {
          toast(err instanceof Error ? err.message : "Failed", true);
        }
      };
      const acceptBtn = document.createElement("button");
      acceptBtn.className = "btn btn-primary btn-small";
      acceptBtn.textContent = "Accept";
      acceptBtn.onclick = () => void respond(true);
      const declineBtn = document.createElement("button");
      declineBtn.className = "btn btn-ghost btn-small";
      declineBtn.textContent = "✕";
      declineBtn.onclick = () => void respond(false);
      row.append(acceptBtn, declineBtn);
      this.body.appendChild(row);
    }
  }

  private renderAdd() {
    const wrap = document.createElement("div");
    wrap.className = "add-friend";
    wrap.innerHTML = `
      <input type="text" inputmode="numeric" placeholder="Enter player UID…" class="uid-input" maxlength="12" />
      <button class="btn btn-primary">Search</button>
      <div class="search-result"></div>
    `;
    this.body.appendChild(wrap);

    const input = wrap.querySelector<HTMLInputElement>(".uid-input")!;
    const searchBtn = wrap.querySelector<HTMLButtonElement>("button")!;
    const resultEl = wrap.querySelector<HTMLElement>(".search-result")!;

    const search = async () => {
      const uid = input.value.trim();
      if (!uid) return;
      resultEl.innerHTML = `<p class="empty-note">Searching…</p>`;
      try {
        const { user } = await api.get<{ user: { uid: string; name: string } }>(`/api/friends/search/${uid}`);
        resultEl.innerHTML = "";
        const row = document.createElement("div");
        row.className = "friend-row";
        row.innerHTML = `
          <div class="friend-info">
            <div class="friend-name"></div>
            <div class="friend-uid">UID ${user.uid}</div>
          </div>
        `;
        row.querySelector(".friend-name")!.textContent = user.name;
        const addBtn = document.createElement("button");
        addBtn.className = "btn btn-primary btn-small";
        addBtn.textContent = "Add Friend";
        addBtn.onclick = async () => {
          addBtn.disabled = true;
          try {
            await api.post("/api/friends/request", { uid: user.uid });
            toast(`Friend request sent to ${user.name}`);
            resultEl.innerHTML = "";
            input.value = "";
          } catch (err) {
            toast(err instanceof Error ? err.message : "Failed to send request", true);
            addBtn.disabled = false;
          }
        };
        row.appendChild(addBtn);
        resultEl.appendChild(row);
      } catch (err) {
        resultEl.innerHTML = "";
        const note = document.createElement("p");
        note.className = "empty-note";
        note.textContent = err instanceof Error ? err.message : "Not found";
        resultEl.appendChild(note);
      }
    };
    searchBtn.onclick = () => void search();
    input.onkeydown = (e) => {
      if (e.key === "Enter") void search();
    };
  }
}
