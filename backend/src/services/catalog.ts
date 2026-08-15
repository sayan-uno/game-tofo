import { config } from "../config.js";

/** ---------------------------------------------------------------------------
 *  The asset catalog — characters, weapons and animation clips.
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

export type ItemKind = "character" | "weapon" | "emote";

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

/** A held prop. Everything about HOW it is held is baked into the model —
 *  pivot at the grip, blade down +Y, edge along X, sized in metres — so the
 *  client has one hand transform for all of them and a second weapon is a
 *  catalog line, not a branch in the render code (see buildProp.mjs, and
 *  weapon.ts on the client for the other half of that contract). */
export interface WeaponItem {
  id: string;
  kind: "weapon";
  name: string;
  /** CDN path — turn into a URL with assetUrl(). */
  key: string;
  rarity: "starter" | "rare" | "epic" | "legendary";
  free: boolean;
  /** Clip id the character stands in while carrying this — a stance, not an
   *  emote. Absent means they keep the ordinary idle. Per-weapon because a
   *  greatsword and a pistol are not held the same way, so the day a second
   *  weapon ships this is a catalog line rather than a branch in the scene. */
  stance?: string;
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

export type CatalogItem = CharacterItem | WeaponItem | EmoteItem;

// Every character moved up a version at once, and they have to stay in step:
// each of these carries a right hand closed into a fist, with the tunnel
// through it aimed by 45 degrees of baked pronation (gripHand.mjs). The
// client's weapon.ts holds the matching grip transform, so a character left
// on an older version would go back to a sword floating past an open palm.
//
// Earlier versions stay published — /vN/ is immutable and cached for a year,
// so nothing is reclaimed by pointing away from them, and a client that
// fetched the catalog before this edit still wants the old one.
//
// male and zenith are at v3 rather than v2 for a dull reason worth writing
// down: both were requested over the CDN in the seconds before R2 finished
// accepting them, and the edge cached the 404 it got. The object was fine;
// the URL was poisoned, and there is no purge credential here. Publishing a
// fresh path is the fix, and the lesson is to let an upload settle BEFORE
// fetching it — a 404 cached against a live path outlives the mistake.
const CHARACTERS: CharacterItem[] = [
  { id: "male", kind: "character", name: "Ranger", key: "characters/male/v3/model.glb", rarity: "starter", free: true },
  { id: "female", kind: "character", name: "Vanguard", key: "characters/female/v2/model.glb", rarity: "starter", free: true },
  { id: "zenith", kind: "character", name: "Zenith", key: "characters/zenith/v3/model.glb", rarity: "legendary", free: true, aura: "ember" },
  // Seraph's v6 added the emissive mask that makes the garment itself glow: the
  // chest and back prisms, the wrist and boot crystals, the blue crown horns,
  // and the gold veins that veinFlow.ts runs a pulse down. v7 is that same
  // model with the fist.
  { id: "seraph", kind: "character", name: "Seraph", key: "characters/seraph/v7/model.glb", rarity: "legendary", free: true, aura: "crystal" },
];

const WEAPONS: WeaponItem[] = [
  { id: "crimson-fang", kind: "weapon", name: "Crimson Fang", key: "weapons/crimson-fang/v1/model.glb", rarity: "legendary", free: true, stance: "sword-idle" },
];

const EMOTES: EmoteItem[] = [
  { id: "dance-shake-it-off", kind: "emote", name: "Shake It Off", key: "animations/dance-shake-it-off/v1/anim.glb", category: "emote",      duration: 16.27, loop: false, rootMotion: true,  free: true },
  { id: "idle",               kind: "emote", name: "Idle",         key: "animations/idle/v1/anim.glb",               category: "locomotion", duration: 9.97,  loop: true,  rootMotion: false, free: true },
  // Idle re-posed into the sword carry — feet apart, blade lowered across the
  // front — derived from the idle clip itself (poseClip.mjs), so the breathing
  // still runs underneath the stance. Worn automatically by anyone holding a
  // weapon that names it; it is listed here because that is how every clip's
  // URL gets resolved, not because it is meant to be performed on purpose.
  //
  // Matched to img/sword-picking*.png: feet apart, sword arm out at the side
  // with the elbow carried outward rather than tucked behind, blade lowered
  // and sweeping across the front of the legs. Blade lands exactly on the
  // reference's line; elbow 29.7cm out and 7.5cm behind the hip, hand 30cm
  // out, wrist at its resting bend.
  //
  // The pose is four joints: two legs, the shoulder, and 60 degrees of forearm
  // pronation that turns the palm IN to face the body — which is how a hand
  // really sits on a hilt carried down at the side, the flat of the palm
  // toward the thigh. That last one is FREE: the forearm's twist axis runs
  // down the arm, so it spins the palm without moving the hand a millimetre
  // (elbow, hand and wrist metrics are identical with it and without), and
  // weapon.ts's grip is re-solved from the twisted hand so the blade still
  // lands on the same line.
  //
  // Nothing else below the shoulder is touched, and that part is deliberate.
  // BENDING the forearm or wrist to aim the blade is what produced the
  // previous eight versions, and it always broke something else: the palm
  // rolled outward, or the hand ended up in front of the body. Twisting is
  // safe; bending is not. If the blade's angle needs changing, change the grip
  // constant in weapon.ts, not the arm.
  { id: "sword-idle",         kind: "emote", name: "Sword Stance", key: "animations/sword-idle/v12/anim.glb",        category: "locomotion", duration: 9.97,  loop: true,  rootMotion: false, free: true },
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
export const weapons = (): WeaponItem[] => WEAPONS;
export const emotes = (): EmoteItem[] => EMOTES;

/** Resolve a stored character id to one that definitely exists. A player whose
 *  equipped character was removed from the catalog gets the default rather
 *  than an empty pedestal. */
export function resolveCharacter(id: string | null | undefined): string {
  return id && CHARACTERS.some((c) => c.id === id) ? id : DEFAULT_CHARACTER;
}

/** Resolve a stored weapon id. Unlike a character, empty hands are a valid —
 *  and the default — state, so this returns null rather than falling back to
 *  something: an unarmed player is correct, a player holding a weapon they
 *  didn't pick is not. A retired weapon therefore just disappears. */
export function resolveWeapon(id: string | null | undefined): string | null {
  return id && WEAPONS.some((w) => w.id === id) ? id : null;
}

/** Can this player equip this character? Every starter is free today; once
 *  paid characters exist this is where the user_items lookup goes. */
export function canEquip(id: string): boolean {
  const item = CHARACTERS.find((c) => c.id === id);
  return item !== undefined && item.free;
}

/** Can this player perform this clip on purpose?
 *
 *  Only `emote` clips qualify: locomotion and traversal are movement the game
 *  plays FOR you, and a lobby full of players triggering "fall" on demand is
 *  not the feature. The `free` check is the same ownership seam as canEquip —
 *  when paid emotes ship, the user_items lookup goes here and nowhere else.
 *
 *  Enforced server-side because the client's list is only a menu: a modified
 *  client can emit any id it likes. */
export function canPerform(id: string): boolean {
  const clip = EMOTES.find((e) => e.id === id);
  return clip !== undefined && clip.category === "emote" && clip.free;
}

/** Same question for a weapon. Null is always allowed — that's unequipping. */
export function canEquipWeapon(id: string | null): boolean {
  if (id === null) return true;
  const item = WEAPONS.find((w) => w.id === id);
  return item !== undefined && item.free;
}

/** The client-facing catalog: same items, with paths resolved to URLs and
 *  ownership flattened into a boolean the UI can render directly. */
export function publicCatalog() {
  return {
    characters: CHARACTERS.map(({ key, free, ...rest }) => ({ ...rest, url: assetUrl(key), owned: free })),
    weapons: WEAPONS.map(({ key, free, ...rest }) => ({ ...rest, url: assetUrl(key), owned: free })),
    emotes: EMOTES.map(({ key, free, ...rest }) => ({ ...rest, url: assetUrl(key), owned: free })),
    defaultCharacter: DEFAULT_CHARACTER,
    lobbyIdleClip: LOBBY_IDLE_CLIP,
  };
}
