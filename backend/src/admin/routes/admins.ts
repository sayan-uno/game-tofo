// Managing the console's own accounts and sessions.
//
// Everything that changes who can do what is owner-only AND behind sudo — a
// fresh authenticator code — because privilege escalation is the most valuable
// thing an attacker with an open session could do. Every one of them is
// audited with a reason, and the alerts go out on a channel that is not this
// console.
import { safeRouter } from "../asyncRouter.js";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { adminUsers } from "../../db/schema.js";
import { requestOrigin } from "../../services/clientIp.js";
import { getAdminById, isAdminRole, listAdmins, replaceRecoveryCodes } from "../accounts.js";
import { hashPassword, verifyPassword } from "../crypto.js";
import { listSessions, revoke, revokeAll } from "../session.js";
import { requireAdmin, requireSudo } from "../guard.js";
import { audit } from "../audit.js";
import { alert } from "../alerts.js";

export const adminsRouter = safeRouter();

const view = (a: Awaited<ReturnType<typeof listAdmins>>[number]) => ({
  id: a.id,
  email: a.email,
  name: a.name,
  role: a.role,
  status: a.status,
  hasPassword: Boolean(a.passwordHash),
  totpEnrolled: Boolean(a.totpActivatedAt),
  createdAt: a.createdAt,
  lastLoginAt: a.lastLoginAt,
});

adminsRouter.get("/", requireAdmin("owner"), async (req, res) => {
  await audit(req.admin!, { action: "admin.list", ip: requestOrigin(req).ip });
  res.json({ admins: (await listAdmins()).map(view) });
});

adminsRouter.post("/", requireAdmin("owner"), requireSudo, async (req, res) => {
  const { email, name, role, reason } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof email !== "string" || !email.includes("@") || !isAdminRole(role)) {
    res.status(400).json({ error: "An email address and a valid role are required" });
    return;
  }
  const [row] = await db
    .insert(adminUsers)
    .values({
      email: email.trim().toLowerCase(),
      name: typeof name === "string" && name.trim() ? name.trim() : email.split("@")[0],
      role,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    res.status(409).json({ error: "That address already has an account" });
    return;
  }
  await audit(req.admin!, {
    action: "admin.create",
    targetType: "admin",
    targetId: row.id,
    reason: typeof reason === "string" ? reason : null,
    after: { email: row.email, role: row.role },
    ip: requestOrigin(req).ip,
  });
  alert(`👤 TOFO admin: ${req.admin!.email} added ${row.email} as ${row.role}`);
  // They enrol an authenticator on their first sign-in; nothing is sent here.
  res.json({ admin: view(row) });
});

adminsRouter.patch("/:id", requireAdmin("owner"), requireSudo, async (req, res) => {
  const target = await getAdminById(req.params.id);
  if (!target) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const { role, status, reason } = (req.body ?? {}) as Record<string, unknown>;
  if (role !== undefined && !isAdminRole(role)) {
    res.status(400).json({ error: "Unknown role" });
    return;
  }
  if (status !== undefined && status !== "active" && status !== "disabled") {
    res.status(400).json({ error: "Unknown status" });
    return;
  }
  // The last owner cannot be demoted or switched off. Otherwise one mistake
  // leaves a console nobody can administer.
  if ((role && role !== "owner") || status === "disabled") {
    const [{ owners }] = await db
      .select({ owners: sql<number>`count(*)::int` })
      .from(adminUsers)
      .where(sql`${adminUsers.role} = 'owner' and ${adminUsers.status} = 'active'`);
    if (target.role === "owner" && owners <= 1) {
      res.status(409).json({ error: "That is the only owner — promote someone else first" });
      return;
    }
  }

  const [updated] = await db
    .update(adminUsers)
    .set({
      ...(role ? { role } : {}),
      ...(status ? { status, disabledAt: status === "disabled" ? sql`now()` : null } : {}),
    })
    .where(eq(adminUsers.id, target.id))
    .returning();
  // A disabled or demoted admin must not keep acting on an open session.
  if (status === "disabled" || (role && role !== target.role)) await revokeAll(target.id);
  await audit(req.admin!, {
    action: "admin.update",
    targetType: "admin",
    targetId: target.id,
    reason: typeof reason === "string" ? reason : null,
    before: { role: target.role, status: target.status },
    after: { role: updated.role, status: updated.status },
    ip: requestOrigin(req).ip,
  });
  alert(`👤 TOFO admin: ${req.admin!.email} changed ${target.email} → ${updated.role}/${updated.status}`);
  res.json({ admin: view(updated) });
});

