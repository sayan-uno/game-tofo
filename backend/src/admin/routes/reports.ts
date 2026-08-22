// The reports queue, and the cases it turns into.
//
// This is the screen the rest of the console was built for. Every other
// feature answers a question — who is this, what did they do, what did the
// match look like, what did they say — and this is where the question gets
// asked in the first place.
//
// A moderator can work the queue: read reports, dismiss them, open a case,
// bundle evidence, write notes. Resolving a case and exporting one are held
// higher: a resolution is the sentence that ends the matter, and an export is
// a file full of somebody's voice and address leaving the building.
import { safeRouter } from "../asyncRouter.js";
import { requestOrigin } from "../../services/clientIp.js";
import { requireAdmin, requireSudo } from "../guard.js";
import { audit } from "../audit.js";
import { logEvent } from "../../services/eventLog.js";
import {
  addItem,
  assignCase,
  attachReports,
  caseTimeline,
  dismissReports,
  getCase,
  listCases,
  listReports,
  openCase,
  pendingCount,
  reopenCase,
  resolveCase,
} from "../../services/reports.js";
import { buildCaseFile } from "../caseFile.js";

export const reportsRouter = safeRouter();

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 200) : [];

// ─── Reports ────────────────────────────────────────────────────────────────

reportsRouter.get("/reports", requireAdmin("moderator"), async (req, res) => {
  const status = String(req.query.status ?? "new");
  res.json(
    await listReports({
      status: status === "all" ? undefined : (status as "new" | "attached" | "dismissed"),
      kind: req.query.kind === "appeal" || req.query.kind === "report" ? req.query.kind : undefined,
      subjectUid: typeof req.query.uid === "string" && req.query.uid ? req.query.uid : undefined,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : null,
      limit: Number(req.query.limit ?? 50),
    })
  );
});

/** For the rail's badge. Cheap enough to poll, and the reason an admin opens
 *  the screen at all rather than remembering to. */
reportsRouter.get("/reports/pending", requireAdmin("support"), async (_req, res) => {
  res.json({ pending: await pendingCount() });
});

reportsRouter.post("/reports/dismiss", requireAdmin("moderator"), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const list = ids(body.ids);
  if (!list.length) {
    res.status(400).json({ error: "Which reports?" });
    return;
  }
  const n = await dismissReports(list, req.admin!.email);
  await audit(req.admin!, {
    action: "report.dismiss",
    targetType: "report",
    targetId: list[0],
    after: { count: n },
    reason: typeof body.reason === "string" ? body.reason : null,
    ip: requestOrigin(req).ip,
  });
  logEvent({ type: "report.dismissed", data: { count: n, by: req.admin!.email } });
  res.json({ dismissed: n });
});

// ─── Cases ──────────────────────────────────────────────────────────────────

reportsRouter.get("/cases", requireAdmin("moderator"), async (req, res) => {
  const status = String(req.query.status ?? "open");
  res.json(
    await listCases({
      status: status === "all" ? undefined : (status as "open" | "resolved"),
      subjectUid: typeof req.query.uid === "string" && req.query.uid ? req.query.uid : undefined,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : null,
      limit: Number(req.query.limit ?? 50),
    })
  );
});

reportsRouter.post("/cases", requireAdmin("moderator"), async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const uid = typeof body.uid === "string" ? body.uid.trim() : "";
  if (!uid) {
    res.status(400).json({ error: "Who is the case about?" });
    return;
  }
  const row = await openCase({
    subjectUid: uid,
    title: typeof body.title === "string" ? body.title : "",
    openedBy: req.admin!.email,
    reportIds: ids(body.reportIds),
  });
  if (!row) {
    res.status(404).json({ error: "No such player" });
    return;
  }
  await audit(req.admin!, {
    action: "case.open",
    targetType: "case",
    targetId: row.id,
    after: { ref: row.ref, subject: uid },
    ip: requestOrigin(req).ip,
  });
  logEvent({ type: "case.opened", uid, data: { ref: row.ref, by: req.admin!.email } });
  res.json({ case: row });
});

reportsRouter.get("/cases/:id", requireAdmin("moderator"), async (req, res) => {
  const row = await getCase(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "No such case" });
    return;
  }
  const [timeline, reports] = await Promise.all([
    caseTimeline(row.id),
    listReports({ limit: 100, subjectUid: row.subjectUid, status: undefined }),
  ]);
  res.json({
    case: row,
    timeline,
    // Everything filed about this person: what is already on the case, and
    // what is not. An admin looking at a case wants to see the report that
    // arrived this morning without going back to the queue to find it.
    reports: reports.reports,
  });
});

reportsRouter.post("/cases/:id/attach", requireAdmin("moderator"), async (req, res) => {
  const row = await getCase(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "No such case" });
    return;
  }
  const n = await attachReports(row.id, ids((req.body ?? {}).reportIds), req.admin!.email);
  await audit(req.admin!, {
    action: "case.attach",
    targetType: "case",
    targetId: row.id,
    after: { count: n },
    ip: requestOrigin(req).ip,
  });
  res.json({ attached: n });
});

