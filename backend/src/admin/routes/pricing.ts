// What the collection costs.
//
// One screen's worth of API over `item_prices`, and the shape of it follows
// from one fact: NO ROW MEANS FREE. So this lists the CATALOG — everything
// that exists — and hangs whatever price has been set beside each entry,
// rather than listing the price table and leaving an admin to work out what is
// missing from it. The interesting rows are the ones with nothing in them.
//
// Reading is analyst-level, because "why can this player not wear that" is a
// support question. Changing a price is admin and sudo, because it is a change
// to what people are charged.
import { safeRouter } from "../asyncRouter.js";
import { requireAdmin, requireSudo } from "../guard.js";
import { audit } from "../audit.js";
import { requestOrigin } from "../../services/clientIp.js";
import { logEvent } from "../../services/eventLog.js";
import { catalogIndex } from "../../services/catalog.js";
import { withdrawnItems } from "../../platform/gameLocks.js";
import { getUserByUid } from "../../services/users.js";
import {
  grantItem,
  itemsOwnedBy,
  listOrders,
  listPrices,
  orderTotals,
  ownerCounts,
  setItemPrice,
  topItems,
} from "../../services/pricing.js";

export const pricingRouter = safeRouter();

/** Everything in the collection, with what it costs and how many people have
 *  bought it. */
pricingRouter.get("/pricing", requireAdmin("analyst"), async (_req, res) => {
  const items = catalogIndex();
  const [prices, counts, gone] = await Promise.all([
    listPrices(),
    ownerCounts(items.map((i) => i.id)),
    withdrawnItems(),
  ]);
  const byId = new Map(prices.map((p) => [p.itemId, p]));
  const withdrawn = new Set(gone);

  res.json({
    items: items.map((i) => {
      const p = byId.get(i.id);
      return {
        ...i,
        // null currency — whether from no row at all or an admin saying so —
        // is free. The console shows which of the two it is.
        currency: p?.currency ?? null,
        price: p?.price ?? 0,
        priced: p !== undefined,
        owners: counts.get(i.id) ?? 0,
        withdrawn: withdrawn.has(i.id),
        updatedBy: p?.updatedBy ?? null,
        updatedAt: p?.updatedAt ?? null,
      };
    }),
  });
});

/** Price one item, or set it back to free. */
pricingRouter.post("/pricing/:itemId", requireAdmin("admin"), requireSudo, async (req, res) => {
  const itemId = String(req.params.itemId);
  const item = catalogIndex().find((i) => i.id === itemId);
  if (!item) {
    res.status(404).json({ error: "No such item in the collection" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = String(body.currency ?? "free");
  const currency = raw === "coin" ? "coin" : raw === "gem" ? "gem" : null;
  const amount = Math.trunc(Number(body.price ?? 0));

  if (currency !== null) {
    // Bounded on both sides. Zero is free — and saying "free" by typing a
    // price of nothing is the sort of ambiguity that ends up as an item
    // nobody can buy and nobody can wear.
    if (!Number.isInteger(amount) || amount < 1 || amount > 10_000_000) {
      res.status(400).json({ error: "A price is between 1 and 1,00,00,000 — use Free to make it free" });
      return;
    }
  }

  if (currency !== null && !item.priceable) {
    res.status(400).json({ error: `That cannot be priced — ${item.why ?? "it is not something a player owns"}` });
    return;
  }

  const before = (await listPrices()).find((p) => p.itemId === itemId) ?? null;
  await setItemPrice(itemId, item.kind, currency, amount, req.admin!.email);

  await audit(req.admin!, {
    action: "pricing.set",
    targetType: "platform",
    targetId: itemId,
    before: before ? { currency: before.currency, price: before.price } : { currency: null, price: 0 },
    after: { currency, price: currency === null ? 0 : amount },
    ip: requestOrigin(req).ip,
  });
  logEvent({
    type: "pricing.set",
    data: { by: req.admin!.email, itemId, currency, price: currency === null ? 0 : amount },
  });
  res.json({ ok: true });
});

/** Give one player one item — a prize, or putting something right. */
pricingRouter.post("/players/:uid/items", requireAdmin("admin"), requireSudo, async (req, res) => {
  const itemId = String((req.body ?? {}).itemId ?? "");
  const note = String((req.body ?? {}).note ?? "").trim().slice(0, 200);
  if (!catalogIndex().some((i) => i.id === itemId)) {
    res.status(404).json({ error: "No such item in the collection" });
    return;
  }
  if (!note) {
    res.status(400).json({ error: "Say why — a grant nobody can account for later is worse than none" });
    return;
  }
  const user = await getUserByUid(String(req.params.uid));
  if (!user) {
    res.status(404).json({ error: "No such player" });
    return;
  }
  const given = await grantItem(user.id, itemId, note);
  await audit(req.admin!, {
    action: "pricing.grant",
    targetType: "user",
    targetId: user.uid,
    reason: note,
    after: { itemId, given },
    ip: requestOrigin(req).ip,
  });
  res.json({ ok: true, given });
});

/** What one player has acquired — the collection half of their page. */
pricingRouter.get("/players/:uid/items", requireAdmin("support"), async (req, res) => {
  const user = await getUserByUid(String(req.params.uid));
  if (!user) {
    res.status(404).json({ error: "No such player" });
    return;
  }
  res.json({ items: await itemsOwnedBy(user.id) });
});

// ---------------------------------------------------------------------------
// Orders — who took what, and what it cost them
// ---------------------------------------------------------------------------

/** A window with sane ends. A missing side means "as far as anyone would want
 *  to look" rather than a 400 — a filter that refuses to work until it is
 *  fully filled in is a filter nobody uses. */
function windowOf(q: Record<string, unknown>): { from: Date; to: Date } {
  const parse = (v: unknown, fallback: number): Date => {
    const d = new Date(String(v ?? ""));
    return Number.isNaN(d.getTime()) ? new Date(fallback) : d;
  };
  const to = parse(q.to, Date.now() + 60_000);
  const from = parse(q.from, to.getTime() - 7 * 24 * 3600_000);
  return { from, to };
}

pricingRouter.get("/orders", requireAdmin("support"), async (req, res) => {
  const q = req.query as Record<string, unknown>;
  const { from, to } = windowOf(q);
  const out = await listOrders({
    from,
    to,
    currency: String(q.currency ?? "") || undefined,
    who: String(q.who ?? "").trim() || undefined,
    limit: Number(q.limit ?? 60),
    cursor: q.cursor ? String(q.cursor) : null,
  });
  res.json({ ...out, from: from.toISOString(), to: to.toISOString() });
});

/** The strip above the table, and what actually sells. */
pricingRouter.get("/orders/totals", requireAdmin("support"), async (req, res) => {
  const { from, to } = windowOf(req.query as Record<string, unknown>);
  const [totals, top] = await Promise.all([orderTotals(from, to), topItems(from, to)]);
  res.json({ ...totals, top, from: from.toISOString(), to: to.toISOString() });
});
