export interface User {
  id: string;
  uid: string;
  name: string;
  avatarUrl: string | null;
}

export interface Friend extends User {
  online: boolean;
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

export interface LobbyState {
  lobbyId: string;
  members: LobbyMember[];
}
