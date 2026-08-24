// The console's side of the money.
//
// Three screens' worth of API, and one rule running through all of it: an
// admin may READ everything here at analyst level, because "did this player's
// payment land" is a support question, and may CHANGE nothing without being an
// admin holding a fresh authenticator code. Approving a payment by hand mints
// gems out of nothing but somebody's word, so it is the single most abusable
// button in the console and is gated like one — sudo, admin-or-owner, and an
// audit row naming who did it.
import { randomBytes } from "node:crypto";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { gemPacks } from "../../db/schema.js";
import { safeRouter } from "../asyncRouter.js";
import { requireAdmin, requireSudo } from "../guard.js";
import { audit } from "../audit.js";
import { requestOrigin } from "../../services/clientIp.js";
import { logEvent } from "../../services/eventLog.js";
import { sendOpsCommand } from "../../platform/opsCommands.js";
import { rupees } from "../../services/money.js";
import { credit, getBalance, ledger } from "../../services/wallet.js";
import { getUserByUid } from "../../services/users.js";
import {
  approveByHand,
  getSession,
  GRACE_MS,
  listHookLog,
  listSessions,
  liveSessions,
  looksLikeVpa,
  nearMisses,
  paymentTotals,
  forgetPacks,
  getHookRow,
  getPacks,
  getSettings,
  sessionsForUser,
  setSettings,
  whoHolds,
  WINDOW_MS,
  type HookOutcome,
  type SessionStatus,
} from "../../services/payments.js";

export const paymentsRouter = safeRouter();

/** A window with sane ends. Both sides of every screen here are optional, and
 *  a missing one means "as far back as anyone would want to look" rather than
 *  a 400 — a filter that refuses to work until it is fully filled in is a
 *  filter nobody uses. */
function windowOf(q: Record<string, unknown>): { from: Date; to: Date } {
  const parse = (v: unknown, fallback: number): Date => {
    const d = new Date(String(v ?? ""));
    return Number.isNaN(d.getTime()) ? new Date(fallback) : d;
  };
  const to = parse(q.to, Date.now() + 60_000);
  const from = parse(q.from, to.getTime() - 24 * 3600_000);
  return { from, to };
}

/** "100.01" or "10001p" → paise. The console's amount box takes rupees,
 *  because that is what the bank's message says and what an admin is reading
 *  off their phone. */
function paiseOf(v: unknown): number | null {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(raw)) return null;
  const [whole, fraction = ""] = raw.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

// ---------------------------------------------------------------------------
// Payment management — where the money goes
// ---------------------------------------------------------------------------

paymentsRouter.get("/payments/settings", requireAdmin("admin"), async (req, res) => {
  const s = await getSettings(true);
  const packs = await getPacks(true);
  // The key is a CREDENTIAL. It is shown only to somebody who has just proved
  // they are holding the phone, and reading it is audited like any other
  // exercise of power — because whoever has it can tell this platform a
  // payment arrived.
  res.json({
    upiId: s.upiId,
    payeeName: s.payeeName,
    hasKey: s.hookKey.length > 0,
    keyLength: s.hookKey.length,
    packs,
    windowMs: WINDOW_MS,
    graceMs: GRACE_MS,
    ready: looksLikeVpa(s.upiId) && s.hookKey.length > 0,
    admin: req.admin!.email,
  });
});

/** The key itself, once, behind sudo — for pasting into the forwarding app. */
paymentsRouter.post("/payments/settings/reveal", requireAdmin("admin"), requireSudo, async (req, res) => {
  const s = await getSettings(true);
  await audit(req.admin!, {
    action: "payments.key.reveal",
    targetType: "platform",
    ip: requestOrigin(req).ip,
  });
  res.json({ hookKey: s.hookKey });
});

paymentsRouter.post("/payments/settings", requireAdmin("admin"), requireSudo, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const before = await getSettings(true);
  const patch: { upiId?: string; payeeName?: string; hookKey?: string } = {};

  if (body.upiId !== undefined) {
    const upi = String(body.upiId).trim();
    if (upi && !looksLikeVpa(upi)) {
      res.status(400).json({ error: "That does not look like a UPI id — it should read name@bank" });
      return;
    }
    patch.upiId = upi;
  }
  if (body.payeeName !== undefined) {
    const name = String(body.payeeName).trim().slice(0, 40);
    if (name && !/^[A-Za-z0-9 .&'-]{2,40}$/.test(name)) {
      res.status(400).json({ error: "The payee name can only be letters, numbers and simple punctuation" });
      return;
    }
    patch.payeeName = name || "TOFO";
  }
  // The key is GENERATED, never typed. A shared secret somebody chose is a
  // shared secret somebody can guess, and this one is the whole authentication
  // on an open route.
  if (body.rotateKey === true) patch.hookKey = randomBytes(24).toString("base64url");

  const after = await setSettings(patch, req.admin!.email);
  await audit(req.admin!, {
    action: "payments.settings",
    targetType: "platform",
    before: { upiId: before.upiId, payeeName: before.payeeName, hadKey: before.hookKey.length > 0 },
    after: { upiId: after.upiId, payeeName: after.payeeName, hadKey: after.hookKey.length > 0 },
    reason: body.rotateKey === true ? "webhook key rotated" : null,
    ip: requestOrigin(req).ip,
  });
  logEvent({ type: "payments.settings", data: { by: req.admin!.email, rotated: body.rotateKey === true } });

  res.json({
    upiId: after.upiId,
    payeeName: after.payeeName,
    hasKey: after.hookKey.length > 0,
    // Returned exactly once, at the moment it is made. Never again without
    // sudo and an audit row.
    newKey: patch.hookKey ?? null,
    ready: looksLikeVpa(after.upiId) && after.hookKey.length > 0,
  });
});

