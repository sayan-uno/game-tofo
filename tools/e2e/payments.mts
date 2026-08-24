#!/usr/bin/env node
// DEV ONLY — proves the gem store and the UPI gateway against a RUNNING
// backend: the whole path a real rupee takes, over real HTTP.
//
//   npm run e2e:payments                       (backend on :4000)
//   PORT=4100 npm run e2e:payments             (the test backend)
//
// tools/checks/payments.mts proves the LOGIC against Postgres and Redis. This
// proves the two things that only exist once a server is actually listening:
//
//   * the webhook is an OPEN route, and behaves like one — a wrong key, a
//     malformed body, a scanner's payload and a flood all get an answer, are
//     recorded, and change nothing;
//   * the exact JSON MacroDroid will POST, carrying the exact SMS a bank
//     sends, credits the right player's gems.
//
// It creates its own throwaway accounts and deletes everything it wrote,
// whether it passes or not — including putting the payment settings back the
// way it found them, because this platform's real UPI id may well be in there.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const back = (p: string) => import(path.join(root, "backend", "node_modules", p));

const { config } = (await back("dotenv/lib/main.js")) as { config: (o: { path: string }) => void };
config({ path: path.join(root, "backend", ".env") });
const { default: pg } = (await back("pg/lib/index.js")) as { default: any };
const { default: jwt } = (await back("jsonwebtoken/index.js")) as { default: any };
const { Redis } = (await back("ioredis/built/index.js")) as { Redis: any };

if (!process.env.JWT_SECRET || !process.env.DATABASE_URL) {
  console.error("backend/.env is missing JWT_SECRET or DATABASE_URL");
  process.exit(2);
}

const API = `http://localhost:${process.env.PORT || 4000}`;
const HOOK_KEY = `e2e-${Math.random().toString(36).slice(2)}-${Date.now()}`;
/** A bank reference this run has never used.
 *
 *  `payment_sessions.upi_ref` is UNIQUE, which is exactly what makes a
 *  redelivered SMS a no-op — so a hardcoded reference works precisely once and
 *  is a duplicate for ever after. That is the product behaving correctly and
 *  the test being wrong, and it looks like a real failure, so: never a
 *  constant. */
const ref = (): string => String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 9000) + 1000);
let fails = 0;
const ok = (c: unknown, m: string) => {
  console.log((c ? "  ✓ " : "  ✗ ") + m);
  if (!c) fails++;
};

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

/** Forget this machine's webhook rate limit.
 *
 *  The flood check deliberately exhausts it, and the window is a minute — so
 *  two runs back to back would have the second one refused before it started,
 *  which reads as "the webhook is broken" rather than "the limit works". Run
 *  before AND after, so the order the tests happen to be in cannot matter.
 *
 *  SCAN rather than KEYS: this may be a Redis somebody else is using, and
 *  blocking it to tidy up after a test is not a trade worth making. */
const redis = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: 2 });
async function forgetRateLimit(): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = (await redis.scan(cursor, "MATCH", "pay:hook:*", "COUNT", 200)) as [string, string[]];
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== "0");
}
await forgetRateLimit();

// Anything a previous run left behind, however it was killed.
{
  const { rows } = await db.query("select id from users where google_id like 'paye2e-%'");
  if (rows.length) {
    await db.query("delete from users where id = any($1)", [rows.map((r: any) => r.id)]);
    console.log(`swept ${rows.length} account(s) from an interrupted run`);
  }
}

// The real settings, so they can be put back. This database may be the live
// one, and a test that leaves a stranger's UPI id in it is worse than no test.
const { rows: settingsBefore } = await db.query("select * from payment_settings where id = 1");
const restore = settingsBefore[0] ?? null;

const ids: string[] = [];
const hookIds: number[] = [];

async function makeUser(name: string): Promise<{ id: string; uid: string; token: string }> {
  const uid = String(9_500_000_000 + Math.floor(Math.random() * 499_999_999));
  const { rows } = await db.query(
    `insert into users (uid, google_id, email, name, username)
     values ($1, $2, $3, $4, $5) returning id`,
    [uid, `paye2e-${uid}`, `paye2e-${uid}@example.invalid`, name, `${name}${uid.slice(-4)}`]
  );
  ids.push(rows[0].id);
  return {
    id: rows[0].id,
    uid,
    token: jwt.sign({ userId: rows[0].id, uid, name }, process.env.JWT_SECRET, { expiresIn: "1h" }),
  };
}

/** Paise as money, for this file's own messages. Integer arithmetic, like
 *  everywhere else money is written down here. */
const rupees = (paise: number): string =>
  `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;

const call = async (p: string, token: string, body?: unknown) => {
  const res = await fetch(API + p, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

/** Exactly what the forwarding app sends: one POST, one JSON object, no auth
 *  header, no cookie, no session. */
const hook = async (payload: unknown, raw?: string) => {
  const res = await fetch(`${API}/pay/sms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

