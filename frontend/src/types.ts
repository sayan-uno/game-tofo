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
  /** Catalog id of the weapon in their hand, or null for empty-handed — which
   *  is the default, not a failure. Also resolved server-side. */
  weapon: string | null;
}

/** ---------------------------------------------------------------------------
 *  Collection — mirrors backend/src/services/catalog.ts. Every `url` is built
 *  server-side from CDN_BASE_URL; null means the CDN isn't configured, and the
 *  lobby falls back to its built-in placeholder character.
 * ------------------------------------------------------------------------- */
/** Which legendary effect a character wears. Only meaningful at `legendary`
 *  rarity; absent means "ember". */
export type AuraKind = "ember" | "crystal";

export interface CatalogCharacter {
  id: string;
  kind: "character";
  name: string;
  rarity: "starter" | "rare" | "epic" | "legendary";
  /** Chosen server-side so a new character's look is data, not a client branch. */
  aura?: AuraKind;
  url: string | null;
  owned: boolean;
}

/** A held prop. How it is held is baked into the model (pivot at the grip,
 *  blade +Y, metres) — see buildProp.mjs — so there is nothing positional here
 *  and a second weapon is a catalog line, not a change to the render code. */
export interface CatalogWeapon {
  id: string;
  kind: "weapon";
  name: string;
  rarity: "starter" | "rare" | "epic" | "legendary";
  /** Clip id to stand in while carrying this. Absent = the ordinary idle. */
  stance?: string;
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
  weapons: CatalogWeapon[];
  emotes: CatalogEmote[];
  defaultCharacter: string;
  lobbyIdleClip: string;
}

export interface CollectionData extends Catalog {
  equippedCharacter: string;
  /** null = empty-handed, the default. */
  equippedWeapon: string | null;
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
  distanceMetres: number;
  coins: number;
  totalScore: number;
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
  /** Game the leader picked for the party, or null. Tolerated as absent so a
   *  client that outlives a backend rollback keeps working. */
  game?: string | null;
  /** Download progress per member uid (0–100) for the picked game. */
  loading?: Record<string, number>;
  /** Uids who have said they want to play what is picked. The leader is not
   *  in here — pressing START is how they say it. Absent from an older
   *  backend, which reads as "nobody has been asked yet". */
  ready?: string[];
  /** Members who may not play the game that is picked, and why. Named rather
   *  than counted: a party told "somebody here cannot play this" spends the
   *  next minute working out who. */
  barred?: { uid: string; why: string }[];
}

/** One entry of GET /api/games — what the picker shows and what the pack
 *  loader downloads. Mirrors backend/src/routes/games.ts. */
export interface GameInfo {
  id: string;
  /** Why nobody may start this right now (an admin hold), or null. */
  heldReason?: string | null;
  /** Why THIS player may not play it, or null. */
  bannedReason?: string | null;
  name: string;
  tagline: string;
  matchSizes: Record<LobbyMode, number>;
  durationSec: number;
  /** Typical length when that differs from the ceiling above; null when the
   *  ceiling IS the length. */
  typicalSec: number | null;
  packVersion: string;
  packBytes: number;
  /** null when the CDN isn't configured or the pack hasn't been published. */
  packUrl: string | null;
}
