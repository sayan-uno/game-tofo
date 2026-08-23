// The bot population: persistent accounts, minted on demand, cached in memory.
//
// A bot used to be three fields generated at match creation and forgotten at
// match end. That was right while a bot's whole life was one match. It stopped
// being right the moment a bot had to stand in a world chat all evening, ask
// to team up, be joined, and be looked at — because all four of those need an
// identity that is the same tomorrow.
//
// So the pool. `bot_accounts` holds the identities; this module owns:
//
//   * MINTING — never on a hot path, always in batches, and every candidate
//     name and uid is checked against real players first so a bot can never
//     shadow an account somebody signs in to.
//   * THE CACHE — the whole roster in memory as plain objects. A world of a
//     thousand redraws its member list constantly, and a list that costs a
//     query per redraw is a list that eventually costs the game server.
//   * GROWTH — `ensureBotPool(n)` tops the roster up towards what demand now
//     needs. Worlds call it as they fill; matchmaking calls it when it runs
//     short. Nobody has to decide up front how many bots the platform needs.
//
// What is deliberately NOT here: any notion of a bot being "logged in". A bot
// has no session, no socket and no token. Where a bot appears to be present —
// a world roster, a party seat — that presence is a row in Redis put there by
// the server, and nothing about it can be replayed into an authenticated
// request.
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { botAccounts, botStats, users } from "../db/schema.js";
import { characters, resolveCharacter, resolveWeapon, weapons } from "../services/catalog.js";

export type BotRow = typeof botAccounts.$inferSelect;

/** How a bot talks. Fixed per account: a bot that is quiet on Monday and
 *  can't stop typing on Tuesday reads as two people sharing a name. */
export type BotPersona = "quiet" | "casual" | "chatty" | "hype";
const PERSONAS: BotPersona[] = ["quiet", "casual", "chatty", "hype"];
/** The mix a real room has: most people say little, a few carry the chat. */
const PERSONA_WEIGHTS: Record<BotPersona, number> = { quiet: 45, casual: 32, chatty: 16, hype: 7 };

export interface BotAccount {
  id: string;
  uid: string;
  name: string;
  /** Catalog ids, already resolved — a retired item never reaches a scene. */
  character: string;
  weapon: string | null;
  /** 0…1, the shape every game's difficulty dial already speaks. */
  skill: number;
  persona: BotPersona;
  /** When the account was minted. Their "member since", and the only date on a
   *  bot's profile — which is a real date, because the account really is that
   *  old. */
  createdAt: Date;
}

/** Name parts chosen to sit in the same space as real gamer tags: short,
 *  pronounceable, occasionally suffixed with digits. Deliberately NOT themed
 *  around robots. Widened from the original list because a pool of thousands
 *  drawn from thirty heads produces obvious siblings. */
const HEADS = [
  "Nova", "Rift", "Echo", "Vex", "Kaze", "Onyx", "Ryu", "Zed", "Mika", "Blaze",
  "Frost", "Volt", "Aero", "Kira", "Neo", "Jinx", "Sable", "Dusk", "Cyra", "Halo",
  "Rogue", "Titan", "Wisp", "Nyx", "Riven", "Kobi", "Sora", "Vega", "Ash", "Zephy",
  "Kade", "Lumi", "Orin", "Pyra", "Quill", "Raze", "Silas", "Tavi", "Ulla", "Varo",
  "Wren", "Xiro", "Yuki", "Zola", "Bex", "Caz", "Dari", "Enzo", "Fira", "Gale",
  "Hux", "Iris", "Juno", "Koda", "Lyra", "Milo", "Nero", "Opal", "Pike", "Rune",
  "Sage", "Tessa", "Umi", "Vale", "Wolfe", "Yara", "Zane", "Arlo", "Bly", "Coda",
];
const TAILS = ["", "", "", "", "x", "z", "yt", "op", "gg", "_", "ix", "on", "ka", "sy", "th", "r7"];

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];

function pickPersona(): BotPersona {
  const total = PERSONAS.reduce((n, p) => n + PERSONA_WEIGHTS[p], 0);
  let roll = Math.random() * total;
  for (const p of PERSONAS) {
    roll -= PERSONA_WEIGHTS[p];
    if (roll <= 0) return p;
  }
  return "casual";
}

function candidateName(): string {
  const head = pick(HEADS);
  const tail = pick(TAILS);
  const digits = Math.random() < 0.45 ? String(Math.floor(Math.random() * 900) + 10) : "";
  return `${head}${tail}${digits}`.slice(0, 15);
}

/** Same shape as a real uid (see services/users.ts): 10 digits, no leading 0. */
function candidateUid(): string {
  let s = String(Math.floor(1 + Math.random() * 9));
  for (let i = 0; i < 9; i++) s += Math.floor(Math.random() * 10);
  return s;
}

/** A spread of ability across the population, so a lobby is not uniformly
 *  average. Two rolls averaged is a triangular distribution: mostly ordinary
 *  players, occasionally someone excellent or hopeless — which is what a real
 *  player list looks like. */
const rollSkill = (): number => Math.round(((Math.random() + Math.random()) / 2) * 100);

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------

