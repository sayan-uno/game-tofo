// The self-made UPI gateway.
//
// There is no payment provider here. A player is shown a QR that pays a real
// UPI id, they pay it from whatever app they like, and the only thing that
// ever comes back is an SMS on the owner's phone, forwarded to a webhook. That
// message says how much arrived and says NOTHING about who sent it.
//
// So the amount is the identity. That is the one idea this whole file is built
// around, and everything below is a consequence of it:
//
//   NO TWO LIVE SESSIONS MAY SHARE AN AMOUNT. The second person buying a ₹100
//   pack while the first is still paying is asked for ₹100.01, the third for
//   ₹100.02. The claim is a Redis SET NX, because two people pressing Buy in
//   the same millisecond is not a hypothetical and only an atomic claim is
//   safe. Postgres records what the claim decided; Redis decides it.
//
//   AN AMOUNT IS HELD LONGER THAN ITS QR IS OFFERED. The QR expires after two
//   minutes; the reservation lasts two and a half. Somebody who paid in the
//   last second of the window, or whose bank took twenty seconds to send the
//   SMS, is still the only person that amount can belong to. Releasing at
//   expiry would hand their money to whoever bought next — which is the one
//   failure in this design that takes real money from a real person.
//
//   A REDELIVERED SMS IS NOT A SECOND PAYMENT. MacroDroid retries. The bank's
//   own reference is unique in `payment_sessions`, so a retry loses the race
//   with itself and is logged as a duplicate.
//
// Cost: every function here is a cold path. A session is created when somebody
// deliberately presses Buy; the webhook fires once per payment. Nothing in
// this file is within reach of a game loop.
import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import QRCode from "qrcode";
import { db } from "../db/client.js";
import { gemPacks, paymentHookLog, paymentSessions, paymentSettings } from "../db/schema.js";
import { redis } from "../redis.js";
import { credit } from "./wallet.js";
import { rupees } from "./money.js";

// ---------------------------------------------------------------------------
// What is for sale
// ---------------------------------------------------------------------------

export interface GemPack {
  id: string;
  gems: number;
  /** 1 gem = ₹1 by default, so this starts at gems × 100 — but it is a stored
   *  number rather than a computed one precisely so an admin can discount it
   *  without the rate becoming a lie. */
  pricePaise: number;
  /** The artwork in frontend/public/store/. */
  art: string;
  /** A ribbon on the tile; null for none. */
  tag: string | null;
  /** Left to right on the shelf. */
  sort: number;
  /** Off the shelf, without being forgotten by sessions already paying. */
  active: boolean;
}

/** The shelf as it ships. Seeds `gem_packs` the first time this process starts
 *  against an empty table, and is never read again — after that the database
 *  is the shelf, because a festival price or a pack pulled for a week is an
 *  operational decision and the console exists so those are not a redeploy. */
export const DEFAULT_PACKS: readonly GemPack[] = [
  { id: "gems-100", gems: 100, pricePaise: 10_000, art: "pack-100", tag: null, sort: 0, active: true },
  { id: "gems-300", gems: 300, pricePaise: 30_000, art: "pack-300", tag: null, sort: 1, active: true },
  { id: "gems-500", gems: 500, pricePaise: 50_000, art: "pack-500", tag: "POPULAR", sort: 2, active: true },
  { id: "gems-1000", gems: 1000, pricePaise: 100_000, art: "pack-1000", tag: null, sort: 3, active: true },
  { id: "gems-1500", gems: 1500, pricePaise: 150_000, art: "pack-1500", tag: null, sort: 4, active: true },
  { id: "gems-2000", gems: 2000, pricePaise: 200_000, art: "pack-2000", tag: "BEST VALUE", sort: 5, active: true },
] as const;

/** Put the defaults in if there is nothing there. `do nothing` on conflict, so
 *  a price an admin has changed is never quietly reset by a deploy. */
export async function seedPacks(): Promise<void> {
  await db.insert(gemPacks).values(DEFAULT_PACKS.map((p) => ({ ...p, updatedBy: "default" }))).onConflictDoNothing();
}

