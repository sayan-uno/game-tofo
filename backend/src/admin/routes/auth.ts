// Signing in to the console.
//
// The chain, in order, each stage independent:
//
//   Google      proves the account — reusing the same verified-ID-token flow
//               the game already trusts, against an allowlist that lives in
//               the database rather than an env var.
//   Password    optional third factor, per admin. Its only job is covering a
//               takeover of the Google account itself.
//   Authenticator  proves possession of the phone, right now.
//
// Between the stages the client holds a PENDING token: five minutes, its own
// audience, and useless anywhere else — every guard demands the access
// audience, so a pending token cannot be waved at an endpoint.
//
// Two rules run through all of it. An unknown or disabled account gets the
// same 404 as a wrong path, so the console never confirms who its admins are.
// And every outcome — refused, locked out, signed in — is audited and alerted,
// because the console noticing its own break-in is the point.
import { safeRouter } from "../asyncRouter.js";
import { OAuth2Client } from "google-auth-library";
import { config } from "../../config.js";
import { requestOrigin } from "../../services/clientIp.js";
import { logEvent } from "../../services/eventLog.js";
import {
  activateTotp,
  consumeRecoveryCode,
  findAdminByEmail,
  getAdminById,
  noteLogin,
  noteTotpStep,
  replaceRecoveryCodes,
  setPendingTotp,
  type AdminRow,
} from "../accounts.js";
import { verifyPassword } from "../crypto.js";
import { checkCode, newEnrolment, qrFor } from "../totp.js";
import { issueSession, revoke, rotate, signPending, verifyPending } from "../session.js";
import { audit, auditAnonymous } from "../audit.js";
import { alert, who } from "../alerts.js";
import { dropSudo, grantSudo, requireAdmin, sudoActive } from "../guard.js";
import { clear, hit } from "../rateLimit.js";

export const authRouter = safeRouter();
const google = new OAuth2Client(config.googleClientIds[0]);

const REFRESH_COOKIE = "tofo_admin_rt";
/** Scoped to the session endpoints, so it is not attached to every call the
 *  console makes. SameSite=Lax is enough here because the console UI and this
 *  API are the same SITE (ports and subdomains do not change a site), and it
 *  keeps the cookie off genuine cross-site requests. */
const cookiePath = () => `/${config.admin.path}/session`;
const secureCookie = () => config.admin.origin.startsWith("https://");

function setRefreshCookie(res: import("express").Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(),
    path: cookiePath(),
    maxAge: config.admin.refreshTtlHours * 3600_000,
  });
}
const clearRefreshCookie = (res: import("express").Response) =>
  res.clearCookie(REFRESH_COOKIE, { path: cookiePath(), sameSite: "lax", secure: secureCookie(), httpOnly: true });

/** Express does not parse cookies and this is the only one we read. */
function readCookie(req: import("express").Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** What the client is asked for next. */
function stageFor(admin: AdminRow): "password" | "totp" | "enrol" {
  if (admin.passwordHash) return "password";
  return admin.totpSecretEnc && admin.totpActivatedAt ? "totp" : "enrol";
}

async function afterPassword(admin: AdminRow): Promise<"totp" | "enrol"> {
  return admin.totpSecretEnc && admin.totpActivatedAt ? "totp" : "enrol";
}

/** Build the enrolment payload AND park the secret on the account, unactivated.
 *  Unactivated matters: a mis-scanned QR must not be able to lock the only
 *  admin out of their own console, so nothing counts until one code works. */
async function beginEnrolment(admin: AdminRow) {
  const enrolment = newEnrolment(admin.email);
  await setPendingTotp(admin.id, enrolment.secretEnc);
  return { uri: enrolment.uri, secret: enrolment.secret, qr: await qrFor(enrolment.uri) };
}

// ---- stage 1: Google -------------------------------------------------------
authRouter.post("/google", async (req, res) => {
  const origin = requestOrigin(req);
  const { credential } = (req.body ?? {}) as { credential?: string };
  if (!credential) {
    res.status(400).json({ error: "Missing credential" });
    return;
  }
  const gate = await hit("google", origin.ip ?? "unknown", 20, 900);
  if (!gate.ok) {
    res.status(429).json({ error: "Too many attempts", retryAfter: gate.retryAfterSec });
    return;
  }
  let email: string;
  try {
    const ticket = await google.verifyIdToken({ idToken: credential, audience: config.googleClientIds });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.email_verified) throw new Error("unverified");
    email = payload.email.toLowerCase();
  } catch {
    res.status(401).json({ error: "Google sign-in failed" });
    return;
  }

  const admin = await findAdminByEmail(email);
  if (!admin || admin.status !== "active") {
    // Same answer a wrong path gets. The console does not confirm who its
    // admins are, and an attempt against it is worth knowing about.
    await auditAnonymous(email, { action: "admin.signin.refused", ip: origin.ip, reason: "not an admin" });
    alert(`⛔ TOFO admin: refused sign-in\n${who(email, origin.ip, origin.ua)}`);
    res.status(404).json({ error: "Not found" });
    return;
  }

  const stage = stageFor(admin);
  const pending = signPending(admin.id, admin.email, stage);
  const extra = stage === "enrol" ? await beginEnrolment(admin) : {};
  await audit({ id: admin.id, email: admin.email }, { action: "admin.signin.google", ip: origin.ip });
  res.json({ stage, pending, name: admin.name, ...extra });
});

