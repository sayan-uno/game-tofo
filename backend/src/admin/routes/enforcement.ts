// Doing something about it.
//
// Everything here is behind SUDO — a fresh authenticator code — because these
// are the actions that cannot be quietly undone: a ban is felt by a real person
// within a second, and a console left open on a stolen laptop must not be able
// to hand one out.
//
// Three things happen for every sanction, in this order, and the order matters:
//   1. the record is written (Postgres), which is what makes it evidence;
//   2. the enforcement cache is rebuilt (Redis), which is what makes it real;
//   3. the live session is interrupted (ops channel), which is what makes it
//      immediate rather than "from their next connection".
// Steps 1 and 2 are applySanction. Step 3 is here, because only this layer
// knows that a ban should hang up a socket and a voice mute should not.
import { safeRouter } from "../asyncRouter.js";
import { and, desc, eq, isNull, or, gt, sql, inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { sanctions, users } from "../../db/schema.js";
import { requestOrigin } from "../../services/clientIp.js";
import { applySanction, isSanctionType, liftSanction, SANCTION_TYPES } from "../../services/sanctions.js";
import { sendOpsCommand } from "../../platform/opsCommands.js";
import { clearMaintenance, getFlags, MAINTENANCE_LEAD_MS, setFlags } from "../../platform/flags.js";
import { deleteNotice, listNotices, sendNotice } from "../../services/notices.js";
import { onlineUserIds } from "../../redis.js";
import {
  hideGame,
  showGame,
  withdrawItem,
  restoreItem,
  withdrawnItems,
  banFromGame,
  bannedFrom,
  gameBanReason,
  gameHeld,
  heldGames,
  holdGame,
  releaseGame,
  unbanFromGame,
} from "../../platform/gameLocks.js";
import { listGames } from "../../platform/games.js";
import { defaultCharacterId, publicCatalog } from "../../services/catalog.js";
import { requireAdmin, requireSudo } from "../guard.js";
import { audit } from "../audit.js";
import { logEvent } from "../../services/eventLog.js";
import { alert } from "../alerts.js";

export const enforcementRouter = safeRouter();

/** The longest a moderator may act alone. Anything beyond this — and anything
 *  permanent — is an admin's decision, because it is the one that a player
 *  cannot simply wait out. */
const MODERATOR_MAX_MINUTES = 30 * 24 * 60;

const label = (t: string) =>
  ({ ban: "banned", match: "barred from matches", voice: "voice muted", chat: "chat muted", "shadow-chat": "shadow muted" })[t] ?? t;

// ---- apply ----------------------------------------------------------------

enforcementRouter.post("/players/:uid/sanctions", requireAdmin("moderator"), requireSudo, async (req, res) => {
  const { type, reason, note, minutes } = (req.body ?? {}) as Record<string, unknown>;
  if (!isSanctionType(type)) {
    res.status(400).json({ error: `Type must be one of: ${SANCTION_TYPES.join(", ")}` });
    return;
  }
  if (typeof reason !== "string" || reason.trim().length < 3) {
    res.status(400).json({ error: "Give a reason — the player is shown it, and so is the audit trail" });
    return;
  }
  const permanent = minutes === null || minutes === undefined;
  const mins = permanent ? null : Number(minutes);
  if (!permanent && (!Number.isFinite(mins) || mins! < 1)) {
    res.status(400).json({ error: "Duration must be at least a minute, or leave it out for permanent" });
    return;
  }
  const senior = req.admin!.role === "admin" || req.admin!.role === "owner";
  if (!senior && (permanent || mins! > MODERATOR_MAX_MINUTES)) {
    res.status(403).json({
      error: "A moderator can act for up to 30 days. Anything longer is an admin's decision.",
      code: "FORBIDDEN",
    });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.uid, req.params.uid));
  if (!user) {
    res.status(404).json({ error: "No player with that UID" });
    return;
  }

  const expiresAt = permanent ? null : new Date(Date.now() + mins! * 60_000);
  const { id } = await applySanction({
    userId: user.id,
    uid: user.uid,
    type,
    reason: reason.trim(),
    note: typeof note === "string" && note.trim() ? note.trim() : null,
    expiresAt,
    createdBy: req.admin!.id,
    evidence: { by: req.admin!.email },
  });

  // Step 3: make it immediate. A ban hangs the socket up; a voice mute takes
  // the permission away from a player who may be talking this second. The
  // other kinds are checked on their next action anyway, so they need nothing.
  let live: unknown = null;
  if (type === "ban") {
    live = await sendOpsCommand("disconnect", { userId: user.id, reason: reason.trim() }, { by: req.admin!.email });
  } else if (type === "voice") {
    live = await sendOpsCommand("silence", { userId: user.id, uid: user.uid }, { by: req.admin!.email });
  }

  await audit(req.admin!, {
    action: "sanction.apply",
    targetType: "user",
    targetId: user.uid,
    reason: reason.trim(),
    after: { sanctionId: id, type, until: expiresAt?.toISOString() ?? "permanent" },
    ip: requestOrigin(req).ip,
  });
  alert(
    `🚫 TOFO: ${user.username ?? user.uid} ${label(type)} ${permanent ? "permanently" : `for ${mins} min`}\n` +
      `by ${req.admin!.email}\nreason: ${reason.trim()}`
  );
  res.json({ ok: true, id, appliedLive: live !== null });
});

