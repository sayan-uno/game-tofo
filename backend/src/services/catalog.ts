import { config } from "../config.js";

/** ---------------------------------------------------------------------------
 *  The asset catalog — characters and animation clips.
 *
 *  Every entry stores a PATH, never a URL. `assetUrl()` is the single place a
 *  path becomes fetchable, so the CDN can move with one env var (see
 *  config.cdnBaseUrl) and nothing stored anywhere has to change.
 *
 *  Today this is a constant, because two free starter characters don't justify
 *  a table. It is shaped like the query that replaces it: when the store ships,
 *  `characters()` / `emotes()` become reads from an `items` table and every
 *  consumer — the collection page, the lobby broadcast, the equip endpoint —
 *  keeps working untouched. Same seam trick as careerStats() in profile.ts.
 *
 *  Cost: cold path. Built once at module load, served from memory, no I/O.
 * ------------------------------------------------------------------------- */

export type ItemKind = "character" | "emote";

/** What the clip actually is. Only `emote` clips are meant to be performed on
 *  purpose — the rest are movement the game plays for you. The collection page
 *  shows all of them (you can preview anything), but the future "show this to
 *  the squad" flow will only ever offer `emote`. */
export type ClipCategory = "emote" | "locomotion" | "traversal";

/** Which legendary effect a character wears. Only read for `legendary`
 *  rarity; anything else ignores it. Absent means "ember", so the field can be
 *  left off every character that shipped before a second effect existed. */
export type AuraKind = "ember" | "crystal";

export interface CharacterItem {
  id: string;
  kind: "character";
  name: string;
  /** CDN path — turn into a URL with assetUrl(). */
  key: string;
  rarity: "starter" | "rare" | "epic" | "legendary";
  /** Free starters are owned by everyone; paid ones will check user_items. */
  free: boolean;
  /** Legendary effect variant. Lives here rather than in the client so a new
   *  character's look is data, not a branch in the render code. */
  aura?: AuraKind;
}

export interface EmoteItem {
  id: string;
  kind: "emote";
  name: string;
  key: string;
  category: ClipCategory;
  /** Seconds. The client uses it to size the preview's progress bar. */
  duration: number;
  /** Loops forever (idle/walk/run) vs plays once (dance, vault). */
  loop: boolean;
  /** True when the clip carries the character across the floor. Those are
   *  wrong on a fixed lobby pedestal — the preview re-centres them instead. */
  rootMotion: boolean;
  free: boolean;
}

export type CatalogItem = CharacterItem | EmoteItem;

const CHARACTERS: CharacterItem[] = [
  { id: "male", kind: "character", name: "Ranger", key: "characters/male/v1/model.glb", rarity: "starter", free: true },
  { id: "female", kind: "character", name: "Vanguard", key: "characters/female/v1/model.glb", rarity: "starter", free: true },
  { id: "zenith", kind: "character", name: "Zenith", key: "characters/zenith/v1/model.glb", rarity: "legendary", free: true, aura: "ember" },
  // v6 carries the emissive mask that makes the garment itself glow: the chest
  // and back prisms, the wrist and boot crystals, the blue crown horns, and the
  // gold veins that veinFlow.ts runs a pulse down. Earlier versions are the same
  // mesh with less of that mask and stay published — /vN/ is immutable and
  // cached for a year, so nothing is reclaimed by pointing away from them, and
  // a client that fetched the catalog before this edit still wants the old one.
  { id: "seraph", kind: "character", name: "Seraph", key: "characters/seraph/v6/model.glb", rarity: "legendary", free: true, aura: "crystal" },
];

const EMOTES: EmoteItem[] = [
  { id: "dance-shake-it-off", kind: "emote", name: "Shake It Off", key: "animations/dance-shake-it-off/v1/anim.glb", category: "emote",      duration: 16.27, loop: false, rootMotion: true,  free: true },
  { id: "idle",               kind: "emote", name: "Idle",         key: "animations/idle/v1/anim.glb",               category: "locomotion", duration: 9.97,  loop: true,  rootMotion: false, free: true },
  { id: "walk",               kind: "emote", name: "Walk",         key: "animations/walk/v1/anim.glb",               category: "locomotion", duration: 1.03,  loop: true,  rootMotion: false, free: true },
  { id: "run",                kind: "emote", name: "Run",          key: "animations/run/v1/anim.glb",                category: "locomotion", duration: 0.63,  loop: true,  rootMotion: false, free: true },
  { id: "run-fast",           kind: "emote", name: "Run Fast",     key: "animations/run-fast/v1/anim.glb",           category: "locomotion", duration: 0.57,  loop: true,  rootMotion: true,  free: true },
  { id: "sprint",             kind: "emote", name: "Sprint",       key: "animations/sprint/v1/anim.glb",             category: "locomotion", duration: 0.77,  loop: true,  rootMotion: true,  free: true },
  { id: "vault",              kind: "emote", name: "Vault",        key: "animations/vault/v1/anim.glb",              category: "traversal",  duration: 1.17,  loop: false, rootMotion: true,  free: true },
  { id: "roll",               kind: "emote", name: "Roll Dodge",   key: "animations/roll/v1/anim.glb",               category: "traversal",  duration: 1.27,  loop: false, rootMotion: true,  free: true },
  { id: "fall",               kind: "emote", name: "Fall",         key: "animations/fall/v1/anim.glb",               category: "traversal",  duration: 4.5,   loop: false, rootMotion: false, free: true },
];

/** Worn by anyone who hasn't chosen — and the fallback whenever a stored id no
 *  longer exists in the catalog (character retired, typo in the DB). */
export const DEFAULT_CHARACTER = CHARACTERS[0].id;

/** The clip the lobby plays on every character standing around. */
export const LOBBY_IDLE_CLIP = "idle";

/** Path → fetchable URL. The ONLY place the two are joined. Returns null when
 *  CDN_BASE_URL isn't configured, which the client reads as "no 3D assets
 *  available" and falls back to the built-in placeholder character. */
export function assetUrl(key: string): string | null {
  return config.cdnBaseUrl ? `${config.cdnBaseUrl}/${key}` : null;
}

export const characters = (): CharacterItem[] => CHARACTERS;
export const emotes = (): EmoteItem[] => EMOTES;

/** Resolve a stored character id to one that definitely exists. A player whose
 *  equipped character was removed from the catalog gets the default rather
 *  than an empty pedestal. */
export function resolveCharacter(id: string | null | undefined): string {
  return id && CHARACTERS.some((c) => c.id === id) ? id : DEFAULT_CHARACTER;
}

/** Can this player equip this character? Every starter is free today; once
 *  paid characters exist this is where the user_items lookup goes. */
export function canEquip(id: string): boolean {
  const item = CHARACTERS.find((c) => c.id === id);
  return item !== undefined && item.free;
}

/** The client-facing catalog: same items, with paths resolved to URLs and
 *  ownership flattened into a boolean the UI can render directly. */
export function publicCatalog() {
  return {
    characters: CHARACTERS.map(({ key, free, ...rest }) => ({ ...rest, url: assetUrl(key), owned: free })),
    emotes: EMOTES.map(({ key, free, ...rest }) => ({ ...rest, url: assetUrl(key), owned: free })),
    defaultCharacter: DEFAULT_CHARACTER,
    lobbyIdleClip: LOBBY_IDLE_CLIP,
  };
}
