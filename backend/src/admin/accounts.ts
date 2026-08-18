// Who the console's own accounts are.
//
// Deliberately not the players table. A different realm, a different token
// audience, and no path by which a player row could ever become an admin one —
// which means a bug in the game's auth cannot escalate into the console.
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { adminRecoveryCodes, adminUsers } from "../db/schema.js";
import { config } from "../config.js";
import { newRecoveryCode, sha256 } from "./crypto.js";

export type AdminRole = "owner" | "admin" | "moderator" | "support" | "analyst";
export type AdminRow = typeof adminUsers.$inferSelect;

/** Higher outranks lower. `requireAdmin("moderator")` therefore admits an
 *  owner and an admin as well, which is what anyone would expect. */
const RANK: Record<AdminRole, number> = { owner: 5, admin: 4, moderator: 3, support: 2, analyst: 1 };
export const outranks = (have: string, need: AdminRole): boolean =>
  (RANK[have as AdminRole] ?? 0) >= RANK[need];
export const isAdminRole = (v: unknown): v is AdminRole =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(RANK, v);

export async function findAdminByEmail(email: string): Promise<AdminRow | null> {
  const [row] = await db
    .select()
    .from(adminUsers)
    .where(sql`lower(${adminUsers.email}) = ${email.trim().toLowerCase()}`);
  return row ?? null;
}

export async function getAdminById(id: string): Promise<AdminRow | null> {
  const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, id));
  return row ?? null;
}

/** Create the first owner — and ONLY while the table is empty.
 *
 *  That condition is the whole safety argument: once one admin exists this can
 *  never do anything again, so leaving the environment variable set on a live
 *  server is harmless. Adding the second admin is a deliberate act inside the
 *  console, by someone already signed in. */
export async function bootstrapFirstAdmin(): Promise<AdminRow | null> {
  const email = config.admin.bootstrapEmail;
  if (!email) return null;
  const [existing] = await db.select({ id: adminUsers.id }).from(adminUsers).limit(1);
  if (existing) return null;
  const [row] = await db
    .insert(adminUsers)
    .values({ email, name: email.split("@")[0], role: "owner", status: "active" })
    .onConflictDoNothing()
    .returning();
  if (row) console.log(`✔ Created the first admin account (owner): ${email}`);
  return row ?? null;
}

export async function setPendingTotp(adminId: string, secretEnc: string): Promise<void> {
  // activated_at stays null: the secret is not usable until one working code
  // has confirmed the QR was actually scanned correctly.
  await db
    .update(adminUsers)
    .set({ totpSecretEnc: secretEnc, totpActivatedAt: null, totpLastStep: null })
    .where(eq(adminUsers.id, adminId));
}

export async function activateTotp(adminId: string, step: number): Promise<void> {
  await db
    .update(adminUsers)
    .set({ totpActivatedAt: sql`now()`, totpLastStep: step })
    .where(eq(adminUsers.id, adminId));
}

/** Remember the newest accepted time step — this is the replay guard. */
export async function noteTotpStep(adminId: string, step: number): Promise<void> {
  await db.update(adminUsers).set({ totpLastStep: step }).where(eq(adminUsers.id, adminId));
}

export async function noteLogin(adminId: string): Promise<void> {
  await db.update(adminUsers).set({ lastLoginAt: sql`now()` }).where(eq(adminUsers.id, adminId));
}

/** Ten fresh codes, returned in the clear ONCE and stored only as hashes.
 *
 *  Hashed with SHA-256 rather than scrypt, deliberately: a code carries about
 *  fifty bits of entropy, so there is nothing to brute-force, and checking ten
 *  slow hashes per attempt would hand anyone a cheap way to load the server. */
export async function replaceRecoveryCodes(adminId: string): Promise<string[]> {
  const codes = Array.from({ length: 10 }, newRecoveryCode);
  await db.transaction(async (tx) => {
    await tx.delete(adminRecoveryCodes).where(eq(adminRecoveryCodes.adminId, adminId));
    await tx.insert(adminRecoveryCodes).values(codes.map((c) => ({ adminId, codeHash: sha256(c) })));
  });
  return codes;
}

/** Spend one. Returns how many are left, or null when the code was no good. */
export async function consumeRecoveryCode(adminId: string, code: string): Promise<number | null> {
  const hash = sha256(code.trim().toUpperCase());
  const [used] = await db
    .update(adminRecoveryCodes)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(adminRecoveryCodes.adminId, adminId),
        eq(adminRecoveryCodes.codeHash, hash),
        isNull(adminRecoveryCodes.usedAt)
      )
    )
    .returning({ id: adminRecoveryCodes.id });
  if (!used) return null;
  const [{ left }] = await db
    .select({ left: sql<number>`count(*)::int` })
    .from(adminRecoveryCodes)
    .where(and(eq(adminRecoveryCodes.adminId, adminId), isNull(adminRecoveryCodes.usedAt)));
  return left;
}

export async function listAdmins(): Promise<AdminRow[]> {
  return db.select().from(adminUsers).orderBy(adminUsers.createdAt);
}
