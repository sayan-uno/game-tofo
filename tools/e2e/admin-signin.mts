// DEV ONLY — drives the console's sign-in over HTTP against a RUNNING admin
// process, and checks that the gates behave when a real browser would hit them.
//
//   ADMIN_PORT=4031 npm run e2e:admin
//
// The Google stage is NOT exercised: it needs a real ID token from Google, and
// faking one would mean adding a bypass to production code, which is precisely
// the thing this console must not have. It is the same verifyIdToken call the
// game's own login already uses. Everything AFTER Google — enrolment, the
// authenticator, sessions, sudo, rotation, the role gates — is exercised here
// for real, over the wire, with cookies.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const requireBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
for (const line of readFileSync(new URL("../../backend/.env", import.meta.url), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { Client } = requireBackend("pg") as typeof import("pg");
const jwt = requireBackend("jsonwebtoken") as typeof import("jsonwebtoken");
const { generateSync } = requireBackend("otplib") as typeof import("otplib");
const { newEnrolment } = await import("../../backend/src/admin/totp.js");
const { decryptSecret } = await import("../../backend/src/admin/crypto.js");

const PORT = process.env.ADMIN_PORT || "4031";
const PATH = process.env.ADMIN_PATH!;
const BASE = `http://localhost:${PORT}/${PATH}`;
const MARK = `a1e2e-${Date.now()}`;
let fails = 0;
const ok = (c: unknown, m: string) => {
  console.log((c ? "  ✓ " : "  ✗ ") + m);
  if (!c) fails++;
};

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

// Sweep anything an interrupted run left behind — including the activity-log
// rows, which carry no user id (an admin is not a player) and so would survive
// any cleanup keyed on one.
await db.query("delete from admin_users where email like 'a1e2e-%@check.invalid'");
await db.query("delete from event_log where data->>'email' like '%@check.invalid'");

let cookie = "";
let refreshValue = "";
let access = "";
async function call(path: string, init: RequestInit = {}, useAuth = true) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as object) };
  if (useAuth && access) headers.authorization = `Bearer ${access}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + path, { ...init, headers });
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const [pair] = c.split(";");
    if (pair.startsWith("tofo_admin_rt=")) {
      cookie = pair.endsWith("=") ? "" : pair;
      refreshValue = pair.slice("tofo_admin_rt=".length);
    }
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* empty body is fine */
  }
  return { status: res.status, body };
}

const now = () => Math.floor(Date.now() / 1000);
let adminId = "";
let secret = "";

/** Create a throwaway admin of a given role and sign them all the way in.
 *  Used to prove the role gates from the OUTSIDE — the only way to know a
 *  support account cannot see addresses is to be one and try. */
async function signInAs(role: string): Promise<string> {
  const em = `${MARK}-${role}@check.invalid`;
  const enrolment = newEnrolment(em);
  const { rows } = await db.query(
    "insert into admin_users (email, name, role, totp_secret_enc) values ($1,$2,$3,$4) returning id",
    [em, role, role, enrolment.secretEnc]
  );
  const pending = jwt.sign({ sub: rows[0].id, email: em, stage: "enrol" }, process.env.ADMIN_JWT_SECRET!, {
    audience: "admin-pending",
    issuer: "tofo-admin",
    expiresIn: "5m",
  });
  const res = await fetch(`${BASE}/session/enrol`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pending, code: generateSync({ secret: enrolment.secret }) }),
  });
  const body = (await res.json()) as { accessToken?: string };
  if (!body.accessToken) throw new Error(`could not sign in as ${role}: HTTP ${res.status}`);
  return body.accessToken;
}
const asRole = (token: string, path: string) => fetch(BASE + path, { headers: { authorization: `Bearer ${token}` } });

try {
  // A throwaway owner, parked mid-enrolment exactly as POST /session/google
  // would have left it: a secret stored but NOT activated.
  const enrolment = newEnrolment(`${MARK}@check.invalid`);
  secret = enrolment.secret;
  const { rows } = await db.query(
    "insert into admin_users (email, name, role, totp_secret_enc) values ($1,$2,'owner',$3) returning id",
    [`${MARK}@check.invalid`, "A1 e2e", enrolment.secretEnc]
  );
  adminId = rows[0].id;
  const pending = (stage: string) =>
    jwt.sign({ sub: adminId, email: `${MARK}@check.invalid`, stage }, process.env.ADMIN_JWT_SECRET!, {
      audience: "admin-pending",
      issuer: "tofo-admin",
      expiresIn: "5m",
    });

  console.log("\nthe path");
  {
    const wrong = await fetch(`http://localhost:${PORT}/not-the-path/session/me`);
    ok(wrong.status === 404, "a wrong path is a plain 404 — the console does not announce itself");
    const noToken = await fetch(`${BASE}/overview`);
    ok(noToken.status === 401, "the right path with no token is 401");
  }

  console.log("\nenrolment");
  {
    const bad = await call("/session/enrol", { method: "POST", body: JSON.stringify({ pending: pending("enrol"), code: "000000" }) }, false);
    ok(bad.status === 401, "a wrong code does not enrol you");

    const r = await call(
      "/session/enrol",
      { method: "POST", body: JSON.stringify({ pending: pending("enrol"), code: generateSync({ secret }) }) },
      false
    );
    ok(r.status === 200, "a working code completes enrolment");
    ok(typeof r.body.accessToken === "string", "and signs you in");
    ok(Array.isArray(r.body.recoveryCodes) && (r.body.recoveryCodes as string[]).length === 10, "handing over ten recovery codes, once");
    ok(cookie.startsWith("tofo_admin_rt="), "the refresh token comes back as a cookie, not in the body");
    ok(
      refreshValue.length > 20 && !JSON.stringify(r.body).includes(refreshValue),
      "…and the token itself never appears in the JSON, so a script on the page cannot read it"
    );
    access = String(r.body.accessToken ?? "");
  }

  console.log("\nsigned in");
  {
    const me = await call("/session/me", { method: "GET" });
    ok(me.status === 200, "the session answers for itself");
    ok((me.body.admin as { role?: string })?.role === "owner", "with the role it was given");
    ok(me.body.sudo === false, "and not in sudo — signing in is not the same as confirming");

    const over = await fetch(`http://localhost:${PORT}/${PATH}/overview`, { headers: { authorization: `Bearer ${access}` } });
    const overBody = (await over.json()) as Record<string, Record<string, unknown>>;
    ok(over.status === 200, "the overview loads");
    ok(typeof overBody.totals?.players === "number", `it counts the players (${overBody.totals?.players})`);
    ok(typeof overBody.live?.online === "number", "and reads who is online from the snapshot");
    ok(Array.isArray(overBody.instances), "listing every game server publishing");

    const player = jwt.sign({ userId: "x", uid: "1", name: "p" }, process.env.JWT_SECRET!, { expiresIn: "1h" });
    const asPlayer = await fetch(`${BASE}/overview`, { headers: { authorization: `Bearer ${player}` } });
    ok(asPlayer.status === 401, "a PLAYER's token is refused — the two realms cannot be confused");
  }

  console.log("\nsudo");
  {
    const before = await call("/admins", {
      method: "POST",
      body: JSON.stringify({ email: `${MARK}-two@check.invalid`, role: "moderator", reason: "e2e" }),
    });
    ok(before.status === 403 && before.body.code === "SUDO_REQUIRED", "creating an admin is refused without a fresh code");

    // The enrolment code was spent, so sudo needs a NEWER step — which is
    // exactly the property that makes sudo mean "holding the phone now".
    const stale = await call("/session/sudo", {
      method: "POST",
      body: JSON.stringify({ code: generateSync({ secret, epoch: now() }) }),
    });
    ok(stale.status === 401, "the code just used to sign in will not do — replay is refused");

    const fresh = await call("/session/sudo", {
      method: "POST",
      body: JSON.stringify({ code: generateSync({ secret, epoch: now() + 30 }) }),
    });
    ok(fresh.status === 200, "the next code grants sudo");

    const after = await call("/admins", {
      method: "POST",
      body: JSON.stringify({ email: `${MARK}-two@check.invalid`, role: "moderator", reason: "e2e" }),
    });
    ok(after.status === 200, "and now the admin can be created");
    ok((after.body.admin as { role?: string })?.role === "moderator", "with the role asked for");
  }

  console.log("\nplayer data, and who may see it");
  {
    const { rows: sample } = await db.query(
      "select uid from users where username is not null order by created_at limit 1"
    );
    const uid = sample[0]?.uid;
    if (!uid) {
      console.log("  (no players in the database — skipped)");
    } else {
      const owner = await call(`/players/${uid}`, { method: "GET" });
      ok(owner.status === 200, "an owner can open a player");
      ok(owner.body.canSeeAddresses === true, "and is told they may see addresses");
      ok(Array.isArray(owner.body.sessions), "so the sessions are actually included");
      ok(Array.isArray(owner.body.linked), "and the linked-accounts list");

      const support = await signInAs("support");
      const sres = await asRole(support, `/players/${uid}`);
      const sbody = (await sres.json()) as Record<string, unknown>;
      ok(sres.status === 200, "a support account can open the same player");
      ok(sbody.canSeeAddresses === false, "but is told they may NOT see addresses");
      ok(sbody.sessions === undefined, "and the sessions are ABSENT, not merely hidden by the page");
      ok(sbody.linked === undefined, "so is the linked-accounts list");
      ok((sbody.player as { uid?: string })?.uid === uid, "while identity and career still come through");

      const byIp = await asRole(support, "/players/search?q=203.0.113.9");
      ok(byIp.status === 403, "a support account searching by address is refused outright");

      const analyst = await signInAs("analyst");
      const ares = await asRole(analyst, `/players/${uid}`);
      ok(ares.status === 403, "an analyst cannot open a player at all — they get aggregates, not people");
    }
  }

  console.log("\nhanding out a sanction, and who may");
  {
    const { rows: sample } = await db.query(
      "select uid from users where username is not null order by created_at limit 1"
    );
    const uid = sample[0]?.uid;
    if (!uid) {
      console.log("  (no players in the database — skipped)");
    } else {
      const moderator = await signInAs("moderator");
      const send = (token, body) =>
        fetch(`${BASE}/players/${uid}/sanctions`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      // The moderator has never confirmed with a code, so nothing may be
      // handed out yet — that is the whole point of sudo.
      const noSudo = await send(moderator, { type: "chat", reason: "e2e", minutes: 60 });
      const noSudoBody = await noSudo.json();
      ok(noSudo.status === 403 && noSudoBody.code === "SUDO_REQUIRED",
        "a sanction cannot be handed out without confirming with a fresh code");

      const bad = await call(`/players/${uid}/sanctions`, { method: "POST", body: JSON.stringify({ type: "chat", reason: "x", minutes: 60 }) });
      ok(bad.status === 400, "a reason of two characters is refused — the player is shown it");

      const forever = await call(`/players/${uid}/sanctions`, {
        method: "POST",
        body: JSON.stringify({ type: "chat", reason: "e2e permanent", minutes: null }),
      });
      ok(forever.status === 200, "an owner may act permanently");
      const sanctionId = String(forever.body.id ?? "");

      const live = await call("/sanctions", { method: "GET" });
      ok(
        (live.body.sanctions as { id: string }[]).some((x) => x.id === sanctionId),
        "and it shows up in what is currently in force"
      );

      const lifted = await call(`/sanctions/${sanctionId}`, { method: "DELETE", body: JSON.stringify({ reason: "e2e" }) });
      ok(lifted.status === 200, "lifting it works");
      const twice = await call(`/sanctions/${sanctionId}`, { method: "DELETE", body: JSON.stringify({}) });
      ok(twice.status === 409, "and lifting the same one twice is refused, so a double click is harmless");

      // Now give the moderator sudo, and check the ceiling on how long they
      // may act for. A moderator is trusted with a week, not with forever.
      const modAdmin = await db.query("select id, totp_secret_enc from admin_users where email = $1", [`${MARK}-moderator@check.invalid`]);
      const modSecret = decryptSecret(modAdmin.rows[0].totp_secret_enc);
      // One step ahead: newer than the code they enrolled with (so replay
      // protection is satisfied) and still inside the ±30s tolerance. Sixty
      // seconds ahead is two steps and would be refused — and the failure
      // would be silent, which is why the answer is checked.
      const modSudo = await fetch(`${BASE}/session/sudo`, {
        method: "POST",
        headers: { authorization: `Bearer ${moderator}`, "content-type": "application/json" },
        body: JSON.stringify({ code: generateSync({ secret: modSecret, epoch: now() + 30 }) }),
      });
      ok(modSudo.status === 200, "the moderator can confirm with a fresh code");

      const modForever = await send(moderator, { type: "chat", reason: "e2e mod forever", minutes: null });
      ok(modForever.status === 403, "a moderator with sudo still may not act permanently");
      const modYear = await send(moderator, { type: "chat", reason: "e2e mod year", minutes: 525600 });
      ok(modYear.status === 403, "nor for a year");
      const modWeek = await send(moderator, { type: "chat", reason: "e2e mod week", minutes: 10080 });
      ok(modWeek.status === 200, "but a week is theirs to give");
      if (modWeek.ok) {
        const id = (await modWeek.json()).id;
        await call(`/sanctions/${id}`, { method: "DELETE", body: JSON.stringify({ reason: "cleanup" }) });
      }

      const modPlatform = await fetch(`${BASE}/platform`, {
        method: "POST",
        headers: { authorization: `Bearer ${moderator}`, "content-type": "application/json" },
        body: JSON.stringify({ maintenance: true }),
      });
      ok(modPlatform.status === 403, "and the platform switches are not a moderator's to touch");
    }
  }

  // LAST, deliberately: proving that a reused refresh token ends every session
  // means this admin cannot make another authenticated call afterwards.
  console.log("\nsessions");
  {
    const first = cookie;
    const r = await call("/session/refresh", { method: "POST" }, false);
    ok(r.status === 200 && typeof r.body.accessToken === "string", "the refresh cookie exchanges for a new access token");
    ok(cookie !== first, "and the cookie itself is replaced — refresh tokens rotate");

    const replay = await fetch(`${BASE}/session/refresh`, { method: "POST", headers: { cookie: first } });
    ok(replay.status === 401, "presenting the OLD cookie again is refused");
    const afterReuse = await fetch(`${BASE}/overview`, { headers: { authorization: `Bearer ${access}` } });
    ok(afterReuse.status === 401, "…and every session for that admin is ended, because a reused token means a copy exists");
  }

  console.log("\nthe audit trail");
  {
    const { rows: trail } = await db.query(
      "select action from admin_audit where admin_email = $1 order by id",
      [`${MARK}@check.invalid`]
    );
    const actions = trail.map((r: { action: string }) => r.action);
    for (const want of ["admin.signin.ok", "admin.sudo", "admin.create"]) {
      ok(actions.includes(want), `${want} was recorded`);
    }
  }
} finally {
  await db.query("delete from sanctions where reason like 'e2e%'");
  await db.query("delete from admin_audit where admin_email like 'a1e2e-%@check.invalid'");
  await db.query("delete from event_log where data->>'email' like '%@check.invalid'");
  await db.query("delete from admin_users where email like 'a1e2e-%@check.invalid'");
  await db.query("delete from admin_users where email like '%@check.invalid'");
  await db.end();
}

console.log(fails === 0 ? "\nSIGN-IN PROVEN" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