// Read on every store open and every Buy, both deliberate taps — but a few
// seconds of cache keeps a burst of them off Postgres, and is short enough
// that an admin changing a price sees it while still looking at the screen.
let packCache: { at: number; packs: GemPack[] } | null = null;
const PACK_CACHE_MS = 5_000;

export function forgetPacks(): void {
  packCache = null;
}

export async function getPacks(includeHidden = false): Promise<GemPack[]> {
  if (!includeHidden && packCache && Date.now() - packCache.at < PACK_CACHE_MS) return packCache.packs;
  const rows = await db.select().from(gemPacks).orderBy(gemPacks.sort, gemPacks.pricePaise);
  const all: GemPack[] = rows.map((r) => ({
    id: r.id,
    gems: r.gems,
    pricePaise: r.pricePaise,
    art: r.art,
    tag: r.tag,
    sort: r.sort,
    active: r.active,
  }));
  if (includeHidden) return all;
  const shelf = all.filter((p) => p.active);
  packCache = { at: Date.now(), packs: shelf };
  return shelf;
}

/** A pack by id, INCLUDING a hidden one.
 *
 *  Hidden on purpose: a player who opened a QR a minute before an admin pulled
 *  the pack is still paying for it, and their session already snapshotted the
 *  gems and the price. Refusing to resolve the id here would strand money that
 *  is already in the air. Hiding takes a pack off the shelf; it does not
 *  cancel what is being paid for. */
