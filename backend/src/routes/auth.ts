import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import { config } from "../config.js";
import { requireAuth, signToken } from "../middleware/auth.js";
import { getUserById, toPublicUser, upsertGoogleUser } from "../services/users.js";

export const authRouter = Router();
const googleClient = new OAuth2Client(config.googleClientIds[0]);

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
    const token = signToken({ userId: user.id, uid: user.uid, name: user.name });
    res.json({ token, user: toPublicUser(user) });
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
  res.json({ user: toPublicUser(user) });
});
