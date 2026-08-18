// Verification suite for the console's sign-in machinery (A1) — run it after
// ANY change under backend/src/admin/.
//
//     npm run check:admin
//
// What it proves, and why each check is here:
//
//   crypto     — a TOTP secret survives a round trip and a TAMPERED one is
//                refused rather than decrypting to rubbish; a password hash
//                verifies and a wrong password does not
//   totp       — a code from the phone works, one thirty seconds either side
//                works (clocks drift), one from two minutes ago does not, and
//                the SAME code cannot be spent twice. That last one is the
//                whole reason a time step is stored
//   session    — an access token verifies; a PLAYER token does not, because
//                the audience makes it a forgery rather than a near miss; a
//                pending token is not an access token; rotation replaces the
//                pair; and presenting a spent refresh token ends every session
//                that admin has, because nothing can tell a thief from the
//                owner at that point
//   roles      — the ordering, including that owner outranks everything
//   limits     — the attempt ceiling stops at the ceiling and says how long
//   sudo       — granted, seen, and dropped
//
// It uses its own Redis database index and deletes every row it writes.

const base = (process.env.REDIS_URL || "").replace(/\/\d+$/, "");
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "backend", ".env");
try {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch {
  console.error(`Could not read ${envPath}`);
  process.exit(2);
}
process.env.REDIS_URL = `${(process.env.REDIS_URL || base || "").replace(/\/\d+$/, "")}/7`;

const { config } = await import("../../backend/src/config.js");
const { redis } = await import("../../backend/src/redis.js");
const { pool } = await import("../../backend/src/db/client.js");
const { encryptSecret, decryptSecret, hashPassword, verifyPassword, newRecoveryCode, safeEqual } = await import(
  "../../backend/src/admin/crypto.js"
);
const { newEnrolment, checkCode } = await import("../../backend/src/admin/totp.js");
const { issueSession, verifyAccess, signPending, verifyPending, rotate, revokeAll, sessionLive } = await import(
  "../../backend/src/admin/session.js"
);
const { outranks, isAdminRole, getAdminById, replaceRecoveryCodes, consumeRecoveryCode } = await import(
  "../../backend/src/admin/accounts.js"
);
const { grantSudo, sudoActive, dropSudo } = await import("../../backend/src/admin/guard.js");
const { hit, clear } = await import("../../backend/src/admin/rateLimit.js");
const { audit } = await import("../../backend/src/admin/audit.js");
// otplib and jsonwebtoken belong to the backend, and the repo root cannot
// resolve its node_modules — same reason tools/e2e/mint.mjs does this.
const { createRequire } = await import("node:module");
const requireBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
const { generateSync } = requireBackend("otplib") as typeof import("otplib");
const jwt = requireBackend("jsonwebtoken") as typeof import("jsonwebtoken");

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  if (!cond) {
    console.log("  ✗ " + msg);
    fails++;
  } else console.log("  ✓ " + msg);
};
const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> =>
  (await pool.query(text, values)).rows as T[];

await redis.connect();
await redis.flushdb();
const MARK = `admincheck-${Date.now()}`;
let adminId = "";