/** Change what a pack costs, how many gems it gives, or whether it is on the
 *  shelf at all.
 *
 *  Sudo and admin, like everything else here that touches money. Bounded on
 *  both sides: a pack priced at nothing is a pack that gives gems away, and a
 *  pack priced absurdly high is a fat-finger nobody notices until somebody
 *  pays it.
 *
 *  Note what this does NOT do — it never touches a payment already in flight.
 *  A session snapshots the gems and the price when it opens, so a player
 *  halfway through paying keeps the deal they were quoted. */
paymentsRouter.post("/payments/packs/:id", requireAdmin("admin"), requireSudo, async (req, res) => {
  const id = String(req.params.id);
  const before = (await getPacks(true)).find((p) => p.id === id);
  if (!before) {
    res.status(404).json({ error: "No such pack" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  if (body.pricePaise !== undefined) {
    const paise = paiseOf(body.pricePaise) ?? Math.trunc(Number(body.pricePaise));
    if (!Number.isFinite(paise) || paise < 100 || paise > 100_000_000) {
      res.status(400).json({ error: "A pack must cost between ₹1 and ₹10,00,000" });
      return;
    }
    patch.pricePaise = paise;
  }
  if (body.gems !== undefined) {
    const gems = Math.trunc(Number(body.gems));
    if (!Number.isInteger(gems) || gems < 1 || gems > 10_000_000) {
      res.status(400).json({ error: "A pack must give between 1 and 1,00,00,000 gems" });
      return;
    }
    patch.gems = gems;
  }
  if (body.tag !== undefined) {
    const tag = String(body.tag).trim().slice(0, 24);
    if (tag && !/^[A-Za-z0-9 %+!-]{1,24}$/.test(tag)) {
      res.status(400).json({ error: "A ribbon is letters, numbers and simple punctuation" });
      return;
    }
    patch.tag = tag || null;
  }
  if (body.active !== undefined) patch.active = body.active === true;
  if (body.sort !== undefined) patch.sort = Math.max(0, Math.min(99, Math.trunc(Number(body.sort)) || 0));

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "Nothing to change" });
    return;
  }

  await db
    .update(gemPacks)
    .set({ ...patch, updatedBy: req.admin!.email, updatedAt: drizzleSql`now()` })
    .where(eq(gemPacks.id, id));
  forgetPacks();

  await audit(req.admin!, {
    action: "payments.pack",
    targetType: "platform",
    targetId: id,
    before: { gems: before.gems, pricePaise: before.pricePaise, tag: before.tag, active: before.active },
    after: patch,
    ip: requestOrigin(req).ip,
  });
  logEvent({ type: "payments.settings", data: { by: req.admin!.email, pack: id, ...patch } });
  res.json({ packs: await getPacks(true) });
});

// ---------------------------------------------------------------------------
// Payment sessions
// ---------------------------------------------------------------------------

paymentsRouter.get("/payments/sessions", requireAdmin("support"), async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const { from, to } = windowOf(q);
  const out = await listSessions({
    from,
    to,
    status: (String(q.status ?? "") || "") as SessionStatus | "",
    who: String(q.who ?? "").trim() || undefined,
    amountPaise: paiseOf(q.amount),
    limit: Number(q.limit ?? 60),
    cursor: q.cursor ? String(q.cursor) : null,
  });
  res.json({ ...out, from: from.toISOString(), to: to.toISOString() });
});

/** The strip above the table: how much came in, how much is in the air. */
paymentsRouter.get("/payments/totals", requireAdmin("support"), async (req, res) => {
  const { from, to } = windowOf(req.query as Record<string, unknown>);
  const totals = await paymentTotals(from, to);
  res.json({ ...totals, rupees: rupees(totals.paise), from: from.toISOString(), to: to.toISOString() });
});

/** What is being paid RIGHT NOW, with the Redis reservation each one holds —
 *  which is the only honest answer to "why was this player quoted ₹100.02". */
paymentsRouter.get("/payments/live", requireAdmin("support"), async (_req, res) => {
  const sessions = await liveSessions();
  const held = await Promise.all(sessions.map((s) => whoHolds(s.amountPaise).catch(() => null)));
  res.json({
    sessions: sessions.map((s, i) => ({
      ...s,
      /** False means the reservation has already lapsed while the row still
       *  says pending — the sweeper has simply not caught up yet. */
      reserved: held[i] === s.id,
    })),
  });
});