/** Their phone is gone. Clearing the secret sends them back through enrolment
 *  on the next sign-in — and ends every session they had, because whoever has
 *  the old phone must not keep one. */
adminsRouter.post("/:id/reset-authenticator", requireAdmin("owner"), requireSudo, async (req, res) => {
  const target = await getAdminById(req.params.id);
  if (!target) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db
    .update(adminUsers)
    .set({ totpSecretEnc: null, totpActivatedAt: null, totpLastStep: null })
    .where(eq(adminUsers.id, target.id));
  const ended = await revokeAll(target.id);
  await audit(req.admin!, {
    action: "admin.resetAuthenticator",
    targetType: "admin",
    targetId: target.id,
    reason: typeof (req.body ?? {}).reason === "string" ? (req.body as { reason: string }).reason : null,
    ip: requestOrigin(req).ip,
  });
  alert(`🔐 TOFO admin: ${req.admin!.email} reset the authenticator for ${target.email} (${ended} session(s) ended)`);
  res.json({ ok: true, sessionsEnded: ended });
});

// ---- my own account -------------------------------------------------------

adminsRouter.get("/me/sessions", requireAdmin(), async (req, res) => {
  const rows = await listSessions(req.admin!.id);
  res.json({
    sessions: rows.map((s) => ({
      id: s.id,
      ip: s.ip,
      ua: s.ua,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      current: s.id === req.admin!.sessionId,
    })),
  });
});

adminsRouter.delete("/me/sessions/:id", requireAdmin(), async (req, res) => {
  const mine = await listSessions(req.admin!.id);
  if (!mine.some((s) => s.id === req.params.id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await revoke(req.params.id);
  await audit(req.admin!, { action: "admin.session.revoke", targetType: "admin", targetId: req.params.id, ip: requestOrigin(req).ip });
  res.json({ ok: true });
});

/** Set or clear the optional password. Requires the current one to change it,
 *  and sudo either way — this is a factor being added or removed. */
adminsRouter.post("/me/password", requireAdmin(), requireSudo, async (req, res) => {
  const { current, next } = (req.body ?? {}) as { current?: string; next?: string | null };
  const me = await getAdminById(req.admin!.id);
  if (!me) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (me.passwordHash) {
    if (typeof current !== "string" || !(await verifyPassword(current, me.passwordHash))) {
      res.status(401).json({ error: "That password is not right" });
      return;
    }
  }
  if (next === null || next === "") {
    await db.update(adminUsers).set({ passwordHash: null }).where(eq(adminUsers.id, me.id));
    await audit(req.admin!, { action: "admin.password.clear", ip: requestOrigin(req).ip });
    alert(`🔐 TOFO admin: ${me.email} removed their password factor`);
    res.json({ ok: true, hasPassword: false });
    return;
  }
  if (typeof next !== "string" || next.length < 12) {
    res.status(400).json({ error: "Use at least 12 characters" });
    return;
  }
  await db.update(adminUsers).set({ passwordHash: await hashPassword(next) }).where(eq(adminUsers.id, me.id));
  await audit(req.admin!, { action: "admin.password.set", ip: requestOrigin(req).ip });
  alert(`🔐 TOFO admin: ${me.email} set a password factor`);
  res.json({ ok: true, hasPassword: true });
});

/** Fresh recovery codes, shown once. The old ones stop working immediately. */
adminsRouter.post("/me/recovery-codes", requireAdmin(), requireSudo, async (req, res) => {
  const codes = await replaceRecoveryCodes(req.admin!.id);
  await audit(req.admin!, { action: "admin.recoveryCodes.regenerate", ip: requestOrigin(req).ip });
  alert(`🔑 TOFO admin: ${req.admin!.email} regenerated their recovery codes`);
  res.json({ codes });
});
