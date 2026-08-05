// On-device store for downloaded assets (character models, animation clips).
//
// WHY THIS EXISTS
// The browser's own HTTP cache would also keep these files, but nothing can
// delete an entry from it — there is no API, at any TTL. That matters here:
// seeing one squadmate wearing a skin downloads it onto the player's phone,
// and without a way to reclaim that space it accumulates forever. This store
// keeps the same bytes somewhere we can measure, age out and delete on demand.
//
// SHAPE — two object stores, deliberately
//   bodies : url -> ArrayBuffer          the file itself
//   meta   : url -> { size, lastUsed, pinned, pack }   indexed by lastUsed
//
// Splitting them is the single most important performance decision in here.
// Recording "this asset was used just now" is a write to a ~100-byte record;
// if metadata lived alongside the body we would have to read and rewrite a
// 300 kB ArrayBuffer every time a character appears on screen.
//
// EVERYTHING HERE FAILS SOFT. IndexedDB can be unavailable (some private
// modes, locked-down webviews), full, or simply broken. Every function below
// resolves to null/void rather than throwing, and the caller falls back to a
// plain network fetch. Caching must never be able to break asset loading.
import { getEmote, getLobbyIdleClip } from "./assets";

const DB_NAME = "tofo-assets";
const DB_VERSION = 1;
const BODIES = "bodies";
const META = "meta";

/** Untouched for this long and an asset is dropped. Generous on purpose: an
 *  eviction that fires too early costs the player a re-download, possibly on a
 *  bad connection, which is worse than the disk space it saved. */
const MAX_AGE_DAYS = 30;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** Hard ceiling on everything stored here. The age rule handles the slow drift
 *  of cosmetics seen once in someone else's squad; this catches the fast case —
 *  a player who plays a lot in a short burst — before the game becomes the app
 *  they delete to free up their phone. Oldest goes first. */
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;

interface MetaRecord {
  url: string;
  size: number;
  lastUsed: number;
  /** Never evicted: the player's own character and the clip every lobby plays. */
  pinned: boolean;
  /** Groups assets so a finished event can be dropped in one call. */
  pack?: string;
}

/** Opened once and reused. Resolves to null — never rejects — when IndexedDB
 *  is unusable, which is the signal for callers to fall back to the network. */
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  return (dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(BODIES)) db.createObjectStore(BODIES);
        if (!db.objectStoreNames.contains(META)) {
          const meta = db.createObjectStore(META, { keyPath: "url" });
          // The sweep is a range scan over this index, so ageing out assets
          // never has to read a single file body.
          meta.createIndex("lastUsed", "lastUsed");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}

/** Promisify one transaction. Resolves with `fallback` on any failure so a
 *  broken store degrades to "cache miss" instead of an exception. */
function run<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => IDBRequest | null,
  fallback: T
): Promise<T> {
  return new Promise<T>((resolve) => {
    try {
      const tx = db.transaction(stores, mode);
      const request = body(tx);
      tx.onabort = () => resolve(fallback);
      tx.onerror = () => resolve(fallback);
      if (request) {
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => resolve(fallback);
      } else {
        tx.oncomplete = () => resolve(fallback);
      }
    } catch {
      resolve(fallback);
    }
  });
}

/** ---------------------------------------------------------------------------
 *  lastUsed bookkeeping
 *
 *  Touches are batched and flushed on a timer rather than written inline. Four
 *  squadmates appearing at once would otherwise open four write transactions
 *  during the exact frames the lobby is trying to render. The read path never
 *  waits on any of this.
 * ------------------------------------------------------------------------- */
const pendingTouches = new Set<string>();
let touchTimer: number | undefined;

function scheduleTouch(url: string) {
  pendingTouches.add(url);
  if (touchTimer !== undefined) return;
  touchTimer = window.setTimeout(() => {
    touchTimer = undefined;
    void flushTouches();
  }, 3000);
}

