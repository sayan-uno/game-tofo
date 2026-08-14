// Which legendary effect a character wears, and the one place it is chosen.
//
// Deliberately FREE of any runtime Babylon import — it holds the decision and
// nothing else, so the lobby and the collection preview can depend on it
// statically while each effect implementation stays behind a dynamic import.
// A session that never stands next to a legendary downloads neither of them;
// a session that only ever sees Seraph downloads only the crystal one.
//
// The variant comes from the catalog (`aura`), never from a branch on
// character id: adding a third effect should be a catalog edit plus a module,
// not a change to every scene that renders a character.
import type { Scene } from "@babylonjs/core/scene";
import type { CharacterRig } from "./characterRig";
import { getCharacter } from "./assets";

/** All an owning scene needs from an effect. Both implementations satisfy it
 *  structurally, so neither has to import this file. */
export interface Aura {
  dispose(): void;
}

/** Build the effect for a character, or null when it has none — which is the
 *  common case and never an error. Callers hold the result and dispose it when
 *  the character goes away. */
export async function attachAura(characterId: string, rig: CharacterRig, scene: Scene): Promise<Aura | null> {
  const character = getCharacter(characterId);
  if (character?.rarity !== "legendary") return null;
  // Characters that shipped before a second effect existed carry no `aura`,
  // and keep the original ember one.
  if (character.aura === "crystal") {
    return (await import("./crystalAura")).CrystalAura.attach(rig, scene);
  }
  return (await import("./legendaryAura")).LegendaryAura.attach(rig, scene);
}
