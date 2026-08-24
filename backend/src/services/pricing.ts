// What things cost, and who owns what.
//
// Two ideas, and both are load-bearing:
//
//   NO PRICE MEANS FREE. An item with no row in `item_prices` costs nothing
//   and is owned by everybody — which is exactly how the whole catalog
//   behaved before this file existed, so an empty table is a no-op and
//   nothing had to be backfilled. `user_items` therefore only ever holds
//   things somebody had to ACQUIRE.
//
//   BUYING IS ONE STATEMENT PER RISK. Claim the item first, then take the
//   money, both inside one transaction. Claiming first means a double tap
//   cannot buy twice (the primary key refuses the second); taking the money
//   with `where balance >= price` means it cannot go negative, and a spend
//   that matches no row is a spend that did not happen. Doing it the other way
//   round — check, then deduct, then grant — is three chances to lose a race.
//
// Cost: cold path. Prices are read when the collection is opened and cached
// for a few seconds; ownership is one indexed read per player. Nothing here is
// near a game loop, and `canEquip` is a deliberate tap.
import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { itemPrices, userItems, users, wallets, walletLedger } from "../db/schema.js";
import type { Currency } from "./wallet.js";

export interface Price {
  currency: Currency;
  amount: number;
}

/** itemId → what it costs. Absent means free. */
export type PriceBook = Map<string, Price>;

// The collection is opened by a deliberate tap and the answer changes only
// when an admin edits it, so a few seconds of staleness costs nothing and
// saves a query on every open. Short enough that an admin setting a price sees
// it take effect while they are still looking at the screen.
let cache: { at: number; book: PriceBook } | null = null;
const CACHE_MS = 5_000;

export function forgetPrices(): void {
  cache = null;
}

export async function priceBook(fresh = false): Promise<PriceBook> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.book;
  const rows = await db.select().from(itemPrices);
  const book: PriceBook = new Map();
  for (const r of rows) {
    // A null currency is an admin saying "free" out loud. Same effect as no
    // row at all; kept apart in the table because "decided" and "never looked
    // at" are different things to read in the console.
    if (r.currency === "coin" || r.currency === "gem") {
      book.set(r.itemId, { currency: r.currency, amount: Number(r.price) });
    }
  }
  cache = { at: Date.now(), book };
  return book;
}

export const priceOf = (book: PriceBook, itemId: string): Price | null => book.get(itemId) ?? null;

/** Everything this player has had to acquire. Free items are not in here and
 *  never will be — see the note at the top. */
export async function ownedItems(userId: string): Promise<Set<string>> {
  const rows = await db.select({ itemId: userItems.itemId }).from(userItems).where(eq(userItems.userId, userId));
  return new Set(rows.map((r) => r.itemId));
}

/** The question the catalog's three seams ask.
 *
 *  Owning something means having CLAIMED it, whatever it costs. Free does not
 *  mean owned — it means claimable for nothing. */
export const ownsItem = (owned: Set<string>, itemId: string): boolean => owned.has(itemId);

// ---------------------------------------------------------------------------
// Claiming
// ---------------------------------------------------------------------------
//
// EVERYTHING IS CLAIMED, free or not. That is the whole model, and it is what
// makes a later price change harmless: owning something is a row somebody
// asked for, not a property of what it happens to cost today. Price a free
// item afterwards and everyone who already claimed it keeps it, because their
// row is already there; only somebody claiming it AFTER pays.
//
// The alternative — "free means everybody owns it" — has no memory, so the
// day an item stops being free it is taken off everybody at once. That is the
// bug this shape exists to make impossible rather than to patch afterwards.

export type ClaimOutcome =
  | { ok: true; free: boolean; currency: Currency | null; spent: number; balance: { coins: number; gems: number } }
  | { ok: false; code: "OWNED" | "POOR" | "UNKNOWN"; error: string };

