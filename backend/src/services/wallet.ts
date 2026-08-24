// The wallet: two balances, and the rule that neither may move silently.
//
// `wallets` is a CACHE. The truth is `wallet_ledger`, and the only function
// below that can change a balance writes both in one transaction — so a crash
// can leave a player with neither the gems nor the line explaining them, but
// never with one and not the other.
//
// Cost: cold path. A balance is read when the lobby is drawn and when the
// store is opened; it is written when a match ends or a payment lands. Nothing
// here is anywhere near a game loop, and nothing here is ever called per tick.
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { walletLedger, wallets } from "../db/schema.js";

export type Currency = "coin" | "gem";

export interface Balance {
  coins: number;
  gems: number;
  /** Lifetime paise received from this player. */
  spentPaise: number;
}

const EMPTY: Balance = { coins: 0, gems: 0, spentPaise: 0 };

/** One primary-key read. A player with no row has never earned or bought
 *  anything, which is a zero balance and not an error — so no row is created
 *  just to look. */
export async function getBalance(userId: string): Promise<Balance> {
  const [row] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  if (!row) return { ...EMPTY };
  return { coins: Number(row.coins), gems: Number(row.gems), spentPaise: Number(row.spentPaise) };
}

export async function getBalances(userIds: string[]): Promise<Map<string, Balance>> {
  const out = new Map<string, Balance>();
  if (userIds.length === 0) return out;
  // inArray, never an interpolated list: these ids come from a caller, and a
  // hand-built `array[...]` is the one place in this file a string could turn
  // into SQL.
  const rows = await db.select().from(wallets).where(inArray(wallets.userId, userIds));
  for (const r of rows) {
    out.set(r.userId, { coins: Number(r.coins), gems: Number(r.gems), spentPaise: Number(r.spentPaise) });
  }
  return out;
}

export interface CreditInput {
  userId: string;
  currency: Currency;
  /** Signed. Negative spends; the balance is floored at zero rather than
   *  allowed to go negative, because a negative wallet is a bug that follows
   *  a player around for ever. */
  delta: number;
  reason: string;
  ref?: string | null;
  note?: string | null;
  /** Paise to add to the lifetime-received total. Only a real payment sets
   *  this — a grant is not revenue and must not read as any. */
  spentPaise?: number;
}

/** Move a balance and write the line that explains it.
 *
 *  The upsert is a single statement so two concurrent credits cannot read the
 *  same starting balance and both write it back; `returning` then gives the
 *  authoritative new total, which is what the ledger line records. Doing this
 *  as a read-then-write would lose a credit exactly when two of them arrive at
 *  once, which for a payment webhook is not a hypothetical. */
/** Anything that can run a query — the pool, or a transaction already open.
 *  Deliberately structural rather than Drizzle's own transaction type, which
 *  is a deep generic that would drag the whole schema into every signature
 *  that wants to pass one along. */
type Runner = Pick<typeof db, "insert" | "select" | "update">;

export async function credit(input: CreditInput, outer?: Runner): Promise<Balance> {
  if (!Number.isInteger(input.delta)) throw new Error("wallet delta must be a whole number");
  const spent = Math.max(0, Math.trunc(input.spentPaise ?? 0));
  // Inside somebody else's transaction, this must NOT open its own — a match
  // that failed to record must not have paid out for itself.
  const run = async (tx: Runner): Promise<Balance> => {
    const isCoin = input.currency === "coin";
    const [row] = await tx
      .insert(wallets)
      .values({
        userId: input.userId,
        coins: isCoin ? Math.max(0, input.delta) : 0,
        gems: isCoin ? 0 : Math.max(0, input.delta),
        spentPaise: spent,
      })
      .onConflictDoUpdate({
        target: wallets.userId,
        set: {
          // GREATEST(…, 0): a spend larger than the balance clamps instead of
          // going negative. Callers are expected to check first; this is the
          // backstop that keeps a bug from becoming a permanent debt.
          coins: isCoin ? sql`greatest(${wallets.coins} + ${input.delta}, 0)` : sql`${wallets.coins}`,
          gems: isCoin ? sql`${wallets.gems}` : sql`greatest(${wallets.gems} + ${input.delta}, 0)`,
          spentPaise: sql`${wallets.spentPaise} + ${spent}`,
          updatedAt: sql`now()`,
        },
      })
      .returning();

    const balanceAfter = isCoin ? Number(row.coins) : Number(row.gems);
    await tx.insert(walletLedger).values({
      userId: input.userId,
      currency: input.currency,
      delta: input.delta,
      balanceAfter,
      reason: input.reason.slice(0, 40),
      ref: input.ref ?? null,
      note: input.note ?? null,
    });
    return { coins: Number(row.coins), gems: Number(row.gems), spentPaise: Number(row.spentPaise) };
  };
  return outer ? run(outer) : db.transaction((tx) => run(tx));
}

export interface LedgerRow {
  id: number;
  currency: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  ref: string | null;
  note: string | null;
  createdAt: string;
}

/** A player's statement, newest first. */
export async function ledger(userId: string, limit = 50): Promise<LedgerRow[]> {
  const rows = await db
    .select()
    .from(walletLedger)
    .where(eq(walletLedger.userId, userId))
    .orderBy(desc(walletLedger.id))
    .limit(Math.min(200, Math.max(1, limit)));
  return rows.map((r) => ({
    id: Number(r.id),
    currency: r.currency,
    delta: Number(r.delta),
    balanceAfter: Number(r.balanceAfter),
    reason: r.reason,
    ref: r.ref,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }));
}
