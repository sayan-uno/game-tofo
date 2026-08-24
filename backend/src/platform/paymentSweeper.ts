// Two housekeeping jobs, on one slow timer.
//
// Neither is load-bearing, and saying so is the point: the Redis reservation
// that makes an amount exclusive carries its own TTL and lets go on its own,
// so a sweeper that never runs cannot strand an amount or lose a payment. All
// this does is stop the console showing rows that say "pending" about
// something that has not been pending for an hour, and keep the open route's
// log from growing for ever.
import { lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { paymentHookLog } from "../db/schema.js";
import { expireDue } from "../services/payments.js";

/** Often enough that a two-and-a-half minute window is never stale for long,
 *  rare enough to be invisible. */
const TICK_MS = 15_000;
/** How long the webhook log is kept. Long enough to answer "who paid ₹300 in
 *  March"; short enough that an open route cannot fill a disk in a year.
 *  Payment SESSIONS are never swept — those are the financial record. */
const HOOK_RETENTION_DAYS = 180;

let tick: NodeJS.Timeout | null = null;
let sinceSweep = 0;

export function startPaymentSweeper(): void {
  if (tick) return;
  tick = setInterval(() => {
    void (async () => {
      try {
        const n = await expireDue();
        if (n > 0) console.log(`[pay] ${n} payment session(s) timed out`);
      } catch (err) {
        console.error("[pay] expire sweep:", err);
      }
      // Retention once an hour, counted in ticks rather than by its own timer
      // so there is one thing to start and one thing to stop.
      if (++sinceSweep >= (3600_000 / TICK_MS)) {
        sinceSweep = 0;
        try {
          const gone = await db
            .delete(paymentHookLog)
            .where(lt(paymentHookLog.createdAt, sql`now() - interval '${sql.raw(String(HOOK_RETENTION_DAYS))} days'`))
            .returning({ id: paymentHookLog.id });
          if (gone.length > 0) console.log(`[pay] swept ${gone.length} webhook log row(s) past retention`);
        } catch (err) {
          console.error("[pay] hook log retention:", err);
        }
      }
    })();
  }, TICK_MS);
  tick.unref();
  console.log("✔ Payment sweeper running (expiry every 15s, webhook log retention hourly)");
}

export function stopPaymentSweeper(): void {
  if (tick) clearInterval(tick);
  tick = null;
}