const byId = new Map<string, BotAccount>();
const byUid = new Map<string, BotAccount>();
let loaded = false;

function cache(row: BotRow): BotAccount {
  const bot: BotAccount = {
    id: row.id,
    uid: row.uid,
    name: row.username,
    // Resolved here, once, rather than on every broadcast: a bot wearing a
    // withdrawn character must fall back exactly like a player does.
    character: resolveCharacter(row.character),
    weapon: resolveWeapon(row.weapon),
    skill: Math.min(1, Math.max(0, row.skill / 100)),
    persona: (PERSONAS as string[]).includes(row.persona) ? (row.persona as BotPersona) : "casual",
    createdAt: row.createdAt,
  };
  byId.set(bot.id, bot);
  byUid.set(bot.uid, bot);
  return bot;
}

/** Read the whole active roster into memory. Called once at boot and after
 *  every mint. Thousands of rows of six small fields — a couple of hundred
 *  kilobytes at the scale this is designed for, and it removes a query from
 *  every world redraw for ever. */
export async function loadBotPool(): Promise<number> {
  const rows = await db.select().from(botAccounts).where(eq(botAccounts.status, "active"));
  byId.clear();
  byUid.clear();
  for (const row of rows) cache(row);
  loaded = true;
  return byId.size;
}

export const botPoolSize = (): number => byId.size;
export const botPoolLoaded = (): boolean => loaded;
export const getBot = (id: string): BotAccount | null => byId.get(id) ?? null;
export const getBotByUid = (uid: string): BotAccount | null => byUid.get(uid) ?? null;
export const allBots = (): BotAccount[] => [...byId.values()];

/** Resolve a mixed list of ids, silently dropping any that have gone. Callers
 *  hold ids in Redis, which outlives a retirement. */
export const getBots = (ids: string[]): BotAccount[] =>
  ids.map((id) => byId.get(id)).filter((b): b is BotAccount => b !== undefined);

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/** Never let one call mint the world. A demand spike that asks for fifty
 *  thousand bots is a bug somewhere upstream, and the right answer is to grow
 *  steadily rather than to hand it what it asked for. */
const MINT_BATCH_MAX = 400;
/** Hard ceiling on the population, as a backstop against a runaway caller.
 *  Twenty thousand is twenty full worlds of nothing but bots. */
const POOL_MAX = 20_000;

let minting: Promise<number> | null = null;

/** Grow the pool towards `target` accounts. Returns how many were created.
 *
 *  Serialised: two callers asking at once share the same mint rather than both
 *  generating names against the same view of the table. Cheap to call
 *  repeatedly — it returns immediately once the pool is big enough.
 *
 *  Minting happens in batches and this LOOPS until the target is met, because
 *  a function that says "ensure 1200" and quietly delivers 400 is a function
 *  whose caller has to know its batch size to be correct. The round cap is a
 *  backstop against a target the mint can never reach (every candidate name
 *  colliding, say), which would otherwise spin. */
export async function ensureBotPool(target: number): Promise<number> {
  if (!loaded) await loadBotPool();
  const want = Math.min(target, POOL_MAX);
  if (byId.size >= want) return 0;
  if (minting) return minting;
  minting = (async () => {
    let made = 0;
    for (let round = 0; round < 40 && byId.size < want; round++) {
      const n = await mint(Math.min(MINT_BATCH_MAX, want - byId.size));
      if (n === 0) break; // nothing is being created; stop rather than spin
      made += n;
    }
    return made;
  })().finally(() => {
    minting = null;
  });
  return minting;
}

async function mint(count: number): Promise<number> {
  if (count <= 0) return 0;
  const free = characters().filter((c) => c.free);
  const freeWeapons = weapons().filter((w) => w.free);

  // Over-generate, then throw away anything that clashes with a real player or
  // with a bot that already exists. Three tries per seat is generous: with
  // ten-digit uids and seventy name heads, a clash is rare.
  const names: string[] = [];
  const uids: string[] = [];
  for (let i = 0; i < count * 3; i++) {
    names.push(candidateName());
    uids.push(candidateUid());
  }

  let taken = new Set<string>();
  let takenUids = new Set<string>();
  try {
    const lowered = names.map((n) => n.toLowerCase());
    const [playerRows, botRows] = await Promise.all([
      db
        .select({ uid: users.uid, username: users.username })
        .from(users)
        .where(sql`${users.uid} IN ${uids} OR lower(${users.username}) IN ${lowered}`),
      db
        .select({ uid: botAccounts.uid, username: botAccounts.username })
        .from(botAccounts)
        .where(sql`${botAccounts.uid} IN ${uids} OR lower(${botAccounts.username}) IN ${lowered}`),
    ]);
    taken = new Set([...playerRows, ...botRows].map((r) => (r.username ?? "").toLowerCase()));
    takenUids = new Set([...playerRows, ...botRows].map((r) => r.uid));
  } catch (err) {
    // A failed check must not stop the pool growing; the unique indexes below
    // are the real referee and a lost candidate costs nothing.
    console.warn("[bots] identity collision check failed, relying on the unique index:", err);
  }

  const rows: (typeof botAccounts.$inferInsert)[] = [];
  const usedNames = new Set<string>();
  const usedUids = new Set<string>();
  for (let i = 0; i < names.length && rows.length < count; i++) {
    const name = names[i];
    const uid = uids[i];
    if (taken.has(name.toLowerCase()) || usedNames.has(name.toLowerCase())) continue;
    if (takenUids.has(uid) || usedUids.has(uid)) continue;
    usedNames.add(name.toLowerCase());
    usedUids.add(uid);
    rows.push({
      uid,
      username: name,
      character: free.length ? pick(free).id : null,
      // Most players carry nothing, so most bots carry nothing.
      weapon: freeWeapons.length && Math.random() < 0.3 ? pick(freeWeapons).id : null,
      skill: rollSkill(),
      persona: pickPersona(),
    });
  }
  if (rows.length === 0) return 0;

  // onConflictDoNothing on BOTH unique keys: a name that slipped past the
  // check above is dropped rather than failing the whole batch.
  const created = await db.insert(botAccounts).values(rows).onConflictDoNothing().returning();
  for (const row of created) cache(row);
  if (created.length > 0) console.info(`[bots] minted ${created.length} account(s) — pool now ${byId.size}`);
  return created.length;
}

