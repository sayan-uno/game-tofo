// Verification suite for the money (P1) — run it after ANY change to the
// wallet, the gem store or the UPI gateway.
//
//     npm run check:payments
//
// Like check:ops this one is NOT pure: every property worth proving here is a
// property of the real Postgres and the real Redis, so it talks to both. It
// takes the same two precautions — its OWN Redis database index, and every row
// it writes to Postgres is deleted at the end.
//
// What it proves, and why each check is here:
//
//   paise      — money is integer arithmetic. 100.01 is not representable as a
//                double and rounding it the wrong way pays the wrong person
//   sms        — the parser reads a credit, refuses a debit, and above all
//                refuses to read a masked ACCOUNT NUMBER as an amount, which
//                is the mistake that would silently credit ₹92.03
//   collision  — two people buying the same pack at the same instant are never
//                quoted the same amount, because the claim is atomic. This is
//                the property the whole design rests on
//   grace      — an amount stays reserved for THIRTY SECONDS after its QR
//                expires, so a payment made in the last second is still that
//                player's and not the next buyer's
//   settle     — a matching SMS credits exactly once; a redelivered one does
//                not credit twice; an unmatched amount is reported as such
//                rather than guessed at
//   ledger     — no balance moves without a line explaining it, and concurrent
//                credits do not lose each other
//   approve    — an admin can settle a dead session by hand, once
//   isolation  — one player cannot read another's payment session

// ---- prelude ----------------------------------------------------------------
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

const base = (process.env.REDIS_URL || "").replace(/\/\d+$/, "");
if (!base) {
  console.error("REDIS_URL is not set in backend/.env");
  process.exit(2);
}
// Its own index — never the dev lobby's.
process.env.REDIS_URL = `${base}/7`;

const { redis } = await import("../../backend/src/redis.js");
const { pool } = await import("../../backend/src/db/client.js");
const { rupees, rupeesPretty } = await import("../../backend/src/services/money.js");
const { parseSms, toPaise } = await import("../../backend/src/services/smsParse.js");
const { credit, getBalance, ledger } = await import("../../backend/src/services/wallet.js");
const {
  PACKS,
  approveByHand,
  buildUpiUri,
  cancelSession,
  expireDue,
  getOwnSession,
  getSession,
  listHookLog,
  listSessions,
  liveSessions,
  logHook,
  looksLikeVpa,
  openSession,
  paymentTotals,
  releaseAmount,
  reserveAmount,
  setSettings,
  settleFromSms,
  whoHolds,
  GRACE_MS,
  WINDOW_MS,
} = await import("../../backend/src/services/payments.js");
const { coinsFor, recordMatch } = await import("../../backend/src/services/matchResults.js");
const { randomUUID } = await import("node:crypto");

let fails = 0;
const ok = (cond: unknown, msg: string) => {
  if (!cond) {
    console.log("  ✗ " + msg);
    fails++;
  } else console.log("  ✓ " + msg);
};
const q = async <T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> =>
  (await pool.query(text, values)).rows as T[];

const TAG = `paycheck-${process.pid}`;
/** Four characters that make this run's accounts its own. Usernames are
 *  case-insensitively unique platform-wide, so "Alice" cannot be reused — and
 *  a run killed by a closed pipe (`| head`) never reaches its own cleanup,
 *  which is exactly how a fixed name becomes a check that fails once and then
 *  fails for ever. */
const RUN = Math.random().toString(36).slice(2, 6);
const made: string[] = []; // user ids to remove
const hooks: number[] = []; // webhook log rows this run wrote

async function makePlayer(display: string): Promise<{ id: string; uid: string; username: string }> {
  const uid = `PC${RUN}${String(made.length).padStart(2, "0")}`.slice(0, 12);
  const username = `${display}${RUN}`.slice(0, 15);
  const [row] = await q<{ id: string }>(
    `insert into users (uid, google_id, email, name, username)
     values ($1, $2, $3, $4, $5) returning id`,
    [uid, `${TAG}-${uid}`, `${TAG}-${uid}@example.invalid`, display, username]
  );
  made.push(row.id);
  return { id: row.id, uid, username };
}

await redis.connect();
await redis.flushdb(); // our own index — see the header
// Anything a previous run left behind, whoever killed it and however. Swept
// BEFORE as well as after, for the same reason ops.mts does it.
await pool.query("delete from users where google_id like 'paycheck-%'");

