// The asset catalog, client side.
//
// Deliberately FREE of any runtime Babylon import — it holds ids, names and
// URLs, nothing else. That is what lets the lobby depend on it statically while
// the heavy model/animation machinery in characterRig.ts stays behind a dynamic
// import. Adding a Babylon value import here would quietly put ~550 kB back on
// the lobby's first frame, so keep everything below `import type`.
import type { Catalog, CatalogCharacter, CatalogEmote, CatalogWeapon } from "../types";

/** How tall a character stands in the world, in scene units (1 unit = 1 metre).
 *
 *  This is a TARGET, not a scale factor: every model is measured on load and
 *  scaled to hit it, with its feet placed on y=0 (see normalizeSize in
 *  characterRig.ts). A fixed scale factor was the wrong shape — it assumes all
 *  models share a unit, which nothing enforces, and one bad guess renders a
 *  character many times too large with no clue why.
 *
 *  Shared by the lobby and the collection preview so a character can never look
 *  like a different size in the two places. */
export const CHARACTER_HEIGHT = 1.8;

let catalog: Catalog | null = null;
const characters = new Map<string, CatalogCharacter>();
const weapons = new Map<string, CatalogWeapon>();
const emotes = new Map<string, CatalogEmote>();

/** Handed the catalog once per session, right after it's fetched. Everything
 *  else resolves ids through this — no URL is ever built on the client. */
export function setCatalog(next: Catalog) {
  catalog = next;
  characters.clear();
  weapons.clear();
  emotes.clear();
  for (const c of next.characters) characters.set(c.id, c);
  // Tolerated as absent: a client that outlives a backend rollback still gets
  // a catalog, just without weapons in it.
  for (const w of next.weapons ?? []) weapons.set(w.id, w);
  for (const e of next.emotes) emotes.set(e.id, e);
}

export const getCharacter = (id: string): CatalogCharacter | undefined => characters.get(id);
export const getWeapon = (id: string): CatalogWeapon | undefined => weapons.get(id);
export const getEmote = (id: string): CatalogEmote | undefined => emotes.get(id);
export const getLobbyIdleClip = (): string | null => catalog?.lobbyIdleClip ?? null;

/** The clip a character stands in: the carried weapon's stance if it names
 *  one, otherwise the ordinary idle. Empty hands and unknown weapons both fall
 *  through to the idle, so this is safe to call before anything has loaded. */
export const getStanceClip = (weaponId: string | null): string | null =>
  (weaponId ? weapons.get(weaponId)?.stance : undefined) ?? catalog?.lobbyIdleClip ?? null;

/** The clips a player can choose to PERFORM.
 *
 *  A filter over the catalog rather than a second list to keep in step with
 *  it: only `emote` clips are meant to be performed on purpose — locomotion
 *  and traversal are movement the game plays for you — so shipping a new
 *  dance is a catalog line and nothing here changes. The server enforces the
 *  same rule (canPerform), because this list is only a menu. */
export const getPerformableEmotes = (): CatalogEmote[] =>
  [...emotes.values()].filter((e) => e.category === "emote" && e.owned && e.url);

/** True once at least one character URL is known — i.e. the CDN is configured
 *  and worth trying. The lobby checks this before paying for the rig chunk at
 *  all, so a deployment with no CDN never downloads a byte of it. */
export const hasAssets = (): boolean =>
  characters.size > 0 && [...characters.values()].some((c) => c.url);