export async function findPack(id: string): Promise<GemPack | null> {
  return (await getPacks(true)).find((p) => p.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/** How long the QR is offered. */
export const WINDOW_MS = 120_000;
/** How much longer the AMOUNT stays this player's after the QR stops being
 *  offered. See the note at the top — this is not a courtesy, it is what makes
 *  a late SMS still theirs. */
export const GRACE_MS = 30_000;
/** How many people may be buying the same pack at once. Ninety-nine paise of
 *  headroom; past that the honest answer is "try again in a moment", because
 *  rolling over into the next rupee would collide with a DIFFERENT pack's
 *  price the moment two of them are a rupee apart. */
export const MAX_COLLISION = 99;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface PaySettings {
  upiId: string;
  payeeName: string;
  hookKey: string;
}

const NO_SETTINGS: PaySettings = { upiId: "", payeeName: "TOFO", hookKey: "" };

// The webhook is open to the internet, so a flood of junk must not become a
// flood of Postgres reads. Thirty seconds is short enough that changing the
// UPI id in the console takes effect while the admin is still looking at it.
let cache: { at: number; value: PaySettings } | null = null;
const CACHE_MS = 30_000;

export async function getSettings(fresh = false): Promise<PaySettings> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const [row] = await db.select().from(paymentSettings).where(eq(paymentSettings.id, 1)).limit(1);
  const value: PaySettings = row
    ? { upiId: row.upiId, payeeName: row.payeeName || "TOFO", hookKey: row.hookKey }
    : { ...NO_SETTINGS };
  cache = { at: Date.now(), value };
  return value;
}

export async function setSettings(patch: Partial<PaySettings>, by: string): Promise<PaySettings> {
  await db
    .insert(paymentSettings)
    .values({
      id: 1,
      upiId: patch.upiId ?? "",
      payeeName: patch.payeeName ?? "TOFO",
      hookKey: patch.hookKey ?? "",
      updatedBy: by,
    })
    .onConflictDoUpdate({
      target: paymentSettings.id,
      set: {
        ...(patch.upiId !== undefined ? { upiId: patch.upiId } : {}),
        ...(patch.payeeName !== undefined ? { payeeName: patch.payeeName } : {}),
        ...(patch.hookKey !== undefined ? { hookKey: patch.hookKey } : {}),
        updatedBy: by,
        updatedAt: sql`now()`,
      },
    });
  cache = null;
  return getSettings(true);
}

/** A VPA is "name@handle". Deliberately permissive about what a bank allows in
 *  a name and strict about the shape, because the one mistake that matters
 *  here is a QR that pays nobody. */
export const looksLikeVpa = (v: string): boolean => /^[A-Za-z0-9.\-_]{2,64}@[A-Za-z][A-Za-z0-9.\-]{1,32}$/.test(v);

// ---------------------------------------------------------------------------
// The amount reservation
// ---------------------------------------------------------------------------

const amountKey = (paise: number) => `pay:amt:${paise}`;

/** Release the claim, but ONLY if it is still this session's.
 *
 *  Between reading the key and deleting it the reservation can have expired
 *  and been taken by somebody else, and deleting THEIR claim would let a third
 *  person be quoted the same amount — two live sessions, one price, which is
 *  the exact thing this design exists to prevent. Compare-and-delete in one
 *  Lua step, so there is no between. */
const RELEASE = `
  if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end
  return 0`;

/** Claim an amount, walking up in paise until one is free.
 *
 *  SET NX is the referee. Two players pressing Buy at the same instant both
 *  try `base`; exactly one wins, and the loser moves on to base+1 without ever
 *  having seen a stale read. */
export async function reserveAmount(
  basePaise: number,
  sessionId: string
): Promise<{ amountPaise: number; offset: number } | null> {
  const ttl = Math.ceil((WINDOW_MS + GRACE_MS) / 1000);
  for (let offset = 0; offset <= MAX_COLLISION; offset++) {
    const amount = basePaise + offset;
    const won = await redis.set(amountKey(amount), sessionId, "EX", ttl, "NX");
    if (won === "OK") return { amountPaise: amount, offset };
  }
  return null;
}

export const releaseAmount = (paise: number, sessionId: string): Promise<unknown> =>
  redis.eval(RELEASE, 1, amountKey(paise), sessionId);

/** Which session currently owns an amount, if any. The webhook does not use
 *  this — it asks Postgres, which is the record — but the console does, to
 *  show what is actually held right now. */
export const whoHolds = (paise: number): Promise<string | null> => redis.get(amountKey(paise));

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type SessionStatus = "pending" | "paid" | "approved" | "expired" | "cancelled";

export interface SessionView {
  id: string;
  uid: string;
  username: string;
  packId: string;
  gems: number;
  basePaise: number;
  amountPaise: number;
  collisionOffset: number;
  status: SessionStatus;
  expiresAt: string;
  graceUntil: string;
  settledAt: string | null;
  upiRef: string | null;
  approvedBy: string | null;
  createdAt: string;
}

type Row = typeof paymentSessions.$inferSelect;

const view = (r: Row): SessionView => ({
  id: r.id,
  uid: r.uid,
  username: r.username,
  packId: r.packId,
  gems: r.gems,
  basePaise: r.basePaise,
  amountPaise: r.amountPaise,
  collisionOffset: r.collisionOffset,
  status: r.status as SessionStatus,
  expiresAt: r.expiresAt.toISOString(),
  graceUntil: r.graceUntil.toISOString(),
  settledAt: r.settledAt?.toISOString() ?? null,
  upiRef: r.upiRef,
  approvedBy: r.approvedBy,
  createdAt: r.createdAt.toISOString(),
});

export interface OpenSessionInput {
  userId: string;
  uid: string;
  username: string;
  packId: string;
}

export type OpenResult =
  | { ok: true; session: SessionView; qrDataUrl: string; upiUri: string; payeeName: string }
  | { ok: false; code: "NO_UPI" | "NO_PACK" | "BUSY" | "TOO_MANY"; error: string };

/** How many unpaid sessions one player may have open at once.
 *
 *  Not a fraud control — a broom, and a deliberately loose one. Every press of
 *  Buy opens a NEW payment (see the note on openSession), so somebody who
 *  opens a QR, closes it, thinks better of it and opens it again is on their
 *  third session inside a minute, which is ordinary behaviour and must not be
 *  refused. What this stops is a script taking every amount a pack has.
 *
 *  There are MAX_COLLISION + 1 amounts per pack, so even a player who exhausts
 *  this leaves the great majority of them for everybody else. */
const MAX_OPEN_PER_PLAYER = 10;

/** Open a payment. EVERY press of Buy is a new one.
 *
 *  Deliberately not idempotent, and it is worth being clear why, because the
 *  obvious alternative — handing back the payment they already had — was tried
 *  and is worse. A session that is still live still holds its amount, so a
 *  second press cannot be quoted the same figure; it takes the next paise. The
 *  consequences are all good ones:
 *
 *   * The QR on screen always carries a fresh two minutes, rather than however
 *     little was left of one opened before.
 *   * A screenshot taken of the FIRST code is still payable, because that
 *     session is still live and still holds that amount. Whichever code they
 *     end up scanning, the money finds a session.
 *   * Two amounts are held rather than one, which costs nothing worth having:
 *     they expire on their own in two and a half minutes.
 */
export async function openSession(input: OpenSessionInput): Promise<OpenResult> {
  const pack = await findPack(input.packId);
  if (!pack) return { ok: false, code: "NO_PACK", error: "That pack is not for sale" };

  const settings = await getSettings();
  if (!looksLikeVpa(settings.upiId)) {
    return { ok: false, code: "NO_UPI", error: "Payments are not set up yet — try again later" };
  }

  const open = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentSessions)
    .where(
      and(
        eq(paymentSessions.userId, input.userId),
        eq(paymentSessions.status, "pending"),
        gt(paymentSessions.graceUntil, sql`now()`)
      )
    );
  if ((open[0]?.n ?? 0) >= MAX_OPEN_PER_PLAYER) {
    return {
      ok: false,
      code: "TOO_MANY",
      error: "You have several payments open already. Pay one of them, or wait a couple of minutes.",
    };
  }

  // The id is minted HERE rather than by the database, because the Redis claim
  // has to be stamped with it before the row exists — the claim is what makes
  // the row safe to write, not the other way round.
  const id = randomUUID();
  const claim = await reserveAmount(pack.pricePaise, id);
  if (!claim) {
    return {
      ok: false,
      code: "BUSY",
      error: "Too many people are buying this pack right now. Try again in a couple of minutes.",
    };
  }

  const now = Date.now();
  try {
    const [row] = await db
      .insert(paymentSessions)
      .values({
        id,
        userId: input.userId,
        uid: input.uid,
        username: input.username,
        packId: pack.id,
        gems: pack.gems,
        basePaise: pack.pricePaise,
        amountPaise: claim.amountPaise,
        collisionOffset: claim.offset,
        status: "pending",
        expiresAt: new Date(now + WINDOW_MS),
        graceUntil: new Date(now + WINDOW_MS + GRACE_MS),
      })
      .returning();

    return { ok: true, ...(await present(row, settings)) };
  } catch (err) {
    // The row did not happen, so the claim must not outlive it — otherwise
    // that amount is unusable for two and a half minutes for nothing.
    await releaseAmount(claim.amountPaise, id).catch(() => undefined);
    throw err;
  }
}

