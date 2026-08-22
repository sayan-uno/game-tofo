// One audio file being written, from live PCM to an object in the evidence
// bucket.
//
// The shape of this is decided by one question: what happens if the process
// dies halfway through? So —
//
//   ffmpeg writes to disk continuously, and the file is UPLOADED PERIODICALLY,
//   not only at the end. Ogg is a streaming container: a partial file is a
//   valid, playable file that simply stops early. A crash therefore costs at
//   most one flush interval of audio, not the whole session, and what is in
//   the bucket is always playable.
//
// The row in `voice_recordings` is written before any bytes exist, for the
// same reason the egress version did it: the database is what stops two
// recorders, or one recorder twice, writing the same file.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createReadStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { voiceRecordings } from "../db/schema.js";
import { config } from "../config.js";
import { putEvidence } from "../platform/evidence.js";

/** What LiveKit hands us and what ffmpeg is told to expect. */
export const SAMPLE_RATE = 48_000;
export const CHANNELS = 1;

/** Speech is coalesced into segments at this granularity. Twenty milliseconds
 *  is one Opus frame — finer than anyone can perceive, coarse enough that a
 *  ten-minute file is a few kilobytes of JSON. */
const SEGMENT_MS = 20;
/** Loudness at which a frame counts as speech. Room noise sits under it. */
const SPEECH_RMS = 0.02;
/** A gap shorter than this is a pause in a sentence, not the end of one. */
const SPEECH_GAP_MS = 400;

export interface WriterOptions {
  /** Session this belongs to: match id or lobby id. */
  key: string;
  scope: "match" | "lobby";
  kind: "track" | "mix";
  /** Player uid, or "room" for the mix. */
  uid: string;
  userId: string | null;
  /** LiveKit track id, or the sentinel "mix". */
  trackSid: string;
  /** Where this file starts on the session's timeline. */
  offsetMs: number;
  roster?: unknown;
}

export class AudioWriter {
  private ff: ChildProcessByStdio<Writable, null, Readable> | null = null;
  private file: string;
  private rowId: string | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private samples = 0;
  private lastUploadedBytes = -1;
  /** Speech segments, in milliseconds from the session's start. */
  private speech: [number, number][] = [];
  private openSegment: [number, number] | null = null;
  readonly r2Key: string;

  constructor(private readonly o: WriterOptions) {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dir = `voice/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${o.key}`;
    this.r2Key = `${dir}/${o.uid}-${o.trackSid}.ogg`;
    this.file = path.join(tmpdir(), "tofo-rec", o.key, `${o.uid}-${o.trackSid}.ogg`);
  }

  /** Claims the row, then starts encoding. Returns false when this file is
   *  already being written — which is how a duplicate is refused rather than
   *  becoming two recorders fighting over one key. */
  async start(): Promise<boolean> {
    try {
      const [row] = await db
        .insert(voiceRecordings)
        .values({
          matchKey: this.o.key,
          scope: this.o.scope,
          kind: this.o.kind,
          uid: this.o.uid,
          userId: this.o.userId,
          trackSid: this.o.trackSid,
          r2Key: this.r2Key,
          offsetMs: this.o.offsetMs,
          roster: (this.o.roster as never) ?? null,
          status: "active",
          startedAt: new Date(),
          expiresAt: new Date(Date.now() + config.voiceRecording.retentionDays * 86_400_000),
        })
        .returning({ id: voiceRecordings.id });
      this.rowId = row.id;
    } catch (err) {
      if ((err as { code?: string })?.code === "23505") return false;
      throw err;
    }

    await fs.mkdir(path.dirname(this.file), { recursive: true });
    // Raw PCM in, Opus in an Ogg container out. 32 kbps mono is transparent
    // for speech and keeps an hour of talking under fifteen megabytes.
    const ff = spawn(
      ffmpegPath as unknown as string,
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", String(CHANNELS), "-i", "pipe:0",
        // WITHOUT THIS THE FILE STAYS AT ZERO BYTES UNTIL FFMPEG EXITS.
        // Measured, not assumed: eight seconds of audio, and the file on disk
        // was 0 bytes the whole way through, then 61 kB at once at the end.
        // Every periodic upload below would have found nothing, and a crash
        // would have lost the entire recording while looking like it could not
        // have. With it, the file grows continuously and a crash costs the
        // last few seconds.
        "-flush_packets", "1",
        "-c:a", "libopus", "-b:a", "32k", "-application", "voip",
        "-y", this.file,
      ],
      { stdio: ["pipe", "ignore", "pipe"] }
    );
    this.ff = ff;
    ff.stderr.on("data", (d: Buffer) => console.error(`[rec] ffmpeg ${this.o.uid}: ${d.toString().trim()}`));
    ff.on("error", (err) => console.error(`[rec] ffmpeg failed for ${this.o.uid}:`, err));
    // EPIPE when ffmpeg exits first; the close path handles the real ending.
    ff.stdin.on("error", () => undefined);