try {
  // ---- crypto --------------------------------------------------------------
  console.log("\ncrypto");
  {
    const secret = "JBSWY3DPEHPK3PXP";
    const packed = encryptSecret(secret);
    ok(!packed.includes(secret), "the ciphertext does not contain the secret");
    ok(decryptSecret(packed) === secret, "and it round-trips exactly");
    ok(encryptSecret(secret) !== encryptSecret(secret), "two encryptions of one secret differ — the nonce is fresh each time");

    const [v, iv, tag, body] = packed.split(".");
    const flipped = Buffer.from(body, "base64url");
    flipped[0] ^= 0xff;
    let refused = false;
    try {
      decryptSecret(`${v}.${iv}.${tag}.${flipped.toString("base64url")}`);
    } catch {
      refused = true;
    }
    ok(refused, "a tampered ciphertext is REFUSED rather than decrypting to rubbish");

    const hash = await hashPassword("correct horse battery staple");
    ok(await verifyPassword("correct horse battery staple", hash), "a password verifies against its hash");
    ok(!(await verifyPassword("wrong", hash)), "and a wrong one does not");
    ok((await hashPassword("x")) !== (await hashPassword("x")), "two hashes of one password differ — the salt is fresh");

    const code = newRecoveryCode();
    ok(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(code), `a recovery code is unambiguous to write down (${code})`);
    ok(safeEqual("abc", "abc") && !safeEqual("abc", "abd") && !safeEqual("abc", "abcd"), "the constant-time compare handles equal, different and different-length");
  }

  // ---- totp ----------------------------------------------------------------
  console.log("\ntotp");
  {
    const enrolment = newEnrolment("owner@example.com");
    ok(enrolment.uri.startsWith("otpauth://totp/TOFO%20Admin:"), "enrolment produces a scannable otpauth URI");
    ok(enrolment.uri.includes("secret="), "which carries the secret the phone needs");

    const now = Math.floor(Date.now() / 1000);
    const token = generateSync({ secret: enrolment.secret, epoch: now });
    const first = checkCode(enrolment.secretEnc, token, null);
    ok(first.ok, "the current code is accepted");

    if (first.ok) {
      const again = checkCode(enrolment.secretEnc, token, first.step);
      ok(!again.ok && again.reason === "replay", "the SAME code cannot be spent twice — a code seen over a shoulder is dead");
    }

    const drifted = generateSync({ secret: enrolment.secret, epoch: now - 30 });
    ok(checkCode(enrolment.secretEnc, drifted, null).ok, "a code from thirty seconds ago still works — clocks drift");
    const ahead = generateSync({ secret: enrolment.secret, epoch: now + 30 });
    ok(checkCode(enrolment.secretEnc, ahead, null).ok, "and one thirty seconds ahead, for the same reason");
    const old = generateSync({ secret: enrolment.secret, epoch: now - 120 });
    ok(!checkCode(enrolment.secretEnc, old, null).ok, "but one from two minutes ago does not");

    ok(!checkCode(enrolment.secretEnc, "000000", null).ok, "a wrong code is refused");
    ok(!checkCode(enrolment.secretEnc, "12345", null).ok, "so is one that is not six digits");
    ok(checkCode("not-a-secret", token, null).reason === "unreadable", "an unreadable stored secret fails closed");
  }

  // ---- session -------------------------------------------------------------
  console.log("\nsession");
  {
    const [a] = await q<{ id: string }>(
      "insert into admin_users (email, name, role) values ($1,$2,'owner') returning id",
      [`${MARK}@check.invalid`, "A1 check"]
    );
    adminId = a.id;
    const admin = (await getAdminById(adminId))!;

    const first = await issueSession(admin, "203.0.113.9", "check");
    const claims = verifyAccess(first.accessToken);
    ok(claims?.sub === adminId && claims?.role === "owner", "an access token carries who and what role");
    ok(await sessionLive(first.sessionId), "and its session is live");

    const playerToken = jwt.sign({ userId: "x", uid: "1", name: "p" }, config.jwtSecret, { expiresIn: "1h" });
    ok(verifyAccess(playerToken) === null, "a PLAYER token is refused here — different secret and a different audience");
    const wrongAud = jwt.sign({ sub: adminId }, config.admin.jwtSecret, { audience: "admin-pending", issuer: "tofo-admin", expiresIn: "5m" });
    ok(verifyAccess(wrongAud) === null, "a pending token is refused as an access token, so a half-finished sign-in cannot act");

    const pending = signPending(adminId, admin.email, "totp");
    ok(verifyPending(pending)?.stage === "totp", "a pending token carries the stage it is for");
    ok(verifyAccess(pending) === null, "and is not an access token either way round");

    const rotated = await rotate(first.refreshToken, getAdminById, "203.0.113.9", "check");
    ok(rotated.ok, "a refresh token exchanges for a new pair");
    ok(!(await sessionLive(first.sessionId)), "and the session it came from is closed");

    const reused = await rotate(first.refreshToken, getAdminById, "203.0.113.9", "check");
    ok(!reused.ok && reused.reason === "reused", "presenting the SPENT token again is detected as reuse");
    if (rotated.ok) {
      ok(
        !(await sessionLive(rotated.session.sessionId)),
        "…and every session that admin had is ended, because nothing can tell a thief from the owner"
      );
    }

    const fresh = await issueSession(admin, null, null);
    ok(await sessionLive(fresh.sessionId), "a new sign-in works afterwards");
    ok((await revokeAll(adminId)) >= 1, "revoking all reports how many it closed");
    ok(!(await sessionLive(fresh.sessionId)), "and they are closed at once — revocation is not delayed to token expiry");
  }

  // ---- recovery codes ------------------------------------------------------
  console.log("\nrecovery codes");
  {
    const codes = await replaceRecoveryCodes(adminId);
    ok(codes.length === 10, "ten codes are issued");
    ok(new Set(codes).size === 10, "and they are all different");
    const [{ n }] = await q<{ n: string }>("select count(*) n from admin_recovery_codes where admin_id = $1", [adminId]);
    ok(Number(n) === 10, "stored as hashes, one row each");
    const [{ plain }] = await q<{ plain: string }>(
      "select count(*) plain from admin_recovery_codes where admin_id = $1 and code_hash = any($2)",
      [adminId, codes]
    );
    ok(Number(plain) === 0, "and NONE of them is stored in the clear");
    ok((await consumeRecoveryCode(adminId, codes[0])) === 9, "spending one leaves nine");
    ok((await consumeRecoveryCode(adminId, codes[0])) === null, "and it cannot be spent twice");
    ok((await consumeRecoveryCode(adminId, "AAAAA-AAAAA")) === null, "an invented code is refused");
    const replaced = await replaceRecoveryCodes(adminId);
    ok((await consumeRecoveryCode(adminId, codes[1])) === null, "regenerating kills the old set immediately");
    ok((await consumeRecoveryCode(adminId, replaced[0])) === 9, "and the new set works");
  }

  // ---- roles ---------------------------------------------------------------
  console.log("\nroles");
  {
    ok(outranks("owner", "analyst") && outranks("owner", "owner"), "an owner outranks everything, itself included");
    ok(outranks("moderator", "support") && !outranks("support", "moderator"), "the ordering runs the right way");
    ok(!outranks("analyst", "moderator"), "an analyst cannot moderate");
    ok(!outranks("nonsense", "analyst"), "an unknown role outranks nothing — it fails closed");
    ok(isAdminRole("owner") && !isAdminRole("root"), "only the five known roles are roles");
  }

  // ---- limits --------------------------------------------------------------
  console.log("\nlimits");
  {
    await clear("test", "k");
    let last = await hit("test", "k", 3, 60);
    for (let i = 0; i < 2; i++) last = await hit("test", "k", 3, 60);
    ok(last.ok && last.count === 3, "attempts are allowed up to the ceiling");
    const over = await hit("test", "k", 3, 60);
    ok(!over.ok, "and refused past it");
    ok(over.retryAfterSec > 0 && over.retryAfterSec <= 60, `saying how long to wait (${over.retryAfterSec}s)`);
    await clear("test", "k");
    ok((await hit("test", "k", 3, 60)).ok, "a success clears the counter — a bad day at the keyboard does not follow you around");
  }

  // ---- sudo ----------------------------------------------------------------
  console.log("\nsudo");
  {
    const sid = "session-under-test";
    ok(!(await sudoActive(sid)), "a session is not in sudo by default");
    const seconds = await grantSudo(sid);
    ok(seconds === config.admin.sudoTtlMin * 60, `granting lasts the configured window (${seconds}s)`);
    ok(await sudoActive(sid), "and is visible while it lasts");
    ok((await redis.ttl(`admin:sudo:${sid}`)) > 0, "it expires by itself rather than being forgotten about");
    await dropSudo(sid);
    ok(!(await sudoActive(sid)), "signing out drops it");
  }

  // ---- audit ---------------------------------------------------------------
  console.log("\naudit");
  {
    await audit({ id: adminId, email: `${MARK}@check.invalid` }, { action: "check.action", targetType: "admin", targetId: adminId, reason: "self-check", ip: "203.0.113.9" });
    const [row] = await q<{ admin_email: string; action: string; ip: string }>(
      "select admin_email, action, host(ip) ip from admin_audit where admin_id = $1 order by id desc limit 1",
      [adminId]
    );
    ok(row?.action === "check.action", "an action is recorded");
    ok(row?.admin_email === `${MARK}@check.invalid`, "with the admin's identity SNAPSHOTTED, so deleting the account cannot blank the trail");
    ok(row?.ip === "203.0.113.9", "and where it came from");

    await q("delete from admin_users where id = $1", [adminId]);
    const [{ n }] = await q<{ n: string }>("select count(*) n from admin_audit where admin_id = $1", [adminId]);
    ok(Number(n) === 1, "the row survives the account being deleted — there is no foreign key to cascade it away");
  }
} finally {
  try {
    await q("delete from admin_audit where admin_email like '%@check.invalid'");
    if (adminId) await q("delete from admin_users where id = $1", [adminId]);
    await q("delete from admin_users where email like '%@check.invalid'");
  } catch (err) {
    console.error("cleanup failed:", err);
  }
  await redis.flushdb();
  redis.disconnect();
  await pool.end();
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