/** A session as the player's screen needs it: the row, the QR, and who they
 *  are paying. The QR is rebuilt rather than stored — it is a pure function of
 *  the amount and the UPI id, and storing an image of a thing you can derive
 *  is how the image and the thing end up disagreeing. */
async function present(
  row: Row,
  settings: PaySettings
): Promise<{ session: SessionView; qrDataUrl: string; upiUri: string; payeeName: string }> {
  const upiUri = buildUpiUri(settings, row.amountPaise, row.id);
  const qrDataUrl = await QRCode.toDataURL(upiUri, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 512,
    color: { dark: "#0b0507", light: "#ffffff" },
  });
  return { session: view(row), qrDataUrl, upiUri, payeeName: settings.payeeName };
}

/** The UPI intent the QR encodes.
 *
 *  `am` is the only place in this system where money is written as rupees, and
 *  it is built from the integer paise rather than from any float that has been
 *  near a decimal point. `tr` gives the payer's app something to echo; nothing
 *  depends on it coming back, because most banks do not send it on. */
export function buildUpiUri(settings: PaySettings, amountPaise: number, sessionId: string): string {
  const params = new URLSearchParams({
    pa: settings.upiId,
    pn: settings.payeeName || "TOFO",
    am: rupees(amountPaise),
    cu: "INR",
    tn: `TOFO Gems`,
    tr: `TOFO${sessionId.replace(/-/g, "").slice(0, 20).toUpperCase()}`,
  });
  return `upi://pay?${params.toString()}`;
}

