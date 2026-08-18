// The authenticator app half of signing in.
//
// The secret crosses once, as a QR code at enrolment, and after that only six
// digits ever travel — derived on both sides from the shared secret and the
// clock. That is why this works on a plane, why a code seen over a shoulder is
// worthless in thirty seconds, and why the two rules below matter:
//
//   TOLERANCE  ±30 seconds — one period either side, for clock drift between
//              the phone and the server. Wider is a real weakening; narrower
//              rejects honest codes typed a moment late.
//   REPLAY     A code is accepted ONCE. The time step it belonged to is stored,
//              and anything not strictly newer is refused — otherwise a code
//              read over a shoulder stays usable for the rest of its window.
import { generateSecret, generateURI, verifySync, type VerifyResult } from "otplib";
import QRCode from "qrcode";
import { decryptSecret, encryptSecret } from "./crypto.js";

const ISSUER = "TOFO Admin";
/** Seconds, past and future. otplib v13 takes a tolerance in SECONDS — not a
 *  count of periods, which is what the older API took and what every example
 *  on the internet still says. */
const TOLERANCE: [number, number] = [30, 30];

export interface Enrolment {
  /** Encrypted — this is what goes in the database. */
  secretEnc: string;
  /** The otpauth:// URI the QR code encodes. */
  uri: string;
  /** For the "can't scan it?" fallback. Shown once, never stored in the clear. */
  secret: string;
}

/** The QR as a data URI, rendered here so the console UI needs no QR library
 *  of its own — one less dependency on the page that guards everything. */
export const qrFor = (uri: string): Promise<string> =>
  QRCode.toDataURL(uri, { margin: 1, width: 240, color: { dark: "#0d0b0f", light: "#ffffff" } });

export function newEnrolment(email: string): Enrolment {
  const secret = generateSecret();
  return { secret, secretEnc: encryptSecret(secret), uri: generateURI({ issuer: ISSUER, label: email, secret }) };
}

export type TotpResult = { ok: true; step: number } | { ok: false; reason: "bad-code" | "replay" | "unreadable" };

/** Check a code against an admin's stored secret.
 *
 *  `lastStep` is the newest time step already accepted for this admin; pass
 *  what is in the database and write back the step this returns. */
export function checkCode(secretEnc: string, token: string, lastStep: number | null): TotpResult {
  if (!/^\d{6}$/.test(token.trim())) return { ok: false, reason: "bad-code" };
  let secret: string;
  try {
    secret = decryptSecret(secretEnc);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  // The functional verifySync is shared by TOTP and HOTP, so its declared
  // return type is the union of both and loses `timeStep` — which is the field
  // replay protection is built on. The root re-exports the TOTP result type;
  // naming it here is the narrowing, not a guess.
  const result = verifySync({ token: token.trim(), secret, epochTolerance: TOLERANCE }) as VerifyResult;
  if (!result.valid) return { ok: false, reason: "bad-code" };
  if (lastStep !== null && result.timeStep <= lastStep) return { ok: false, reason: "replay" };
  return { ok: true, step: result.timeStep };
}
