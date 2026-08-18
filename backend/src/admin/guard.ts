// What every console request has to get past.
//
// Four gates, in order, each independent of the others:
//
//   1. CORS      — exactly one origin may call this API, with credentials.
//   2. Cloudflare— when configured, the request must carry an assertion
//                  Cloudflare signed. Not configured is allowed (you may not
//                  have set it up yet) but it says so loudly at boot.
//   3. Session   — a short-lived access token, checked against a session row
//                  that can be revoked, and against an account that can be
//                  disabled. Both take effect on the NEXT request, not in
//                  twenty minutes.
//   4. Role      — least privilege, and a role change applies immediately
//                  because it is read from the database rather than the token.
//
// The two extra queries per request are deliberate. Console traffic is a few
// requests a minute; instant revocation is worth far more than saving them.
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import { config } from "../config.js";
import { redis } from "../redis.js";
import { getAdminById, outranks, type AdminRole } from "./accounts.js";
import { sessionLive, verifyAccess } from "./session.js";
import { cfAccessConfigured, HEADER, verifyAssertion } from "./cfAccess.js";

export interface AdminIdentity {
  id: string;
  email: string;
  role: AdminRole;
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminIdentity;
    }
  }
}

/** Answering 404 rather than 401 keeps the console from confirming it exists
 *  to anyone poking at it. The one place that says more is the sign-in flow,
 *  which has to be able to tell you your code was wrong. */
const hide = (res: Response) => res.status(404).json({ error: "Not found" });

export const adminCors = () =>
  cors({
    origin: config.admin.origin,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Request"],
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });

/** Gate 2. Mounted in front of everything, sign-in included. */
export async function cloudflareGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!cfAccessConfigured()) return next();
  const assertion = await verifyAssertion(req.header(HEADER) ?? undefined);
  if (!assertion) {
    hide(res);
    return;
  }
  // Recorded for the audit trail: which identity Cloudflare vouched for, which
  // is not necessarily the one the app then authenticates.
  res.locals.cfEmail = assertion.email;
  next();
}

/** Gates 3 and 4. */
export function requireAdmin(minRole: AdminRole = "analyst") {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const claims = token ? verifyAccess(token) : null;
    if (!claims) {
      res.status(401).json({ error: "Not signed in", code: "NO_SESSION" });
      return;
    }
    if (!(await sessionLive(claims.sid))) {
      res.status(401).json({ error: "Session ended", code: "NO_SESSION" });
      return;
    }
    // Read from the database, not the token: disabling an account or dropping
    // someone's role has to bite now, not when their token happens to expire.
    const admin = await getAdminById(claims.sub);
    if (!admin || admin.status !== "active") {
      res.status(401).json({ error: "Session ended", code: "NO_SESSION" });
      return;
    }
    if (!outranks(admin.role, minRole)) {
      res.status(403).json({ error: "Your role does not allow that", code: "FORBIDDEN" });
      return;
    }
    req.admin = { id: admin.id, email: admin.email, role: admin.role as AdminRole, sessionId: claims.sid };
    next();
  };
}

// ---------------------------------------------------------------------------
// Sudo: a fresh authenticator code buys a few minutes for the irreversible
// things. A stolen laptop with the console already open can then read, but not
// ban anyone, not start a recording, and not download evidence.
//
// In Redis rather than the session row because it is meant to expire on its
// own and never to be forgotten about.
// ---------------------------------------------------------------------------
const sudoKey = (sessionId: string) => `admin:sudo:${sessionId}`;

export async function grantSudo(sessionId: string): Promise<number> {
  const seconds = config.admin.sudoTtlMin * 60;
  await redis.set(sudoKey(sessionId), "1", "EX", seconds);
  return seconds;
}

export const sudoActive = async (sessionId: string): Promise<boolean> =>
  (await redis.get(sudoKey(sessionId))) === "1";

export const dropSudo = (sessionId: string): Promise<number> => redis.del(sudoKey(sessionId));

export async function requireSudo(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.admin) {
    res.status(401).json({ error: "Not signed in", code: "NO_SESSION" });
    return;
  }
  if (!(await sudoActive(req.admin.sessionId))) {
    res.status(403).json({ error: "Confirm with your authenticator code first", code: "SUDO_REQUIRED" });
    return;
  }
  next();
}
