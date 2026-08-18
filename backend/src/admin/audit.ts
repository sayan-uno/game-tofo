// Every admin action, and every sensitive READ.
//
// Reads are in here on purpose. "Who has been looking at whom" is a question a
// moderation console must be able to answer about itself — opening someone's
// IP history or playing their voice recording is an exercise of power, and an
// audit trail that only records writes cannot see it.
//
// Written directly rather than through the buffered event logger: this is the
// one table where losing the last two seconds is not acceptable, and it is
// written a few times a minute at most. The admin's identity is SNAPSHOTTED
// into the row rather than joined, so deleting an account cannot blank the
// trail behind it.
import { db } from "../db/client.js";
import { adminAudit } from "../db/schema.js";

/** All this file needs of an actor. Kept narrow on purpose so the audit trail
 *  does not depend on the request layer that happens to produce it. */
export interface AuditActor {
  id: string | null;
  email: string;
}

export interface AuditInput {
  action: string;
  targetType?: "user" | "match" | "sanction" | "recording" | "admin" | "platform";
  targetId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  requestId?: string | null;
}

export async function audit(actor: AuditActor, input: AuditInput): Promise<void> {
  try {
    await db.insert(adminAudit).values({
      adminId: actor.id,
      adminEmail: actor.email,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      ip: input.ip ?? null,
      reason: input.reason ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      requestId: input.requestId ?? null,
    });
  } catch (err) {
    // An audit row that cannot be written must be loud. It must not, however,
    // take down the action it was describing — the console reporting an error
    // while having already banned someone is its own kind of wrong.
    console.error("[audit] FAILED to record", input.action, err);
  }
}

/** For events that happen before anyone is signed in — a refused sign-in, a
 *  lockout. There is no actor yet, only a claimed identity. */
export async function auditAnonymous(email: string, input: AuditInput): Promise<void> {
  await audit({ id: null, email }, input);
}