// ---- lift -----------------------------------------------------------------

enforcementRouter.delete("/sanctions/:id", requireAdmin("moderator"), requireSudo, async (req, res) => {
  const [row] = await db.select().from(sanctions).where(eq(sanctions.id, req.params.id));
  if (!row) {
    res.status(404).json({ error: "No such sanction" });
    return;
  }
  const { reason } = (req.body ?? {}) as { reason?: unknown };
  const lifted = await liftSanction(row.id, req.admin!.id);
  if (!lifted) {
    res.status(409).json({ error: "That sanction was already lifted" });
    return;
  }
  const [user] = await db.select().from(users).where(eq(users.id, row.userId));
  await audit(req.admin!, {
    action: "sanction.lift",
    targetType: "user",
    targetId: user?.uid ?? row.userId,
    reason: typeof reason === "string" ? reason : null,
    before: { sanctionId: row.id, type: row.type },
    ip: requestOrigin(req).ip,
  });
  alert(`✅ TOFO: ${user?.username ?? row.userId} — ${label(row.type)} lifted by ${req.admin!.email}`);
  res.json({ ok: true });
});

// ---- what is currently in force -------------------------------------------

enforcementRouter.get("/sanctions", requireAdmin("moderator"), async (_req, res) => {
  const rows = await db
    .select({
      id: sanctions.id,
      type: sanctions.type,
      reason: sanctions.reason,
      createdAt: sanctions.createdAt,
      expiresAt: sanctions.expiresAt,
      uid: users.uid,
      username: users.username,
    })
    .from(sanctions)
    .innerJoin(users, eq(users.id, sanctions.userId))
    .where(
      and(
        isNull(sanctions.revokedAt),
        or(isNull(sanctions.expiresAt), gt(sanctions.expiresAt, sql`now()`))
      )
    )
    .orderBy(desc(sanctions.createdAt))
    .limit(100);
  res.json({ sanctions: rows });
});

// ---- notices --------------------------------------------------------------
//
// A record, not a broadcast. One send is one row whoever it reached, which is
// what makes taking it back an undo rather than an afternoon's work.

enforcementRouter.get("/notices", requireAdmin("moderator"), async (_req, res) => {
  res.json({ notices: await listNotices() });
});

