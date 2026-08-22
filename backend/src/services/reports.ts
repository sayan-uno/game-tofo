// Reports and cases.
//
// A REPORT IS WHAT A PLAYER SAYS. A CASE IS WHAT AN ADMIN DOES ABOUT IT. Five
// people reporting one cheater is five reports and one case, and it is the
// case that carries the evidence, the decision, and the export. Keeping them
// apart is what stops a queue from being a pile.
//
// REPORTS ARE NEVER EDITED. An admin attaches one to a case or dismisses it;
// the row stays exactly as the player wrote it. A report that can be rewritten
// is not evidence of anything.
//
// AND A REPORT COSTS THE PLAYER NOTHING. Filing one is an ordinary HTTP POST
// off the hot path — no socket, no match state, nothing the runtime waits on.
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { caseItems, cases, reports, users } from "../db/schema.js";

/** The categories a player can pick. Short on purpose: a long list is a list
 *  nobody reads to the end of, and every extra entry is one more way to file
 *  the same complaint in the wrong place. */
export const CATEGORIES = ["voice", "text", "cheating", "griefing", "name"] as const;
export type Category = (typeof CATEGORIES)[number];

/** How many a player may file in a day. Generous for anybody with a real
 *  complaint, and low enough that flooding the queue takes deliberate effort
 *  rather than an afternoon of irritation. */
export const DAILY_LIMIT = 15;

const NOTE_MAX = 500;

export interface ReportRow {
  id: string;
  kind: "report" | "appeal";
  reporterUid: string;
  reporterName: string | null;
  subjectUid: string;
  subjectName: string | null;
  category: string;
  note: string | null;
  matchKey: string | null;
  lobbyId: string | null;
  caseId: string | null;
  caseRef: string | null;
  status: "new" | "attached" | "dismissed";
  createdAt: string;
}

export interface CaseRow {
  id: string;
  ref: string;
  subjectUid: string;
  subjectName: string | null;
  status: "open" | "resolved";
  title: string;
  assignedTo: string | null;
  openedBy: string | null;
  openedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
  resolutionNote: string | null;
  reportCount: number;
}

export interface CaseItemRow {
  id: string;
  kind: string;
  refId: string | null;
  atMs: number | null;
  body: string | null;
  addedBy: string | null;
  createdAt: string;
}

/** Why a report was not filed. `ok` covers one case that is not a success and
 *  must look exactly like one — see `filed` below. */
export type FileResult =
  | { ok: true; id: string | null; duplicate: boolean }
  | { ok: false; reason: "self" | "unknown" | "limit" | "category" };

/**
 * File a report.
 *
 * The bot case is the subtle one. Bots carry uids shaped exactly like real
 * ones, and the client contract deliberately hides which players are bots — a
 * results screen that quietly dropped the button for three of six players
 * would announce it. So a report against a uid with no account behind it
 * returns success and writes nothing: the player sees what they expect, the
 * queue stays clean, and nothing leaks.
 */
export async function fileReport(input: {
  reporterUserId: string;
  reporterUid: string;
  subjectUid: string;
  category: string;
  note?: string | null;
  matchKey?: string | null;
  lobbyId?: string | null;
}): Promise<FileResult> {
  if (!CATEGORIES.includes(input.category as Category)) return { ok: false, reason: "category" };
  if (input.subjectUid === input.reporterUid) return { ok: false, reason: "self" };

  const [subject] = await db
    .select({ id: users.id, uid: users.uid })
    .from(users)
    .where(eq(users.uid, input.subjectUid))
    .limit(1);

  // No account behind that uid: a bot, or a uid somebody typed. Either way the
  // answer a player gets is the same one they would get for a real person.
  if (!subject) return { ok: true, id: null, duplicate: false };

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reports)
    .where(
      and(
        eq(reports.reporterUserId, input.reporterUserId),
        gte(reports.createdAt, sql`now() - interval '24 hours'`)
      )
    );
  if (n >= DAILY_LIMIT) return { ok: false, reason: "limit" };

  const note = (input.note ?? "").trim().slice(0, NOTE_MAX) || null;
  const matchKey = input.matchKey?.trim() || null;

  // Pressing the button twice is a slip, not a second complaint. The unique
  // index is the authority — two taps racing each other both reach this line.
  const rows = await db
    .insert(reports)
    .values({
      kind: "report",
      reporterUserId: input.reporterUserId,
      reporterUid: input.reporterUid,
      subjectUserId: subject.id,
      subjectUid: subject.uid,
      category: input.category,
      note,
      matchKey,
      lobbyId: input.lobbyId?.trim() || null,
    })
    .onConflictDoNothing()
    .returning({ id: reports.id });

  return { ok: true, id: rows[0]?.id ?? null, duplicate: rows.length === 0 };
}

