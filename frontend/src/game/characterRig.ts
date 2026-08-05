// Loading and reuse of the CDN-hosted character models and animation clips.
//
// Split out from assets.ts on purpose: everything in here drags in Babylon's
// skinning, animation and PBR machinery (~550 kB). The lobby imports this
// DYNAMICALLY so its first frame — placeholder characters, pedestals, name
// plates — paints without waiting for any of it, and the real models swap in
// as the download lands.
//
// Two rules keep it cheap:
//
//  1. ONE download per asset. Containers are cached per scene (see the cache
//     below for why scene, not just URL) and the cache stores the in-flight
//     PROMISE, so four squadmates wearing the same character trigger one load,
//     not four. Instances come from instantiateModelsToScene(), which shares
//     geometry and textures on the GPU.
//
//  2. NOTHING loads until it is actually needed. The lobby pulls one character
//     and one idle clip; the other eight clips only download when a player taps
//     them in the collection.
import { loadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import type { Scene } from "@babylonjs/core/scene";
import type { Node } from "@babylonjs/core/node";
import { CHARACTER_HEIGHT, getCharacter, getEmote, getLobbyIdleClip } from "./assets";
import { fetchAsset, primeStore } from "./assetStore";

/** The glTF loader, pulled in on first use and never before.
 *
 *  Two deliberate choices here, both worth ~1 MB of lobby start-up:
 *
 *  - DYNAMIC. Importing it at module scope welds it onto the Babylon chunk,
 *    which the lobby blocks on. Loaded this way it downloads in parallel while
 *    placeholder characters are already on screen.
 *  - MINIMAL. `@babylonjs/loaders/glTF/2.0` registers all 41 glTF extensions;
 *    these files declare exactly three. Importing the file loader, the v2
 *    loader and those three is all the registration needed — each module
 *    self-registers on import.
 *
 *  The three come straight from the build pipeline that produced the assets:
 *    EXT_meshopt_compression — compressed geometry
 *    KHR_mesh_quantization   — meshopt quantises vertex attributes
 *    EXT_texture_webp        — textures were re-encoded to WebP
 *  They are listed in each file's `extensionsRequired`, which means the loader
 *  THROWS if any is missing rather than degrading — so if the asset pipeline
 *  ever changes (KTX2 instead of WebP, say), this list must change with it.
 */
let loaderReady: Promise<void> | null = null;
function ensureLoader(): Promise<void> {
  return (loaderReady ??= (async () => {
    const [{ MeshoptCompression }] = await Promise.all([
      import("@babylonjs/core/Meshes/Compression/meshoptCompression"),
      import("@babylonjs/loaders/glTF/glTFFileLoader"),
      import("@babylonjs/loaders/glTF/2.0/glTFLoader"),
      import("@babylonjs/loaders/glTF/2.0/Extensions/EXT_meshopt_compression"),
      import("@babylonjs/loaders/glTF/2.0/Extensions/KHR_mesh_quantization"),
      import("@babylonjs/loaders/glTF/2.0/Extensions/EXT_texture_webp"),
    ]);
    // The models are meshopt-compressed, so the decoder is mandatory, not an
    // optimisation. Babylon's default points at preview.babylonjs.com — a
    // third party in the critical path of every character load. This copy is
    // served from our own origin (public/meshopt_decoder.js, 25 KB).
    MeshoptCompression.Configuration = { decoder: { url: "/meshopt_decoder.js" } };
  })().catch((err: unknown) => {
    loaderReady = null; // a failed download must not poison every later load
    throw err;
  }));
}

/** Container cache, keyed by SCENE and then by URL.
 *
 *  Keying by scene is not optional. An AssetContainer belongs to the scene it
 *  was loaded into, and `instantiateModelsToScene()` always builds into THAT
 *  scene — so handing the lobby's container to the collection's preview puts
 *  the new character in the lobby and leaves the preview empty (and vice
 *  versa). A URL-only cache produced exactly that: whichever character was
 *  already loaded turned invisible, while the other one worked.
 *
 *  The bytes are still downloaded once: the second scene's load is served from
 *  the on-device store, so this costs a re-parse, not a re-download.
 *
 *  WeakMap so a disposed scene's containers become collectable with it, and
 *  a stale container can never outlive its scene.
 *
 *  Within a scene the cache stores the in-flight PROMISE, so four squadmates
 *  wearing the same character still trigger one load, not four. A rejected
 *  load is evicted so a flaky network can be retried. */
const containers = new WeakMap<Scene, Map<string, Promise<AssetContainer>>>();

function load(url: string, scene: Scene): Promise<AssetContainer> {
  let perScene = containers.get(scene);
  if (!perScene) {
    perScene = new Map();
    containers.set(scene, perScene);
  }
  let pending = perScene.get(url);
  if (!pending) {
    // Bytes are fetched by assetStore, not by Babylon. That is what lets the
    // on-device store hold the only copy: Babylon fetching the URL itself would
    // populate the browser's HTTP cache with a duplicate we could never delete.
    // Passing an ArrayBufferView means the loader has no filename to sniff, so
    // the format has to be named explicitly.
    const pluginExtension = url.slice(url.lastIndexOf(".")).split("?")[0] || ".glb";
    pending = ensureLoader()
      .then(() => fetchAsset(url))
      .then((bytes) => loadAssetContainerAsync(bytes, scene, { pluginExtension }))
      .catch((err: unknown) => {
        perScene.delete(url);
        throw err;
      });
    perScene.set(url, pending);
  }
  return pending;
}

/** Pull a character and the lobby's idle clip into cache without building
 *  anything. Called as soon as the catalog lands, so the download overlaps the
 *  socket handshake instead of starting after the member list arrives — by the
 *  time the lobby knows who is standing where, the model is usually ready and
 *  the pedestal is never visibly empty.
 *
 *  Failures are swallowed: this is a head start, not a requirement. */
export async function prefetchCharacter(id: string, scene: Scene): Promise<void> {
  const character = getCharacter(id);
  if (!character?.url) return;
  // This is the one character that must survive eviction — a player returning
  // after a month should not re-download their own skin. Also kicks off the
  // idle sweep, once per session, off the critical path.
  primeStore(character.url);
  const idleId = getLobbyIdleClip();
  const idle = idleId ? getEmote(idleId) : undefined;
  await Promise.all([
    load(character.url, scene).catch(() => {}),
    idle?.url ? load(idle.url, scene).catch(() => {}) : Promise.resolve(),
  ]);
}

/** One posed, animatable character in a scene.
 *
 *  Owns its instantiated nodes and every clip retargeted onto them, so
 *  dispose() is guaranteed to leave nothing behind — the lobby rebuilds these
 *  whenever the member list changes, and a leak here would compound per join. */
export class CharacterRig {
  /** Parent this to position the character. Always present, even mid-load. */
  readonly root: TransformNode;
  private scene: Scene;
  private nodes = new Map<string, Node>();
  private clips = new Map<string, AnimationGroup>();
  private current: AnimationGroup | null = null;
  private disposed = false;
  private instantiated: { dispose: () => void } | null = null;
  /** Transform node of the skeleton's root bone. Its scale is the correction
   *  factor between bone space and render space — see normalizeSize. */
  private skeletonRoot: TransformNode | null = null;

  private constructor(scene: Scene, name: string) {
    this.scene = scene;
    this.root = new TransformNode(name, scene);
  }

  /** Builds a rig, or returns null if the character can't be loaded — callers
   *  treat null as "use the placeholder", never as a fatal error. */
  static async create(characterId: string, scene: Scene, name: string): Promise<CharacterRig | null> {
    const character = getCharacter(characterId);
    if (!character?.url) return null;
    const rig = new CharacterRig(scene, name);
    try {
      const container = await load(character.url, scene);
      if (rig.disposed) return null;

      // Names are preserved verbatim so clip retargeting can match bone for
      // bone. That makes them non-unique scene-wide, which is fine precisely
      // because lookups below go through this rig's own map, never the scene.
      const entries = container.instantiateModelsToScene((n) => n, false, { doNotInstantiate: false });
      rig.instantiated = entries;
      rig.skeletonRoot = entries.skeletons[0]?.bones[0]?.getTransformNode() ?? null;
      for (const node of entries.rootNodes) {
        node.parent = rig.root;
        rig.nodes.set(node.name, node);
        for (const child of node.getDescendants(false)) rig.nodes.set(child.name, child);
      }
      // Clips ship separately, but if a model ever arrives with one baked in,
      // stop it driving the rig behind our back.
      for (const group of entries.animationGroups) group.stop();

      rig.normalizeSize(characterId);
      return rig;
    } catch (err) {
      console.warn(`[assets] character "${characterId}" failed to load`, err);
      rig.dispose();
      return null;
    }
  }

  /** Scale and lift the model so it is always CHARACTER_HEIGHT tall with its
   *  feet on y=0, whatever height it happens to be authored at.
   *
   *  The subtlety is WHICH SPACE you measure in, and it is worth spelling out
   *  because two plausible measurements both read ~1.8 while the character was
   *  actually drawing at 170 units:
   *
   *    - bone transform nodes and the mesh bounding box agree with each other,
   *      because both sit under the skeleton root node and inherit its scale
   *    - the GPU does not. Babylon skins as `meshWorld x boneMatrix x
   *      inverseBind`, and the bone matrices handed to the shader are relative
   *      to the SKELETON, so the skeleton root node's scale never reaches them
   *
   *  With these models that node carries 0.01, so anything measured on the CPU
   *  reads 100x smaller than what is drawn. Dividing by that scale converts the
   *  measurement into the space the mesh actually renders in. A conventionally
   *  authored rig has scale 1 there and this is a no-op.
   *
   *  Runs in the bind pose, before any clip plays, so a clip that lifts or
   *  crouches the character can't skew the measurement. */
  private normalizeSize(characterId: string) {
    this.root.scaling.setAll(1);
    this.root.position.setAll(0);
    this.root.computeWorldMatrix(true);
    // getDescendants returns parents before children, so one pass leaves every
    // world matrix current.
    for (const node of this.root.getDescendants(false)) {
      (node as Partial<TransformNode>).computeWorldMatrix?.(true);
    }

    let low = Infinity;
    let high = -Infinity;
    for (const node of this.nodes.values()) {
      const at = (node as Partial<TransformNode>).getAbsolutePosition?.();
      if (!at || !Number.isFinite(at.y)) continue;
      if (at.y < low) low = at.y;
      if (at.y > high) high = at.y;
    }
    const boneSpan = high - low;

    // Bone nodes and the drawn mesh do NOT share a scale.
    //
    // Babylon skins on the GPU as `meshWorld x boneMatrix x inverseBind`, and
    // the bone matrices it feeds the shader are relative to the SKELETON — they
    // do not include the scale sitting on the skeleton's root node. The bone
    // TRANSFORM NODES, which is what we just measured, do include it. With a
    // root bone scaled to 0.01 (how these models are authored) the bones
    // measure 1.7 while the mesh draws at 170 — a character so large that only
    // one boot fills the screen, with every CPU-side number insisting it is
    // fine. Dividing by that scale converts the measurement into the space the
    // mesh is actually drawn in. A well-formed rig has scale 1 here, so this is
    // a no-op for anything authored normally.
    const rootScale = this.skeletonRoot?.scaling.x ?? 1;
    const renderedSpan = Number.isFinite(rootScale) && Math.abs(rootScale) > 1e-9 ? boneSpan / rootScale : boneSpan;
    const scale = CHARACTER_HEIGHT / renderedSpan;

    // Refuse an absurd correction rather than apply it. Anything far outside a
    // sane range means the measurement failed, and applying it would put a
    // hundred-metre character on the pedestal; using the model as authored is
    // much closer to right, and the log says exactly what happened.
    if (!Number.isFinite(scale) || scale <= 0 || scale > 1e4) {
      console.warn(
        `[assets] "${characterId}": rendered span ${renderedSpan.toFixed(4)}u implies a ${scale.toFixed(2)}x ` +
          `correction — ignoring it and using the model as authored.`
      );
      return;
    }

    this.root.scaling.setAll(scale);
    // Whatever the model's own origin was, put the feet on the pedestal. The
    // offset is in the same rendered space as the scale above.
    this.root.position.y = (-low / rootScale) * scale;
    this.root.computeWorldMatrix(true);
    console.info(
      `[assets] "${characterId}": bones ${boneSpan.toFixed(3)}u / rootScale ${rootScale} ` +
        `= ${renderedSpan.toFixed(2)}u drawn -> ${CHARACTER_HEIGHT}u (${scale.toFixed(4)}x)`
    );
  }

  /** Load (once) and play a clip. Repeat calls are cheap: the retargeted group
   *  is kept, so replaying an emote costs no network and no rebuild. */
  async play(clipId: string, opts: { loop?: boolean } = {}): Promise<boolean> {
    const emote = getEmote(clipId);
    if (!emote?.url || this.disposed) return false;

    let group = this.clips.get(clipId);
    if (!group) {
      try {
        const container = await load(emote.url, this.scene);
        if (this.disposed) return false;
        const source = container.animationGroups[0];
        if (!source) return false;

        // Retarget by bone name onto THIS rig's nodes. The clip files carry a
        // bare skeleton, so every channel target is a joint that the character
        // also has — verified across the whole library at build time.
        let matched = 0;
        group = source.clone(`${clipId}_${this.root.name}`, (old: { name: string }) => {
          const node = this.nodes.get(old.name);
          if (node) matched++;
          return node ?? null;
        });
        if (matched === 0) {
          console.warn(`[assets] clip "${clipId}" matched no bones — skipped`);
          group.dispose();
          return false;
        }
        group.stop();
        this.clips.set(clipId, group);
      } catch (err) {
        console.warn(`[assets] clip "${clipId}" failed to load`, err);
        return false;
      }
    }

    if (this.disposed) return false;
    this.current?.stop();
    group.start(opts.loop ?? emote.loop, 1.0, group.from, group.to);
    this.current = group;
    return true;
  }

  stop() {
    this.current?.stop();
    this.current = null;
  }

  /** Fires when the running clip finishes — used by the preview to drop back
   *  to idle after a one-shot emote. Returns an unsubscribe. */
  onClipEnd(fn: () => void): () => void {
    const group = this.current;
    if (!group) return () => {};
    const observer = group.onAnimationGroupEndObservable.add(fn);
    return () => group.onAnimationGroupEndObservable.remove(observer);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.current?.stop();
    for (const group of this.clips.values()) group.dispose();
    this.clips.clear();
    this.instantiated?.dispose();
    this.nodes.clear();
    this.root.dispose();
  }
}
