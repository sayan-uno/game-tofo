// Username rules (the client mirrors these for live feedback, but this file
// is the enforcement):
//   - 2–15 characters, counted in Unicode code points (the unit varchar(15)
//     counts, so DB and app can never disagree)
//   - no ASCII whitespace or control characters — real spaces break layouts
//     and logs; exotic Unicode (including invisible letters) is deliberately
//     allowed, Free Fire style
//   - unique across all players, case-insensitively
//   - claimed exactly once; there is no rename flow (yet)
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import type { UserRow } from "./users.js";

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 15;

// ASCII space + control chars (NUL–US, DEL). Nothing above U+007F is banned.
const FORBIDDEN = /[\u0000-\u0020\u007f]/;

export type UsernameCheck = { ok: true; username: string } | { ok: false; error: string };

export function validateUsername(raw: unknown): UsernameCheck {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, error: "Username is required" };
  const length = [...raw].length; // code points, not UTF-16 units — an emoji counts as 1
  if (length < USERNAME_MIN) return { ok: false, error: `At least ${USERNAME_MIN} characters` };
  if (length > USERNAME_MAX) return { ok: false, error: `${USERNAME_MAX} characters max` };
  if (FORBIDDEN.test(raw)) return { ok: false, error: "Spaces aren't allowed" };
  return { ok: true, username: raw };
}

/** Advisory pre-check for the live availability probe. The real gate is the
 *  unique index on lower(username) — this query rides the same index. */
export async function isUsernameTaken(username: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`)
    .limit(1);
  return !!row;
}

export type ClaimResult = { user: UserRow; error?: never } | { user?: never; error: "taken" | "already-set" | "not-found" };

/** One-shot claim: succeeds only while the caller has no username yet, so a
 *  username can never be overwritten. Caller must have validated `username`.
 *  A race between two players over the same name resolves at the unique
 *  index: the loser gets a clean "taken". */
export async function claimUsername(userId: string, username: string): Promise<ClaimResult> {
  try {
    const [row] = await db
      .update(users)
      .set({ username })
      .where(and(eq(users.id, userId), isNull(users.username)))
      .returning();
    if (row) return { user: row };
  } catch (err: unknown) {
    // (drizzle may wrap the pg error, so check `cause` too)
    const pgErr = ((err as { cause?: unknown }).cause ?? err) as { code?: string; constraint?: string };
    if (pgErr.code === "23505" && (pgErr.constraint ?? "").includes("username")) return { error: "taken" };
    throw err;
  }
  // Nothing updated — either the user is gone or the username already exists.
  const [existing] = await db.select().from(users).where(eq(users.id, userId));
  return { error: existing ? "already-set" : "not-found" };
}

/** The Skip flow: build a tag from the Google name — whitespace squeezed out
 *  ("Sayan Mondal" → "SayanMondal"), cut to 15 code points — then, if taken,
 *  append random digit tails (shrinking the base so the total stays 15) until
 *  a free one lands. */
export async function claimGeneratedUsername(userId: string, googleName: string): Promise<ClaimResult> {
  const cleaned = [...googleName.replace(/[\u0000-\u0020\u007f]/g, "")];
  const base = cleaned.length >= USERNAME_MIN ? cleaned : [..."Player"];
  for (let attempt = 0; attempt < 10; attempt++) {
    // Attempt 0 is the clean name itself; 3-digit tails cover friendly cases,
    // 6-digit tails (a million combinations) make later attempts sure things.
    const tailLen = attempt === 0 ? 0 : attempt < 4 ? 3 : 6;
    const tail = tailLen === 0 ? "" : String(Math.floor(Math.random() * 10 ** tailLen)).padStart(tailLen, "0");
    const candidate = base.slice(0, USERNAME_MAX - tailLen).join("") + tail;
    const result = await claimUsername(userId, candidate);
    if (result.user || result.error !== "taken") return result;
  }
  return { error: "taken" };
}