// ---------------------------------------------------------------------------
// Handing them out
// ---------------------------------------------------------------------------

/** Bots currently spoken for — standing in a world, holding a party seat, or
 *  playing a match. Held in memory rather than Redis because it is a hint, not
 *  a lock: the cost of the same bot appearing twice is cosmetic, and the cost
 *  of a Redis round trip per seat on the match-creation path is not.
 *
 *  Reference-counted, because one bot can legitimately be in a world AND in a
 *  match at the same time — a player in a world chat who is also playing is
 *  exactly what a busy platform looks like. */
const busy = new Map<string, number>();

export function holdBots(ids: string[]): void {
  for (const id of ids) busy.set(id, (busy.get(id) ?? 0) + 1);
}

export function releaseBots(ids: string[]): void {
  for (const id of ids) {
    const n = (busy.get(id) ?? 0) - 1;
    if (n > 0) busy.set(id, n);
    else busy.delete(id);
  }
}

export const isBotBusy = (id: string): boolean => (busy.get(id) ?? 0) > 0;

/** `count` bots that are not already spoken for, minting more if the pool is
 *  short. Random order, so the same handful is not always first.
 *
 *  Falls back to reusing busy bots only when the pool genuinely cannot cover
 *  the ask (the ceiling, a database that is away) — a match with a repeated
 *  name is worse than nothing, but no match at all is worse still. */
export async function takeBots(count: number, exclude: Set<string> = new Set()): Promise<BotAccount[]> {
  if (count <= 0) return [];
  if (!loaded) await loadBotPool();

  const scan = (): { free: BotAccount[]; fallback: BotAccount[] } => {
    const free: BotAccount[] = [];
    const fallback: BotAccount[] = [];
    for (const bot of byId.values()) {
      if (exclude.has(bot.id)) continue;
      (isBotBusy(bot.id) ? fallback : free).push(bot);
    }
    return { free, fallback };
  };

  let { free, fallback } = scan();
  // Grow ONLY when the pool cannot cover the ask, and only by the shortfall
  // plus a little headroom. Growing on every call — "top up to size + count ×
  // 2" — mints thousands of accounts on a busy evening that are never used,
  // because it measures the pool against the ask rather than against how much
  // of the pool is free.
  if (free.length < count) {
    const short = count - free.length;
    await ensureBotPool(byId.size + short + Math.max(20, short)).catch((err) => {
      console.error("[bots] pool growth failed:", err);
      return 0;
    });
    ({ free, fallback } = scan());
  }

  shuffle(free);
  const out = free.slice(0, count);
  if (out.length < count) {
    // The pool genuinely cannot cover it (the ceiling, a database that is
    // away). A repeated name is bad; no match at all is worse.
    shuffle(fallback);
    out.push(...fallback.slice(0, count - out.length));
  }
  holdBots(out.map((b) => b.id));
  return out;
}

function shuffle<T>(list: T[]): void {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
}

// ---------------------------------------------------------------------------
// Careers
// ---------------------------------------------------------------------------

export type BotStatsRow = typeof botStats.$inferSelect;

export async function getBotStats(botId: string): Promise<BotStatsRow | null> {
  const [row] = await db.select().from(botStats).where(eq(botStats.botId, botId));
  return row ?? null;
}

export async function getBotStatsMany(botIds: string[]): Promise<Map<string, BotStatsRow>> {
  if (botIds.length === 0) return new Map();
  const rows = await db.select().from(botStats).where(inArray(botStats.botId, botIds));
  return new Map(rows.map((r) => [r.botId, r]));
}

/** Say a bot was seen. Batched by the caller (worlds tick, matches end) and
 *  never awaited on anything a player is waiting for. */
export async function touchBotsSeen(botIds: string[]): Promise<void> {
  if (botIds.length === 0) return;
  await db
    .update(botAccounts)
    .set({ lastSeenAt: new Date() })
    .where(inArray(botAccounts.id, botIds));
}