/** A note, a flagged moment, or a piece of evidence. One route, because on the
 *  timeline they are the same kind of thing: something somebody added. */
reportsRouter.post("/cases/:id/items", requireAdmin("moderator"), async (req, res) => {
  const row = await getCase(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "No such case" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const kind = String(body.kind ?? "note");
  if (!["note", "replay", "voice", "moment", "sanction"].includes(kind)) {
    res.status(400).json({ error: "Not something a case can hold" });
    return;
  }
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (kind === "note" && text.length < 2) {
    res.status(400).json({ error: "Write something" });
    return;
  }
  const item = await addItem({
    caseId: row.id,
    kind,
    refId: typeof body.refId === "string" ? body.refId : null,
    atMs: Number.isFinite(Number(body.atMs)) ? Number(body.atMs) : null,
    body: text || null,
    by: req.admin!.email,
  });

  // Evidence attached to an open case must outlive its ordinary retention —
  // that is what the `hold` tier is for, and doing it here rather than asking
  // the admin to remember is the difference between a policy and a hope.
  if (kind === "replay" && typeof body.refId === "string") await holdReplay(body.refId);

  await audit(req.admin!, {
    action: "case.item",
    targetType: "case",
    targetId: row.id,
    after: { kind, refId: body.refId ?? null },
    ip: requestOrigin(req).ip,
  });
  res.json({ item });
});

reportsRouter.post("/cases/:id/assign", requireAdmin("moderator"), async (req, res) => {
  const row = await getCase(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "No such case" });
    return;
  }
  const to = (req.body ?? {}).to;
  await assignCase(row.id, typeof to === "string" && to ? to : null, req.admin!.email);
  res.json({ ok: true });
});

/** Resolving is an admin's call, not a moderator's: it is the sentence that
 *  ends the matter, and it is what the export will say happened. */
reportsRouter.post("/cases/:id/resolve", requireAdmin("admin"), async (req, res) => {
  const row = await getCase(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "No such case" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const resolution = String(body.resolution ?? "");
  if (!["no-action", "warned", "sanctioned"].includes(resolution)) {
    res.status(400).json({ error: "Say what was decided" });
    return;
  }
  const updated = await resolveCase({
    caseId: row.id,
    resolution,
    note: typeof body.note === "string" ? body.note : "",
    by: req.admin!.email,
  });
  if (!updated) {
    res.status(409).json({ error: "That case is already resolved" });
    return;
  }
  await audit(req.admin!, {
    action: "case.resolve",
    targetType: "case",
    targetId: row.id,
    after: { resolution, ref: row.ref },
    reason: typeof body.note === "string" ? body.note : null,
    ip: requestOrigin(req).ip,
  });
  logEvent({
    type: "case.resolved",
    uid: row.subjectUid,
    data: { ref: row.ref, resolution, by: req.admin!.email },
  });
  res.json({ case: updated });
});

reportsRouter.post("/cases/:id/reopen", requireAdmin("admin"), async (req, res) => {
  const row = await getCase(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "No such case" });
    return;
  }
  const updated = await reopenCase(row.id, req.admin!.email);
  await audit(req.admin!, {
    action: "case.reopen",
    targetType: "case",
    targetId: row.id,
    ip: requestOrigin(req).ip,
  });
  res.json({ case: updated });
});

/**
 * The case file: one download that is the whole answer.
 *
 * Behind sudo, and audited, because this is evidence leaving the building —
 * a zip holding somebody's voice, their address history and everything they
 * were reported for. The console's own rule is that sensitive READS are
 * logged, not only writes, and there is no more sensitive read than this one.
 */
reportsRouter.get("/cases/:id/export", requireAdmin("admin"), requireSudo, async (req, res) => {
  const row = await getCase(String(req.params.id));
  if (!row) {
    res.status(404).json({ error: "No such case" });
    return;
  }
  const zip = await buildCaseFile(row);
  await audit(req.admin!, {
    action: "case.export",
    targetType: "case",
    targetId: row.id,
    after: { ref: row.ref, bytes: zip.length },
    ip: requestOrigin(req).ip,
  });
  logEvent({ type: "case.export", uid: row.subjectUid, data: { ref: row.ref, by: req.admin!.email } });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${row.ref}.zip"`);
  res.send(zip);
});

/** Kept here rather than in the service so the service stays about reports.
 *  Attaching a replay to a case is the one moment a retention tier changes
 *  for a reason that is not the calendar. */
async function holdReplay(matchKey: string): Promise<void> {
  const { db } = await import("../../db/client.js");
  const { matchReplays } = await import("../../db/schema.js");
  const { eq } = await import("drizzle-orm");
  await db
    .update(matchReplays)
    .set({ tier: "hold", expiresAt: null })
    .where(eq(matchReplays.matchKey, matchKey));
}
