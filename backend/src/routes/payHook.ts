// The one door this platform leaves open on purpose.
//
// A phone that receives a bank SMS cannot hold a session, so the route that
// receives the forwarded message has to be reachable by anybody who finds the
// URL. Everything below follows from taking that seriously:
//
//   IT PROVES NOTHING BY ITSELF. The only thing that turns a request into a
//   payment is a shared key, compared in constant time, and an amount that
//   matches a live session. Reaching this URL is not the same as being paid.
//
//   IT CANNOT BE MADE TO DO WORK. Its own body parser with a tight limit, its
//   own JSON parse inside a try, a rate limit ahead of the database, and a
//   ceiling on how many refusals one address may write to the log. A scanner
//   costs one Redis INCR.
//
//   IT TOUCHES NOTHING BUT MONEY. No game state, no sockets beyond telling one
//   player their gems arrived, no interpretation of anything it was sent. The
//   body is stored as text, truncated, and rendered escaped by the console. A
//   payload built to be executed somewhere is a row here like any other.
//
//   IT NEVER THROWS. Anything unexpected is caught, logged and answered. A
//   crash on this route is a payment nobody hears about.
//
// It is mounted OUTSIDE the /api maintenance gate deliberately: a session
// opened before a maintenance window still has money in the air, and the SMS
// for it must land whatever else the platform is doing.
import express, { Router } from "express";
import type { Server } from "socket.io";
import { timingSafeEqual } from "node:crypto";
import { redis } from "../redis.js";
import { requestOrigin } from "../services/clientIp.js";
import { logEvent } from "../services/eventLog.js";
import { getSettings, logHook, resolveHook, sessionOwner, settleFromSms } from "../services/payments.js";
import { parseSms } from "../services/smsParse.js";
import { getBalance } from "../services/wallet.js";

/** Bigger than any SMS and smaller than anything worth sending here. */
const BODY_LIMIT = "16kb";
/** Per address, per minute. A real phone sends one of these every few minutes. */
const RATE_MAX = 20;
const RATE_WINDOW_SEC = 60;
/** How many refusals one address may write into the log per hour. Enough to
 *  SEE that somebody is knocking; not enough for the knocking to be the
 *  attack. */
const BAD_LOG_MAX = 3;

/** Constant time, and length-safe. `timingSafeEqual` throws on a length
 *  mismatch, which would otherwise leak the key's length through a 500. */
function keyMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** MacroDroid, Tasker and whatever comes next all name their fields
 *  differently. Be liberal about the label, strict about everything after it. */
function pick(body: Record<string, unknown>, names: string[]): string {
  for (const n of names) {
    const v = body[n];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
  }
  return "";
}