export async function getSession(id: string): Promise<SessionView | null> {
  const [row] = await db.select().from(paymentSessions).where(eq(paymentSessions.id, id)).limit(1);
  return row ? view(row) : null;
}

/** The player's own view, which must never be another player's. */
export async function getOwnSession(id: string, userId: string): Promise<SessionView | null> {
  const [row] = await db
    .select()
    .from(paymentSessions)
    .where(and(eq(paymentSessions.id, id), eq(paymentSessions.userId, userId)))
    .limit(1);
  return row ? view(row) : null;
}

/** A player giving up on a QR. The amount goes back into circulation at once,
 *  which is the point — the next buyer of that pack should not be quoted a
 *  stranger price because somebody changed their mind. */
export async function cancelSession(id: string, userId: string): Promise<boolean> {
  const [row] = await db
    .update(paymentSessions)
    .set({ status: "cancelled", settledAt: sql`now()` })
    .where(
      and(eq(paymentSessions.id, id), eq(paymentSessions.userId, userId), eq(paymentSessions.status, "pending"))
    )
    .returning();
  if (!row) return false;
  await releaseAmount(row.amountPaise, row.id).catch(() => undefined);
  return true;
}

/** Mark everything whose grace has run out. Purely bookkeeping: the Redis
 *  claim carries its own TTL and has already let go, so a sweeper that fails
 *  to run cannot leave an amount reserved for ever — it only leaves a row
 *  saying "pending" that is no longer pending. */
