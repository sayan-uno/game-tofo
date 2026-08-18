import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { getSanctions } from "../services/sanctions.js";

export interface AuthPayload {
  userId: string;
  uid: string;
  name: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: "30d" });
}

export function verifyToken(token: string): AuthPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as AuthPayload;
  } catch {
    return null;
  }
}

/** Verify the caller, and refuse a banned one.
 *
 *  The ban check is a single Redis GET against a key that only exists for
 *  sanctioned players — so for everyone else it is the cheapest thing Redis
 *  does, and it never touches Postgres. This is a cold path (profile, friends,
 *  chat); the game loop is nowhere near it. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = token ? verifyToken(token) : null;
  if (!payload) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const sanctions = await getSanctions(payload.userId);
  if (sanctions.ban) {
    res.status(403).json({ error: sanctions.ban.reason, code: "BANNED", until: sanctions.ban.until });
    return;
  }
  req.auth = payload;
  next();
}