paymentsRouter.get("/payments/sessions/:id", requireAdmin("support"), async (req, res) => {
  const session = await getSession(String(req.params.id));
  if (!session) {
    res.status(404).json({ error: "No such payment session" });
    return;
  }
  const user = await getUserByUid(session.uid);
  res.json({
    session,
    reserved: (await whoHolds(session.amountPaise).catch(() => null)) === session.id,
    balance: user ? await getBalance(user.id) : null,
  });
});

/** Crediting somebody because you looked at your UPI history and their money
 *  is there. The most abusable button in the console: admin, sudo, audited. */
paymentsRouter.post("/payments/sessions/:id/approve", requireAdmin("admin"), requireSudo, async (req, res) => {
  const note = String((req.body ?? {}).note ?? "").trim().slice(0, 200);
  const before = await getSession(String(req.params.id));
  if (!before) {
    res.status(404).json({ error: "No such payment session" });
    return;
  }
  const result = await approveByHand(before.id, req.admin!.email, note || null);
  if (!result.ok) {
    res.status(409).json({ error: result.error, session: result.session });
    return;
  }
  await audit(req.admin!, {
    action: "payments.approve",
    targetType: "user",
    targetId: before.uid,
    reason: note || null,
    before: { status: before.status },
    after: { status: "approved", gems: before.gems, amountPaise: before.amountPaise },
    ip: requestOrigin(req).ip,
  });
  logEvent({
    type: "payments.approve",
    uid: before.uid,
    data: { by: req.admin!.email, gems: before.gems, amountPaise: before.amountPaise, sessionId: before.id },
  });
  // The console's process holds no sockets, so this is the only way somebody
  // still staring at the QR finds out. Best effort — the popup polls too.
  const user = await getUserByUid(before.uid);
  if (user) {
    await sendOpsCommand("wallet", { userId: user.id, sessionId: before.id }, { by: req.admin!.email }).catch(
      () => null
    );
  }
  res.json({ ok: true, session: result.session });
});

// ---------------------------------------------------------------------------
// The webhook log
// ---------------------------------------------------------------------------

paymentsRouter.get("/payments/hooks", requireAdmin("support"), async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const { from, to } = windowOf(q);
  const out = await listHookLog({
    from,
    to,
    outcome: (String(q.outcome ?? "") || "") as HookOutcome | "",
    amountPaise: paiseOf(q.amount),
    limit: Number(q.limit ?? 60),
    cursor: q.cursor ? String(q.cursor) : null,
  });
  res.json({ ...out, from: from.toISOString(), to: to.toISOString() });
});

/** "₹300 arrived at 17:05 and nobody was credited — whose was it?"
 *
 *  Answers with candidates, never with a verdict. An admin ringing a player to
 *  confirm needs the shortlist; deciding for them is how the wrong person gets
 *  the gems. */
paymentsRouter.get("/payments/hooks/:id/candidates", requireAdmin("support"), async (req, res) => {
  const row = await getHookRow(Number(req.params.id));
  if (!row || row.amountPaise === null) {
    res.status(404).json({ error: "That log row has no amount to match" });
    return;
  }
  res.json({ candidates: await nearMisses(row.amountPaise, new Date(row.createdAt)) });
});

// ---------------------------------------------------------------------------
// One player's wallet — the player-360 block
// ---------------------------------------------------------------------------

paymentsRouter.get("/players/:uid/wallet", requireAdmin("support"), async (req, res) => {
  const user = await getUserByUid(String(req.params.uid));
  if (!user) {
    res.status(404).json({ error: "No such player" });
    return;
  }
  res.json({
    balance: await getBalance(user.id),
    ledger: await ledger(user.id, 40),
    sessions: await sessionsForUser(user.id, 20),
  });
});

/** Giving somebody coins or gems without a payment — compensation, a
 *  competition prize, putting right something the platform broke. */
paymentsRouter.post("/players/:uid/wallet", requireAdmin("admin"), requireSudo, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const currency = body.currency === "gem" ? "gem" : "coin";
  const delta = Math.trunc(Number(body.delta ?? 0));
  const note = String(body.note ?? "").trim().slice(0, 200);
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > 1_000_000) {
    res.status(400).json({ error: "Give a whole amount between -1,000,000 and 1,000,000" });
    return;
  }
  if (!note) {
    res.status(400).json({ error: "Say why — a grant with no reason is one nobody can answer for later" });
    return;
  }
  const user = await getUserByUid(String(req.params.uid));
  if (!user) {
    res.status(404).json({ error: "No such player" });
    return;
  }
  const balance = await credit({
    userId: user.id,
    currency,
    delta,
    reason: "admin.grant",
    ref: req.admin!.email,
    note,
  });
  await audit(req.admin!, {
    action: "payments.grant",
    targetType: "user",
    targetId: user.uid,
    reason: note,
    after: { currency, delta, balance },
    ip: requestOrigin(req).ip,
  });
  logEvent({ type: "payments.grant", userId: user.id, uid: user.uid, data: { by: req.admin!.email, currency, delta } });
  await sendOpsCommand("wallet", { userId: user.id }, { by: req.admin!.email }).catch(() => null);
  res.json({ ok: true, balance });
});
