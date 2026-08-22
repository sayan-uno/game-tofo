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
/** The TOTP code spent on enrolment, so replaying it can be tested exactly. */
let spentCode = "";

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
/** Wait for a buffered activity-log row to reach Postgres.
 *
 *  logEvent does not write on the spot — it buffers and flushes on a timer, so
 *  that recording something costs the request nothing. A test that queries the
 *  moment after the call is racing that timer, and losing. */
async function loggedRow(
  sql: string,
  args: unknown[] = [],
  want = 1,
  budgetMs = 8000
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const { rows } = await db.query(sql, args);
    // How many are EXPECTED, not merely "any". Two writes a moment apart can
    // land in two different flushes, and stopping at the first one reports the
    // second as missing when it is only late.
    if (rows.length >= want || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 300));
  }
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

    // Kept, so the replay below can offer THE code that was used rather than
    // whatever the clock says now. Regenerating it made that assertion depend
    // on the run not crossing a thirty-second TOTP step — which it does, at
    // random, and the suite then failed for a reason that had nothing to do
    // with what it was testing.
    spentCode = generateSync({ secret });
    const r = await call(
      "/session/enrol",
      { method: "POST", body: JSON.stringify({ pending: pending("enrol"), code: spentCode }) },
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
      body: JSON.stringify({ code: spentCode }),
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
  console.log("\nnotices, and taking one back");
  {
    const { rows: sample } = await db.query("select uid from users where username is not null order by created_at limit 1");
    const puid = sample[0]?.uid as string | undefined;

    const empty = await call("/notices", { method: "POST", body: JSON.stringify({ body: "hi", audience: "players" }) });
    ok(empty.status === 400, "a notice to nobody in particular is refused");

    const sent = await call("/notices", {
      method: "POST",
      body: JSON.stringify({ body: "Sent by a test.", audience: "players", uids: puid }),
    });
    ok(sent.status === 200, `a notice to named players is sent (${sent.status})`);
    const id = (sent.body.notice as { id?: string })?.id;
    ok(typeof id === "string", "and comes back with an id to take it back by");

    // ONE SEND IS ONE ROW. A notice to the whole platform must not become a
    // row per player for an admin to tidy.
    const everyone = await call("/notices", {
      method: "POST",
      body: JSON.stringify({ body: "Everyone, by a test.", audience: "everyone" }),
    });
    ok(everyone.status === 200, "and one to everybody is sent");
    const listed = await (await asRole(access, "/notices")).json();
    // Counted by WHO SENT THEM, not by their words: an earlier run's rows are
    // still in the table until its cleanup runs, and matching on text would
    // make this pass or fail depending on what happened before it.
    const mineOnly = (listed.notices as { sentBy: string | null }[]).filter(
      (n) => n.sentBy === `${MARK}@check.invalid`
    );
    ok(
      mineOnly.length === 2,
      `two sends are two rows, whoever they reached (${mineOnly.length} from this run, ${(listed.notices as unknown[]).length} in the list)`
    );

    // THE PLAYER'S OWN LIST — and what deleting does to it.
    // The reading side, asked directly: what the CONSOLE lists and what a PLAYER
    // sees are two different queries, and the one that matters after a delete
    // is the player's.
    const { noticesFor } = await import(new URL("../../backend/src/services/notices.js", import.meta.url).href);
    const before = await noticesFor(puid!);
    ok(before.length >= 2, `the player it was sent to can see it (${before.length})`);

    const gone = await call(`/notices/${id}`, { method: "DELETE" });
    ok(gone.status === 200, "taking it back works");
    const after = await noticesFor(puid!);
    ok(
      !after.some((n: { id: string }) => n.id === id),
      "and it is gone from their list — not struck through, gone"
    );
    ok(
      after.some((n: { body: string }) => n.body === "Everyone, by a test."),
      "while the one that was not taken back is untouched"
    );

    const twice = await call(`/notices/${id}`, { method: "DELETE" });
    ok(twice.status === 404, "and taking it back twice is refused rather than pretending");
  }

  console.log("\nevents");
  {
    const bad = await call("/events", { method: "POST", body: JSON.stringify({ title: "x", kind: "image" }) });
    ok(bad.status === 400, "an event with no title worth having is refused");

    const noFile = await call("/events", {
      method: "POST",
      body: JSON.stringify({ title: "A test event", kind: "image", body: "https://example.invalid/a.png" }),
    });
    ok(noFile.status === 400, "and a LINK is refused — media is uploaded, not pointed at");

    const wrongItem = await call("/events", {
      method: "POST",
      body: JSON.stringify({ title: "A test event", kind: "html", body: "<b>hi</b>", itemId: "not-an-item" }),
    });
    ok(wrongItem.status === 400, "an event that opens the collection at nothing is refused");

    // A REAL weapon, which is the case that was broken: the deep link landed
    // on Characters because only the open tab's cards exist in the page.
    const cat = await (await asRole(access, "/collection")).json();
    const weapon = (cat.items as { id: string; kind: string; withdrawn: boolean }[]).find(
      (i) => i.kind === "weapon" && !i.withdrawn
    );
    ok(weapon, `there is a weapon to point an event at (${weapon?.id})`);
    const pointed = await call("/events", {
      method: "POST",
      body: JSON.stringify({ title: "Weapon event", kind: "html", body: "<b>new</b>", itemId: weapon!.id }),
    });
    ok(pointed.status === 200, `an event can point at a weapon (${pointed.status})`);
    ok((pointed.body.event as { itemId?: string })?.itemId === weapon!.id, "and remembers which one");

    // …but not at something players are not allowed to see.
    await call(`/collection/${weapon!.id}`, { method: "POST", body: JSON.stringify({ on: true }) });
    const atHidden = await call("/events", {
      method: "POST",
      body: JSON.stringify({ title: "Hidden event", kind: "html", body: "<b>x</b>", itemId: weapon!.id }),
    });
    ok(atHidden.status === 400, `an event pointing at a withdrawn item is refused (${atHidden.status})`);
    await call(`/collection/${weapon!.id}`, { method: "POST", body: JSON.stringify({ on: false }) });

    const made = await call("/events", {
      method: "POST",
      body: JSON.stringify({ title: "A test event", kind: "html", body: "<b>hi</b>", pinned: true }),
    });
    ok(made.status === 200, `an event can be created (${made.status})`);
    const evId = (made.body.event as { id?: string })?.id;
    ok((made.body.event as { pinned?: boolean })?.pinned === true, "and pinned when asked");

    // A one-pixel PNG, so the upload path is exercised for real rather than
    // assumed to work because the HTML one did.
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const uploaded = await call("/events", {
      method: "POST",
      body: JSON.stringify({ title: "A test picture", kind: "image", body: png }),
    });
    ok(uploaded.status === 200, `a picture is uploaded and stored (${uploaded.status})`);

    // A REAL-SIZED ONE. The global body parser caps every route at 100kb and
    // runs before the route that knows how to accept an upload, so a genuine
    // photograph was rejected as too large before it ever arrived — which is
    // what "I cannot add any more events" was. A one-pixel PNG never showed
    // it, because a one-pixel PNG fits.
    const big = `data:image/png;base64,${Buffer.alloc(900_000, 7).toString("base64")}`;
    ok(big.length > 1_000_000, `the test file is bigger than the tight cap (${Math.round(big.length / 1024)}kb)`);
    const heavy = await call("/events", {
      method: "POST",
      body: JSON.stringify({ title: "A big test picture", kind: "image", body: big }),
    });
    ok(heavy.status === 200, `and a real-sized one is accepted, not refused as too large (${heavy.status})`);
    // …while everything ELSE keeps the tight cap. The exception is one route,
    // not a hole in the wall.
    const fat = await call("/notices", {
      method: "POST",
      body: JSON.stringify({ body: "x".repeat(400_000), audience: "everyone" }),
    });
    ok(fat.status === 413, `and every other route still refuses a huge body (${fat.status})`);

    const unpin = await call(`/events/${evId}/pin`, { method: "POST", body: JSON.stringify({ on: false }) });
    ok(unpin.status === 200, "pinning can be taken back");

    const gone = await call(`/events/${evId}`, { method: "DELETE" });
    ok(gone.status === 200, "and the event deleted");
    const after = await (await asRole(access, "/events")).json();
    ok(
      (after.events as { id: string; deletedAt: string | null }[]).find((e) => e.id === evId)?.deletedAt !== null,
      "which the console still shows, marked, so it is clear what was taken down"
    );

    // …and gone from what a PLAYER would be served, which is the half that
    // matters.
    const { liveEventsForPlayers } = await import(
      new URL("../../backend/src/services/events.js", import.meta.url).href
    );
    const live = await liveEventsForPlayers();
    ok(!live.some((e: { id: string }) => e.id === evId), "and gone from what players are served");
  }

  console.log("\nwithdrawing something from the collection");
  {
    const list = await (await asRole(access, "/collection")).json();
    ok(Array.isArray(list.items) && list.items.length > 0, `the console can see the collection (${list.items?.length})`);
    const nope = await call("/collection/not-a-real-item", { method: "POST", body: JSON.stringify({ on: true }) });
    ok(nope.status === 404, "something that does not exist cannot be withdrawn");

    // THE FLOOR CANNOT HAVE A HOLE IN IT. A withdrawn character resolves to
    // the default, so withdrawing the default itself would leave every player
    // resolving to something that is itself withdrawn — an empty pedestal for
    // the whole platform, fixable only from a database.
    const { defaultCharacterId } = await import(
      new URL("../../backend/src/services/catalog.js", import.meta.url).href
    );
    const floor = defaultCharacterId() as string;
    const refused = await call(`/collection/${floor}`, { method: "POST", body: JSON.stringify({ on: true }) });
    ok(refused.status === 400, `the default character cannot be withdrawn (${refused.status})`);

    // Something else — a weapon, so the "it leaves their hand" path is the one
    // being exercised.
    const other = (list.items as { id: string; kind: string }[]).find((i) => i.kind === "weapon");
    ok(other, "there is a weapon to try this on");
    const first = other!;

    const pulled = await call(`/collection/${first.id}`, { method: "POST", body: JSON.stringify({ on: true }) });
    ok(pulled.status === 200, `an item can be withdrawn (${pulled.status})`);
    const after = await (await asRole(access, "/collection")).json();
    ok(
      (after.items as { id: string; withdrawn: boolean }[]).find((i) => i.id === first.id)?.withdrawn === true,
      "and the console says so"
    );
    // …and it comes OFF the player who was holding it, rather than being
    // merely hidden from everybody who had not got one yet.
    const { resolveWeapon, resolveCharacter } = await import(
      new URL("../../backend/src/services/catalog.js", import.meta.url).href
    );
    const { refreshWithdrawn } = await import(
      new URL("../../backend/src/platform/gameLocks.js", import.meta.url).href
    );
    await refreshWithdrawn();
    ok(resolveWeapon(first.id) === null, "a withdrawn weapon leaves the hand of anybody holding it");
    ok(resolveCharacter(floor) === floor, "while the default is still what everybody falls back to");

    const back = await call(`/collection/${first.id}`, { method: "POST", body: JSON.stringify({ on: false }) });
    ok(back.status === 200, "and put back again");
    await refreshWithdrawn();
    ok(resolveWeapon(first.id) === first.id, "and is holdable again");
  }

  console.log("\nscheduling maintenance");
  {
    // ANNOUNCED, NEVER SPRUNG. A player halfway through a match has done
    // nothing to deserve losing it without warning, so a window has to be far
    // enough ahead for anybody mid-something to finish.
    const tooSoon = await call("/platform", {
      method: "POST",
      body: JSON.stringify({ maintenanceAt: Date.now() + 5 * 60_000, maintenanceMessage: "Too soon." }),
    });
    ok(tooSoon.status === 400, `a window five minutes out is refused (${tooSoon.status})`);
    ok(
      typeof tooSoon.body.error === "string" && /30 minutes/.test(tooSoon.body.error),
      `and says how much warning is required (${String(tooSoon.body.error).slice(0, 60)})`
    );

    const nameless = await call("/platform", {
      method: "POST",
      body: JSON.stringify({ maintenanceAt: Date.now() + 45 * 60_000 }),
    });
    ok(nameless.status === 400, "and one with nothing to tell players is refused too");

    const at = Date.now() + 45 * 60_000;
    const planned = await call("/platform", {
      method: "POST",
      body: JSON.stringify({ maintenanceAt: at, maintenanceMessage: "Scheduled by a test." }),
    });
    ok(planned.status === 200, `a window far enough ahead is accepted (${planned.status})`);
    ok((planned.body.flags as { maintenanceAt?: number })?.maintenanceAt === at, "at the time that was asked for");
    // Scheduled is NOT down: the platform keeps working right up to the window.
    ok(
      (planned.body.flags as { maintenance?: boolean })?.maintenance === false,
      "and the platform is still open until it starts — a warning is not an outage"
    );

    const off = await call("/platform", { method: "POST", body: JSON.stringify({ maintenanceAt: 0 }) });
    ok(off.status === 200, "calling it off works");
    const after = await (await asRole(access, "/platform")).json();
    ok(after.flags.maintenanceAt === 0 && after.flags.maintenance === false, "and leaves nothing behind");

    const logged = await loggedRow(
      "select type, data from event_log where type = 'platform.maintenance' order by at desc limit 2",
      [],
      2
    );
    ok(logged.length === 2, "scheduling and calling off are both in the activity log");
  }

  console.log("\nholding a game");
  {
    const list = await (await asRole(access, "/games")).json();
    ok(Array.isArray(list.games) && list.games.length > 0, `the console can see the games (${list.games?.length})`);
    ok(list.games.every((g: { heldReason: unknown }) => "heldReason" in g), "and whether each is on hold");

    // A hold is shown to players, so it may not be nameless.
    const bare = await call("/games/ludo/hold", { method: "POST", body: JSON.stringify({ on: true }) });
    ok(bare.status === 400, `a hold with no reason is refused — players are shown it (${bare.status})`);

    const held = await call("/games/ludo/hold", { method: "POST", body: JSON.stringify({ on: true, reason: "Held by a test." }) });
    ok(held.status === 200, `holding a game works (${held.status})`);
    const after = await (await asRole(access, "/games")).json();
    ok(
      after.games.find((g: { id: string }) => g.id === "ludo")?.heldReason === "Held by a test.",
      "and the reason comes back with it"
    );

    const unknown = await call("/games/not-a-game/hold", { method: "POST", body: JSON.stringify({ on: true, reason: "nope" }) });
    ok(unknown.status === 404, "a game that does not exist cannot be held");

    const released = await call("/games/ludo/hold", { method: "POST", body: JSON.stringify({ on: false }) });
    ok(released.status === 200, "releasing needs no reason — nobody is shown anything");
    const back = await (await asRole(access, "/games")).json();
    ok(back.games.find((g: { id: string }) => g.id === "ludo")?.heldReason === null, "and the hold is gone");

    // IN THE ACTIVITY LOG, not only in the audit trail. The two answer
    // different questions: the audit says what the admins have been doing, and
    // is indexed by admin; the activity log says what happened and why, and is
    // where somebody asking "why can nobody start this" actually looks.
    const holds = (await loggedRow(
      "select type, game_id, data from event_log where type in ('game.hold','game.release') order by at desc limit 2",
      [],
      2
    )) as { type: string; game_id: string; data: { reason?: string } }[];
    ok(holds.length === 2, `holding and releasing are both in the activity log (${holds.length})`);
    ok(holds.every((r) => r.game_id === "ludo"), "against the game they were about");
    ok(holds.some((r) => r.data?.reason === "Held by a test."), "carrying the reason players were shown");
  }

  console.log("\nbarring one player from one game");
  {
    // A real account, the same way the sanction section picks one — there is
    // no point proving this against an id that does not exist.
    const { rows: sample } = await db.query(
      "select uid from users where username is not null order by created_at limit 1"
    );
    const puid = sample[0]?.uid as string | undefined;
    if (!puid) {
      console.log("  (no players in the database — skipped)");
    } else {
    const banned = await call(`/games/ludo/ban`, {
      method: "POST",
      body: JSON.stringify({ uid: puid, on: true, reason: "Barred by a test." }),
    });
    ok(banned.status === 200, `a player can be barred from one game (${banned.status})`);

    const nameless = await call(`/games/ludo/ban`, {
      method: "POST",
      body: JSON.stringify({ uid: puid, on: true }),
    });
    ok(nameless.status === 400, "and never without a reason — the player is shown it");

    const listed = await (await asRole(access, "/games")).json();
    const ludo = listed.games.find((g: { id: string }) => g.id === "ludo");
    ok(
      ludo?.banned?.some((b: { uid: string }) => b.uid === puid),
      "the console lists who is barred, by name rather than by raw id"
    );

    // THE THING THAT WAS MISSING. Barring somebody was audited but never
    // written where a player's own history is read, so it was invisible from
    // the side it would be asked about.
    const rows = (await loggedRow(
      "select type, game_id, uid, data from event_log where type = 'game.ban' and uid = $1 order by at desc limit 1",
      [puid]
    )) as { game_id: string; data: { reason?: string; by?: string } }[];
    ok(rows.length === 1, "and it is in the activity log against THAT PLAYER");
    ok(rows[0]?.game_id === "ludo", "naming the game they lost");
    ok(rows[0]?.data?.reason === "Barred by a test.", "and why");
    ok(typeof rows[0]?.data?.by === "string", "and which admin did it");

    const lifted = await call(`/games/ludo/ban`, {
      method: "POST",
      body: JSON.stringify({ uid: puid, on: false }),
    });
    ok(lifted.status === 200, "lifting it works");
    const gone = await loggedRow("select 1 from event_log where type = 'game.unban' and uid = $1", [puid]);
    ok(gone.length === 1, "and that is on the record too — a restriction being removed is also a fact");
    }
  }

  console.log("\nbrowsing everybody");
  {
    // Opening Players with nothing typed lists the whole platform, and the one
    // table here that grows without limit is this one. So it comes a page at a
    // time, positioned by a CURSOR: the same work for page fifty as for page
    // one, and an account created mid-scroll cannot shove a row into a page
    // that has already been drawn — which an OFFSET would do.
    const first = await (await asRole(access, "/players?limit=2")).json();
    ok(Array.isArray(first.players) && first.players.length <= 2,
       `the list comes a page at a time (${first.players?.length} asked for 2)`);
    ok(typeof first.total === "number", `and says how many there are altogether (${first.total})`);

    const at = (p: { createdAt: string }) => new Date(p.createdAt).getTime();
    ok(first.players.every((p: { createdAt: string }, i: number) =>
         i === 0 || at(first.players[i - 1]) >= at(p)),
       "newest account at the top, oldest at the bottom");

    if (first.cursor) {
      const second = await (await asRole(access, `/players?limit=2&cursor=${encodeURIComponent(first.cursor)}`)).json();
      ok(second.players.length > 0, "the cursor brings the next page");
      const seen = new Set(first.players.map((p: { uid: string }) => p.uid));
      ok(second.players.every((p: { uid: string }) => !seen.has(p.uid)),
         "with nobody repeated from the page before it");
      ok(second.players.every((p: { createdAt: string }) => at(p) <= at(first.players[first.players.length - 1])),
         "and nobody newer than the row the cursor names — the order holds across pages");
      ok(second.total === null, "a later page does not pay for a full count of the table again");
    } else {
      ok(first.total <= 2, "there is only one page of accounts on this machine");
    }

    const bad = await asRole(access, "/players?cursor=not-a-real-position");
    ok(bad.status === 400, "a cursor that is not a position is refused rather than silently ignored");
    const huge = await (await asRole(access, "/players?limit=100000")).json();
    ok(huge.players.length <= 100, `and a page size is clamped, not obeyed (${huge.players.length} for 100000)`);
  }

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
  await db.query("delete from event_log where type = 'platform.maintenance' and data->>'by' like '%@check.invalid'");
  // The game rows are stamped with the admin who did it, not with an email
  // field — and the ban ones are written against a REAL player, so leaving
  // them behind would put a restriction this suite invented into somebody's
  // actual history.
  await db.query(
    "delete from event_log where type in ('game.hold','game.release','game.ban','game.unban') and data->>'by' like '%@check.invalid'"
  );
  await db.query("delete from admin_users where email like 'a1e2e-%@check.invalid'");
  // Notices this run sent. They are addressed to a REAL player, so leaving
  // them behind would put a message this suite invented in somebody's lobby.
  await db.query("delete from notices where sent_by like '%@check.invalid'");
  await db.query("delete from events where created_by like '%@check.invalid'");
  await db.query("delete from admin_users where email like '%@check.invalid'");
  await db.end();
}

console.log(fails === 0 ? "\nSIGN-IN PROVEN" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