async function flushTouches(): Promise<void> {
  if (pendingTouches.size === 0) return;
  const urls = [...pendingTouches];
  pendingTouches.clear();
  const db = await openDb();
  if (!db) return;
  const now = Date.now();
  await run<void>(
    db,
    [META],
    "readwrite",
    (tx) => {
      const store = tx.objectStore(META);
      for (const url of urls) {
        const get = store.get(url);
        get.onsuccess = () => {
          const record = get.result as MetaRecord | undefined;
          if (record) store.put({ ...record, lastUsed: now });
        };
      }
      return null;
    },
    undefined
  );
}

/** ---------------------------------------------------------------------------
 *  Read / write
 * ------------------------------------------------------------------------- */

async function readBody(url: string): Promise<ArrayBuffer | null> {
  const db = await openDb();
  if (!db) return null;
  const body = await run<ArrayBuffer | null>(
    db,
    [BODIES],
    "readonly",
    (tx) => tx.objectStore(BODIES).get(url),
    null
  );
  return body ?? null;
}

async function writeAsset(url: string, body: ArrayBuffer, pack?: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  // Body and metadata in ONE transaction — a half-written asset (bytes with no
  // meta, or meta with no bytes) would be invisible to the sweep and leak.
  await run<void>(
    db,
    [BODIES, META],
    "readwrite",
    (tx) => {
      tx.objectStore(BODIES).put(body, url);
      const meta: MetaRecord = { url, size: body.byteLength, lastUsed: Date.now(), pinned: false, pack };
      tx.objectStore(META).put(meta);
      return null;
    },
    undefined
  );
}

/** Fetch an asset, preferring the local copy.
 *
 *  On a hit the bytes are returned immediately and `lastUsed` is updated later,
 *  off the critical path. On a miss the download uses `cache: "no-store"` so the
 *  browser's HTTP cache does not keep a second copy of a file we are already
 *  storing ourselves — that would double the footprint and only one of the two
 *  copies could ever be deleted. */