// ---- stage 2 (optional): password -----------------------------------------
authRouter.post("/password", async (req, res) => {
  const origin = requestOrigin(req);
  const { pending, password } = (req.body ?? {}) as { pending?: string; password?: string };
  const claims = pending ? verifyPending(pending) : null;
  if (!claims || claims.stage !== "password" || typeof password !== "string") {
    res.status(401).json({ error: "Start again", code: "RESTART" });
    return;
  }
  const gate = await hit("password", claims.sub, 5, 900);
  if (!gate.ok) {
    alert(`⚠️ TOFO admin: password attempts exhausted\n${who(claims.email, origin.ip, origin.ua)}`);
    res.status(429).json({ error: "Too many attempts", retryAfter: gate.retryAfterSec });
    return;
  }
  const admin = await getAdminById(claims.sub);
  if (!admin || !admin.passwordHash || !(await verifyPassword(password, admin.passwordHash))) {
    await auditAnonymous(claims.email, { action: "admin.signin.badPassword", ip: origin.ip });
    res.status(401).json({ error: "That password is not right" });
    return;
  }
  await clear("password", claims.sub);
  const next = await afterPassword(admin);
  const extra = next === "enrol" ? await beginEnrolment(admin) : {};
  res.json({ stage: next, pending: signPending(admin.id, admin.email, next), ...extra });
});

// ---- stage 3: the authenticator -------------------------------------------
/** Shared by the "already enrolled" and "enrolling now" paths, because the
 *  code check is identical — only what happens afterwards differs. */
async function finishWithCode(
  req: import("express").Request,
  res: import("express").Response,
  expectStage: "totp" | "enrol"
): Promise<void> {
  const origin = requestOrigin(req);
  const { pending, code } = (req.body ?? {}) as { pending?: string; code?: string };
  const claims = pending ? verifyPending(pending) : null;
  if (!claims || claims.stage !== expectStage || typeof code !== "string") {
    res.status(401).json({ error: "Start again", code: "RESTART" });
    return;
  }
  const gate = await hit("totp", claims.sub, 5, 900);
  if (!gate.ok) {
    alert(`⚠️ TOFO admin: authenticator attempts exhausted\n${who(claims.email, origin.ip, origin.ua)}`);
    await auditAnonymous(claims.email, { action: "admin.signin.lockout", ip: origin.ip });
    res.status(429).json({ error: "Too many attempts — wait a few minutes", retryAfter: gate.retryAfterSec });
    return;
  }
  const admin = await getAdminById(claims.sub);
  if (!admin || !admin.totpSecretEnc || admin.status !== "active") {
    res.status(401).json({ error: "Start again", code: "RESTART" });
    return;
  }
  // During enrolment there is no accepted step yet, so replay cannot apply.
  const result = checkCode(admin.totpSecretEnc, code, expectStage === "enrol" ? null : admin.totpLastStep);
  if (!result.ok) {
    await auditAnonymous(claims.email, { action: "admin.signin.badCode", ip: origin.ip, reason: result.reason });
    res.status(401).json({
      error: result.reason === "replay" ? "That code has already been used — wait for the next one" : "That code is not right",
    });
    return;
  }

  let recoveryCodes: string[] | undefined;
  if (expectStage === "enrol") {
    await activateTotp(admin.id, result.step);
    recoveryCodes = await replaceRecoveryCodes(admin.id);
  } else {
    await noteTotpStep(admin.id, result.step);
  }

  await clear("totp", claims.sub);
  await noteLogin(admin.id);
  const session = await issueSession(admin, origin.ip, origin.ua);
  setRefreshCookie(res, session.refreshToken);
  await audit({ id: admin.id, email: admin.email }, { action: "admin.signin.ok", ip: origin.ip });
  logEvent({ type: "admin.login", ip: origin.ip, ua: origin.ua, data: { email: admin.email, role: admin.role } });
  alert(`✅ TOFO admin signed in\n${who(admin.email, origin.ip, origin.ua)}`);
  res.json({
    accessToken: session.accessToken,
    expiresInSec: session.expiresInSec,
    admin: { email: admin.email, name: admin.name, role: admin.role },
    recoveryCodes,
  });
}