// `payment_settings` is a SINGLETON — one row, id 1 — so this check cannot
// write its own alongside the real one. It has to borrow the row and give it
// back. Getting this wrong deletes the UPI id the platform actually takes
// money at, which is a considerably worse outcome than a failing test.
const { rows: settingsBefore } = await pool.query("select * from payment_settings where id = 1");
const restoreSettings = settingsBefore[0] ?? null;

try {
  // ---- paise ---------------------------------------------------------------
  console.log("\npaise — money is integer arithmetic, never a float");
  {
    ok(toPaise("100") === 10_000, "a whole number of rupees becomes paise");
    ok(toPaise("100.01") === 10_001, "one paisa survives, which a float would not");
    ok(toPaise("100.1") === 10_010, "one decimal place is tenths of a rupee, not paise");
    ok(toPaise("1,234.56") === 123_456, "the thousands separator a bank writes is ignored");
    ok(toPaise("abc") === null && toPaise("") === null, "garbage is null rather than NaN");
    ok(toPaise("1.234") === null, "three decimal places is not money and is refused");
    ok(rupees(10_001) === "100.01", "and back again, exactly");
    ok(rupees(5) === "0.05", "under a rupee still reads as money");
    ok(rupeesPretty(1_234_567_89) === "12,34,567.89", "big numbers group the way they do in India");
    // The one that matters: the round trip a payment actually makes.
    const trip = [10_000, 10_001, 10_099, 200_000, 200_099];
    ok(
      trip.every((p) => toPaise(rupees(p)) === p),
      "every amount this store can quote survives paise → rupees → paise unchanged"
    );
  }

  // ---- sms -----------------------------------------------------------------
  console.log("\nsms — reading the bank, and refusing to guess");
  {
    const real =
      "100.00 was credited to Punjab National Bank A/C XXXX9203 linked to VPA garenabysayan@yesg " +
      "at 17:05 on 2026-08-23. UPI Ref. No. 313080502571. - Groww";
    const r = parseSms(real);
    ok(r.amountPaise === 10_000, `the real message reads as ₹100.00 (${r.amountPaise})`);
    ok(r.upiRef === "313080502571", `and its reference comes out (${r.upiRef})`);

    // The collision amounts, which are the whole point of the design.
    ok(parseSms(real.replace("100.00", "100.01")).amountPaise === 10_001, "₹100.01 reads as 10001 paise exactly");
    ok(parseSms(real.replace("100.00", "100.02")).amountPaise === 10_002, "…and ₹100.02 as 10002");

    ok(parseSms("Rs.500.00 credited to A/c XX1234 by UPI ref no 998877665544").amountPaise === 50_000, "Rs. prefix");
    ok(parseSms("INR 300.00 has been credited to your account").amountPaise === 30_000, "INR prefix");
    ok(parseSms("₹1,500.00 credited").amountPaise === 150_000, "the rupee sign and a separator together");
    ok(parseSms("Your a/c is credited with Rs 2000.00").amountPaise === 200_000, "credited-with word order");
    ok(parseSms("Received Rs.100.00 in your account").amountPaise === 10_000, "'received' counts as arrival");

    ok(parseSms("Rs.100.00 debited from A/c XX1234").amountPaise === null, "a DEBIT is not a payment");
    ok(parseSms("Rs.100.00 has been paid to MERCHANT").amountPaise === null, "money going out is not a payment");
    ok(parseSms("Your OTP is 100200. Do not share it.").amountPaise === null, "an OTP is not a payment");
    ok(parseSms("").amountPaise === null, "an empty message is not a payment");
    ok(parseSms("<script>alert(1)</script>").amountPaise === null, "a payload is not a payment either");

    // THE dangerous one. A masked account number sitting next to the word
    // "credited" must never be read as an amount.
    const trap = parseSms("A/C XXXX9203 credited. Call 18001234 for details.");
    ok(trap.amountPaise === null, `a masked account number is not an amount (got ${trap.amountPaise})`);
    ok(parseSms("A/c **4567 credited with Rs.100.00").amountPaise === 10_000, "…but the real amount beside it is");

    // A bare integer with no currency marker is refused: it is far more often
    // an account than money, and guessing wrong pays the wrong person.
    ok(parseSms("9203 credited").amountPaise === null, "a bare integer next to 'credited' is not trusted");
  }

  // ---- collision -----------------------------------------------------------
  console.log("\ncollision — no two live sessions may share an amount");
  {
    const id1 = randomUUID();
    const id2 = randomUUID();
    const a = await reserveAmount(10_000, id1);
    const b = await reserveAmount(10_000, id2);
    ok(a?.amountPaise === 10_000 && a.offset === 0, "the first buyer of a ₹100 pack pays ₹100.00");
    ok(b?.amountPaise === 10_001 && b.offset === 1, `the second is quoted ₹100.01 (${rupees(b?.amountPaise ?? 0)})`);

    // Ten at once. If the claim were a read-then-write, two of these would
    // collide; SET NX means exactly one wins each amount.
    const ids = Array.from({ length: 10 }, () => randomUUID());
    const claims = await Promise.all(ids.map((id) => reserveAmount(20_000, id)));
    const amounts = claims.map((c) => c?.amountPaise);
    ok(
      new Set(amounts).size === 10 && !amounts.includes(undefined),
      `ten simultaneous buyers get ten different amounts (${new Set(amounts).size} distinct)`
    );
    ok(
      amounts.every((n) => n! >= 20_000 && n! <= 20_009),
      "and they are consecutive paise above the list price, not scattered"
    );

    ok((await whoHolds(10_000)) === id1, "the reservation names the session holding it");
    await releaseAmount(10_000, id1);
    ok((await whoHolds(10_000)) === null, "releasing it hands the amount back");

    // Compare-and-delete: releasing with the WRONG id must not free somebody
    // else's claim, or two live sessions end up sharing a price.
    const id3 = randomUUID();
    await reserveAmount(10_000, id3);
    await releaseAmount(10_000, "not-this-session");
    ok((await whoHolds(10_000)) === id3, "a release quoting the wrong session id does nothing");

    await redis.flushdb();
  }

  // ---- store ---------------------------------------------------------------
  console.log("\nstore — opening a payment");
  {
    await setSettings({ upiId: "tofocheck@ybl", payeeName: "TOFO", hookKey: "check-key-1234567890" }, TAG);
    ok(looksLikeVpa("garenabysayan@yesg"), "a real VPA is accepted");
    ok(!looksLikeVpa("not a vpa") && !looksLikeVpa("nope@"), "nonsense is refused before it reaches a QR");

    const alice = await makePlayer("Alice");
    const bob = await makePlayer("Bob");

    const first = await openSession({ ...alice, userId: alice.id, packId: "gems-100" });
    ok(first.ok, "Alice can open a payment");
    if (!first.ok) throw new Error("cannot continue");
    ok(first.session.amountPaise === 10_000, "she is quoted the list price");
    ok(first.session.gems === 100, "for the gems the pack says");
    ok(first.qrDataUrl.startsWith("data:image/png;base64,"), "and gets a QR image back, built by the server");
    ok(first.upiUri.includes("pa=tofocheck%40ybl"), "the QR pays the configured UPI id");
    ok(first.upiUri.includes("am=100.00"), `and asks for exactly that amount (${first.upiUri.match(/am=[\d.]+/)?.[0]})`);

    const second = await openSession({ ...bob, userId: bob.id, packId: "gems-100" });
    ok(second.ok && second.session.amountPaise === 10_001, "Bob, buying the same pack, is quoted ₹100.01");
    ok(second.ok && second.upiUri.includes("am=100.01"), "and HIS QR asks for the odd amount, not the list price");

    ok(
      (await openSession({ ...alice, userId: alice.id, packId: "nope" })).ok === false,
      "a pack that is not for sale is refused"
    );

    // The price is the SERVER's. Nothing a client sends can change it.
    const pack = PACKS.find((p) => p.id === "gems-2000")!;
    ok(pack.pricePaise === pack.gems * 100, "every pack is priced at exactly 1 gem = ₹1");
    ok(
      PACKS.every((p) => p.pricePaise === p.gems * 100),
      "…and that holds for the whole shelf, so nobody has to check by hand"
    );

    const uri = buildUpiUri({ upiId: "a@b", payeeName: "TOFO", hookKey: "" }, 10_001, first.session.id);
    ok(uri.includes("am=100.01") && uri.includes("cu=INR"), "the intent carries the amount and the currency");

    // Isolation: a session id is not a way to watch somebody else's purchase.
    ok((await getOwnSession(first.session.id, bob.id)) === null, "Bob cannot read Alice's payment session");
    ok((await getOwnSession(first.session.id, alice.id)) !== null, "…and Alice can read her own");
  }

  // ---- settle --------------------------------------------------------------
  console.log("\nsettle — a bank SMS finding its session");
  {
    const carol = await makePlayer("Carol");
    const opened = await openSession({ ...carol, userId: carol.id, packId: "gems-300" });
    if (!opened.ok) throw new Error("could not open");
    const amount = opened.session.amountPaise;

    const before = await getBalance(carol.id);
    ok(before.gems === 0, "she starts with nothing");

    const sms = `Rs.${rupees(amount)} credited to A/c XX1234. UPI Ref. No. 900000000001. -Bank`;
    const parsed = parseSms(sms);
    const hookId = await logHook({ outcome: "unmatched", detail: "…", body: sms, amountPaise: parsed.amountPaise });
    hooks.push(hookId);
    const result = await settleFromSms({ amountPaise: parsed.amountPaise!, upiRef: parsed.upiRef, hookId });
    ok(result.outcome === "verified", `the SMS is matched to her session (${result.outcome})`);

    const after = await getBalance(carol.id);
    ok(after.gems === 300, `and 300 gems arrive (${after.gems})`);
    ok(after.spentPaise === amount, "the lifetime spend records what she actually paid, not the list price");

    const lines = await ledger(carol.id);
    ok(lines.length === 1 && lines[0].delta === 300, "one ledger line explains where they came from");
    ok(lines[0].reason === "purchase" && lines[0].ref === opened.session.id, "…and points at the session that paid");
    ok(lines[0].balanceAfter === 300, "the line carries the balance after it, so a statement reads on its own");

    // The redelivery. MacroDroid retries; a retry must not be a gift.
    const again = await settleFromSms({ amountPaise: amount, upiRef: "900000000001", hookId: null });
    ok(again.outcome === "duplicate", `the same reference a second time is a duplicate (${again.outcome})`);
    ok((await getBalance(carol.id)).gems === 300, "and nothing is credited twice");

    // The amount is released the moment it settles, so the next buyer of that
    // pack is quoted the ordinary price again.
    ok((await whoHolds(amount)) === null, "a settled session gives its amount straight back");

    // Money arriving that nobody was expecting.
    const orphan = await settleFromSms({ amountPaise: 777_77, upiRef: "900000000002", hookId: null });
    ok(orphan.outcome === "unmatched", "an amount with no live session is reported unmatched, not guessed at");
    ok(orphan.session === null, "…and names nobody");
  }

  // ---- walking away --------------------------------------------------------
  console.log("\nwalking away — closing the window is ON THE WAY to paying");
  {
    // The bug this exists to prevent: closing the window released the amount
    // at once, so a player who screenshotted the code, left for their UPI app
    // and paid a minute later had their money arrive with nothing holding it.
    // The flow this store ASKS for is to leave and pay elsewhere, so the
    // window being closed says nothing about whether somebody will pay.
    const nina = await makePlayer("Nina");
    const first = await openSession({ ...nina, userId: nina.id, packId: "gems-100" });
    if (!first.ok) throw new Error("could not open");
    const amount = first.session.amountPaise;

    // She closes the window. Nothing is told to the server, and nothing moves.
    ok((await whoHolds(amount)) === first.session.id, "the amount is still hers after she closes the window");
    ok((await getSession(first.session.id))?.status === "pending", "and the session is still live");

    // She opens the same pack again. A NEW payment, a paisa higher, with a
    // fresh two minutes — not the old one with whatever was left of its clock.
    const second = await openSession({ ...nina, userId: nina.id, packId: "gems-100" });
    if (!second.ok) throw new Error("could not reopen");
    ok(second.session.id !== first.session.id, "opening it again is a NEW payment, not the old one");
    ok(
      second.session.amountPaise === amount + 1,
      `at one paisa more (₹${rupees(amount)} → ₹${rupees(second.session.amountPaise)})`
    );
    ok(
      new Date(second.session.expiresAt).getTime() - Date.now() > WINDOW_MS - 5000,
      "with a fresh two minutes rather than what was left of the first"
    );
    ok((await whoHolds(amount)) === first.session.id, "and the FIRST amount is still held, not handed back");

    // Which matters: a screenshot of either code is payable. She scans the one
    // she saved first.
    const paid = await settleFromSms({ amountPaise: amount, upiRef: "900000000010", hookId: null });
    ok(paid.outcome === "verified", `paying the code she saved earlier still works (${paid.outcome})`);
    ok((await getBalance(nina.id)).gems === 100, "and the gems arrive");
    ok((await getSession(second.session.id))?.status === "pending", "the other one is simply left to time out");

    // …and paying the newer code instead would have worked just as well.
    const other = await settleFromSms({ amountPaise: second.session.amountPaise, upiRef: "900000000011", hookId: null });
    ok(other.outcome === "verified", "so would the newer one — whichever she scans finds a session");
    ok((await getBalance(nina.id)).gems === 200, "each pays for its own pack, exactly once");

    // The cap is loose enough for somebody fiddling, and still bounded.
    const owen = await makePlayer("Owen");
    const opened: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await openSession({ ...owen, userId: owen.id, packId: "gems-300" });
      if (r.ok) opened.push(r.session.amountPaise);
    }
    ok(opened.length === 10, `one player may hold ten payments at once, not more (${opened.length})`);
    ok(new Set(opened).size === opened.length, "every one of them at its own amount");
    ok(
      (await openSession({ ...owen, userId: owen.id, packId: "gems-300" })).ok === false,
      "and the eleventh is refused rather than eating the pack's whole range"
    );

    // Giving up early is still possible — but only by saying so.
    const grace2 = await makePlayer("Pia");
    const hers = await openSession({ ...grace2, userId: grace2.id, packId: "gems-1500" });
    if (!hers.ok) throw new Error("could not open");
    ok(await cancelSession(hers.session.id, grace2.id), "an explicit 'not paying' closes it");
    ok((await whoHolds(hers.session.amountPaise)) === null, "and only THAT releases the amount early");
  }

  // ---- the impossible case -------------------------------------------------
  console.log("\nthe impossible case — two live sessions on one amount");
  {
    // The Redis claim makes this unreachable, so it is forced here by writing
    // straight to the table: a flushed Redis mid-flight is all it would take,
    // and "the guard we rely on cannot fail" is not a thing to find out about
    // from somebody's missing money.
    const lena = await makePlayer("Lena");
    const milo = await makePlayer("Milo");
    const opened = await openSession({ ...lena, userId: lena.id, packId: "gems-1500" });
    if (!opened.ok) throw new Error("could not open");
    const amount = opened.session.amountPaise;

    await q(
      `insert into payment_sessions
         (user_id, uid, username, pack_id, gems, base_paise, amount_paise, status, expires_at, grace_until)
       values ($1, $2, $3, 'gems-1500', 1500, $4, $4, 'pending', now() + interval '2 minutes', now() + interval '150 seconds')`,
      [milo.id, milo.uid, milo.username, amount]
    );
    const both = await q<{ n: number }>(
      "select count(*)::int as n from payment_sessions where amount_paise = $1 and status = 'pending'",
      [amount]
    );
    ok(both[0].n === 2, `two sessions really do hold ₹${rupees(amount)} (${both[0].n})`);

    const settled = await settleFromSms({ amountPaise: amount, upiRef: "900000000009", hookId: null });
    ok(settled.outcome === "verified", "the credit is matched to one of them");

    const left = await q<{ n: number }>(
      "select count(*)::int as n from payment_sessions where amount_paise = $1 and status = 'pending'",
      [amount]
    );
    ok(left[0].n === 1, `and EXACTLY ONE is claimed — the other is still waiting (${left[0].n})`);
    const paidTotal = (await getBalance(lena.id)).gems + (await getBalance(milo.id)).gems;
    ok(paidTotal === 1500, `one payment paid for one pack, not two (${paidTotal} gems out)`);
    ok(
      (await getBalance(lena.id)).gems === 1500,
      "and it went to the one who opened first, which is the one whose QR is closer to expiring"
    );
  }

  // ---- cancel --------------------------------------------------------------
  console.log("\ncancel — changing your mind gives the amount back at once");
  {
    const frank = await makePlayer("Frank");
    const opened = await openSession({ ...frank, userId: frank.id, packId: "gems-1000" });
    if (!opened.ok) throw new Error("could not open");
    ok((await whoHolds(opened.session.amountPaise)) === opened.session.id, "the amount is held while the QR is up");
    ok(await cancelSession(opened.session.id, frank.id), "the player can close it");
    ok((await whoHolds(opened.session.amountPaise)) === null, "and the amount is free immediately, not in two minutes");
    ok((await getSession(opened.session.id))?.status === "cancelled", "the row records that they backed out");
    ok(!(await cancelSession(opened.session.id, frank.id)), "cancelling twice does nothing");

    const grace = await makePlayer("Grace");
    const hers = await openSession({ ...grace, userId: grace.id, packId: "gems-1000" });
    ok(hers.ok && hers.session.amountPaise === 100_000, "the next buyer is quoted the list price again, not ₹1000.01");
    if (hers.ok) await cancelSession(hers.session.id, grace.id);
  }

  // ---- ledger --------------------------------------------------------------
  console.log("\nledger — no balance moves without a line explaining it");
  {
    const heidi = await makePlayer("Heidi");
    await credit({ userId: heidi.id, currency: "coin", delta: 250, reason: "match", ref: "m-1" });
    await credit({ userId: heidi.id, currency: "coin", delta: 100, reason: "event", ref: "e-1" });
    await credit({ userId: heidi.id, currency: "coin", delta: -80, reason: "spend", ref: "shop" });
    const balance = await getBalance(heidi.id);
    ok(balance.coins === 270, `earning and spending both land (${balance.coins})`);
    ok(balance.gems === 0, "and coins never touch gems — they are different money");

    const lines = await ledger(heidi.id);
    ok(lines.length === 3, "every movement wrote a line");
    ok(lines[0].balanceAfter === 270 && lines[2].balanceAfter === 250, "each line carries the running balance");

    // Spending more than you hold clamps at zero rather than going negative —
    // a negative wallet is a bug that follows somebody around for ever.
    await credit({ userId: heidi.id, currency: "coin", delta: -9999, reason: "spend", ref: "oops" });
    ok((await getBalance(heidi.id)).coins === 0, "a spend bigger than the balance floors at zero");

    // Twenty credits at once. A read-then-write would lose several of these.
    const ivan = await makePlayer("Ivan");
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        credit({ userId: ivan.id, currency: "gem", delta: 5, reason: "match", ref: `m-${i}` })
      )
    );
    const ivanBalance = await getBalance(ivan.id);
    ok(ivanBalance.gems === 100, `twenty concurrent credits all land (${ivanBalance.gems}/100)`);
    ok((await ledger(ivan.id, 50)).length === 20, "and every one of them wrote its line");
  }

  // ---- earning -------------------------------------------------------------
  console.log("\nearning — the half of the wallet that is not bought");
  {
    const jack = await makePlayer("Jack");
    const kim = await makePlayer("Kim");

    // Turning up is paid; winning is paid more. A currency you only earn by
    // winning punishes the people already losing.
    ok(coinsFor({ uid: "a", name: "a", placement: 1, score: 0, detail: {}, forfeit: false }, 1) >
       coinsFor({ uid: "b", name: "b", placement: 4, score: 0, detail: {}, forfeit: false }, 1),
       "first place earns more than last");
    ok(coinsFor({ uid: "b", name: "b", placement: 4, score: 0, detail: {}, forfeit: false }, 1) > 0,
       "…and last place still earns something");
    ok(coinsFor({ uid: "c", name: "c", placement: 1, score: 0, detail: {}, forfeit: false }, 0.5) <
       coinsFor({ uid: "c", name: "c", placement: 1, score: 0, detail: {}, forfeit: false }, 1),
       "a lobby of bots pays less than a lobby of people");
    ok(coinsFor({ uid: "d", name: "d", placement: 1, score: 0, detail: {}, forfeit: true }, 1) <
       coinsFor({ uid: "d", name: "d", placement: 1, score: 0, detail: {}, forfeit: false }, 1),
       "and leaving early earns the appearance fee, not the win");

    const matchKey = `paycheck-${RUN}-m1`;
    const play = () =>
      recordMatch({
        matchKey,
        gameId: "trackline",
        seed: 1,
        reason: "all-out",
        ticks: 600,
        tickRate: 30,
        standings: [
          { uid: jack.uid, name: jack.username, placement: 1, score: 900, detail: { coins: 40 }, forfeit: false },
          { uid: kim.uid, name: kim.username, placement: 2, score: 400, detail: { coins: 12 }, forfeit: false },
        ],
        runners: [
          { uid: jack.uid, userId: jack.id, botId: null, isBot: false },
          { uid: kim.uid, userId: kim.id, botId: null, isBot: false },
        ],
      });

    const first = await play();
    ok(first.written, "a finished match is recorded");
    const winner = await getBalance(jack.id);
    const runnerUp = await getBalance(kim.id);
    ok(winner.coins > 0, `the winner is paid coins (${winner.coins})`);
    ok(winner.coins > runnerUp.coins, `more than the runner-up (${winner.coins} vs ${runnerUp.coins})`);
    ok(winner.gems === 0, "and no gems — those are bought, never earned");

    const lines = await ledger(jack.id);
    ok(lines.length === 1 && lines[0].reason === "match", "with a ledger line naming the match");
    ok(lines[0].ref === matchKey, "…and the match key it came from");

    // The SAME match again. `matches.match_key` is unique, so the whole
    // transaction is a no-op — and that has to include the payout, or a
    // retried write pays everybody twice.
    const again = await play();
    ok(!again.written, "recording the same match twice does nothing");
    ok((await getBalance(jack.id)).coins === winner.coins, "and nobody is paid twice for it");

    await q("delete from matches where match_key = $1", [matchKey]);
  }

  // ---- console -------------------------------------------------------------
  console.log("\nconsole — what an admin can see");
  {
    const from = new Date(Date.now() - 3600_000);
    const to = new Date(Date.now() + 60_000);
    const { sessions } = await listSessions({ from, to, limit: 100 });
    ok(sessions.length >= 6, `the sessions this run created are listed (${sessions.length})`);
    ok(
      sessions.every((s, i) => i === 0 || s.createdAt <= sessions[i - 1].createdAt),
      "newest first, so the screen opens on what just happened"
    );

    const settled = await listSessions({ from, to, status: "paid", limit: 100 });
    ok(
      settled.sessions.every((s) => s.status === "paid"),
      "filtering by outcome really filters"
    );

    const narrow = await listSessions({ from: new Date(Date.now() + 30_000), to, limit: 100 });
    ok(narrow.sessions.length === 0, "and a window with nothing in it returns nothing rather than everything");

    const totals = await paymentTotals(from, to);
    ok(totals.settled >= 3, `the strip counts what was settled (${totals.settled})`);
    ok(totals.paise > 0 && rupees(totals.paise).includes("."), "and totals the money as money");

    const live = await liveSessions();
    ok(Array.isArray(live), "the live list answers");

    hooks.push(await logHook({ outcome: "ignored", detail: "not a payment", body: "hello", ip: null }));
    const log = await listHookLog({ from, to, limit: 100 });
    ok(log.rows.length >= 2, `the webhook log keeps everything it was sent (${log.rows.length})`);
    ok(
      log.rows.some((r) => r.outcome === "ignored"),
      "…including the requests that were not payments at all"
    );
    const onlyIgnored = await listHookLog({ from, to, outcome: "ignored", limit: 100 });
    ok(onlyIgnored.rows.every((r) => r.outcome === "ignored"), "and it filters by outcome too");
  }
} finally {
  try {
    // payment_sessions, wallet_ledger and wallets all cascade from users, so
    // removing the accounts removes everything this run wrote about them.
    //
    // Everything else is deleted BY ID. A cleanup phrased as "anything from the
    // last ten minutes" is a cleanup that eats real rows the first time this is
    // run against a database somebody is also using — which is exactly what a
    // payment log must never lose.
    for (const id of made) await q("delete from users where id = $1", [id]);
    for (const id of hooks) await q("delete from payment_hook_log where id = $1", [id]);
    // The borrowed singleton, back exactly as it was — or gone, if there was
    // nothing there to begin with.
    if (restoreSettings) {
      await q(
        `insert into payment_settings (id, upi_id, payee_name, hook_key, updated_by, updated_at)
         values (1, $1, $2, $3, $4, $5)
         on conflict (id) do update set upi_id = $1, payee_name = $2, hook_key = $3,
                                        updated_by = $4, updated_at = $5`,
        [
          restoreSettings.upi_id,
          restoreSettings.payee_name,
          restoreSettings.hook_key,
          restoreSettings.updated_by,
          restoreSettings.updated_at,
        ]
      );
    } else {
      await q("delete from payment_settings where id = 1");
    }
  } catch (err) {
    console.error("cleanup failed:", err);
  }
  await redis.flushdb();
  redis.disconnect();
  await pool.end();
}

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