export function payHookRouter(io: Server) {
  const router = Router();

  // Its OWN parser. The route reads the raw bytes and does the JSON itself, so
  // a malformed body becomes a logged row rather than an exception thrown by
  // middleware into a handler that never runs.
  router.post("/sms", express.raw({ type: () => true, limit: BODY_LIMIT }), async (req, res) => {
    const ip = requestOrigin(req).ip;

    try {
      // ---- 1. the rate limit, ahead of everything that costs anything ----
      const rateKey = `pay:hook:rl:${ip ?? "unknown"}`;
      const hits = await redis.incr(rateKey);
      if (hits === 1) await redis.expire(rateKey, RATE_WINDOW_SEC);
      if (hits > RATE_MAX) {
        // Exactly one row for the whole flood, written the moment it becomes
        // one. Logging every refusal would make the log the denial of service.
        if (hits === RATE_MAX + 1) {
          await logHook({
            outcome: "rejected",
            detail: `More than ${RATE_MAX} requests in a minute from this address — the rest are being refused unlogged`,
            body: "",
            ip,
          }).catch(() => undefined);
        }
        res.status(429).json({ ok: false, error: "too many requests" });
        return;
      }

      const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");

      // ---- 2. is it even JSON ----
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        body = parsed as Record<string, unknown>;
      } catch {
        await logHook({ outcome: "malformed", detail: "Body was not a JSON object", body: raw, ip });
        res.status(400).json({ ok: false, error: "expected a json object" });
        return;
      }

      const key = pick(body, ["key", "password", "pass", "secret", "token"]);
      const text = pick(body, ["sender", "message", "text", "sms", "body", "msg"]);

      // ---- 3. the key ----
      const settings = await getSettings();
      if (!settings.hookKey || !keyMatches(key, settings.hookKey)) {
        const badKey = `pay:hook:bad:${ip ?? "unknown"}`;
        const bad = await redis.incr(badKey);
        if (bad === 1) await redis.expire(badKey, 3600);
        if (bad <= BAD_LOG_MAX) {
          await logHook({
            outcome: "rejected",
            detail: settings.hookKey
              ? "Wrong key — nothing was read from this request"
              : "No webhook key is set in Payment management, so everything is refused",
            // The body IS kept for a refused request: what somebody sends to a
            // door they cannot open is exactly what an admin wants to see. The
            // key itself is not — logging a guess is logging a credential.
            body: raw.slice(0, 2000).replace(key, key ? "«key»" : ""),
            ip,
          });
        }
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
      }

      // ---- 4. is it a payment ----
      if (!text.trim()) {
        await logHook({ outcome: "ignored", detail: "No message in the request", body: raw, ip });
        res.json({ ok: true, outcome: "ignored", detail: "no message" });
        return;
      }

      const parsed = parseSms(text);
      if (parsed.amountPaise === null) {
        await logHook({
          outcome: "ignored",
          detail: `Not a payment — ${parsed.why}`,
          body: text,
          upiRef: parsed.upiRef,
          ip,
        });
        res.json({ ok: true, outcome: "ignored", detail: parsed.why });
        return;
      }

      // ---- 5. whose is it ----
      // The log row is written FIRST, so that a crash between settling and
      // logging leaves a record of the money rather than none. The id it
      // returns is then stamped onto the session it paid for.
      const hookId = await logHook({
        outcome: "unmatched",
        detail: "Matching…",
        body: text,
        amountPaise: parsed.amountPaise,
        upiRef: parsed.upiRef,
        ip,
      });

      const result = await settleFromSms({
        amountPaise: parsed.amountPaise,
        upiRef: parsed.upiRef,
        hookId,
      });

      // Correct the row now that we know. One UPDATE on a row we just wrote.
      await resolveHook(hookId, {
        outcome: result.outcome,
        detail: result.detail,
        sessionId: result.session?.id ?? null,
        uid: result.session?.uid ?? null,
      });

      if (result.outcome === "verified" && result.session) {
        logEvent({
          type: "store.paid",
          uid: result.session.uid,
          data: {
            packId: result.session.packId,
            gems: result.session.gems,
            amountPaise: result.session.amountPaise,
            upiRef: parsed.upiRef,
          },
        });
        // Tell the player, if they are still looking at the QR. Never awaited
        // in a way that could delay the answer to the bank's phone, and never
        // fatal: the popup polls as well, precisely so that this is a nicety.
        void notifyPaid(io, result.session.id).catch(() => undefined);
      }

      res.json({ ok: true, outcome: result.outcome, detail: result.detail });
    } catch (err) {
      console.error("[payhook] unhandled:", err);
      // Say nothing useful, record everything. A 500 here is a bug on our side
      // and the forwarder should retry, so it gets a 500 rather than a 200.
      await logHook({
        outcome: "malformed",
        detail: `The server failed while handling this: ${err instanceof Error ? err.message : "unknown"}`,
        body: Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "",
        ip,
      }).catch(() => undefined);
      res.status(500).json({ ok: false, error: "server error" });
    }
  });

  return router;
}

/** "Your gems are here" — to that player's own room, with the new balance
 *  already in it so the HUD does not have to go and ask.
 *
 *  A nicety and nothing more: the popup polls as well, because a socket that
 *  happens to be reconnecting must never be the reason somebody's purchase
 *  looks like it failed. */
async function notifyPaid(io: Server, sessionId: string): Promise<void> {
  const userId = await sessionOwner(sessionId);
  if (!userId) return;
  const balance = await getBalance(userId);
  io.to(`user:${userId}`).emit("wallet:update", { balance, paidSessionId: sessionId });
}