authRouter.post("/totp", (req, res) => void finishWithCode(req, res, "totp"));
authRouter.post("/enrol", (req, res) => void finishWithCode(req, res, "enrol"));

// ---- the way back in ------------------------------------------------------
authRouter.post("/recovery", async (req, res) => {
  const origin = requestOrigin(req);
  const { pending, code } = (req.body ?? {}) as { pending?: string; code?: string };
  const claims = pending ? verifyPending(pending) : null;
  if (!claims || typeof code !== "string") {
    res.status(401).json({ error: "Start again", code: "RESTART" });
    return;
  }
  const gate = await hit("recovery", claims.sub, 5, 3600);
  if (!gate.ok) {
    res.status(429).json({ error: "Too many attempts", retryAfter: gate.retryAfterSec });
    return;
  }
  const admin = await getAdminById(claims.sub);
  if (!admin || admin.status !== "active") {
    res.status(401).json({ error: "Start again", code: "RESTART" });
    return;
  }
  const left = await consumeRecoveryCode(admin.id, code);
  if (left === null) {
    await auditAnonymous(claims.email, { action: "admin.signin.badRecovery", ip: origin.ip });
    res.status(401).json({ error: "That code is not right" });
    return;
  }
  await noteLogin(admin.id);
  const session = await issueSession(admin, origin.ip, origin.ua);
  setRefreshCookie(res, session.refreshToken);
  await audit({ id: admin.id, email: admin.email }, { action: "admin.signin.recovery", ip: origin.ip });
  // Loudly, and on the channel that is not wherever the codes were kept.
  alert(`🔑 TOFO admin: a RECOVERY CODE was used — ${left} left\n${who(admin.email, origin.ip, origin.ua)}`);
  res.json({
    accessToken: session.accessToken,
    expiresInSec: session.expiresInSec,
    admin: { email: admin.email, name: admin.name, role: admin.role },
    recoveryCodesLeft: left,
  });
});

// ---- keeping the session --------------------------------------------------
authRouter.post("/refresh", async (req, res) => {
  const origin = requestOrigin(req);
  const token = readCookie(req, REFRESH_COOKIE);
  if (!token) {
    res.status(401).json({ error: "Not signed in", code: "NO_SESSION" });
    return;
  }
  const result = await rotate(token, getAdminById, origin.ip, origin.ua);
  if (!result.ok) {
    clearRefreshCookie(res);
    res.status(401).json({
      error: result.reason === "reused" ? "That session was ended for safety — sign in again" : "Not signed in",
      code: "NO_SESSION",
    });
    return;
  }
  setRefreshCookie(res, result.session.refreshToken);
  res.json({ accessToken: result.session.accessToken, expiresInSec: result.session.expiresInSec });
});

authRouter.post("/logout", requireAdmin(), async (req, res) => {
  await dropSudo(req.admin!.sessionId);
  await revoke(req.admin!.sessionId);
  clearRefreshCookie(res);
  await audit(req.admin!, { action: "admin.signout", ip: requestOrigin(req).ip });
  res.json({ ok: true });
});

authRouter.get("/me", requireAdmin(), async (req, res) => {
  res.json({ admin: req.admin, sudo: await sudoActive(req.admin!.sessionId) });
});

// ---- sudo: a fresh code for the irreversible things -----------------------
authRouter.post("/sudo", requireAdmin(), async (req, res) => {
  const origin = requestOrigin(req);
  const { code } = (req.body ?? {}) as { code?: string };
  const gate = await hit("sudo", req.admin!.id, 5, 900);
  if (!gate.ok) {
    res.status(429).json({ error: "Too many attempts", retryAfter: gate.retryAfterSec });
    return;
  }
  const admin = await getAdminById(req.admin!.id);
  if (!admin?.totpSecretEnc || typeof code !== "string") {
    res.status(400).json({ error: "No authenticator enrolled" });
    return;
  }
  // Replay protection applies here too, which is the point: the code you signed
  // in with cannot be reused, so this proves you are holding the phone NOW
  // rather than that you were twenty minutes ago.
  const result = checkCode(admin.totpSecretEnc, code, admin.totpLastStep);
  if (!result.ok) {
    res.status(401).json({
      error: result.reason === "replay" ? "Wait for the next code" : "That code is not right",
    });
    return;
  }
  await noteTotpStep(admin.id, result.step);
  await clear("sudo", admin.id);
  const seconds = await grantSudo(req.admin!.sessionId);
  await audit(req.admin!, { action: "admin.sudo", ip: origin.ip });
  res.json({ ok: true, seconds });
});