/** Claim an item. `price` null means it is free today — one tap, no money. */
export async function claimItem(userId: string, itemId: string, price: Price | null): Promise<ClaimOutcome> {
  const free = price === null || price.amount <= 0;

  try {
    return await db.transaction(async (tx) => {
      // 1. CLAIM IT. The primary key is the referee: a second tap, or a second
      //    tab, matches nothing and never reaches the money below.
      const claimed = await tx
        .insert(userItems)
        .values({
          userId,
          itemId,
          currency: free ? null : price!.currency,
          pricePaid: free ? 0 : price!.amount,
          source: free ? "claim" : "purchase",
        })
        .onConflictDoNothing({ target: [userItems.userId, userItems.itemId] })
        .returning({ itemId: userItems.itemId });
      if (claimed.length === 0) {
        return { ok: false as const, code: "OWNED" as const, error: "You already have that" };
      }
      if (free) {
        const [w] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
        return {
          ok: true as const,
          free: true,
          currency: null,
          spent: 0,
          balance: { coins: Number(w?.coins ?? 0), gems: Number(w?.gems ?? 0) },
        };
      }

      // 2. TAKE THE MONEY, and only if it is there. A spend that matches no
      //    row is a spend that did not happen — which rolls the claim back
      //    with it, because both are in this transaction.
      const isCoin = price!.currency === "coin";
      const column = isCoin ? wallets.coins : wallets.gems;
      const [paid] = await tx
        .update(wallets)
        .set({
          ...(isCoin
            ? { coins: sql`${wallets.coins} - ${price!.amount}` }
            : { gems: sql`${wallets.gems} - ${price!.amount}` }),
          updatedAt: sql`now()`,
        })
        .where(and(eq(wallets.userId, userId), sql`${column} >= ${price!.amount}`))
        .returning();
      if (!paid) throw new InsufficientFunds(isCoin ? "coins" : "gems");

      // 3. And the line that explains it. Never a balance without one.
      await tx.insert(walletLedger).values({
        userId,
        currency: price!.currency,
        delta: -price!.amount,
        balanceAfter: isCoin ? Number(paid.coins) : Number(paid.gems),
        reason: "item",
        ref: itemId,
        note: `claimed ${itemId}`,
      });

      return {
        ok: true as const,
        free: false,
        currency: price!.currency,
        spent: price!.amount,
        balance: { coins: Number(paid.coins), gems: Number(paid.gems) },
      };
    });
  } catch (err) {
    if (err instanceof InsufficientFunds) {
      return { ok: false, code: "POOR", error: `You don't have enough ${err.money}` };
    }
    throw err;
  }
}

/** Thrown to roll the claim back when the money is not there. A sentinel
 *  rather than a returned value because a transaction callback can only undo
 *  its own writes by throwing. */
class InsufficientFunds extends Error {
  constructor(readonly money: string) {
    super("insufficient funds");
  }
}

// ---------------------------------------------------------------------------
// The console's side
// ---------------------------------------------------------------------------

export interface PriceRow {
  itemId: string;
  kind: string;
  currency: Currency | null;
  price: number;
  updatedBy: string | null;
  updatedAt: string;
}

