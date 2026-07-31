import "./style.css";
import { api, getToken, clearSession } from "./api/http";
import { connectSocket, emitAck } from "./api/socket";
import { showLogin } from "./ui/login";
import { showUsernameSetup } from "./ui/username";
import { passEntryGate } from "./ui/entryGate";
import { Hud } from "./ui/hud";
import { FriendsPanel } from "./ui/friends";
import { ChatPanel } from "./ui/chat";
import { showMemberMenu } from "./ui/memberMenu";
import { toast, actionToast } from "./ui/toast";
import { joinVoice, leaveVoice } from "./voice/livekit";
import type { LobbyState, User } from "./types";

async function boot() {
  // Try to resume an existing session; otherwise show the login screen.
  if (getToken()) {
    try {
      const { user, needsUsername } = await api.get<{ user: User; needsUsername?: boolean }>("/api/auth/me");
      afterAuth(user, needsUsername === true);
      return;
    } catch {
      clearSession();
    }
  }
  showLogin(afterAuth);
}

/** Accounts without a claimed gamer tag (brand-new OR from before usernames
 *  existed) go through the one-time claim screen first; everyone else drops
 *  straight into the lobby. The server enforces the same gate at the socket
 *  handshake, so this isn't just cosmetic routing. */
function afterAuth(user: User, needsUsername: boolean) {
  if (needsUsername) showUsernameSetup(user, (claimed) => void enterLobby(claimed));
  else void enterLobby(user);
}

/** Run once the device has a spare moment (Safari only shipped
 *  requestIdleCallback recently, hence the timeout fallback). */
function whenIdle(fn: () => void) {
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(() => fn());
  else window.setTimeout(fn, 1500);
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

  const [{ createEngine, startRenderLoop, setRenderPaused }, { LobbyScene }] = await heavyChunks;

  const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
  const engine = createEngine(canvas);

  // Tapping a teammate's character opens the leader's manage menu
  // (transfer leadership / kick). Non-leaders and self-taps do nothing.
  let lobbyState: LobbyState | null = null;
  const onMemberTap = (uid: string) => {
    const state = lobbyState;
    if (!state || uid === user.uid || state.lobbyId !== `L${user.uid}`) return;
    const member = state.members.find((m) => m.uid === uid);
    if (!member) return;
    // Menu buttons act immediately — opening the menu is the deliberate step,
    // a second accept/decline prompt was dropped on purpose.
    showMemberMenu(member.name, {
      onTransfer: () => {
        void emitAck("lobby:transferLead", { targetUid: uid }).then((res) => {
          if (res.error) toast(res.error, true);
        });
      },
      onKick: () => {
        void emitAck("lobby:kick", { targetUid: uid }).then((res) => {
          if (res.error) toast(res.error, true);
        });
      },
    });
  };

  const lobby = new LobbyScene(engine, user.uid, onMemberTap);
  startRenderLoop(engine, () => lobby.scene.render());

  // The profile page is its own chunk: off the lobby's critical path, but
  // warmed while the device is idle so the first tap on the chip is instant.
  let profileChunk: Promise<typeof import("./ui/profile")> | null = null;
  const loadProfile = () =>
    (profileChunk ??= import("./ui/profile").catch((err: unknown) => {
      profileChunk = null; // a chunk that failed to download must not poison the next tap
      throw err;
    }));
  whenIdle(() => void loadProfile().catch(() => {}));

  const uiRoot = document.getElementById("ui-root")!;
  const friendsPanel = new FriendsPanel(uiRoot);
  const hud = new Hud(user, {
    onToggleFriends: () => friendsPanel.toggle(),
    onToggleChat: () => chatPanel.toggle(),
    onOpenProfile: () => {
      void loadProfile()
        .then(({ openProfile }) =>
          openProfile(user, {
            // Nothing of the lobby is visible behind an opaque full-screen
            // page — stop drawing it until the player comes back.
            onShow: () => setRenderPaused(engine, true),
            onHide: () => setRenderPaused(engine, false),
          })
        )
        .catch(() => toast("Couldn't open your profile", true));
    },
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
    onJoinByCode: async (code) => {
      try {
        const res = await emitAck("lobby:joinByCode", { code });
        if (res.error) toast(res.error, true);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Join failed", true);
      }
    },
    onTeamCode: async (reset) => {
      try {
        const res = await emitAck("lobby:teamCode", { reset });
        if (res.error) toast(res.error, true);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Team code failed", true);
      }
    },
  });
  const chatPanel = new ChatPanel(uiRoot, user, {
    onUnread: (hasUnread) => hud.setChatUnread(hasUnread),
  });
  // Restore red dots for messages that arrived while offline (non-critical —
  // on failure the dots simply start empty).
  void api
    .get<{ unread: { uid: string; isFriend: boolean }[] }>("/api/chat/unread")
    .then(({ unread }) => chatPanel.seedUnread(unread))
    .catch(() => {});
  closeGate();

  const socket = connectSocket();

  socket.on("connect_error", (err) => {
    // A session that slipped past the claim screen (stale token from another
    // tab/device) gets bounced back to boot, which lands on that screen.
    if (err.message === "USERNAME_REQUIRED") {
      location.reload();
      return;
    }
    toast(`Connection error: ${err.message}`, true);
  });

  socket.on("lobby:members", (state: LobbyState) => {
    lobbyState = state;
    lobby.setMembers(state.members);
    hud.setLobby(state.members.length, state.lobbyId === `L${user.uid}`, state.mode, state.teamCode ?? null);
    // In the team while the party is open — even alone in it (the group only
    // dies when its last member leaves, not when teammates walk out).
    chatPanel.setTeam(state.mode !== "solo");
    friendsPanel.setLobby(state.lobbyId, state.members.map((m) => m.uid));
    // Voice: join the lobby's room when squadded up, leave when solo.
    if (state.members.length > 1) {
      void joinVoice(state.lobbyId, (msg, isError) => toast(msg, isError));
    } else {
      void leaveVoice();
    }
  });

  socket.on("lobby:error", ({ error }: { error: string }) => toast(error, true));

  // A member revealed or reset the party's code — keep every open card fresh.
  socket.on("lobby:teamCode", ({ teamCode }: { teamCode: string }) => {
    hud.setTeamCode(teamCode);
  });

  socket.on("lobby:invite", ({ from, lobbyId }: { from: { uid: string; name: string }; lobbyId: string }) => {
    actionToast(
      `${from.name} invited you to their lobby`,
      () => {
        void emitAck("lobby:join", { lobbyId }).then((res) => {
          if (res.error) toast(res.error, true);
        });
      },
      () => {},
      7000
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
      },
      7000,
      () => {} // expiry vanishes silently — only a pressed Decline notifies
    );
  });

  socket.on("lobby:joinApproved", ({ name }: { name: string }) => {
    toast(`${name} let you into the group!`);
  });

  socket.on("lobby:leader", ({ uid, name }: { uid: string; name: string }) => {
    toast(uid === user.uid ? "You are now the group leader 👑" : `${name} is now the group leader`);
  });

  socket.on("lobby:kicked", ({ by }: { by: string }) => {
    toast(`${by} removed you from the group`, true);
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
    // Free Fire-style: the message also pops up over the sender's head (the
    // server echoes team chat to the whole room, so own messages show too).
    lobby.showChatBubble(msg.from.uid, msg.body);
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