try {
  // The server has to be up before any of this means anything.
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`No backend answering on ${API}. Start it with: npm run dev`);
    process.exit(2);
  }

  await db.query(
    `insert into payment_settings (id, upi_id, payee_name, hook_key, updated_by)
     values (1, $1, $2, $3, 'e2e')
     on conflict (id) do update set upi_id = $1, payee_name = $2, hook_key = $3, updated_by = 'e2e'`,
    ["tofoe2e@ybl", "TOFO E2E", HOOK_KEY]
  );
  // The server caches settings for thirty seconds; nothing below can work
  // until that lapses, so the check waits rather than reporting a false fail.
  console.log("\nwaiting for the server's settings cache to lapse (30s)…");
  await new Promise((r) => setTimeout(r, 31_000));

  const alice = await makeUser("Alice");
  const bob = await makeUser("Bob");

  // ---- the shelf -----------------------------------------------------------
  console.log("\nthe shelf");
  {
    const shelf = await call("/api/store", alice.token);
    ok(shelf.status === 200, "the store answers a signed-in player");
    ok(shelf.body.packs?.length === 6, `six packs are for sale (${shelf.body.packs?.length})`);
    ok(
      shelf.body.packs?.every((p: any) => p.pricePaise === p.gems * 100),
      "every one priced at 1 gem = ₹1"
    );
    ok(shelf.body.balance?.gems === 0, "a new player holds nothing");
    ok(shelf.body.live === undefined, "and the shelf carries no session list — a QR lives in its window only");

    const anon = await fetch(`${API}/api/store`);
    ok(anon.status === 401, "and it is not readable without a token");
  }

  // ---- buying --------------------------------------------------------------
  console.log("\nbuying");
  let session: any;
  {
    const bought = await call("/api/store/buy", alice.token, { packId: "gems-100" });
    ok(bought.status === 200, "Alice can open a payment over HTTP");
    session = bought.body.session;
    // RELATIVE, never absolute. Whether the list price itself is free depends
    // on what else is live — a run 150 seconds ago, or a real player buying
    // the same pack — and a test that assumes ₹100.00 fails for the one
    // reason the design exists to cause.
    ok(
      session?.amountPaise >= 10_000 && session?.amountPaise <= 10_000 + 99,
      `she is quoted the ₹100 pack's price or a few paise above it (₹${rupees(session?.amountPaise)})`
    );
    ok(String(bought.body.qrDataUrl ?? "").startsWith("data:image/png"), "and the server built the QR");
    ok(String(bought.body.upiUri ?? "").includes("pa=tofoe2e%40ybl"), "which pays the configured id");

    // Pressing Buy again is a NEW payment, a paisa higher, with a fresh clock —
    // never the old one with whatever was left of its timer.
    const encore = await call("/api/store/buy", alice.token, { packId: "gems-100" });
    ok(encore.body.session?.id !== session.id, "pressing Buy again opens a new payment, not the old one");
    ok(
      encore.body.session?.amountPaise === session.amountPaise + 1,
      `at one paisa more (₹${rupees(encore.body.session?.amountPaise)})`
    );
    // …and the FIRST amount is still held, so a code screenshotted before is
    // still payable. That is the whole point of not releasing on close.
    const firstStillLive = await call(`/api/store/session/${session.id}`, alice.token);
    ok(firstStillLive.body.session?.status === "pending", "and the first one is still live, not cancelled");

    const second = await call("/api/store/buy", bob.token, { packId: "gems-100" });
    ok(
      second.body.session?.amountPaise === session.amountPaise + 2,
      `Bob, buying the same pack, gets the next amount after both of Alice's (₹${rupees(
        second.body.session?.amountPaise
      )})`
    );

    const peek = await call(`/api/store/session/${session.id}`, bob.token);
    ok(peek.status === 404, "Bob cannot read Alice's session even knowing its id");

    const bad = await call("/api/store/buy", alice.token, { packId: "gems-999999" });
    ok(bad.status === 400, "a pack that does not exist is refused");

    // Put Bob's back so it cannot interfere below.
    await call(`/api/store/session/${second.body.session.id}/cancel`, bob.token, {});
  }

  // ---- the open door -------------------------------------------------------
  console.log("\nthe open door — what an unauthenticated route must survive");
  {
    const noKey = await hook({ sender: "Rs.100.00 credited", key: "" });
    ok(noKey.status === 401, "an empty key is refused");

    const wrongKey = await hook({ sender: "Rs.100.00 credited to A/c XX1. UPI Ref. No. 1", key: "hunter2" });
    ok(wrongKey.status === 401, "a wrong key is refused");
    ok(wrongKey.body.ok === false, "…and says nothing about why");

    const junk = await hook(null, "this is not json at all {{{");
    ok(junk.status === 400, "a body that is not JSON is refused, not thrown on");

    const notObject = await hook(null, '["array","not","object"]');
    ok(notObject.status === 400, "…and neither is an array");

    // A payload built to be executed somewhere. It must be a row like any
    // other: refused for the key, recorded, and interpreted as nothing.
    const payload = await hook({
      sender: "<script>alert(1)</script>'; drop table users; --",
      key: "'; drop table payment_sessions; --",
    });
    ok(payload.status === 401, "a payload aimed at the parser is just a wrong key");
    const { rows: alive } = await db.query("select count(*)::int as n from payment_sessions");
    ok(typeof alive[0].n === "number", "and the tables it aimed at are still there");

    // Still credits nothing, even with the RIGHT key, if it is not a payment.
    const notPayment = await hook({ sender: "Your OTP is 445566. Do not share it.", key: HOOK_KEY });
    ok(notPayment.status === 200 && notPayment.body.outcome === "ignored", "an OTP with a valid key is ignored");

    const debit = await hook({ sender: `Rs.100.00 debited from A/c XX1234 UPI Ref ${ref()}`, key: HOOK_KEY });
    ok(debit.body.outcome === "ignored", "a debit with a valid key is ignored");

    const before = await call(`/api/store/session/${session.id}`, alice.token);
    ok(before.body.session.status === "pending", "…and Alice's session is untouched by any of it");
  }

  // ---- the payment ---------------------------------------------------------
  console.log("\nthe payment — the exact message a bank sends");
  {
    // The amount SHE WAS QUOTED, not the list price — that is what her bank
    // message would say, and the difference is the whole collision scheme.
    const quoted = rupees(session.amountPaise);
    const bankRef = ref();
    const sms =
      `${quoted} was credited to Punjab National Bank A/C XXXX9203 linked to VPA garenabysayan@yesg ` +
      `at 17:05 on 2026-08-23. UPI Ref. No. ${bankRef}. - Groww`;
    const paid = await hook({ sender: sms, key: HOOK_KEY });
    ok(paid.status === 200, "the webhook accepts it");
    ok(paid.body.outcome === "verified", `and matches it to a session (${paid.body.outcome})`);
    ok(String(paid.body.detail ?? "").includes("100 gems"), `naming what went out — "${paid.body.detail}"`);

    const after = await call(`/api/store/session/${session.id}`, alice.token);
    ok(after.body.session.status === "paid", "Alice's session reads as paid");
    ok(after.body.balance.gems === 100, `and her balance is 100 gems (${after.body.balance.gems})`);

    const wallet = await call("/api/store/wallet", alice.token);
    ok(wallet.body.ledger?.[0]?.reason === "purchase", "her statement says where they came from");
    ok(
      wallet.body.balance.spentPaise === session.amountPaise,
      `and records the ₹${quoted} she actually paid, not the list price`
    );

    // The retry. MacroDroid resends; a retry must never be a second hundred.
    const retry = await hook({ sender: sms, key: HOOK_KEY });
    ok(retry.body.outcome === "duplicate", `the same message again is a duplicate (${retry.body.outcome})`);
    const still = await call("/api/store/wallet", alice.token);
    ok(still.body.balance.gems === 100, "and she still has exactly 100");

    // Money arriving for nobody.
    const orphan = await hook({
      sender: `Rs.1357.00 credited to A/c XX9203. UPI Ref. No. ${ref()}. -Bank`,
      key: HOOK_KEY,
    });
    ok(orphan.body.outcome === "unmatched", "an amount nobody was quoted is reported unmatched");
  }

  // ---- the flood -----------------------------------------------------------
  console.log("\nthe flood — an open route that cannot be made to do work");
  {
    // Well past the limit, all at once. Every one must get an answer, and the
    // log must gain ONE row for the flood rather than one per request.
    const { rows: logBefore } = await db.query("select count(*)::int as n from payment_hook_log");
    const answers = await Promise.all(
      Array.from({ length: 45 }, () => hook({ sender: "flood", key: "nope" }).then((r) => r.status))
    );
    ok(
      answers.every((s) => s === 401 || s === 429),
      "every request in a flood is answered, none hangs"
    );
    ok(answers.includes(429), `and the limit bites (${answers.filter((s) => s === 429).length} refused outright)`);
    const { rows: logAfter } = await db.query("select count(*)::int as n from payment_hook_log");
    ok(
      logAfter[0].n - logBefore[0].n <= 6,
      `the log gained ${logAfter[0].n - logBefore[0].n} rows for 45 requests — the knocking is not the attack`
    );

    const health = await fetch(`${API}/health`);
    ok(health.ok, "and the server is still serving everything else");
    // …and forget it again, so the next run does not start refused.
    await forgetRateLimit();
  }

  const { rows: mine } = await db.query(
    "select id from payment_hook_log where created_at > now() - interval '5 minutes'"
  );
  hookIds.push(...mine.map((r: any) => Number(r.id)));
} finally {
  try {
    for (const id of ids) await db.query("delete from users where id = $1", [id]);
    for (const id of hookIds) await db.query("delete from payment_hook_log where id = $1", [id]);
    if (restore) {
      await db.query(
        "update payment_settings set upi_id = $1, payee_name = $2, hook_key = $3, updated_by = $4 where id = 1",
        [restore.upi_id, restore.payee_name, restore.hook_key, restore.updated_by]
      );
      console.log("payment settings put back the way they were");
    } else {
      await db.query("delete from payment_settings where id = 1");
    }
  } catch (err) {
    console.error("cleanup failed:", err);
  }
  await forgetRateLimit().catch(() => undefined);
  redis.disconnect();
  await db.end();
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
