import "./style.css";
import { api, getToken, clearSession } from "./api/http";
import { connectSocket, emitAck } from "./api/socket";
import { showLogin } from "./ui/login";
import { passEntryGate } from "./ui/entryGate";
import { Hud } from "./ui/hud";
import { FriendsPanel } from "./ui/friends";
import { ChatPanel } from "./ui/chat";
import { toast, actionToast } from "./ui/toast";
import { joinVoice, leaveVoice } from "./voice/livekit";
import type { LobbyState, User } from "./types";

async function boot() {
  // Try to resume an existing session; otherwise show the login screen.
  if (getToken()) {
    try {
      const { user } = await api.get<{ user: User }>("/api/auth/me");
      await enterLobby(user);
      return;
    } catch {
      clearSession();
    }
  }
  showLogin((user) => void enterLobby(user));
}

async function enterLobby(user: User) {
  document.body.classList.add("in-game");

  // Babylon is the heaviest dependency — load it only when actually entering
  // the lobby, so the login screen stays instant even on slow connections.
  // Kicked off before the entry gate so the chunks download while the player
  // is tapping through it.
  const heavyChunks = Promise.all([import("./game/engine"), import("./game/lobbyScene")]);

  // Phones: one-tap gate → fullscreen + landscape (PUBG-style). No-op on desktop.
  const closeGate = await passEntryGate();

  const [{ createEngine, startRenderLoop }, { LobbyScene }] = await heavyChunks;

  const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
  const engine = createEngine(canvas);
  const lobby = new LobbyScene(engine, user.uid);
  startRenderLoop(engine, () => lobby.scene.render());

  const uiRoot = document.getElementById("ui-root")!;
  const friendsPanel = new FriendsPanel(uiRoot);
  const hud = new Hud(user, {
    onToggleFriends: () => friendsPanel.toggle(),
    onToggleChat: () => chatPanel.toggle(),
    onLeaveLobby: () => {
      void emitAck("lobby:leave").then((res) => {
        if (res.error) toast(res.error, true);
      });
    },
    onChangeMode: (mode) => {
      void emitAck("lobby:mode", { mode }).then((res) => {
        if (res.error) toast(res.error, true);
      });
    },
  });
  const chatPanel = new ChatPanel(uiRoot, user, {
    onUnread: (hasUnread) => hud.setChatUnread(hasUnread),
  });
  closeGate();

  const socket = connectSocket();

  socket.on("connect_error", (err) => {
    toast(`Connection error: ${err.message}`, true);
  });

  socket.on("lobby:members", (state: LobbyState) => {
    lobby.setMembers(state.members);
    hud.setLobby(state.members.length, state.lobbyId === `L${user.uid}`, state.mode);
    chatPanel.setTeam(state.members.length > 1);
    friendsPanel.setLobby(state.lobbyId);
    // Voice: join the lobby's room when squadded up, leave when solo.
    if (state.members.length > 1) {
      void joinVoice(state.lobbyId, (msg, isError) => toast(msg, isError));
    } else {
      void leaveVoice();
    }
  });

  socket.on("lobby:error", ({ error }: { error: string }) => toast(error, true));

  socket.on("lobby:invite", ({ from, lobbyId }: { from: { uid: string; name: string }; lobbyId: string }) => {
    actionToast(
      `${from.name} invited you to their lobby`,
      () => {
        void emitAck("lobby:join", { lobbyId }).then((res) => {
          if (res.error) toast(res.error, true);
        });
      },
      () => {}
    );
  });

  socket.on("lobby:joinRequest", ({ from }: { from: { uid: string; name: string } }) => {
    actionToast(
      `${from.name} wants to join your group`,
      () => {
        void emitAck("lobby:joinRespond", { requesterUid: from.uid, accept: true }).then((res) => {
          if (res.error) toast(res.error, true);
        });
      },
      () => {
        void emitAck("lobby:joinRespond", { requesterUid: from.uid, accept: false });
      }
    );
  });

  socket.on("lobby:joinApproved", ({ name }: { name: string }) => {
    toast(`${name} let you into the group!`);
  });

  socket.on("lobby:joinDeclined", ({ name }: { name: string }) => {
    toast(`${name} declined your join request`, true);
  });

  socket.on("friend:request", ({ name }: { name: string }) => {
    toast(`${name} sent you a friend request`);
    void friendsPanel.refresh();
  });

  socket.on("friend:accepted", ({ name }: { name: string }) => {
    toast(`${name} accepted your friend request!`);
    void friendsPanel.refresh();
    chatPanel.onRelationshipChanged();
  });

  // Unfriended by someone — no toast (Free Fire keeps this silent too), but
  // their chat thread moves from Friends to Recent right away.
  socket.on("friend:removed", () => {
    void friendsPanel.refresh();
    chatPanel.onRelationshipChanged();
  });

  socket.on("chat:dm", (msg: { id: string; from: { uid: string; name: string }; body: string; at: string; isFriend: boolean }) => {
    chatPanel.onDmReceived(msg);
  });

  socket.on("chat:team", (msg: { id: string; from: { uid: string; name: string }; body: string; at: string }) => {
    chatPanel.onTeamReceived(msg);
  });

  socket.on("friend:online", ({ uid, name }: { uid: string; name: string }) => {
    toast(`${name} is online`);
    friendsPanel.setFriendOnline(uid, true);
  });

  socket.on("friend:offline", ({ uid }: { uid: string }) => {
    friendsPanel.setFriendOnline(uid, false);
  });
}

void boot();