export async function fetchAsset(url: string, opts: { pack?: string } = {}): Promise<Uint8Array> {
  try {
    const cached = await readBody(url);
    if (cached) {
      scheduleTouch(url);
      return new Uint8Array(cached);
    }
  } catch {
    /* fall through to the network */
  }

  let bytes: ArrayBuffer;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = await res.arrayBuffer();
  } catch {
    // Last resort: a normal fetch, which may be served by the HTTP cache. Used
    // when the no-store request failed outright (offline, transient error).
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Asset fetch failed: ${res.status} ${url}`);
    bytes = await res.arrayBuffer();
  }

  // Storing is best-effort: a full disk must not fail a load that already has
  // its bytes in hand.
  void writeAsset(url, bytes, opts.pack).catch(() => {});
  return new Uint8Array(bytes);
}

/** ---------------------------------------------------------------------------
 *  Pinning
 * ------------------------------------------------------------------------- */

/** Marks exactly these URLs as un-evictable and clears the flag from everything
 *  else, so switching character automatically releases the previous one. Called
 *  once per session with the player's own character and the lobby idle clip —
 *  the two assets whose absence would be felt immediately on a cold start. */
export async function setPinned(urls: string[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const keep = new Set(urls);
  await run<void>(
    db,
    [META],
    "readwrite",
    (tx) => {
      const store = tx.objectStore(META);
      const all = store.getAll();
      all.onsuccess = () => {
        for (const record of (all.result as MetaRecord[]) ?? []) {
          const shouldPin = keep.has(record.url);
          if (record.pinned !== shouldPin) store.put({ ...record, pinned: shouldPin });
        }
      };
      return null;
    },
    undefined
  );
}

/** ---------------------------------------------------------------------------
 *  Eviction
 * ------------------------------------------------------------------------- */

async function allMeta(db: IDBDatabase): Promise<MetaRecord[]> {
  return (await run<MetaRecord[]>(db, [META], "readonly", (tx) => tx.objectStore(META).getAll(), [])) ?? [];
}

async function deleteUrls(db: IDBDatabase, urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  await run<void>(
    db,
    [BODIES, META],
    "readwrite",
    (tx) => {
      const bodies = tx.objectStore(BODIES);
      const meta = tx.objectStore(META);
      for (const url of urls) {
        bodies.delete(url);
        meta.delete(url);
      }
      return null;
    },
    undefined
  );
}

export interface SweepResult {
  removedStale: number;
  removedForSize: number;
  bytesFreed: number;
  bytesKept: number;
}

/** Drop what the player is not using: anything untouched for MAX_AGE_DAYS, then
 *  oldest-first until the total is back under MAX_TOTAL_BYTES. Pinned assets
 *  are exempt from both rules. */
export async function sweep(): Promise<SweepResult | null> {
  const db = await openDb();
  if (!db) return null;
  await flushTouches(); // don't age out something used seconds ago

  const records = await allMeta(db);
  if (records.length === 0) return { removedStale: 0, removedForSize: 0, bytesFreed: 0, bytesKept: 0 };

  const cutoff = Date.now() - MAX_AGE_MS;
  const stale = records.filter((r) => !r.pinned && r.lastUsed < cutoff);
  const staleUrls = new Set(stale.map((r) => r.url));

  const survivors = records.filter((r) => !staleUrls.has(r.url));
  const overflow: MetaRecord[] = [];
  let total = survivors.reduce((sum, r) => sum + r.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    // Oldest first, pinned never.
    for (const record of survivors.filter((r) => !r.pinned).sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (total <= MAX_TOTAL_BYTES) break;
      overflow.push(record);
      total -= record.size;
    }
  }

  const doomed = [...stale, ...overflow];
  await deleteUrls(db, doomed.map((r) => r.url));

  return {
    removedStale: stale.length,
    removedForSize: overflow.length,
    bytesFreed: doomed.reduce((sum, r) => sum + r.size, 0),
    bytesKept: total,
  };
}

/** Runs the sweep once the device is idle, never during start-up. Nothing here
 *  is urgent — a few stale files living an extra minute costs nothing, while a
 *  scan competing with the lobby's first frames is felt immediately. */
export function sweepWhenIdle(): void {
  const go = () => void sweep().catch(() => {});
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(() => go());
  else window.setTimeout(go, 5000);
}

/** Everything from one content pack — an event that has finished, say. */
export async function clearPack(pack: string): Promise<number> {
  const db = await openDb();
  if (!db) return 0;
  const records = (await allMeta(db)).filter((r) => r.pack === pack);
  await deleteUrls(db, records.map((r) => r.url));
  return records.length;
}

export async function clearAll(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await run<void>(
    db,
    [BODIES, META],
    "readwrite",
    (tx) => {
      tx.objectStore(BODIES).clear();
      tx.objectStore(META).clear();
      return null;
    },
    undefined
  );
}

/** What the game is using on this device — ready for a Storage screen in
 *  settings. `quota` comes from the browser and is approximate by design. */
export async function storageReport(): Promise<{
  assets: number;
  bytes: number;
  quotaBytes: number | null;
  persisted: boolean;
} | null> {
  const db = await openDb();
  if (!db) return null;
  const records = await allMeta(db);
  let quotaBytes: number | null = null;
  let persisted = false;
  try {
    const estimate = await navigator.storage?.estimate?.();
    quotaBytes = estimate?.quota ?? null;
    persisted = (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    /* storage manager unavailable — counts below are still accurate */
  }
  return {
    assets: records.length,
    bytes: records.reduce((sum, r) => sum + r.size, 0),
    quotaBytes,
    persisted,
  };
}

/** Ask the browser to exempt this origin from routine eviction. Granted based
 *  on engagement, so it usually fails on a first visit and succeeds later —
 *  which is why it is fire-and-forget and nothing depends on the answer. */
export function requestPersistence(): void {
  try {
    void navigator.storage?.persist?.().catch(() => {});
  } catch {
    /* not supported */
  }
}

/** Pin the two assets a cold start cannot do without, and kick off the sweep.
 *  Called once, after the catalog is known. */
export function primeStore(ownCharacterUrl: string | null): void {
  requestPersistence();
  const idleId = getLobbyIdleClip();
  const idleUrl = idleId ? (getEmote(idleId)?.url ?? null) : null;
  const pins = [ownCharacterUrl, idleUrl].filter((u): u is string => !!u);
  if (pins.length > 0) void setPinned(pins).catch(() => {});
  sweepWhenIdle();
}