enforcementRouter.post("/notices", requireAdmin("admin"), requireSudo, async (req, res) => {
  const { body, audience, uids } = (req.body ?? {}) as Record<string, unknown>;
  const text = typeof body === "string" ? body.trim().slice(0, 300) : "";
  if (text.length < 3) {
    res.status(400).json({ error: "Write something first" });
    return;
  }
  const kind = audience === "everyone" || audience === "players" ? audience : "online";

  // Resolve WHO, now, so the record says what actually happened rather than
  // "whoever happened to be connected" — which is unanswerable a day later.
  let to: string[] = [];
  if (kind === "players") {
    const asked = String(uids ?? "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean)
      .slice(0, 200);
    if (asked.length === 0) {
      res.status(400).json({ error: "Which players? Give at least one UID" });
      return;
    }
    const rows = asked.length ? await db.select({ uid: users.uid }).from(users).where(inArray(users.uid, asked)) : [];
    to = rows.map((r) => r.uid);
    if (to.length === 0) {
      res.status(404).json({ error: "None of those UIDs is a player" });
      return;
    }
  } else if (kind === "online") {
    // The set holds internal ids; the record wants UIDs.
    const ids = await onlineUserIds();
    const rows = ids.length ? await db.select({ uid: users.uid }).from(users).where(inArray(users.id, ids)) : [];
    to = rows.map((r) => r.uid);
    if (to.length === 0) {
      res.status(400).json({ error: "Nobody is online to receive it" });
      return;
    }
  }

  const row = await sendNotice({ body: text, audience: kind, uids: to, sentBy: req.admin!.email });
  // Pushed to whoever is connected, so it lands now rather than on their next
  // sign-in. The stored row is what makes it readable later, and what makes it
  // reach the people who were not here.
  await sendOpsCommand(
    "broadcast",
    { message: text, level: "info", uids: kind === "everyone" ? [] : to, noticeId: row.id },
    { by: req.admin!.email }
  );
  await audit(req.admin!, {
    action: "notice.send",
    targetType: "platform",
    targetId: row.id,
    after: { audience: kind, recipients: kind === "everyone" ? "all" : to.length, body: text },
    ip: requestOrigin(req).ip,
  });
  logEvent({ type: "notice.send", data: { id: row.id, audience: kind, to: to.length, by: req.admin!.email } });
  res.json({ notice: row });
});

enforcementRouter.delete("/notices/:id", requireAdmin("admin"), requireSudo, async (req, res) => {
  const gone = await deleteNotice(String(req.params.id), req.admin!.email);
  if (!gone) {
    res.status(404).json({ error: "No such notice, or it is already deleted" });
    return;
  }
  // Off every player's list, live. The stored row already stops it reaching
  // anybody who was offline; this is for the people looking at it right now.
  await sendOpsCommand("noticeGone", { noticeId: String(req.params.id) }, { by: req.admin!.email });
  await audit(req.admin!, {
    action: "notice.delete",
    targetType: "platform",
    targetId: String(req.params.id),
    ip: requestOrigin(req).ip,
  });
  logEvent({ type: "notice.delete", data: { id: String(req.params.id), by: req.admin!.email } });
  res.json({ ok: true });
});

// ---- holding a game -------------------------------------------------------
//
// Narrower than maintenance mode, which stops the whole platform, and narrower
// again for one player. Matches already running are never touched: by the time
// a hold goes on, the damage is in the matches about to start.

enforcementRouter.get("/games", requireAdmin("moderator"), async (_req, res) => {
  const held = new Map((await heldGames()).map((h) => [h.gameId, h.reason]));
  const games = listGames();
  // Everyone barred, with their names — a list of raw ids is a list nobody can
  // act on without looking every one of them up.
  const banned = await Promise.all(games.map((g) => bannedFrom(g.id)));
  const ids = [...new Set(banned.flat().map((b) => b.userId))];
  const rows = ids.length
    ? await db.select({ id: users.id, uid: users.uid, username: users.username }).from(users).where(inArray(users.id, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  res.json({
    games: games.map((g, i) => ({
      id: g.id,
      name: g.name,
      heldReason: held.get(g.id) ?? null,
      banned: banned[i].map((b) => ({
        uid: byId.get(b.userId)?.uid ?? null,
        username: byId.get(b.userId)?.username ?? null,
        reason: b.reason,
      })),
    })),
  });
});

enforcementRouter.post("/games/:gameId/hide", requireAdmin("admin"), requireSudo, async (req, res) => {
  const gameId = String(req.params.gameId);
  if (!listGames().some((g) => g.id === gameId)) {
    res.status(404).json({ error: "No such game" });
    return;
  }
  const on = (req.body ?? {}).on === true;
  if (on) await hideGame(gameId);
  else await showGame(gameId);
  await audit(req.admin!, {
    action: on ? "game.hide" : "game.show",
    targetType: "platform",
    targetId: gameId,
    ip: requestOrigin(req).ip,
  });
  logEvent({ type: on ? "game.hide" : "game.show", gameId, data: { by: req.admin!.email } });
  res.json({ ok: true });
});

// ---- the collection -------------------------------------------------------
//
// Withdrawing an item, not deleting it. It stays in the code and in the
// bucket; it simply stops being offered and stops being accepted.

enforcementRouter.get("/collection", requireAdmin("moderator"), async (_req, res) => {
  const gone = new Set(await withdrawnItems());
  const cat = publicCatalog();
  const rows = [
    ...cat.characters.map((c) => ({ ...c, kind: "character" as const })),
    ...cat.weapons.map((w) => ({ ...w, kind: "weapon" as const })),
    ...cat.emotes.map((e) => ({ ...e, kind: "emote" as const })),
  ];
  res.json({
    items: rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, withdrawn: gone.has(r.id) })),
  });
});