/** An appeal is a report about a decision, and it belongs in the same queue:
 *  an admin working through the morning should meet it in the order it
 *  arrived, not in a screen they have to remember to open. */
export async function fileAppeal(input: {
  userId: string;
  uid: string;
  note: string;
}): Promise<FileResult> {
  const note = input.note.trim().slice(0, NOTE_MAX);
  if (note.length < 3) return { ok: false, reason: "category" };

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reports)
    .where(
      and(
        eq(reports.reporterUserId, input.userId),
        eq(reports.kind, "appeal"),
        gte(reports.createdAt, sql`now() - interval '24 hours'`)
      )
    );
  // One appeal a day. An appeal is answered by a person; twenty copies of it
  // do not make that person read faster.
  if (n >= 1) return { ok: false, reason: "limit" };

  const [row] = await db
    .insert(reports)
    .values({
      kind: "appeal",
      reporterUserId: input.userId,
      reporterUid: input.uid,
      subjectUserId: input.userId,
      subjectUid: input.uid,
      category: "appeal",
      note,
    })
    .returning({ id: reports.id });
  return { ok: true, id: row.id, duplicate: false };
}

/** How many the player has left today, so the client can say so before they
 *  write three paragraphs and lose them. */
export async function reportsLeftToday(userId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reports)
    .where(and(eq(reports.reporterUserId, userId), gte(reports.createdAt, sql`now() - interval '24 hours'`)));
  return Math.max(0, DAILY_LIMIT - n);
}

// ─── The queue ──────────────────────────────────────────────────────────────

// A CORRELATED SUBQUERY MUST NAME THE OUTER TABLE ITSELF.
//
// Interpolating a column object — sql`… where r.case_id = ${cases.id}` —
// renders the column UNQUALIFIED, and an unqualified name inside a subquery
// binds to the INNER table first. `reports` has an `id`, so that count
// silently became "reports whose case_id equals their own id": zero, always,
// with no error anywhere. The name lookups above got away with it only
// because `users` happens to have no column of the same name.
//
// So these are written out in full. The table names are fixed; the ambiguity
// is not worth the interpolation.
const reporter = sql<string | null>`(select username from users u where u.id = "reports"."reporter_user_id")`;
const subject = sql<string | null>`(select username from users u where u.id = "reports"."subject_user_id")`;

/** The inbound queue, newest first, cursored on (created_at, id) — never
 *  OFFSET, which re-reads what it has already skipped and shifts under a list
 *  that is being written to while somebody pages through it. */
