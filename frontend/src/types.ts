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
  /** Catalog id of the character this player is wearing. Always a valid id —
   *  the server resolves unset/retired values before broadcasting. */
  character: string;
}

/** ---------------------------------------------------------------------------
 *  Collection — mirrors backend/src/services/catalog.ts. Every `url` is built
 *  server-side from CDN_BASE_URL; null means the CDN isn't configured, and the
 *  lobby falls back to its built-in placeholder character.
 * ------------------------------------------------------------------------- */
export interface CatalogCharacter {
  id: string;
  kind: "character";
  name: string;
  rarity: "starter" | "rare" | "epic" | "legendary";
  url: string | null;
  owned: boolean;
}

export interface CatalogEmote {
  id: string;
  kind: "emote";
  name: string;
  /** Only "emote" clips are meant to be performed on purpose; the rest are
   *  movement. All are previewable, but the future squad-showcase uses this. */
  category: "emote" | "locomotion" | "traversal";
  duration: number;
  loop: boolean;
  /** Travels across the floor — wrong on a fixed pedestal, fine in a preview. */
  rootMotion: boolean;
  url: string | null;
  owned: boolean;
}

export interface Catalog {
  characters: CatalogCharacter[];
  emotes: CatalogEmote[];
  defaultCharacter: string;
  lobbyIdleClip: string;
}

export interface CollectionData extends Catalog {
  equippedCharacter: string;
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

/** Career card behind the top-left player chip. Mirrors the payload built in
 *  backend/src/services/profile.ts — everything match-related is zero/null
 *  until the first TOFO game ships. */
export interface ProfileStats {
  matches: number;
  wins: number;
  losses: number;
  /** Percent, 0–100. null until there's a match — rendered as "—". */
  winRate: number | null;
  kills: number;
  deaths: number;
  kd: number | null;
  playtimeMinutes: number;
  bestPlacement: number | null;
}

export interface ProfileRank {
  tier: string;
  label: string;
  note: string;
  placementsDone: number;
  placementsNeeded: number;
}

export interface ProfileAchievement {
  id: string;
  name: string;
  desc: string;
  icon: string;
  unlocked: boolean;
  /** Countable goals show a progress bar while still locked. */
  progress?: { have: number; need: number };
}

export interface Profile {
  user: User;
  /** False when looking at a squadmate's card — owner-only rows are dropped. */
  isSelf: boolean;
  online: boolean;
  level: number;
  xpInLevel: number;
  xpForLevel: number;
  totalXp: number;
  rank: ProfileRank;
  stats: ProfileStats;
  achievements: ProfileAchievement[];
  friends: number;
  memberSince: string;
  /** Owner-only — null on someone else's profile. */
  lastLoginAt: string | null;
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
