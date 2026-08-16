// Downloads a game's pack into the on-device store, with honest progress.
//
// A pack is a versioned CDN folder with a manifest.json listing every file
// and its size. Everything is fetched through the same IndexedDB store the
// lobby uses for characters (tagged `<gameId>@<version>`), so a second match
// — or a second day — costs zero bytes, and a new pack version reclaims the
// old one the moment it lands. The game's CODE is a Vite chunk: it is fetched
// alongside (import()) and lives in the browser's immutable HTTP cache — JS
// can't run out of IndexedDB and doesn't need to.
//
// Progress is bytes: received / manifest total, so a 25 MB texture and a 2 kB
// json move the bar honestly. Cached files count as received at once, which
// is what puts a returning player at 100 % before the bar even paints.
import { clearPacksExcept, fetchAsset, fetchAssetProgress, hasAsset } from "../game/assetStore";
import type { GameInfo } from "../types";
import { getClientGame } from "./games";
import type { GameModule, PackAssets } from "./types";

export interface PackManifest {
  game: string;
  version: string;
  files: { path: string; bytes: number }[];
  totalBytes: number;
}

export interface LoadedPack {
  gameId: string;
  version: string;
  assets: PackAssets;
  module: GameModule;
}

const loaded = new Map<string, LoadedPack>();
const packTag = (gameId: string, version: string) => `${gameId}@${version}`;

function baseOf(manifestUrl: string): string {
  return manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
}

/** The pack of this game as currently downloaded and its module — null until
 *  loadPack has completed for it in this session. */
export const getLoadedPack = (gameId: string): LoadedPack | undefined => loaded.get(gameId);

/** Is every file of the pack already on the device? Metadata reads only. */
export async function isPackCached(info: GameInfo): Promise<boolean> {
  if (!info.packUrl) return false;
  if (loaded.get(info.id)?.version === info.packVersion) return true;
  try {
    if (!(await hasAsset(info.packUrl))) return false;
    const manifest = JSON.parse(new TextDecoder().decode(await fetchAsset(info.packUrl))) as PackManifest;
    const base = baseOf(info.packUrl);
    const flags = await Promise.all(manifest.files.map((f) => hasAsset(base + f.path)));
    return flags.every(Boolean);
  } catch {
    return false;
  }
}

/** Download (or verify) the whole pack and the game's code chunk.
 *
 *  `onProgress(pct)` runs on the caller's thread as bytes arrive; the caller
 *  throttles what it sends over the wire. Rejects on failure or abort — the
 *  caller shows a retry. Never partially "succeeds": the pack is loaded only
 *  when every file and the module are in hand. */
export async function loadPack(
  info: GameInfo,
  opts: { signal?: AbortSignal; onProgress?: (pct: number) => void } = {}
): Promise<LoadedPack> {
  const already = loaded.get(info.id);
  if (already && already.version === info.packVersion) {
    opts.onProgress?.(100);
    return already;
  }
  const client = getClientGame(info.id);
  if (!client) throw new Error(`This build can't run "${info.id}"`);
  if (!info.packUrl) throw new Error("This game's files aren't published yet");

  const tag = packTag(info.id, info.packVersion);
  // Code chunk in parallel with the files. Its size isn't in the manifest, so
  // it is not part of the bar; readiness waits for it all the same.
  const modulePromise = client.load();

  const manifestBytes = await fetchAssetProgress(info.packUrl, { pack: tag, signal: opts.signal });
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as PackManifest;
  const base = baseOf(info.packUrl);
  const total = Math.max(1, manifest.totalBytes || manifest.files.reduce((n, f) => n + f.bytes, 0));

  const perFile = new Map<string, number>();
  let lastPct = -1;
  const report = () => {
    let sum = 0;
    for (const n of perFile.values()) sum += n;
    const pct = Math.min(99, Math.floor((sum / total) * 100));
    if (pct !== lastPct) {
      lastPct = pct;
      opts.onProgress?.(pct);
    }
  };
  report();

  await Promise.all(
    manifest.files.map((f) =>
      fetchAssetProgress(base + f.path, {
        pack: tag,
        signal: opts.signal,
        expectedBytes: f.bytes,
        onBytes: (n) => {
          perFile.set(f.path, Math.min(n, f.bytes));
          report();
        },
      }).then(() => {
        perFile.set(f.path, f.bytes);
        report();
      })
    )
  );
  const module = await modulePromise;
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const paths = new Set(manifest.files.map((f) => f.path));
  const assets: PackAssets = {
    version: manifest.version,
    has: (path) => paths.has(path),
    url: (path) => base + path,
    get: async (path) => {
      if (!paths.has(path)) throw new Error(`pack has no "${path}"`);
      return fetchAsset(base + path, { pack: tag });
    },
  };
  const pack: LoadedPack = { gameId: info.id, version: manifest.version, assets, module };
  loaded.set(info.id, pack);
  opts.onProgress?.(100);
  // Reclaim any previous version of this game's pack, off the critical path.
  void clearPacksExcept(`${info.id}@`, tag).catch(() => {});
  return pack;
}