export async function expireDue(): Promise<number> {
  const rows = await db
    .update(paymentSessions)
    .set({ status: "expired" })
    .where(and(eq(paymentSessions.status, "pending"), lt(paymentSessions.graceUntil, sql`now()`)))
    .returning({ id: paymentSessions.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Settling
// ---------------------------------------------------------------------------

export type HookOutcome = "verified" | "unmatched" | "duplicate" | "ignored" | "rejected" | "malformed";

export interface LogHookInput {
  outcome: HookOutcome;
  detail: string;
  body: string;
  amountPaise?: number | null;
  upiRef?: string | null;
  sessionId?: string | null;
  uid?: string | null;
  ip?: string | null;
}

/** Anything sent to the webhook, whatever it turned out to be.
 *
 *  Truncated on the way in. This is a log, not a file drop, and the one thing
 *  an open route must never be is a way to fill somebody's disk. */
export async function logHook(input: LogHookInput): Promise<number> {
  const [row] = await db
    .insert(paymentHookLog)
    .values({
      outcome: input.outcome,
      detail: input.detail.slice(0, 300),
      body: input.body.slice(0, 2000),
      amountPaise: input.amountPaise ?? null,
      upiRef: input.upiRef ? input.upiRef.slice(0, 64) : null,
      sessionId: input.sessionId ?? null,
      uid: input.uid ?? null,
      ip: input.ip ?? null,
    })
    .returning({ id: paymentHookLog.id });
  return Number(row.id);
}

/** Correct a log row once the matching is done. The row is written BEFORE the
 *  match is attempted, so that a crash in between leaves a record of money
 *  arriving rather than no record at all; this is the second half of that. */
export async function resolveHook(
  id: number,
  patch: { outcome: HookOutcome; detail: string; sessionId: string | null; uid: string | null }
): Promise<void> {
  await db
    .update(paymentHookLog)
    .set({
      outcome: patch.outcome,
      detail: patch.detail.slice(0, 300),
      sessionId: patch.sessionId,
      uid: patch.uid,
    })
    .where(eq(paymentHookLog.id, id));
}

/** Who a session belongs to, without pulling the whole row across. */
export async function sessionOwner(sessionId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: paymentSessions.userId })
    .from(paymentSessions)
    .where(eq(paymentSessions.id, sessionId))
    .limit(1);
  return row?.userId ?? null;
}

export interface SettleResult {
  outcome: HookOutcome;
  detail: string;
  session: SessionView | null;
}

/** A credit has arrived. Find whose it was, or say plainly that nobody's
 *  matched — which is a real answer and not a failure.
 *
 *  The claim is made in ONE statement. `UPDATE … WHERE status='pending'
 *  RETURNING` is what stops the same session being settled twice by two
 *  redeliveries racing: the second update matches no rows because the first
 *  already moved the status, and it never gets as far as crediting anything. */
export async function settleFromSms(args: {
  amountPaise: number;
  upiRef: string | null;
  hookId: number | null;
}): Promise<SettleResult> {
  const { amountPaise, upiRef } = args;

  // Already seen? The bank's reference is the only thing both sides share, so
  // it is the only honest way to recognise a redelivery.
  if (upiRef) {
    const [seen] = await db
      .select()
      .from(paymentSessions)
      .where(eq(paymentSessions.upiRef, upiRef))
      .limit(1);
    if (seen) {
      return {
        outcome: "duplicate",
        detail: `Already credited to ${seen.uid} (${seen.packId}) — same UPI reference`,
        session: view(seen),
      };
    }
  }

  // Whose amount is this? Still pending, and still inside the grace window —
  // which is deliberately LONGER than the QR was offered.
  //
  // The subselect pins it to EXACTLY ONE row. Matching on the amount alone
  // would, if two live sessions ever shared one, mark both paid and credit
  // only the first — the second player's money silently gone. The Redis claim
  // is what stops that happening; this is what stops it mattering if the claim
  // ever fails (a flushed Redis mid-flight is all it would take). Oldest
  // first, because the earlier QR is the one more likely to be running out.
  //
  // Two webhook calls racing on the same amount are safe: both subselects may
  // pick the same id, one wins the row lock, and the other re-checks its WHERE
  // afterwards, finds the status already moved, and matches nothing.
  const [claimed] = await db
    .update(paymentSessions)
    .set({
      status: "paid",
      settledAt: sql`now()`,
      upiRef,
      hookId: args.hookId,
    })
    .where(
      and(
        eq(paymentSessions.status, "pending"),
        sql`${paymentSessions.id} = (
          select s.id from ${paymentSessions} s
          where s.amount_paise = ${amountPaise}
            and s.status = 'pending'
            and s.grace_until > now()
          order by s.created_at asc
          limit 1
        )`
      )
    )
    .returning();

  if (!claimed) {
    return {
      outcome: "unmatched",
      detail: `₹${rupees(amountPaise)} arrived with no live session for it — check by hand`,
      session: null,
    };
  }

  await credit({
    userId: claimed.userId,
    currency: "gem",
    delta: claimed.gems,
    reason: "purchase",
    ref: claimed.id,
    note: `${claimed.packId} · ₹${rupees(claimed.amountPaise)}${upiRef ? ` · UPI ${upiRef}` : ""}`,
    spentPaise: claimed.amountPaise,
  });
  // The session is over, so the amount goes back into circulation at once
  // rather than sitting out the rest of its grace for nobody.
  await releaseAmount(claimed.amountPaise, claimed.id).catch(() => undefined);

  return {
    outcome: "verified",
    detail: `${claimed.gems} gems to ${claimed.username} (${claimed.uid}) for ₹${rupees(claimed.amountPaise)}`,
    session: view(claimed),
  };
}

/** An admin putting their name to a payment the parser could not match.
 *
 *  The same single-statement claim as above, for the same reason: two admins
 *  looking at the same queue must not both be able to credit it. */
export async function approveByHand(
  sessionId: string,
  by: string,
  note: string | null
): Promise<{ ok: boolean; error?: string; session?: SessionView }> {
  const [claimed] = await db
    .update(paymentSessions)
    .set({ status: "approved", settledAt: sql`now()`, approvedBy: by })
    .where(
      and(
        eq(paymentSessions.id, sessionId),
        or(eq(paymentSessions.status, "pending"), eq(paymentSessions.status, "expired"))
      )
    )
    .returning();

  if (!claimed) {
    const existing = await getSession(sessionId);
    if (!existing) return { ok: false, error: "No such payment session" };
    return { ok: false, error: `That session is already ${existing.status}`, session: existing };
  }

  await credit({
    userId: claimed.userId,
    currency: "gem",
    delta: claimed.gems,
    reason: "purchase.manual",
    ref: claimed.id,
    note: `${claimed.packId} · ₹${rupees(claimed.amountPaise)} · approved by ${by}${note ? ` · ${note}` : ""}`,
    spentPaise: claimed.amountPaise,
  });
  await releaseAmount(claimed.amountPaise, claimed.id).catch(() => undefined);
  return { ok: true, session: view(claimed) };
}

// ---------------------------------------------------------------------------
// Reading, for the console
// ---------------------------------------------------------------------------

export interface Window {
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string | null;
}

export interface SessionQuery extends Window {
  status?: SessionStatus | "";
  /** A UID, or part of a username. */
  who?: string;
  /** In paise. Finding out who was quoted an odd amount. */
  amountPaise?: number | null;
}

export async function listSessions(q: SessionQuery): Promise<{ sessions: SessionView[]; cursor: string | null }> {
  const limit = Math.min(200, Math.max(1, q.limit ?? 50));
  const clauses = [];
  if (q.from) clauses.push(gt(paymentSessions.createdAt, q.from));
  if (q.to) clauses.push(lt(paymentSessions.createdAt, q.to));
  if (q.status) clauses.push(eq(paymentSessions.status, q.status));
  if (q.amountPaise) clauses.push(eq(paymentSessions.amountPaise, q.amountPaise));
  if (q.who) {
    const needle = `%${q.who.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    clauses.push(sql`(${paymentSessions.uid} ilike ${needle} or ${paymentSessions.username} ilike ${needle})`);
  }
  if (q.cursor) clauses.push(lt(paymentSessions.createdAt, new Date(q.cursor)));

  const rows = await db
    .select()
    .from(paymentSessions)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(paymentSessions.createdAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return {
    sessions: page.map(view),
    cursor: rows.length > limit ? page[page.length - 1].createdAt.toISOString() : null,
  };
}

export interface HookRow {
  id: number;
  outcome: HookOutcome;
  detail: string;
  body: string;
  amountPaise: number | null;
  upiRef: string | null;
  sessionId: string | null;
  uid: string | null;
  ip: string | null;
  createdAt: string;
}

export interface HookQuery extends Window {
  outcome?: HookOutcome | "";
  amountPaise?: number | null;
}

export async function listHookLog(q: HookQuery): Promise<{ rows: HookRow[]; cursor: string | null }> {
  const limit = Math.min(200, Math.max(1, q.limit ?? 50));
  const clauses = [];
  if (q.from) clauses.push(gt(paymentHookLog.createdAt, q.from));
  if (q.to) clauses.push(lt(paymentHookLog.createdAt, q.to));
  if (q.outcome) clauses.push(eq(paymentHookLog.outcome, q.outcome));
  if (q.amountPaise) clauses.push(eq(paymentHookLog.amountPaise, q.amountPaise));
  if (q.cursor) clauses.push(lt(paymentHookLog.id, Number(q.cursor)));

  const rows = await db
    .select()
    .from(paymentHookLog)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(paymentHookLog.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return {
    rows: page.map((r) => ({
      id: Number(r.id),
      outcome: r.outcome as HookOutcome,
      detail: r.detail,
      body: r.body,
      amountPaise: r.amountPaise,
      upiRef: r.upiRef,
      sessionId: r.sessionId,
      uid: r.uid,
      ip: r.ip,
      createdAt: r.createdAt.toISOString(),
    })),
    cursor: rows.length > limit ? String(page[page.length - 1].id) : null,
  };
}

/** One log row by id. The candidates screen needs the row it is asked about,
 *  and paging to it would be a cursor trick that breaks the first time
 *  somebody links straight to a row. */
export async function getHookRow(id: number): Promise<HookRow | null> {
  const [r] = await db.select().from(paymentHookLog).where(eq(paymentHookLog.id, id)).limit(1);
  if (!r) return null;
  return {
    id: Number(r.id),
    outcome: r.outcome as HookOutcome,
    detail: r.detail,
    body: r.body,
    amountPaise: r.amountPaise,
    upiRef: r.upiRef,
    sessionId: r.sessionId,
    uid: r.uid,
    ip: r.ip,
    createdAt: r.createdAt.toISOString(),
  };
}

/** What the console shows above the two tables: how much came in, how much did
 *  not, and how much is in the air right now. */
export async function paymentTotals(from: Date, to: Date): Promise<{
  sessions: number;
  settled: number;
  paise: number;
  live: number;
  unmatched: number;
}> {
  const [s] = await db
    .select({
      sessions: sql<number>`count(*)::int`,
      settled: sql<number>`count(*) filter (where ${paymentSessions.status} in ('paid','approved'))::int`,
      paise: sql<number>`coalesce(sum(${paymentSessions.amountPaise}) filter (where ${paymentSessions.status} in ('paid','approved')), 0)::bigint`,
      live: sql<number>`count(*) filter (where ${paymentSessions.status} = 'pending' and ${paymentSessions.graceUntil} > now())::int`,
    })
    .from(paymentSessions)
    .where(and(gt(paymentSessions.createdAt, from), lt(paymentSessions.createdAt, to)));

  const [h] = await db
    .select({ unmatched: sql<number>`count(*) filter (where ${paymentHookLog.outcome} = 'unmatched')::int` })
    .from(paymentHookLog)
    .where(and(gt(paymentHookLog.createdAt, from), lt(paymentHookLog.createdAt, to)));

  return {
    sessions: Number(s?.sessions ?? 0),
    settled: Number(s?.settled ?? 0),
    paise: Number(s?.paise ?? 0),
    live: Number(s?.live ?? 0),
    unmatched: Number(h?.unmatched ?? 0),
  };
}

/** Every session whose amount could plausibly have been the one that just
 *  arrived unmatched — the answer to "somebody paid ₹100 at 17:05 and nobody
 *  was credited; who was it?".
 *
 *  Deliberately generous: the same amount, or the same BASE amount, anywhere
 *  near that moment. An admin ringing a player to check needs candidates, not
 *  a verdict. */
export async function nearMisses(amountPaise: number, at: Date, windowMin = 10): Promise<SessionView[]> {
  const from = new Date(at.getTime() - windowMin * 60_000);
  const to = new Date(at.getTime() + windowMin * 60_000);
  const rows = await db
    .select()
    .from(paymentSessions)
    .where(
      and(
        gt(paymentSessions.createdAt, from),
        lt(paymentSessions.createdAt, to),
        or(
          eq(paymentSessions.amountPaise, amountPaise),
          // Same pack, different collision offset: the player may have typed
          // the amount from an older QR, or paid the base price by habit.
          and(
            lt(paymentSessions.basePaise, amountPaise + 100),
            gt(paymentSessions.basePaise, amountPaise - 100)
          )
        )
      )
    )
    .orderBy(desc(paymentSessions.createdAt))
    .limit(20);
  return rows.map(view);
}

/** Sessions still live right now — what the console's top strip counts, and
 *  what makes "why was I quoted ₹100.02" answerable. */
export async function liveSessions(): Promise<SessionView[]> {
  const rows = await db
    .select()
    .from(paymentSessions)
    .where(and(eq(paymentSessions.status, "pending"), gt(paymentSessions.graceUntil, sql`now()`)))
    .orderBy(desc(paymentSessions.createdAt))
    .limit(100);
  return rows.map(view);
}

/** Every payment one player has ever opened — the player-360 block. */
export async function sessionsForUser(userId: string, limit = 20): Promise<SessionView[]> {
  const rows = await db
    .select()
    .from(paymentSessions)
    .where(eq(paymentSessions.userId, userId))
    .orderBy(desc(paymentSessions.createdAt))
    .limit(Math.min(100, limit));
  return rows.map(view);
}