enforcementRouter.post("/collection/:id", requireAdmin("admin"), requireSudo, async (req, res) => {
  const id = String(req.params.id);
  const cat = publicCatalog();
  const known = [...cat.characters, ...cat.weapons, ...cat.emotes].some((x) => x.id === id);
  if (!known) {
    res.status(404).json({ error: "No such item" });
    return;
  }
  const on = (req.body ?? {}).on === true;
  // The default character is what a withdrawn one falls back TO. Withdrawing
  // it would leave every player resolving to something that is itself
  // withdrawn — an empty pedestal for the whole platform, fixable only from a
  // database.
  if (on && id === defaultCharacterId()) {
    res.status(400).json({ error: "That is the default everyone falls back to — it cannot be withdrawn" });
    return;
  }
  if (on) await withdrawItem(id);
  else await restoreItem(id);
  await audit(req.admin!, {
    action: on ? "collection.withdraw" : "collection.restore",
    targetType: "platform",
    targetId: id,
    ip: requestOrigin(req).ip,
  });
  logEvent({ type: on ? "collection.withdraw" : "collection.restore", data: { item: id, by: req.admin!.email } });
  res.json({ ok: true });
});

enforcementRouter.post("/games/:gameId/hold", requireAdmin("admin"), requireSudo, async (req, res) => {
  const gameId = String(req.params.gameId);
  if (!listGames().some((g) => g.id === gameId)) {
    res.status(404).json({ error: "No such game" });
    return;
  }
  const { on, reason } = (req.body ?? {}) as { on?: unknown; reason?: unknown };
  const why = typeof reason === "string" ? reason.trim().slice(0, 200) : "";
  if (on === true && why.length < 4) {
    res.status(400).json({ error: "Say why it is being held — players are shown this" });
    return;
  }
  const before = await gameHeld(gameId);
  if (on === true) await holdGame(gameId, why);
  else await releaseGame(gameId);
  await audit(req.admin!, {
    action: on === true ? "game.hold" : "game.release",
    targetType: "platform",
    targetId: gameId,
    before: { heldReason: before },
    after: { heldReason: on === true ? why : null },
    ip: requestOrigin(req).ip,
  });
  // …and into the activity log, which is the one an admin reads backwards from
  // "why could nobody start this at four o'clock".
  logEvent({
    type: on === true ? "game.hold" : "game.release",
    gameId,
    data: { reason: on === true ? why : null, by: req.admin!.email },
  });
  res.json({ ok: true, heldReason: on === true ? why : null });
});

enforcementRouter.post("/games/:gameId/ban", requireAdmin("admin"), requireSudo, async (req, res) => {
  const gameId = String(req.params.gameId);
  if (!listGames().some((g) => g.id === gameId)) {
    res.status(404).json({ error: "No such game" });
    return;
  }
  const { uid, on, reason } = (req.body ?? {}) as { uid?: unknown; on?: unknown; reason?: unknown };
  const [target] = await db.select().from(users).where(eq(users.uid, String(uid ?? "")));
  if (!target) {
    res.status(404).json({ error: "Player not found" });
    return;
  }
  const why = typeof reason === "string" ? reason.trim().slice(0, 200) : "";
  if (on === true && why.length < 4) {
    res.status(400).json({ error: "Say why — this player is shown it when they try to play" });
    return;
  }
  const before = await gameBanReason(gameId, target.id);
  if (on === true) await banFromGame(gameId, target.id, why);
  else await unbanFromGame(gameId, target.id);
  await audit(req.admin!, {
    action: on === true ? "game.ban" : "game.unban",
    targetType: "user",
    targetId: target.id,
    before: { game: gameId, reason: before },
    after: { game: gameId, reason: on === true ? why : null },
    ip: requestOrigin(req).ip,
  });
  // Against the PLAYER, the way a sanction is. It belongs on their page and in
  // the global log: somebody asking "why can this account not play Ludo" is
  // asking from the player's side, and the audit trail is indexed by admin.
  logEvent({
    type: on === true ? "game.ban" : "game.unban",
    userId: target.id,
    uid: target.uid,
    gameId,
    data: { reason: on === true ? why : null, by: req.admin!.email },
  });
  res.json({ ok: true });
});

