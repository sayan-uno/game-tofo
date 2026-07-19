import { api } from "../api/http";
import { emitAck } from "../api/socket";
import { actionToast, toast } from "./toast";
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
  private myLobbyId: string | null = null;
  private dnd = false;

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

  /** Called on every lobby:members update so "Same group" tags stay honest. */
  setLobby(lobbyId: string) {
    if (this.myLobbyId === lobbyId) return;
    this.myLobbyId = lobbyId;
    if (this.open) void this.refresh();
  }

  async refresh() {
    try {
      const [friendsRes, requestsRes] = await Promise.all([
        api.get<{ friends: Friend[]; dnd: boolean }>("/api/friends"),
        api.get<{ requests: FriendRequest[] }>("/api/friends/requests"),
      ]);
      this.friends = friendsRes.friends;
      this.dnd = friendsRes.dnd;
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
    // Do Not Disturb: friends can still message me, but can't invite me or
    // ask to join my group while this is on.
    const dndRow = document.createElement("label");
    dndRow.className = "dnd-row";
    dndRow.innerHTML = `
      <span class="dnd-label">🔕 Do Not Disturb</span>
      <span class="dnd-hint">Friends can message, but can't invite you</span>
      <span class="switch"><input type="checkbox" ${this.dnd ? "checked" : ""} /><span class="switch-slider"></span></span>
    `;
    const checkbox = dndRow.querySelector<HTMLInputElement>("input")!;
    checkbox.onchange = async () => {
      const wanted = checkbox.checked;
      try {
        const res = await emitAck<{ ok?: boolean; on?: boolean; error?: string }>("user:dnd", { on: wanted });
        if (res.error) throw new Error(res.error);
        this.dnd = wanted;
        toast(wanted ? "Do Not Disturb on — no more invites" : "Do Not Disturb off");
      } catch (err) {
        checkbox.checked = !wanted;
        toast(err instanceof Error ? err.message : "Failed to update", true);
      }
    };
    this.body.appendChild(dndRow);

    if (this.friends.length === 0) {
      this.body.insertAdjacentHTML("beforeend", `<p class="empty-note">No friends yet. Use the Add tab to find players by UID.</p>`);
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
      const sameGroup = friend.online && friend.lobbyId !== null && friend.lobbyId === this.myLobbyId;
      if (sameGroup) {
        const tag = document.createElement("span");
        tag.className = "same-group-tag";
        tag.textContent = "Same group";
        row.appendChild(tag);
      } else if (friend.online) {
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
        if (friend.inGroup) {
          const joinBtn = document.createElement("button");
          joinBtn.className = "btn btn-ghost btn-small";
          joinBtn.textContent = "Join";
          joinBtn.title = `Ask to join ${friend.name}'s group`;
          joinBtn.onclick = async () => {
            joinBtn.disabled = true;
            try {
              const res = await emitAck("lobby:joinRequest", { friendUid: friend.uid });
              if (res.error) toast(res.error, true);
              else toast(`Join request sent to ${friend.name}`);
            } catch (err) {
              toast(err instanceof Error ? err.message : "Request failed", true);
            } finally {
              joinBtn.disabled = false;
            }
          };
          row.appendChild(joinBtn);
        }
      }
      const unfriendBtn = document.createElement("button");
      unfriendBtn.className = "btn btn-ghost btn-small btn-danger";
      unfriendBtn.textContent = "✕";
      unfriendBtn.title = "Unfriend";
      unfriendBtn.onclick = () => {
        actionToast(
          `Remove ${friend.name} from your friends?`,
          () => {
            void (async () => {
              try {
                await api.post("/api/friends/unfriend", { uid: friend.uid });
                toast(`${friend.name} removed from friends`);
                await this.refresh();
              } catch (err) {
                toast(err instanceof Error ? err.message : "Failed to unfriend", true);
              }
            })();
          },
          () => {}
        );
      };
      row.appendChild(unfriendBtn);
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
