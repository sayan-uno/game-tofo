export interface User {
  id: string;
  uid: string;
  name: string;
  avatarUrl: string | null;
}

export interface Friend extends User {
  online: boolean;
  /** The lobby this friend is currently in (null when offline). */
  lobbyId: string | null;
  /** True when that lobby is a real group (2+ players). */
  inGroup: boolean;
}

export interface FriendRequest {
  requestId: string;
  uid: string;
  name: string;
  avatarUrl: string | null;
}

export interface LobbyMember extends User {
  isLeader: boolean;
}

export interface ChatMessage {
  id: string;
  fromMe: boolean;
  fromUid?: string;
  fromName?: string;
  body: string;
  at: string;
}

export interface ChatThread {
  user: User;
  isFriend: boolean;
  blockedByMe: boolean;
  lastBody: string;
  lastFromMe: boolean;
  lastAt: string;
}

export interface DmHistory {
  user: User;
  isFriend: boolean;
  blockedByMe: boolean;
  messages: ChatMessage[];
}

export interface TeamHistory {
  inTeam: boolean;
  messages: ChatMessage[];
}

export type LobbyMode = "solo" | "duo" | "squad";

export interface LobbyState {
  lobbyId: string;
  mode: LobbyMode;
  members: LobbyMember[];
  /** 6-digit share code, once a member revealed one — null in solo AND in a
   *  fresh party where nobody has asked for the code yet. */
  teamCode: string | null;
}
