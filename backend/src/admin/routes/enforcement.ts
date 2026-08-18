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
import { and, desc, eq, isNull, or, gt, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { sanctions, users } from "../../db/schema.js";
import { requestOrigin } from "../../services/clientIp.js";
import { applySanction, isSanctionType, liftSanction, SANCTION_TYPES } from "../../services/sanctions.js";
import { sendOpsCommand } from "../../platform/opsCommands.js";
import { getFlags, setFlags } from "../../platform/flags.js";
import { requireAdmin, requireSudo } from "../guard.js";
import { audit } from "../audit.js";
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

// ---- platform switches ----------------------------------------------------

enforcementRouter.get("/platform", requireAdmin("moderator"), async (_req, res) => {
  res.json({ flags: await getFlags() });
});

enforcementRouter.post("/platform", requireAdmin("admin"), requireSudo, async (req, res) => {
  const { maintenance, maintenanceMessage, notice } = (req.body ?? {}) as Record<string, unknown>;
  const before = await getFlags();
  const flags = await setFlags({
    maintenance: typeof maintenance === "boolean" ? maintenance : undefined,
    maintenanceMessage: typeof maintenanceMessage === "string" ? maintenanceMessage.slice(0, 200) : undefined,
    notice: typeof notice === "string" ? notice.slice(0, 300) : undefined,
  });

  // A notice is only useful if the people already online see it — the flag
  // alone would only reach whoever connects next.
  if (typeof notice === "string" && notice.trim()) {
    await sendOpsCommand("broadcast", { message: notice.trim(), level: "info" }, { by: req.admin!.email });
  }
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
