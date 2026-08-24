// Reading a bank's SMS.
//
// This is the whole gateway's weakest joint and it is worth being explicit
// about why: a bank tells you an amount arrived and NOTHING about who sent it.
// So the amount has to be the identity (see services/payments.ts, which makes
// every live amount unique), and this file's only job is to get that amount
// out of a sentence written by somebody at a bank — exactly, or not at all.
//
// Three rules it must never break:
//
//   NEVER FLOAT. "100.01" parsed as a double is 100.00999999999999, and a
//   rounding that goes the wrong way matches the wrong session or none at all.
//   Every amount here is built by INTEGER STRING ARITHMETIC into paise.
//
//   A DEBIT IS NOT A CREDIT. The same phone receives both. An amount is only
//   taken from a message that says money ARRIVED.
//
//   AN ACCOUNT NUMBER IS NOT AN AMOUNT. "A/C XXXX9203 credited with Rs.100"
//   contains two numbers next to a credit verb and only one of them is money.
//   A number is only believed when it carries a currency marker or a decimal
//   part, and never when it is glued to the masking characters that mark an
//   account — which is what the lookbehind below is for.
import { rupees } from "./money.js";

export { rupees };

export interface ParsedSms {
  /** Whole paise. Null when this was not a credit notification at all. */
  amountPaise: number | null;
  /** The bank's own reference, the only identifier both sides share. Used to
   *  make a redelivered SMS a no-op instead of a second credit. */
  upiRef: string | null;
  /** Why it was not read as a payment, for the log. */
  why: string;
}

/** "1,234.5" → 123450 paise. String arithmetic on purpose — see above. */
export function toPaise(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  const total = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  return Number.isSafeInteger(total) ? total : null;
}

// Group 1 = the currency marker, if the bank wrote one. Group 2 = the number.
// The lookbehind refuses a number welded to the characters banks mask account
// numbers with, so "XXXX9203" can never be read as ninety-two rupees.
const MONEY = String.raw`((?:rs\.?|inr|₹)\s*)?(?<![0-9A-Za-z*#])([0-9][0-9,]*(?:\.[0-9]{1,2})?)`;

/** Every shape that means "this much arrived". The regex engine takes the
 *  LEFTMOST match, and in a real credit message the amount comes before the
 *  account it landed in, so ordering plus leftmost is what picks the money. */
const CREDIT_PATTERNS: RegExp[] = [
  new RegExp(`${MONEY}\\s*(?:was|is|has been|have been)?\\s*credited`, "i"),
  new RegExp(`credited\\s*(?:with|by|for)?\\s*${MONEY}`, "i"),
  new RegExp(`${MONEY}\\s*(?:was|is|has been)?\\s*received`, "i"),
  new RegExp(`received\\s*${MONEY}`, "i"),
  new RegExp(`${MONEY}\\s*(?:was|is|has been)?\\s*deposited`, "i"),
  new RegExp(`credit(?:ed)?\\s*(?:of|:)?\\s*${MONEY}`, "i"),
];

/** Words that mean money LEFT. Not automatically fatal — a credit message may
 *  well name the sender's account — but nothing is taken from a message that
 *  says only this. */
const DEBIT_WORDS = /\b(debited|debit|withdrawn|spent|paid to|sent to|transferred to|purchase of)\b/i;
const CREDIT_WORDS = /\b(credited|credit|received|deposited)\b/i;

/** "UPI Ref. No. 313080502571", and the half-dozen other ways it gets written. */
const REF_PATTERNS: RegExp[] = [
  /upi[\s.]*ref(?:erence)?[\s.]*(?:no\.?|number|id)?[\s.:#-]*([0-9]{6,25})/i,
  /\bref(?:erence)?[\s.]*(?:no\.?|number|id)[\s.:#-]*([0-9]{6,25})/i,
  /\bupi[\s.:#-]*([0-9]{10,25})\b/i,
  /\b(?:txn|transaction)[\s.]*(?:id|no\.?)[\s.:#-]*([A-Za-z0-9]{8,25})\b/i,
];

export function parseSms(text: string): ParsedSms {
  // Bank messages arrive with newlines, non-breaking spaces and the occasional
  // zero-width character. Flattening first lets every pattern above be written
  // for one ordinary space and still match all of them.
  const flat = String(text ?? "")
    .replace(/[\u00a0\u200b-\u200d\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!flat) return { amountPaise: null, upiRef: null, why: "empty message" };

  let upiRef: string | null = null;
  for (const re of REF_PATTERNS) {
    const m = re.exec(flat);
    if (m) {
      upiRef = m[1].slice(0, 32);
      break;
    }
  }

  if (!CREDIT_WORDS.test(flat)) {
    return {
      amountPaise: null,
      upiRef,
      why: DEBIT_WORDS.test(flat) ? "a debit, not a credit" : "no credit wording in the message",
    };
  }

  for (const re of CREDIT_PATTERNS) {
    const m = re.exec(flat);
    if (!m) continue;
    const marker = m[1];
    const number = m[2];
    // Money says so: either the bank named the currency, or it wrote paise.
    // A bare integer next to "credited" is far more often an account than an
    // amount, and guessing wrong here pays the wrong person.
    if (!marker && !number.includes(".")) continue;
    const paise = toPaise(number);
    if (paise === null || paise <= 0) continue;
    return { amountPaise: paise, upiRef, why: "" };
  }

  return { amountPaise: null, upiRef, why: "could not find a credited amount" };
}
