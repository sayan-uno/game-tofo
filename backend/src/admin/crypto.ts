// Secrets at rest, and the small primitives the console's sign-in needs.
//
// Two rules shape everything here. A TOTP secret must be recoverable (the
// server has to derive the same six digits the phone does), so it is
// ENCRYPTED, not hashed — and whoever holds it can generate that admin's codes
// for ever, which is why a database dump must not contain it in the clear.
// A password must NOT be recoverable, so it is hashed with a deliberately slow
// function.
//
// The password hash is scrypt from node:crypto rather than argon2id. Argon2 is
// the better function; it is also a native module that has to build or ship a
// binary for whatever host this eventually runs on. Scrypt is memory-hard, in
// the standard library, and entirely adequate for what is the THIRD factor
// behind a Google account and an authenticator app. Recorded here so the
// trade-off is a decision rather than an accident.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "../config.js";

const scryptAsync = promisify(scrypt) as (p: string, s: Buffer, k: number, o: object) => Promise<Buffer>;
/** N=2^16 is roughly 100 ms and 64 MB per attempt — slow enough to make an
 *  offline crack expensive, fast enough that signing in does not feel broken. */
const SCRYPT = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

const encKey = (): Buffer => {
  const key = Buffer.from(config.admin.totpEncKey, "hex");
  if (key.length !== 32) throw new Error("TOTP_ENC_KEY must be 64 hex characters (32 bytes)");
  return key;
};

/** AES-256-GCM. The nonce and tag travel with the ciphertext, so one string is
 *  the whole thing and a column can hold it. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

export function decryptSecret(packed: string): string {
  const [version, iv, tag, body] = packed.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("unreadable encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  // GCM authenticates as it decrypts: a tampered ciphertext throws here rather
  // than returning plausible rubbish.
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, SCRYPT);
  return `s1.${salt.toString("base64url")}.${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [version, salt, expected] = stored.split(".");
  if (version !== "s1" || !salt || !expected) return false;
  const got = await scryptAsync(password, Buffer.from(salt, "base64url"), 32, SCRYPT);
  const want = Buffer.from(expected, "base64url");
  return got.length === want.length && timingSafeEqual(got, want);
}

export const sha256 = (v: string): string => createHash("sha256").update(v).digest("hex");

/** Opaque, high-entropy, and never stored — only its hash is. */
export const newRefreshToken = (): string => randomBytes(32).toString("base64url");

/** Ten of these are shown once at enrolment and then only exist on paper.
 *  Grouped and unambiguous, because they get written down by hand. */
export function newRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I, L, O, 0, 1
  const pick = () => alphabet[randomBytes(1)[0] % alphabet.length];
  const group = () => Array.from({ length: 5 }, pick).join("");
  return `${group()}-${group()}`;
}

/** Constant-time string compare that tolerates different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
