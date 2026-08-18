import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import { config } from "../config.js";
import { requireAuth, signToken } from "../middleware/auth.js";
import { logEvent } from "../services/eventLog.js";
import { requestOrigin } from "../services/clientIp.js";
import { displayName, getUserById, toPublicUser, upsertGoogleUser, type UserRow } from "../services/users.js";
import {
  claimGeneratedUsername,
  claimUsername,
  isUsernameTaken,
  validateUsername,
  type ClaimResult,
} from "../services/username.js";

export const authRouter = Router();
const googleClient = new OAuth2Client(config.googleClientIds[0]);

/** The JWT carries the display name, so it must be (re)signed whenever that
 *  could have changed — at login and after a username claim. */
function sessionFor(user: UserRow) {
  return {
    token: signToken({ userId: user.id, uid: user.uid, name: displayName(user) }),
    user: toPublicUser(user),
    // Steers the client to the claim screen before the lobby. The socket
    // handshake enforces the same rule server-side.
    needsUsername: !user.username,
  };
}

/** Frontend sends the Google ID token (credential); we verify it,
 *  upsert the user in Postgres, and return our own JWT. */
authRouter.post("/google", async (req, res) => {
  try {
    const { credential } = req.body as { credential?: string };
    if (!credential) {
      res.status(400).json({ error: "Missing credential" });
      return;
    }
    // Accepts tokens from the web app AND (later) native Android/iOS apps —
    // just add their client IDs to GOOGLE_CLIENT_ID, comma-separated.
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: config.googleClientIds,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      res.status(401).json({ error: "Invalid Google token" });
      return;
    }
    const user = await upsertGoogleUser({
      googleId: payload.sub,
      email: payload.email,
      name: payload.name || payload.email.split("@")[0],
      avatarUrl: payload.picture,
    });
    // The first row of the session trail. Buffered, so this costs the sign-in
    // nothing — see services/eventLog.ts.
    const origin = requestOrigin(req);
    logEvent({
      type: "auth.login",
      userId: user.id,
      uid: user.uid,
      ip: origin.ip,
      ipCountry: origin.country,
      ua: origin.ua,
      data: { newAccount: user.createdAt.getTime() === user.lastLoginAt.getTime() },
    });
    res.json(sessionFor(user));
  } catch (err) {
    console.error("Google auth failed:", err);
    res.status(401).json({ error: "Google sign-in failed" });
  }
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await getUserById(req.auth!.userId);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({ user: toPublicUser(user), needsUsername: !user.username });
});

/** Live availability probe for the claim screen (debounced client-side; one
 *  index-only lookup per call). Never authoritative — the claim itself is. */
authRouter.get("/username/check", requireAuth, async (req, res) => {
  try {
    const raw = typeof req.query.u === "string" ? req.query.u : "";
    const checked = validateUsername(raw);
    if (!checked.ok) {
      res.json({ available: false, reason: checked.error });
      return;
    }
    res.json({ available: !(await isUsernameTaken(checked.username)) });
  } catch (err) {
    console.error("Username check failed:", err);
    res.status(500).json({ error: "Check failed" });
  }
});

/** Claim the in-game username — once. `skip: true` auto-generates one from
 *  the Google profile name instead. Returns a fresh session (the JWT carries
 *  the display name). */
authRouter.post("/username", requireAuth, async (req, res) => {
  try {
    const { username: rawUsername, skip } = (req.body ?? {}) as { username?: unknown; skip?: unknown };

    let result: ClaimResult;
    if (skip === true) {
      const me = await getUserById(req.auth!.userId);
      if (!me) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      result = await claimGeneratedUsername(me.id, me.name);
    } else {
      const checked = validateUsername(rawUsername);
      if (!checked.ok) {
        res.status(400).json({ error: checked.error });
        return;
      }
      result = await claimUsername(req.auth!.userId, checked.username);
    }

    if (result.error === "taken") {
      res.status(409).json({ error: "That name is already taken" });
      return;
    }
    if (result.error === "already-set") {
      // Another tab/device won the claim — not an error worth blocking on;
      // the client refetches /me and moves on with the existing name.
      res.status(409).json({ error: "Your username is already set", code: "USERNAME_ALREADY_SET" });
      return;
    }
    if (result.error === "not-found" || !result.user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(sessionFor(result.user));
  } catch (err) {
    console.error("Username claim failed:", err);
    res.status(500).json({ error: "Could not set username" });
  }
});
