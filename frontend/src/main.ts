import { EV, WORLD_EV } from "./shared/core/protocol";
import type { WorldChatMessage, WorldLfg, WorldPopulation } from "./shared/core/protocol";
import "./style.css";
import { api, ApiError, getToken, clearSession } from "./api/http";
import { connectSocket, emitAck } from "./api/socket";
import { showLogin } from "./ui/login";
import { showUsernameSetup } from "./ui/username";
import { passEntryGate } from "./ui/entryGate";
import { Hud } from "./ui/hud";
import { FriendsPanel } from "./ui/friends";
import { ChatPanel } from "./ui/chat";
import { toast, actionToast } from "./ui/toast";
import { showPinned, toggleEvents, type GameEvent } from "./ui/events";
import {
  closeNoticeList,
  showMaintenance,
  showNotice,
  toggleNotices,
  type MaintenanceState,
} from "./ui/platformNotice";
import { joinVoice, leaveVoice, onMicChange, revalidateVoice } from "./voice/livekit";
import type { LobbyGameController } from "./platform/lobbyGame";
import type { MatchClient } from "./platform/matchClient";
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

  // The game platform (game picker, pack download, match lifecycle) is a
  // lobby-time concern, so it downloads alongside Babylon rather than sitting
  // in the login shell. Settled before the socket connects below — it has to
  // exist by the first lobby:members event.
  const platformChunk = Promise.all([import("./platform/lobbyGame"), import("./platform/matchClient")]);

  // Phones: one-tap gate → fullscreen + landscape (PUBG-style). No-op on desktop.
  const closeGate = await passEntryGate();

  const [{ createEngine, startRenderLoop, setRenderPaused }, { LobbyScene }] = await heavyChunks;

  const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
  const engine = createEngine(canvas);

  // Nothing of the lobby is visible behind an opaque full-screen page — stop
  // drawing it until the player comes back.
  const profileHooks = {
    onShow: () => setRenderPaused(engine, true),
    onHide: () => setRenderPaused(engine, false),
  };

  // Profile page + player card are their own chunk: off the lobby's critical
  // path, but warmed while the device is idle so the first tap is instant.
  let profileChunk: Promise<{
    profile: typeof import("./ui/profile");
    card: typeof import("./ui/memberCard");
  }> | null = null;
  const loadProfileUi = () =>
    (profileChunk ??= Promise.all([import("./ui/profile"), import("./ui/memberCard")])
      .then(([profile, card]) => ({ profile, card }))
      .catch((err: unknown) => {
        profileChunk = null; // a chunk that failed to download must not poison the next tap
        throw err;
      }));
  whenIdle(() => void loadProfileUi().catch(() => {}));

  // The collection page is its own chunk too. Its module also owns the asset
  // catalog, which the LOBBY needs — squadmates' character models are resolved
  // through it — so the chunk is pulled now and the catalog request starts
  // immediately, in parallel with everything below.
  const collectionChunk = import("./ui/collection");
  const catalogReady = collectionChunk.then((m) => m.primeCollection()).catch(() => null);

  // The store is its own chunk too, and NOT pulled now: most sessions never
  // open it. What is fetched immediately is the balance, because the HUD's two
  // chips are on screen from the first frame and a wallet that says "—" for a
  // second reads as a wallet that is broken.
  const storeChunk = () => import("./ui/store");
  const walletReady = storeChunk()
    .then((m) => m.primeWallet())
    .catch(() => null);

  // Tapping any teammate's character opens their player card. Everyone sees
  // the snapshot and the way through to the full profile; only the leader also
  // gets the group controls on it.
  let lobbyState: LobbyState | null = null;

  // Tapping YOUR OWN character opens the emote sheet. Picking one performs it
  // immediately — the player who chose it never waits for the server — and
  // tells the squad, who play the same clip through the same path.
  const onSelfTap = () => {
    void import("./ui/emotes")
      .then(({ openEmoteSheet }) =>
        openEmoteSheet({
          onOpen: () => void lobby.prefetchEmotes(),
          onPick: (emoteId) => {
            void lobby.playEmote(user.uid, emoteId);
            void emitAck("lobby:emote", { emoteId }).then((res) => {
              // The emote already played here; this only reports that the
              // squad didn't get it, which is worth knowing and not fatal.
              if (res.error) toast(res.error, true);
            });
          },
        })
      )
      .catch(() => toast("Couldn't open your emotes", true));
  };

  const onMemberTap = (uid: string) => {
    const state = lobbyState;
    if (uid === user.uid) {
      onSelfTap();
      return;
    }
    if (!state) return;
    const member = state.members.find((m) => m.uid === uid);
    if (!member) return;
    const isLeader = state.members.find((m) => m.uid === user.uid)?.isLeader === true;
    void loadProfileUi()
      .then(({ card }) =>
        card.showMemberCard(member, {
          profileHooks,
          manage: isLeader
            ? {
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
              }
            : undefined,
        })
      )
      .catch(() => toast("Couldn't open that player's card", true));
  };

  const lobby = new LobbyScene(engine, user.uid, onMemberTap);
  const renderLobby = () => lobby.scene.render();
  startRenderLoop(engine, renderLobby);

  /** Open the locker on one item — what an event's "See it" does. */
  const openCollectionAt = (itemId: string) => {
    void collectionChunk
      .then((m) =>
        m.openCollection({
          engine,
          lobbyScene: lobby.scene,
          restoreLobby: () => startRenderLoop(engine, renderLobby),
          focusItem: itemId,
        })
      )
      .catch(() => toast("Couldn't open your collection", true));
  };

  const uiRoot = document.getElementById("ui-root")!;
  const friendsPanel = new FriendsPanel(uiRoot);
  // The game platform's two halves are built once the socket exists (below);
  // the HUD's buttons reach them through these.
  let lobbyGame: LobbyGameController | null = null;
  let matchClient: MatchClient | null = null;
  const hud = new Hud(user, {
    onOpenEvents: () => {
      void api
        .get<{ events: GameEvent[] }>("/api/events")
        .then((r) => toggleEvents(r.events, openCollectionAt))
        .catch(() => toast("Couldn't load what's on", true));
    },
    onOpenNotices: () => {
      void toggleNotices(async () => {
        const { notices } = await api.get<{ notices: { id: string; body: string; sentAt: string }[] }>("/api/notices");
        return notices;
      });
    },
    onSayReady: (ready) => {
      void emitAck(EV.sayReady, { ready }).then((res) => {
        if (res.error) toast(res.error, true);
      });
    },
    onObjectGame: () => {
      void emitAck(EV.objectGame).then((res) => {
        if (res.error) toast(res.error, true);
        else toast("Your leader has been told");
      });
    },
    onToggleFriends: () => friendsPanel.toggle(),
    onToggleChat: () => chatPanel.toggle(),
    onOpenProfile: () => {
      void loadProfileUi()
        .then(({ profile }) => profile.openProfile(user, { self: true, ...profileHooks }))
        .catch(() => toast("Couldn't open your profile", true));
    },
    onOpenStore: () => {
      void storeChunk()
        .then((m) => m.openStore())
        .catch(() => toast("Couldn't open the store", true));
    },
    onOpenCollection: () => {
      // The page takes the canvas for its own preview scene; restoreLobby hands
      // it straight back. The lobby is never disposed, so returning is instant.
      void collectionChunk
        .then((m) =>
          m.openCollection({
            engine,
            lobbyScene: lobby.scene,
            restoreLobby: () => startRenderLoop(engine, renderLobby),
          })
        )
        .catch(() => toast("Couldn't open your collection", true));
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
    onChooseGame: () => void lobbyGame?.openSheet(),
    onStart: () => void lobbyGame?.start(),
  });
  const chatPanel = new ChatPanel(uiRoot, user, {
    onUnread: (hasUnread) => hud.setChatUnread(hasUnread),
    // A name in world chat belongs to somebody you have never met, which makes
    // "who is this" the commonest question in the room — so it opens the same
    // profile a squadmate's pedestal does.
    onOpenPlayer: (uid, name) => {
      if (uid === user.uid) return;
      void loadProfileUi()
        .then(({ profile }) => profile.openProfile({ id: "", uid, name, avatarUrl: null }, profileHooks))
        .catch(() => toast("Couldn't open that player's card", true));
    },
  });
  // Restore red dots for messages that arrived while offline (non-critical —
  // on failure the dots simply start empty).
  void api
    .get<{ unread: { uid: string; isFriend: boolean }[] }>("/api/chat/unread")
    .then(({ unread }) => chatPanel.seedUnread(unread))
    .catch(() => {});
  closeGate();

  // Settle the catalog before the socket can deliver a member list. It has
  // been in flight since the top of this function, so by now it costs nothing —
  // and it removes the race where members arrive first and everyone is stuck
  // as a placeholder until the next roster change. A failed fetch resolves to
  // null and the lobby simply keeps its built-in characters.
  const collection = await catalogReady;

  // Head start: begin fetching the player's own character (and the idle clip)
  // right now, so it downloads alongside the socket handshake rather than after
  // the member list arrives. Fire-and-forget — the lobby loads it properly
  // either way, this just usually gets there first.
  if (collection?.equippedCharacter) {
    void import("./game/characterRig")
      .then((m) => m.prefetchCharacter(collection.equippedCharacter, lobby.scene))
      .catch(() => {});
  }

  const [{ LobbyGameController }, { MatchClient }] = await platformChunk;
  const socket = connectSocket();

  // Party voice: the lobby's room while squadded up, nothing while solo — and
  // hands off entirely while a match runs (the match client owns voice then:
  // one room for the whole roster, party room again the moment it ends).
  //
  // WHO is in the party decides this, and the client is deliberately not told
  // which of its teammates are people — so it asks. The server answers with no
  // room when there is nobody left to talk to, and joinVoice then does nothing
  // (see voice/livekit.ts). Re-asked only when the membership actually
  // CHANGES, because this broadcast also carries download progress and firing
  // a request at every percentage point would be a request a second.
  let voiceRoster = "";
  const applyPartyVoice = () => {
    if (matchClient?.active) return;
    const state = lobbyState;
    if (state && state.members.length > 1) {
      const roster = `${state.lobbyId}|${state.members.map((m) => m.uid).sort().join(",")}`;
      if (roster === voiceRoster) return;
      voiceRoster = roster;
      // A teammate leaving can turn a conversation into a room of one; the
      // server is the only side that can tell, so re-ask rather than assume.
      void revalidateVoice(state.lobbyId, () => joinVoice(state.lobbyId, (m, e) => toast(m, e), "party"));
    } else {
      voiceRoster = "";
      void leaveVoice();
    }
  };

  lobbyGame = new LobbyGameController({
    hud,
    lobby,
    localUid: user.uid,
    socket,
    onSearching: (size, found) => matchClient?.beginSearch(size, found),
  });
  matchClient = new MatchClient({
    engine,
    socket,
    localUid: user.uid,
    lobby,
    restoreLobby: () => startRenderLoop(engine, renderLobby),
    isPartyLeader: () => lobbyState?.members.find((m) => m.uid === user.uid)?.isLeader === true,
    onEnter: () => {
      // The lobby chrome steps aside; the game draws its own HUD.
      document.body.classList.add("in-match");
      friendsPanel.toggle(false);
      chatPanel.toggle(false);
      lobbyGame?.setInMatch(true);
    },
    onExit: () => {
      document.body.classList.remove("in-match");
      lobbyGame?.setInMatch(false);
      applyPartyVoice();
    },
  });

  // WHAT IS ON, on arrival. Fetched once per session — a pinned event is shown
  // on a fresh sign-in or a reload and not again until the next one, which is
  // why the "seen" mark lives in sessionStorage rather than localStorage.
  whenIdle(() => {
    void api
      .get<{ events: GameEvent[] }>("/api/events")
      .then((r) => showPinned(r.events, openCollectionAt))
      .catch(() => {
        /* an event nobody sees is not worth a toast */
      });
  });

  // ---- what the platform has to say -------------------------------------
  // The wallet, both ways: whatever the first read found, and every change
  // after it. `onBalance` fires immediately with what is already known, so the
  // chips are correct even if the socket message beat this subscription.
  void walletReady.then(() =>
    storeChunk()
      .then((m) => m.onBalance((b) => hud.setWallet(b)))
      .catch(() => undefined)
  );
  // Gems landing — a bank SMS matched, or an admin credited by hand. Carries
  // the new balance so nothing has to go and ask for it.
  socket.on(
    "wallet:update",
    (p: { balance?: { coins: number; gems: number; spentPaise: number }; paidSessionId?: string | null } | null) => {
      const balance = (p ?? {}).balance;
      if (!balance) return;
      void storeChunk()
        .then((m) => m.walletUpdated(balance, (p ?? {}).paidSessionId ?? null))
        .catch(() => undefined);
    }
  );

  socket.on("platform:notice", (p: { message?: string; level?: string } | null) => {
    if (p?.message) showNotice(p.message, p.level ?? "info");
  });
  // An admin took one back. The list is re-read from the server when it is
  // next opened, so all this has to do is stop showing the stale one.
  socket.on("platform:noticeGone", () => closeNoticeList());
  socket.on("platform:maintenance", (p: MaintenanceState | null) => {
    if (!p) return;
    showMaintenance(p, matchClient?.active === true, () => {
      // The platform is holding everybody: there is nobody left to talk to,
      // and a live microphone into an empty room is the last thing a player
      // wants left running while they walk away.
      void leaveVoice();
    });
  });

  socket.on("connect_error", (err) => {
    // The server refused us because the platform is shut. This is the honest
    // signal — not a message we were politely sent, but the door being locked
    // — so it is what the curtain is really driven by. It cannot be argued
    // with by editing the page: every route and every socket event behind it
    // is refused too.
    if (err.message === "MAINTENANCE") {
      showMaintenance({ active: true, at: Date.now(), message: "TOFO is down for maintenance." }, false, () => {
        void leaveVoice();
      });
      return;
    }
    // Banned. The socket refusal is the honest signal — the door being locked,
    // not a message we were politely sent — but it carries only the reason, so
    // the expiry is read off the API's own 403, which has it. Shown as a
    // screen with a way to appeal, because "Connection error: BANNED:Cheating"
    // in a toast is the truth delivered as though it were a bug.
    if (err.message.startsWith("BANNED:")) {
      const reason = err.message.slice("BANNED:".length);
      void leaveVoice();
      void import("./ui/banned").then(async ({ showBanned }) => {
        let until: string | null = null;
        try {
          await api.get("/api/profile/me");
        } catch (e) {
          if (e instanceof ApiError) until = e.until ?? null;
        }
        showBanned(reason, until);
      });
      return;
    }
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
    hud.setLobby(
      state.members.length,
      state.members.find((m) => m.uid === user.uid)?.isLeader === true,
      state.mode,
      state.teamCode ?? null
    );
    // In the team while the party is open — even alone in it (the group only
    // dies when its last member leaves, not when teammates walk out).
    chatPanel.setTeam(state.mode !== "solo");
    friendsPanel.setLobby(state.lobbyId, state.members.map((m) => m.uid));
    // Game pick + everyone's download progress → buttons and name-plate bars.
    lobbyGame?.onLobbyState(state);
    applyPartyVoice();
  });

  // A squadmate's download moved.
  socket.on("lobby:loading", (p: { uid?: string; pct?: number } | null) => {
    if (p && typeof p.uid === "string" && typeof p.pct === "number") lobbyGame?.onLoading(p.uid, p.pct);
  });

  socket.on("lobby:error", ({ error }: { error: string }) => toast(error, true));

  // Tell the server whenever this player's microphone opens or closes.
  //
  // Through the same subscription the two HUD buttons use, so the report and
  // what the player sees can never disagree — and it fires on a room refusing
  // the mic too, which is exactly the case worth having on record.
  let micReported = false;
  onMicChange((on) => {
    // Subscribing paints the button with what is already true, and that first
    // call is not a change — reporting it would stamp "closed their mic" on
    // every player the moment they load the lobby.
    if (!micReported) {
      micReported = true;
      return;
    }
    socket.emit("voice:mic", { on });
  });

  // A squadmate performed an emote. Same call the performer made locally, so
  // both sides of the group are running one behaviour rather than two.
  socket.on("lobby:emote", (payload: { uid?: string; emoteId?: string } | null) => {
    const { uid, emoteId } = payload ?? {};
    if (uid && emoteId) void lobby.playEmote(uid, emoteId);
  });

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

  // ---- world chat (W2) ----
  //
  // Routed straight through: the panel decides whether it is showing, and does
  // nothing at all when it is not. These only arrive while the World tab is
  // open — the socket joins the world's broadcast room on `world:hello` and
  // leaves it the moment the tab does.
  socket.on(WORLD_EV.msg, (msg: WorldChatMessage) => chatPanel.onWorldMessage(msg));
  socket.on(WORLD_EV.request, (req: WorldLfg) => chatPanel.onWorldRequest(req));
  socket.on(WORLD_EV.requestGone, ({ id }: { id: string }) => chatPanel.onWorldRequestGone(id));
  socket.on(WORLD_EV.population, (p: WorldPopulation) =>
    chatPanel.onWorldPopulation(p.online, p.capacity)
  );

  socket.on("friend:online", ({ uid, name }: { uid: string; name: string }) => {
    toast(`${name} is online`);
    friendsPanel.setFriendOnline(uid, true);
  });

  socket.on("friend:offline", ({ uid }: { uid: string }) => {
    friendsPanel.setFriendOnline(uid, false);
  });
}

void boot();