export async function listPrices(): Promise<PriceRow[]> {
  const rows = await db.select().from(itemPrices);
  return rows.map((r) => ({
    itemId: r.itemId,
    kind: r.kind,
    currency: (r.currency as Currency | null) ?? null,
    price: Number(r.price),
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** How many players own each of these — the number that decides whether a
 *  price change is a small edit or a thing to think about. */
export async function ownerCounts(itemIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (itemIds.length === 0) return out;
  const rows = await db
    .select({ itemId: userItems.itemId, n: sql<number>`count(*)::int` })
    .from(userItems)
    .where(inArray(userItems.itemId, itemIds))
    .groupBy(userItems.itemId);
  for (const r of rows) out.set(r.itemId, Number(r.n));
  return out;
}

/** Set (or clear) an item's price.
 *
 *  Nothing has to be grandfathered, and that is the point of claiming. Anybody
 *  who already claimed this has a row saying so, and a row does not care what
 *  the thing costs today — so pricing something can never take it off the
 *  people who have it. Only somebody claiming it from now on pays.
 *
 *  An earlier version DID grandfather, by handing the item to everyone wearing
 *  it at that moment. That was a patch over a model where ownership was
 *  implied by price rather than recorded, and it only covered the people
 *  WEARING it — anybody who had chosen something else that day still lost it. */
export async function setItemPrice(
  itemId: string,
  kind: string,
  currency: Currency | null,
  amount: number,
  by: string
): Promise<void> {
  const price = currency === null ? 0 : Math.max(0, Math.trunc(amount));
  await db
    .insert(itemPrices)
    .values({ itemId, kind, currency, price, updatedBy: by })
    .onConflictDoUpdate({
      target: itemPrices.itemId,
      set: { kind, currency, price, updatedBy: by, updatedAt: sql`now()` },
    });
  forgetPrices();
}

/** Give somebody an item without charging for it — compensation, a prize, or
 *  putting right something that went wrong. */
export async function grantItem(userId: string, itemId: string, note: string): Promise<boolean> {
  const rows = await db
    .insert(userItems)
    .values({ userId, itemId, currency: null, pricePaid: 0, source: "grant" })
    .onConflictDoNothing({ target: [userItems.userId, userItems.itemId] })
    .returning({ itemId: userItems.itemId });
  void note;
  return rows.length > 0;
}

/** One player's acquisitions, for their page in the console. */
export async function itemsOwnedBy(userId: string): Promise<
  { itemId: string; currency: string | null; pricePaid: number; source: string; acquiredAt: string }[]
> {
  const rows = await db.select().from(userItems).where(eq(userItems.userId, userId));
  return rows.map((r) => ({
    itemId: r.itemId,
    currency: r.currency,
    pricePaid: Number(r.pricePaid),
    source: r.source,
    acquiredAt: r.acquiredAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export interface Order {
  uid: string;
  username: string | null;
  itemId: string;
  currency: string | null;
  pricePaid: number;
  source: string;
  at: string;
}

export interface OrderQuery {
  from?: Date;
  to?: Date;
  /** "coin" | "gem" | "free", or nothing for all of them. */
  currency?: string;
  /** A UID, part of a username, or an item id. */
  who?: string;
  limit?: number;
  cursor?: string | null;
}

/** Every claim, newest first — the record of who took what and what it cost
 *  them. Free claims are in here too: "who has this" and "who paid for this"
 *  are different questions and the second is a filter on the first, not a
 *  different table. */
export async function listOrders(q: OrderQuery): Promise<{ orders: Order[]; cursor: string | null }> {
  const limit = Math.min(200, Math.max(1, q.limit ?? 60));
  const clauses = [];
  if (q.from) clauses.push(gt(userItems.acquiredAt, q.from));
  if (q.to) clauses.push(lt(userItems.acquiredAt, q.to));
  if (q.currency === "free") clauses.push(isNull(userItems.currency));
  else if (q.currency === "coin" || q.currency === "gem") clauses.push(eq(userItems.currency, q.currency));
  if (q.who) {
    const needle = `%${q.who.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    clauses.push(
      sql`(${users.uid} ilike ${needle} or ${users.username} ilike ${needle} or ${userItems.itemId} ilike ${needle})`
    );
  }
  if (q.cursor) clauses.push(lt(userItems.acquiredAt, new Date(q.cursor)));

  const rows = await db
    .select({
      uid: users.uid,
      username: users.username,
      itemId: userItems.itemId,
      currency: userItems.currency,
      pricePaid: userItems.pricePaid,
      source: userItems.source,
      at: userItems.acquiredAt,
    })
    .from(userItems)
    .innerJoin(users, eq(users.id, userItems.userId))
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(userItems.acquiredAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return {
    orders: page.map((r) => ({
      uid: r.uid,
      username: r.username,
      itemId: r.itemId,
      currency: r.currency,
      pricePaid: Number(r.pricePaid),
      source: r.source,
      at: r.at.toISOString(),
    })),
    cursor: rows.length > limit ? page[page.length - 1].at.toISOString() : null,
  };
}

/** The strip above the orders table: how many, and how much of each currency
 *  actually changed hands in the window. */
export async function orderTotals(from: Date, to: Date): Promise<{
  claims: number;
  paid: number;
  coins: number;
  gems: number;
  players: number;
}> {
  const [r] = await db
    .select({
      claims: sql<number>`count(*)::int`,
      paid: sql<number>`count(*) filter (where ${userItems.currency} is not null)::int`,
      coins: sql<number>`coalesce(sum(${userItems.pricePaid}) filter (where ${userItems.currency} = 'coin'), 0)::bigint`,
      gems: sql<number>`coalesce(sum(${userItems.pricePaid}) filter (where ${userItems.currency} = 'gem'), 0)::bigint`,
      players: sql<number>`count(distinct ${userItems.userId})::int`,
    })
    .from(userItems)
    .where(and(gt(userItems.acquiredAt, from), lt(userItems.acquiredAt, to)));
  return {
    claims: Number(r?.claims ?? 0),
    paid: Number(r?.paid ?? 0),
    coins: Number(r?.coins ?? 0),
    gems: Number(r?.gems ?? 0),
    players: Number(r?.players ?? 0),
  };
}

/** What sells. Ordered by what it has actually taken, because "most claimed"
 *  and "most valuable" are different lists and only one of them pays for
 *  anything. */
export async function topItems(from: Date, to: Date): Promise<
  { itemId: string; claims: number; coins: number; gems: number }[]
> {
  const rows = await db
    .select({
      itemId: userItems.itemId,
      claims: sql<number>`count(*)::int`,
      coins: sql<number>`coalesce(sum(${userItems.pricePaid}) filter (where ${userItems.currency} = 'coin'), 0)::bigint`,
      gems: sql<number>`coalesce(sum(${userItems.pricePaid}) filter (where ${userItems.currency} = 'gem'), 0)::bigint`,
    })
    .from(userItems)
    .where(and(gt(userItems.acquiredAt, from), lt(userItems.acquiredAt, to)))
    .groupBy(userItems.itemId)
    .orderBy(desc(sql`count(*)`))
    .limit(20);
  return rows.map((r) => ({
    itemId: r.itemId,
    claims: Number(r.claims),
    coins: Number(r.coins),
    gems: Number(r.gems),
  }));
}
