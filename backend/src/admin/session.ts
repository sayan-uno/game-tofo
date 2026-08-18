// Console sessions: a short access token the browser holds in memory, and a
// long refresh token it never sees in JavaScript.
//
// The split is the point. Most admin-panel compromises are not logins — they
// are a token that outlived its usefulness. So the access token is minutes
// long and lives only in a variable, while the refresh token sits in an
// httpOnly cookie that a script cannot read even if one manages to run.
//
// Refresh tokens ROTATE: using one immediately invalidates it and issues a
// replacement. That turns theft into something detectable — if a token that
// has already been rotated is presented again, either the thief or the real
// admin is using a copy, and there is no way to tell which. The only safe
// answer is to end every session that admin has and say so out loud.
import { and, eq, isNull, sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { db } from "../db/client.js";
import { adminSessions } from "../db/schema.js";
import { config } from "../config.js";
import { newRefreshToken, sha256 } from "./crypto.js";
import { alert } from "./alerts.js";
import type { AdminRow } from "./accounts.js";

const AUD_ACCESS = "admin";
const AUD_PENDING = "admin-pending";
const ISSUER = "tofo-admin";

export interface AccessClaims {
  sub: string;
  email: string;
  role: string;
  /** Which session this token belongs to, so one device can be signed out. */
  sid: string;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  expiresInSec: number;
}

export async function issueSession(admin: AdminRow, ip: string | null, ua: string | null): Promise<IssuedSession> {
  const refreshToken = newRefreshToken();
  const expiresAt = new Date(Date.now() + config.admin.refreshTtlHours * 3600_000);
  const [row] = await db
    .insert(adminSessions)
    .values({ adminId: admin.id, refreshHash: sha256(refreshToken), ip, ua, expiresAt })
    .returning({ id: adminSessions.id });
  return {
    accessToken: signAccess({ sub: admin.id, email: admin.email, role: admin.role, sid: row.id }),
    refreshToken,
    sessionId: row.id,
    expiresInSec: config.admin.accessTtlMin * 60,
  };
}

function signAccess(claims: AccessClaims): string {
  return jwt.sign(claims, config.admin.jwtSecret, {
    audience: AUD_ACCESS,
    issuer: ISSUER,
    expiresIn: `${config.admin.accessTtlMin}m`,
  });
}

export function verifyAccess(token: string): AccessClaims | null {
  try {
    // The audience check is what makes a player token a forgery here rather
    // than merely the wrong shape.
    return jwt.verify(token, config.admin.jwtSecret, { audience: AUD_ACCESS, issuer: ISSUER }) as AccessClaims;
  } catch {
    return null;
  }
}

/** The ticket between "Google says it is you" and "you proved you have the
 *  phone". Useless as an access token — different audience, and every guard
 *  checks for the access one. */
export const signPending = (adminId: string, email: string, stage: string): string =>
  jwt.sign({ sub: adminId, email, stage }, config.admin.jwtSecret, {
    audience: AUD_PENDING,
    issuer: ISSUER,
    expiresIn: "5m",
  });

export function verifyPending(token: string): { sub: string; email: string; stage: string } | null {
  try {
    return jwt.verify(token, config.admin.jwtSecret, { audience: AUD_PENDING, issuer: ISSUER }) as {
      sub: string;
      email: string;
      stage: string;
    };
  } catch {
    return null;
  }
}

/** Is this session still allowed to act? Checked on EVERY admin request, so
 *  revoking one takes effect on the next click rather than in twenty minutes. */
export async function sessionLive(sessionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: adminSessions.id })
    .from(adminSessions)
    .where(
      and(
        eq(adminSessions.id, sessionId),
        isNull(adminSessions.revokedAt),
        sql`${adminSessions.expiresAt} > now()`
      )
    );
  if (!row) return false;
  // Cheap liveness for the sessions list; not awaited by the caller's answer.
  void db.update(adminSessions).set({ lastSeenAt: sql`now()` }).where(eq(adminSessions.id, sessionId));
  return true;
}

export type RotateResult =
  | { ok: true; session: IssuedSession }
  | { ok: false; reason: "unknown" | "reused" };

export async function rotate(
  refreshToken: string,
  admin: (id: string) => Promise<AdminRow | null>,
  ip: string | null,
  ua: string | null
): Promise<RotateResult> {
  const hash = sha256(refreshToken);
  const [row] = await db.select().from(adminSessions).where(eq(adminSessions.refreshHash, hash));
  if (!row) return { ok: false, reason: "unknown" };

  if (row.revokedAt || row.expiresAt.getTime() < Date.now()) {
    // A token that was already spent has been presented again. Either a thief
    // is using a stolen copy or the real admin is — and nothing here can tell
    // those apart, so both are ended.
    await revokeAll(row.adminId);
    alert(`⚠️ TOFO admin: a spent session token was reused — every session for that account has been ended.`);
    return { ok: false, reason: "reused" };
  }

  const who = await admin(row.adminId);
  if (!who || who.status !== "active") {
    await revokeAll(row.adminId);
    return { ok: false, reason: "unknown" };
  }
  await db.update(adminSessions).set({ revokedAt: sql`now()` }).where(eq(adminSessions.id, row.id));
  return { ok: true, session: await issueSession(who, ip, ua) };
}

export async function revoke(sessionId: string): Promise<void> {
  await db.update(adminSessions).set({ revokedAt: sql`now()` }).where(eq(adminSessions.id, sessionId));
}

export async function revokeAll(adminId: string): Promise<number> {
  const rows = await db
    .update(adminSessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(adminSessions.adminId, adminId), isNull(adminSessions.revokedAt)))
    .returning({ id: adminSessions.id });
  return rows.length;
}

export async function listSessions(adminId: string) {
  return db
    .select()
    .from(adminSessions)
    .where(and(eq(adminSessions.adminId, adminId), isNull(adminSessions.revokedAt)))
    .orderBy(sql`${adminSessions.lastSeenAt} desc`);
}
