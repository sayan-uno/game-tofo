// The case file: one zip that is the whole answer.
//
// "Proof if it is ever demanded" is not a screenshot of a console. It is a
// file somebody else can open without this software, read in order, and check
// has not been edited since it was written. So the export holds:
//
//   MANIFEST.txt   what is inside, and the SHA-256 of every part
//   case.json      the case, its timeline and its reports, as data
//   timeline.txt   the same thing as prose, for a reader with no tooling
//   log.ndjson     this player's activity log, hash-chained line by line
//   replays/…      the match files attached to the case
//   voice/…        the recordings attached to the case
//
// THE HASH CHAIN IS THE POINT of the log extract. Each line carries the digest
// of the line before it, so removing or altering one row breaks every digest
// after it. A log that can be quietly edited proves nothing, and no amount of
// careful storage fixes that after the fact.
//
// Written with no zip dependency: a zip is a header, some deflated bytes and a
// directory at the end, and the format has not changed since 1989.
import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { and, asc, eq, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { caseItems, eventLog, matchReplays, users, voiceRecordings } from "../db/schema.js";
import { getEvidence } from "../platform/evidence.js";
import { caseTimeline, listReports, type CaseRow } from "../services/reports.js";

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

interface Entry {
  name: string;
  data: Buffer;
}

export async function buildCaseFile(row: CaseRow): Promise<Buffer> {
  const [timeline, filed] = await Promise.all([
    caseTimeline(row.id),
    listReports({ subjectUid: row.subjectUid, limit: 100 }),
  ]);
  const reports = filed.reports.filter((r) => r.caseId === row.id);

  const entries: Entry[] = [];

  // ── The log extract, hash-chained ────────────────────────────────────────
  const [subject] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.uid, row.subjectUid))
    .limit(1);

  const rows = subject
    ? await db
        .select({
          at: eventLog.at,
          type: eventLog.type,
          uid: eventLog.uid,
          matchKey: eventLog.matchKey,
          gameId: eventLog.gameId,
          lobbyId: eventLog.lobbyId,
          data: eventLog.data,
        })
        .from(eventLog)
        .where(or(eq(eventLog.userId, subject.id), eq(eventLog.uid, row.subjectUid)))
        .orderBy(asc(eventLog.at))
        .limit(20_000)
    : [];

  let prev = "0".repeat(64);
  const lines: string[] = [];
  for (const r of rows) {
    const line = {
      at: r.at.toISOString(),
      type: r.type,
      uid: r.uid,
      matchKey: r.matchKey,
      gameId: r.gameId,
      lobbyId: r.lobbyId,
      data: r.data,
      prev,
    };
    // The digest covers the row AND the digest before it — that is what makes
    // it a chain rather than a list of checksums anybody could recompute after
    // deleting a line.
    const hash = sha(JSON.stringify(line));
    lines.push(JSON.stringify({ ...line, hash }));
    prev = hash;
  }
  const logBuf = Buffer.from(lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  entries.push({ name: "log.ndjson", data: logBuf });

  // ── The case itself ──────────────────────────────────────────────────────
  entries.push({
    name: "case.json",
    data: Buffer.from(
      JSON.stringify(
        {
          case: row,
          reports,
          timeline,
          logLines: lines.length,
          logChainHead: prev,
          exportedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf8"
    ),
  });

  entries.push({ name: "timeline.txt", data: Buffer.from(prose(row, reports, timeline), "utf8") });

  // ── The evidence itself ──────────────────────────────────────────────────
  // Only what was actually attached. A case file is not a dump of everything
  // the platform holds about a person; it is the evidence somebody decided
  // was relevant, which is also the only thing it is fair to hand over.
  const attachedReplays = timeline.filter((i) => i.kind === "replay" && i.refId).map((i) => i.refId!);
  const attachedVoice = timeline.filter((i) => i.kind === "voice" && i.refId).map((i) => i.refId!);
  const missing: string[] = [];

  for (const key of new Set(attachedReplays)) {
    const [rep] = await db.select().from(matchReplays).where(eq(matchReplays.matchKey, key)).limit(1);
    const bytes = rep ? await getEvidence(rep.r2Key) : null;
    if (bytes) entries.push({ name: `replays/${safeName(key)}.bin`, data: bytes });
    else missing.push(`replays/${key}`);
  }

  for (const id of new Set(attachedVoice)) {
    const [rec] = await db.select().from(voiceRecordings).where(eq(voiceRecordings.id, id)).limit(1);
    const bytes = rec ? await getEvidence(rec.r2Key) : null;
    if (bytes) entries.push({ name: `voice/${safeName(id)}${ext(rec!.r2Key)}`, data: bytes });
    else missing.push(`voice/${id}`);
  }

  // ── The manifest, written last because it describes the rest ─────────────
  const manifest = [
    `TOFO case file`,
    `case      ${row.ref}`,
    `subject   ${row.subjectUid}${row.subjectName ? ` (${row.subjectName})` : ""}`,
    `status    ${row.status}${row.resolution ? ` — ${row.resolution}` : ""}`,
    `opened    ${row.openedAt} by ${row.openedBy ?? "—"}`,
    row.resolvedAt ? `resolved  ${row.resolvedAt} by ${row.resolvedBy ?? "—"}` : "",
    `exported  ${new Date().toISOString()}`,
    ``,
    `Log extract: ${lines.length} line(s), chain head ${prev}`,
    `Each line in log.ndjson carries the SHA-256 of the line before it. Altering`,
    `or removing any line breaks every hash after it, and the head above.`,
    ``,
    `Contents (SHA-256):`,
    ...entries.map((e) => `  ${sha(e.data)}  ${e.name}`),
    ...(missing.length
      ? [``, `Attached but no longer stored (retention or deletion):`, ...missing.map((m) => `  ${m}`)]
      : []),
    ``,
  ]
    .filter((l) => l !== "")
    .join("\n");
  entries.unshift({ name: "MANIFEST.txt", data: Buffer.from(manifest + "\n", "utf8") });

  return zip(entries);
}

function prose(
  row: CaseRow,
  reports: Awaited<ReturnType<typeof listReports>>["reports"],
  timeline: Awaited<ReturnType<typeof caseTimeline>>
): string {
  const out = [
    `${row.ref} — ${row.title}`,
    `About ${row.subjectUid}${row.subjectName ? ` (${row.subjectName})` : ""}`,
    ``,
    `WHAT WAS REPORTED`,
  ];
  if (!reports.length) out.push(`  (nothing — this case was opened by an admin)`);
  for (const r of reports) {
    out.push(`  ${r.createdAt}  ${r.category} — by ${r.reporterUid}${r.matchKey ? ` in ${r.matchKey}` : ""}`);
    if (r.note) out.push(`      "${r.note}"`);
  }
  out.push(``, `WHAT HAPPENED NEXT`);
  for (const i of timeline) {
    out.push(
      `  ${i.createdAt}  ${i.kind}${i.refId ? ` ${i.refId}` : ""}${
        i.atMs !== null ? ` @${(i.atMs / 1000).toFixed(1)}s` : ""
      }${i.addedBy ? ` (${i.addedBy})` : ""}`
    );
    if (i.body) out.push(`      ${i.body}`);
  }
  if (row.status === "resolved") {
    out.push(``, `OUTCOME`, `  ${row.resolution ?? "—"}${row.resolutionNote ? ` — ${row.resolutionNote}` : ""}`);
  }
  return out.join("\n") + "\n";
}

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
const ext = (key: string): string => {
  const m = /\.[A-Za-z0-9]{2,5}$/.exec(key);
  return m ? m[0] : ".bin";
};

// ─── A zip, by hand ─────────────────────────────────────────────────────────

/** DOS date/time — two 16-bit fields, seconds in units of two, years from
 *  1980. Not a mistake; that is the format. */
function dosStamp(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function zip(entries: Entry[]): Buffer {
  const stamp = dosStamp(new Date());
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const deflated = deflateRawSync(e.data);
    // A tiny file can deflate LARGER than it started. Storing it uncompressed
    // is both smaller and faster to read back.
    const stored = deflated.length >= e.data.length;
    const body = stored ? e.data : deflated;
    const method = stored ? 0 : 8;
    const sum = crc32(e.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(stamp.time, 12);
    dir.writeUInt16LE(stamp.date, 14);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(e.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + body.length;
  }

  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, dirBuf, end]);
}