    this.flushTimer = setInterval(() => void this.flush(), config.recorder.flushSeconds * 1000);
    this.flushTimer.unref();
    return true;
  }

  /** One frame of audio from LiveKit. Never awaited by the caller: this is the
   *  hot path of the recorder and it must not become a queue of promises. */
  write(pcm: Int16Array): void {
    if (this.closing || !this.ff) return;
    this.ff.stdin.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    this.noteSpeech(pcm);
    this.samples += pcm.length / CHANNELS;
  }

  /** Loudness of the frame, turned into "was anyone talking, and when".
   *
   *  This is the thing an egress could never give us: the console can then
   *  light a microphone from recorded fact instead of guessing from playback,
   *  and a moderator can jump straight to where somebody actually spoke. */
  private noteSpeech(pcm: Int16Array): void {
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] / 32768;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, pcm.length));
    const at = this.o.offsetMs + Math.round((this.samples / SAMPLE_RATE) * 1000);
    if (rms > SPEECH_RMS) {
      if (this.openSegment && at - this.openSegment[1] <= SPEECH_GAP_MS) {
        this.openSegment[1] = at + SEGMENT_MS;
      } else {
        if (this.openSegment) this.speech.push(this.openSegment);
        this.openSegment = [at, at + SEGMENT_MS];
      }
    }
  }

  /** Put what exists so far into the bucket. Cheap and idempotent — the same
   *  key is overwritten, and skipped entirely when nothing has been added. */
  private async flush(): Promise<void> {
    if (this.closing) return;
    try {
      const stat = await fs.stat(this.file).catch(() => null);
      if (!stat || stat.size === 0 || stat.size === this.lastUploadedBytes) return;
      await putEvidence(this.r2Key, await fs.readFile(this.file), "audio/ogg");
      this.lastUploadedBytes = stat.size;
    } catch (err) {
      // Never fatal: the next flush, or the close, tries again.
      console.error(`[rec] flush failed for ${this.r2Key}:`, err);
    }
  }

  /** Finish: close ffmpeg cleanly so the container is finalised, upload the
   *  finished file, and complete the row. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.flushTimer) clearInterval(this.flushTimer);

    if (this.ff) {
      const done = new Promise<void>((resolve) => {
        const finish = () => resolve();
        this.ff!.once("close", finish);
        // ffmpeg not exiting is not a reason to hold a shutdown open.
        setTimeout(finish, 8000).unref();
      });
      this.ff.stdin.end();
      await done;
      this.ff = null;
    }
    if (this.openSegment) {
      this.speech.push(this.openSegment);
      this.openSegment = null;
    }

    let bytes: number | null = null;
    try {
      const body = await fs.readFile(this.file);
      bytes = body.length;
      if (bytes > 0) await putEvidence(this.r2Key, body, "audio/ogg");
    } catch (err) {
      console.error(`[rec] final upload failed for ${this.r2Key}:`, err);
    }

    const durationSec = Math.round(this.samples / SAMPLE_RATE);
    if (this.rowId) {
      await db
        .update(voiceRecordings)
        .set({
          status: bytes && bytes > 0 ? "complete" : "failed",
          error: bytes && bytes > 0 ? null : "nothing was captured",
          endedAt: sql`now()`,
          bytes,
          durationSec,
          speech: this.speech.length > 0 ? (this.speech as never) : null,
        })
        .where(eq(voiceRecordings.id, this.rowId));
    }
    await fs.rm(this.file, { force: true }).catch(() => undefined);
  }

  get seconds(): number {
    return this.samples / SAMPLE_RATE;
  }
}

/** Left-over files from a process that died mid-session. Uploaded before
 *  anything else runs, because they are somebody's evidence and the next
 *  session would otherwise sit on top of them. */
export async function recoverOrphanFiles(): Promise<number> {
  const root = path.join(tmpdir(), "tofo-rec");
  let recovered = 0;
  const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const files = await fs.readdir(path.join(root, dir.name)).catch(() => []);
    for (const name of files) {
      const full = path.join(root, dir.name, name);
      try {
        const body = await fs.readFile(full);
        if (body.length === 0) {
          await fs.rm(full, { force: true }).catch(() => undefined);
          continue;
        }
        const [row] = await db
          .select({ id: voiceRecordings.id, key: voiceRecordings.r2Key })
          .from(voiceRecordings)
          .where(sql`${voiceRecordings.matchKey} = ${dir.name} and ${voiceRecordings.r2Key} like ${"%" + name}`);
        if (!row) {
          // No row means we cannot say whose voice this is or where it belongs.
          // Kept, loudly, rather than thrown away.
          console.error(`[rec] orphan file with no row, LEFT ON DISK: ${full}`);
          continue;
        }
        await putEvidence(row.key, body, "audio/ogg");
        await db
          .update(voiceRecordings)
          .set({ status: "complete", endedAt: sql`now()`, bytes: body.length })
          .where(eq(voiceRecordings.id, row.id));
        recovered++;
        // Deleted ONLY after it is safely in the bucket. Removing a file we
        // failed to save is the one unrecoverable mistake available here.
        await fs.rm(full, { force: true }).catch(() => undefined);
      } catch (err) {
        console.error(`[rec] could not recover ${full} — LEFT ON DISK for the next attempt:`, err);
      }
    }
  }
  if (recovered > 0) console.log(`✔ Recovered ${recovered} recording(s) left behind by a previous run`);
  return recovered;
}

/** Reads the stream from a media file back, for tests. */
export const readLocal = (file: string) => createReadStream(file);