// ---- platform switches ----------------------------------------------------

enforcementRouter.get("/platform", requireAdmin("moderator"), async (_req, res) => {
  res.json({ flags: await getFlags() });
});

enforcementRouter.post("/platform", requireAdmin("admin"), requireSudo, async (req, res) => {
  const { maintenance, maintenanceAt, maintenanceMessage, notice, uids, includeOffline } = (req.body ?? {}) as Record<
    string,
    unknown
  >;
  const before = await getFlags();

  // ---- scheduling a window -------------------------------------------------
  //
  // Announced ahead of time, never sprung. A player halfway through a match
  // has done nothing to deserve losing it without warning, and a party about
  // to start one deserves the chance not to.
  if (maintenanceAt !== undefined) {
    const at = Number(maintenanceAt) || 0;
    if (at > 0) {
      const notice = at - Date.now();
      if (notice < MAINTENANCE_LEAD_MS) {
        res.status(400).json({
          error: `Schedule it at least ${Math.round(MAINTENANCE_LEAD_MS / 60_000)} minutes ahead, so people can finish what they are doing`,
          code: "TOO_SOON",
        });
        return;
      }
      const why = typeof maintenanceMessage === "string" ? maintenanceMessage.trim().slice(0, 200) : "";
      if (why.length < 4) {
        res.status(400).json({ error: "Say what is happening — every player is shown this" });
        return;
      }
      const flags = await setFlags({ maintenanceAt: at, maintenanceMessage: why, maintenance: false });
      // Everybody online is told NOW, not when it starts.
      await sendOpsCommand("maintenance", { active: false, at, message: why }, { by: req.admin!.email });
      await audit(req.admin!, {
        action: "platform.maintenanceScheduled",
        targetType: "platform",
        before,
        after: flags,
        ip: requestOrigin(req).ip,
      });
      logEvent({ type: "platform.maintenance", data: { at, message: why, by: req.admin!.email } });
      res.json({ flags });
      return;
    }
    // at === 0 → the window is called off, or maintenance is over.
    const flags = await clearMaintenance();
    await sendOpsCommand("maintenance", { active: false, at: 0, message: "" }, { by: req.admin!.email });
    await audit(req.admin!, {
      action: "platform.maintenanceCleared",
      targetType: "platform",
      before,
      after: flags,
      ip: requestOrigin(req).ip,
    });
    logEvent({ type: "platform.maintenance", data: { at: 0, by: req.admin!.email } });
    res.json({ flags });
    return;
  }

  const flags = await setFlags({
    maintenance: typeof maintenance === "boolean" ? maintenance : undefined,
    maintenanceMessage: typeof maintenanceMessage === "string" ? maintenanceMessage.slice(0, 200) : undefined,
  });

  // Turning it on by hand, with no window: everybody is held immediately and
  // every match ends. A different act from scheduling one, and it reads
  // differently in the record.
  if (maintenance === true) {
    await sendOpsCommand(
      "maintenance",
      { active: true, at: Date.now(), message: flags.maintenanceMessage },
      { by: req.admin!.email }
    );
  } else if (maintenance === false) {
    await clearMaintenance();
    await sendOpsCommand("maintenance", { active: false, at: 0, message: "" }, { by: req.admin!.email });
  }

  void notice;
  void uids;
  void includeOffline;
  await audit(req.admin!, {
    action: "platform.update",
    targetType: "platform",
    before,
    after: flags,
    ip: requestOrigin(req).ip,
  });
  if (before.maintenance !== flags.maintenance) {
    alert(`${flags.maintenance ? "🛑" : "▶️"} TOFO: maintenance mode ${flags.maintenance ? "ON" : "off"} — by ${req.admin!.email}`);
  }
  res.json({ flags });
});