export async function listReports(opts: {
  status?: "new" | "attached" | "dismissed";
  subjectUid?: string;
  kind?: "report" | "appeal";
  cursor?: string | null;
  limit?: number;
}): Promise<{ reports: ReportRow[]; cursor: string | null }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const before = opts.cursor ? new Date(opts.cursor) : null;
  const rows = await db
    .select({
      id: reports.id,
      kind: reports.kind,
      reporterUid: reports.reporterUid,
      reporterName: reporter,
      subjectUid: reports.subjectUid,
      subjectName: subject,
      category: reports.category,
      note: reports.note,
      matchKey: reports.matchKey,
      lobbyId: reports.lobbyId,
      caseId: reports.caseId,
      caseRef: sql<string | null>`(select ref from cases c where c.id = "reports"."case_id")`,
      status: reports.status,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .where(
      and(
        opts.status ? eq(reports.status, opts.status) : sql`true`,
        opts.kind ? eq(reports.kind, opts.kind) : sql`true`,
        opts.subjectUid ? eq(reports.subjectUid, opts.subjectUid) : sql`true`,
        before ? lt(reports.createdAt, before) : sql`true`
      )
    )
    .orderBy(desc(reports.createdAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return {
    reports: page.map(shapeReport),
    cursor: rows.length > limit ? page[page.length - 1].createdAt.toISOString() : null,
  };
}

/** How many are waiting. Shown on the rail, because a queue nobody is told
 *  about is a queue nobody opens. */
export async function pendingCount(): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reports)
    .where(eq(reports.status, "new"));
  return n;
}

// ─── Cases ──────────────────────────────────────────────────────────────────

/** No I, O, 0 or 1: this gets read off a screen and typed into another one. */
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function newRef(): string {
  let out = "C-";
  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export async function openCase(input: {
  subjectUid: string;
  title: string;
  openedBy: string;
  reportIds?: string[];
}): Promise<CaseRow | null> {
  const [who] = await db
    .select({ id: users.id, uid: users.uid })
    .from(users)
    .where(eq(users.uid, input.subjectUid))
    .limit(1);
  if (!who) return null;

  // Retry on the astronomically unlikely collision rather than trusting it not
  // to happen: a unique index that can fail an insert is not a decoration.
  let row: typeof cases.$inferSelect | undefined;
  for (let attempt = 0; attempt < 5 && !row; attempt++) {
    const inserted = await db
      .insert(cases)
      .values({
        ref: newRef(),
        subjectUserId: who.id,
        subjectUid: who.uid,
        title: input.title.trim().slice(0, 200) || `Case about ${who.uid}`,
        openedBy: input.openedBy,
      })
      .onConflictDoNothing()
      .returning();
    row = inserted[0];
  }
  if (!row) return null;

  await db.insert(caseItems).values({
    caseId: row.id,
    kind: "status",
    body: "Case opened",
    addedBy: input.openedBy,
  });

  if (input.reportIds?.length) await attachReports(row.id, input.reportIds, input.openedBy);
  return (await getCase(row.id))!;
}

/** Fold reports into a case. Idempotent: attaching one twice is a slip, and a
 *  slip should not produce two identical lines on a timeline that is meant to
 *  be read as a record. */
export async function attachReports(caseId: string, reportIds: string[], by: string): Promise<number> {
  if (!reportIds.length) return 0;
  const moved = await db
    .update(reports)
    .set({ caseId, status: "attached", handledBy: by, handledAt: sql`now()` })
    .where(and(inArray(reports.id, reportIds), isNull(reports.caseId)))
    .returning({ id: reports.id, category: reports.category, uid: reports.reporterUid });

  for (const r of moved) {
    await db.insert(caseItems).values({
      caseId,
      kind: "report",
      refId: r.id,
      body: `${r.category} — reported by ${r.uid}`,
      addedBy: by,
    });
  }
  return moved.length;
}

/** Read and judged to need nothing. Kept, not deleted: a player who files
 *  forty dismissed reports is himself a pattern worth being able to see. */
export async function dismissReports(reportIds: string[], by: string): Promise<number> {
  if (!reportIds.length) return 0;
  const rows = await db
    .update(reports)
    .set({ status: "dismissed", handledBy: by, handledAt: sql`now()` })
    .where(and(inArray(reports.id, reportIds), eq(reports.status, "new")))
    .returning({ id: reports.id });
  return rows.length;
}

export async function addItem(input: {
  caseId: string;
  kind: string;
  refId?: string | null;
  atMs?: number | null;
  body?: string | null;
  by: string;
}): Promise<CaseItemRow | null> {
  const [row] = await db
    .insert(caseItems)
    .values({
      caseId: input.caseId,
      kind: input.kind,
      refId: input.refId ?? null,
      atMs: input.atMs ?? null,
      body: input.body?.slice(0, 2000) ?? null,
      addedBy: input.by,
    })
    .returning();
  return row ? shapeItem(row) : null;
}

export async function resolveCase(input: {
  caseId: string;
  resolution: string;
  note: string;
  by: string;
}): Promise<CaseRow | null> {
  const [row] = await db
    .update(cases)
    .set({
      status: "resolved",
      resolution: input.resolution.slice(0, 16),
      resolutionNote: input.note.slice(0, 2000) || null,
      resolvedAt: sql`now()`,
      resolvedBy: input.by,
    })
    .where(and(eq(cases.id, input.caseId), eq(cases.status, "open")))
    .returning();
  if (!row) return null;
  await db.insert(caseItems).values({
    caseId: row.id,
    kind: "status",
    body: `Resolved — ${input.resolution}${input.note ? `: ${input.note}` : ""}`,
    addedBy: input.by,
  });
  return (await getCase(row.id))!;
}

export async function reopenCase(caseId: string, by: string): Promise<CaseRow | null> {
  const [row] = await db
    .update(cases)
    .set({ status: "open", resolvedAt: null, resolvedBy: null })
    .where(eq(cases.id, caseId))
    .returning();
  if (!row) return null;
  await db.insert(caseItems).values({ caseId, kind: "status", body: "Reopened", addedBy: by });
  return (await getCase(caseId))!;
}

export async function assignCase(caseId: string, to: string | null, by: string): Promise<boolean> {
  const [row] = await db.update(cases).set({ assignedTo: to }).where(eq(cases.id, caseId)).returning();
  if (!row) return false;
  await db.insert(caseItems).values({
    caseId,
    kind: "status",
    body: to ? `Assigned to ${to}` : "Unassigned",
    addedBy: by,
  });
  return true;
}

const caseReports = sql<number>`(select count(*)::int from reports cr where cr.case_id = "cases"."id")`;
const caseSubject = sql<string | null>`(select username from users u where u.id = "cases"."subject_user_id")`;

export async function listCases(opts: {
  status?: "open" | "resolved";
  subjectUid?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<{ cases: CaseRow[]; cursor: string | null }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const before = opts.cursor ? new Date(opts.cursor) : null;
  const rows = await db
    .select({
      id: cases.id,
      ref: cases.ref,
      subjectUid: cases.subjectUid,
      subjectName: caseSubject,
      status: cases.status,
      title: cases.title,
      assignedTo: cases.assignedTo,
      openedBy: cases.openedBy,
      openedAt: cases.openedAt,
      resolvedAt: cases.resolvedAt,
      resolvedBy: cases.resolvedBy,
      resolution: cases.resolution,
      resolutionNote: cases.resolutionNote,
      reportCount: caseReports,
    })
    .from(cases)
    .where(
      and(
        opts.status ? eq(cases.status, opts.status) : sql`true`,
        opts.subjectUid ? eq(cases.subjectUid, opts.subjectUid) : sql`true`,
        before ? lt(cases.openedAt, before) : sql`true`
      )
    )
    .orderBy(desc(cases.openedAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  return {
    cases: page.map(shapeCase),
    cursor: rows.length > limit ? page[page.length - 1].openedAt.toISOString() : null,
  };
}

/** By id or by the short ref, because the ref is what somebody actually has. */
export async function getCase(idOrRef: string): Promise<CaseRow | null> {
  const byRef = idOrRef.toUpperCase().startsWith("C-");
  const rows = await db
    .select({
      id: cases.id,
      ref: cases.ref,
      subjectUid: cases.subjectUid,
      subjectName: caseSubject,
      status: cases.status,
      title: cases.title,
      assignedTo: cases.assignedTo,
      openedBy: cases.openedBy,
      openedAt: cases.openedAt,
      resolvedAt: cases.resolvedAt,
      resolvedBy: cases.resolvedBy,
      resolution: cases.resolution,
      resolutionNote: cases.resolutionNote,
      reportCount: caseReports,
    })
    .from(cases)
    .where(byRef ? eq(cases.ref, idOrRef.toUpperCase()) : eq(cases.id, idOrRef))
    .limit(1);
  return rows[0] ? shapeCase(rows[0]) : null;
}

export async function caseTimeline(caseId: string): Promise<CaseItemRow[]> {
  const rows = await db
    .select()
    .from(caseItems)
    .where(eq(caseItems.caseId, caseId))
    .orderBy(caseItems.createdAt);
  return rows.map(shapeItem);
}

export async function caseReportRows(caseId: string): Promise<ReportRow[]> {
  const { reports: rows } = await listReports({ limit: 100 });
  return rows.filter((r) => r.caseId === caseId);
}

/** Every uid that has an open case against them. The chat sweeper asks this
 *  before it deletes anything, so evidence does not expire out from under a
 *  case somebody is still working on. */
export async function subjectsWithOpenCases(): Promise<string[]> {
  const rows = await db
    .select({ uid: cases.subjectUid })
    .from(cases)
    .where(eq(cases.status, "open"));
  return [...new Set(rows.map((r) => r.uid))];
}

// ─── Shaping ────────────────────────────────────────────────────────────────

const iso = (d: Date | string | null): string | null =>
  d === null ? null : typeof d === "string" ? d : d.toISOString();

function shapeReport(r: Record<string, unknown>): ReportRow {
  return {
    id: String(r.id),
    kind: r.kind as "report" | "appeal",
    reporterUid: String(r.reporterUid),
    reporterName: (r.reporterName as string | null) ?? null,
    subjectUid: String(r.subjectUid),
    subjectName: (r.subjectName as string | null) ?? null,
    category: String(r.category),
    note: (r.note as string | null) ?? null,
    matchKey: (r.matchKey as string | null) ?? null,
    lobbyId: (r.lobbyId as string | null) ?? null,
    caseId: (r.caseId as string | null) ?? null,
    caseRef: (r.caseRef as string | null) ?? null,
    status: r.status as ReportRow["status"],
    createdAt: iso(r.createdAt as Date)!,
  };
}

function shapeCase(r: Record<string, unknown>): CaseRow {
  return {
    id: String(r.id),
    ref: String(r.ref),
    subjectUid: String(r.subjectUid),
    subjectName: (r.subjectName as string | null) ?? null,
    status: r.status as "open" | "resolved",
    title: String(r.title),
    assignedTo: (r.assignedTo as string | null) ?? null,
    openedBy: (r.openedBy as string | null) ?? null,
    openedAt: iso(r.openedAt as Date)!,
    resolvedAt: iso(r.resolvedAt as Date | null),
    resolvedBy: (r.resolvedBy as string | null) ?? null,
    resolution: (r.resolution as string | null) ?? null,
    resolutionNote: (r.resolutionNote as string | null) ?? null,
    reportCount: Number(r.reportCount ?? 0),
  };
}

function shapeItem(r: typeof caseItems.$inferSelect): CaseItemRow {
  return {
    id: r.id,
    kind: r.kind,
    refId: r.refId,
    atMs: r.atMs,
    body: r.body,
    addedBy: r.addedBy,
    createdAt: iso(r.createdAt)!,
  };
}
