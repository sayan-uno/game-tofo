// One room being recorded: the connection, a file per microphone, and the mix.
//
// The mix is made here rather than bought from LiveKit, and that is the whole
// point of this process — a composite egress costs a concurrency slot and a
// per-minute fee, while summing sixteen-bit samples costs arithmetic.
//
// Mixing needs a CLOCK, not a queue. Frames arrive per track whenever the
// network delivers them, so the mixer runs on its own 20 ms tick and takes
// whatever each speaker has buffered; a track with nothing ready contributes
// silence for that tick. That way the mix stays in real time and self-heals
// after a stall instead of drifting further behind with every hiccup.
import { AccessToken } from "livekit-server-sdk";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, voiceRecordings } from "../db/schema.js";
import { config } from "../config.js";
import { AudioWriter, CHANNELS, SAMPLE_RATE } from "./writer.js";
import type { RecordedSession } from "./registry.js";
import { getSession } from "./registry.js";

/** One Opus frame. The mixer's heartbeat. */
const TICK_MS = 20;
const TICK_SAMPLES = (SAMPLE_RATE / 1000) * TICK_MS;
/** If a speaker's buffer grows past this the network is delivering faster than
 *  real time (a reconnect burst); the oldest audio is dropped rather than
 *  letting the mix fall behind for ever. */
const MAX_BUFFER_SAMPLES = SAMPLE_RATE * 5;

interface Speaker {
  uid: string;
  userId: string | null;
  writer: AudioWriter | null;
  /** Waiting to be mixed. */
  pending: Int16Array[];
  pendingSamples: number;
}

export class RecordingSession {
  private room: import("@livekit/rtc-node").Room | null = null;
  private speakers = new Map<string, Speaker>();
  private mix: AudioWriter | null = null;
  private mixTimer: NodeJS.Timeout | null = null;
  private mixCount = 0;
  private startedAt = Date.now();
  /** Stamped into every file id this run produces, so a recorder that restarts
   *  mid-session records the same people again instead of colliding with the
   *  rows its previous life left behind. Two files, both on the timeline, with
   *  the gap between them visible — which is the truth of what happened. */
  private readonly runId = Date.now().toString(36);
  private closing = false;
  /** Resolved when the timeline anchor is known — see anchorMs(). */
  private anchor: number | null;

  constructor(private readonly spec: RecordedSession) {
    this.anchor = spec.anchor;
  }

  get key(): string {
    return this.spec.key;
  }
  get seconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }
  get speakerCount(): number {
    return this.speakers.size;
  }

  /** Where this session's timeline starts.
   *
   *  A match registers before its countdown has run, so the anchor arrives
   *  after the session does; it is re-read until it is known. Everything else
   *  falls back to when recording began, which is the only honest zero a party
   *  has. */
  private async anchorMs(): Promise<number> {
    if (this.anchor !== null) return this.anchor;
    const fresh = await getSession(this.spec.key).catch(() => null);
    if (fresh?.anchor) this.anchor = fresh.anchor;
    return this.anchor ?? this.startedAt;
  }

  async open(): Promise<void> {
    const { Room, RoomEvent, AudioStream, TrackKind } = await import("@livekit/rtc-node");
    const { url, apiKey, apiSecret } = config.livekit;
    if (!url || !apiKey || !apiSecret) throw new Error("LiveKit is not configured");

    const at = new AccessToken(apiKey, apiSecret, { identity: `rec-${config.instanceId}`.slice(0, 40) });
    // hidden: nobody in the room sees a recorder in the participant list. The
    // decision was that players are told in the Terms, not by a badge in the
    // game, and a visible bot would quietly overturn that.
    at.addGrant({ room: this.spec.room, roomJoin: true, canPublish: false, canSubscribe: true, hidden: true });

    const room = new Room();
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      void this.addSpeaker(participant.identity, new AudioStream(track)).catch((err) =>
        console.error(`[rec] ${this.key}: could not record ${participant.identity}:`, err)
      );
    });
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      void this.dropSpeaker(participant.identity);
    });
    room.on(RoomEvent.Disconnected, () => {
      if (!this.closing) console.log(`[rec] ${this.key}: room closed`);
    });

    await room.connect(url, await at.toJwt(), { autoSubscribe: true, dynacast: false });
    console.log(`[rec] ${this.key}: recording ${this.spec.room} (${this.spec.scope})`);

  }

  /** The mix exists only while somebody's microphone is on.
   *
   *  It used to start with the session, which is right for a match — people
   *  are talking — and wrong for a party, where a group can sit for an hour
   *  with every microphone off. That produced exactly what it sounds like: a
   *  thirteen-minute "everyone together" file containing silence, next to
   *  individual voices that had speech in them. Now the mix is opened by the
   *  first microphone and closed by the last, so a mix always contains a
   *  conversation. */
  private async ensureMix(): Promise<void> {
    if (this.mix || this.closing || !config.voiceRecording.mixEnabled) return;
    const anchor = await this.anchorMs();
    const mix = new AudioWriter({
      key: this.spec.key,
      scope: this.spec.scope,
      kind: "mix",
      uid: "room",
      userId: null,
      // Numbered, because a party that falls quiet and picks up again gets a
      // second mix rather than one file with an hour of nothing in the middle.
      trackSid: `mix-${this.runId}-${this.mixCount}`,
      offsetMs: Math.max(0, Date.now() - anchor),
      roster: this.spec.roster,
    });
    if (await mix.start()) {
      this.mixCount++;
      this.mix = mix;
      this.mixTimer = setInterval(() => this.tickMix(), TICK_MS);
    }
  }

  /** Nobody is speaking any more, so there is nothing to mix. */
  private async endMix(): Promise<void> {
    if (!this.mix) return;
    if (this.mixTimer) clearInterval(this.mixTimer);
    this.mixTimer = null;
    const mix = this.mix;
    this.mix = null;
    await mix.close().catch((err) => console.error(`[rec] closing mix for ${this.key}:`, err));
  }

  private async addSpeaker(uid: string, stream: AsyncIterable<{ data: Int16Array; sampleRate: number }>): Promise<void> {
    if (this.closing) return;
    if (this.speakers.has(uid)) return;
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.uid, uid));
    const speaker: Speaker = { uid, userId: user?.id ?? null, writer: null, pending: [], pendingSamples: 0 };
    this.speakers.set(uid, speaker);
    await this.ensureMix();

    if (config.voiceRecording.separateTracks) {
      const anchor = await this.anchorMs();
      const writer = new AudioWriter({
        key: this.spec.key,
        scope: this.spec.scope,
        kind: "track",
        uid,
        userId: speaker.userId,
        // One file per person per RUN. A microphone going off and on continues
        // the same file — we follow the connection, not the publication — but a
        // recorder restart starts a fresh one, because the old row is closed
        // and its bytes are already in the bucket.
        trackSid: `p-${uid}-${this.runId}`,
        offsetMs: Math.max(0, Date.now() - anchor),
      });
      if (await writer.start()) speaker.writer = writer;
    }

    // Pump frames until the track ends. Nothing here awaits: a slow database
    // or a slow upload must never stall the audio path.
    void (async () => {
      try {
        for await (const frame of stream) {
          if (this.closing) break;
          const pcm = frame.data;
          speaker.writer?.write(pcm);
          if (this.mix) {
            speaker.pending.push(pcm);
            speaker.pendingSamples += pcm.length;
            while (speaker.pendingSamples > MAX_BUFFER_SAMPLES && speaker.pending.length > 0) {
              speaker.pendingSamples -= speaker.pending.shift()!.length;
            }
          }
        }
      } catch (err) {
        console.error(`[rec] ${this.key}: audio stream for ${uid} ended badly:`, err);
      }
      await this.dropSpeaker(uid);
    })();
  }

  private async dropSpeaker(uid: string): Promise<void> {
    const speaker = this.speakers.get(uid);
    if (!speaker) return;
    this.speakers.delete(uid);
    await speaker.writer?.close().catch((err) => console.error(`[rec] closing ${uid}:`, err));
    // The last microphone in the room has gone: end the mix rather than keep
    // writing silence until the party does.
    if (this.speakers.size === 0) await this.endMix();
  }

  /** Sum one frame's worth from every speaker. Absent audio is silence, which
   *  is exactly what it sounds like in the room. */
  private tickMix(): void {
    if (!this.mix || this.closing) return;
    const out = new Int16Array(TICK_SAMPLES * CHANNELS);
    let any = false;
    for (const speaker of this.speakers.values()) {
      let need = out.length;
      let at = 0;
      while (need > 0 && speaker.pending.length > 0) {
        const head = speaker.pending[0];
        const take = Math.min(need, head.length);
        for (let i = 0; i < take; i++) {
          // Sum, then clamp. Clipping is honest; wrapping would turn two
          // people talking at once into a burst of noise.
          const sum = out[at + i] + head[i];
          out[at + i] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum;
        }
        any = true;
        at += take;
        need -= take;
        if (take === head.length) {
          speaker.pending.shift();
          speaker.pendingSamples -= head.length;
        } else {
          speaker.pending[0] = head.subarray(take);
          speaker.pendingSamples -= take;
        }
      }
    }
    // Silence is written too: a mix with gaps cut out would no longer line up
    // with the replay, and the whole point of it is that it does.
    void any;
    this.mix.write(out);
  }

  /** Everything still in hand, pushed through the mixer.
   *
   *  Frames arrive from LiveKit and wait in each speaker's buffer for the
   *  20ms mix clock to pick them up, so at any instant there is a little
   *  audio held that has not been written yet. Whatever is being held when
   *  the session ends is, by definition, the END of the recording — the part
   *  somebody is most likely listening for.
   *
   *  Bounded rather than "until empty": a speaker whose buffer is somehow
   *  never drained must not spin here while a match is shutting down. */
  private drainMix(): void {
    if (!this.mix) return;
    let frames = Math.ceil(MAX_BUFFER_SAMPLES / TICK_SAMPLES) + 2;
    while (frames-- > 0 && [...this.speakers.values()].some((sp) => sp.pending.length > 0)) {
      this.tickMix();
    }
  }

  /** Stop everything and finish every file. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closing) return;
    // DRAIN FIRST. tickMix refuses to run once `closing` is set, so setting it
    // before the drain threw away every frame still buffered — the last
    // seconds of the mix, every time.
    this.drainMix();
    this.closing = true;
    for (const uid of [...this.speakers.keys()]) await this.dropSpeaker(uid);
    await this.endMix();
    try {
      await this.room?.disconnect();
    } catch {
      /* already gone */
    }
    this.room = null;
    console.log(`[rec] ${this.key}: finished after ${Math.round(this.seconds)}s`);
  }
}

/** Rows this process believes are live but has no writer for — a crash, or a
 *  session that ended while the recorder was down. Closed out so the console
 *  never shows a recording that stopped an hour ago as still running. */
export async function closeStaleRows(liveKeys: Set<string>): Promise<number> {
  const { getEvidence } = await import("../platform/evidence.js");
  const { isLeased } = await import("./registry.js");
  const rows = await db
    .select({ id: voiceRecordings.id, key: voiceRecordings.matchKey, r2Key: voiceRecordings.r2Key })
    .from(voiceRecordings)
    .where(sql`${voiceRecordings.status} in ('starting','active')`);
  let closed = 0;
  for (const row of rows) {
    if (liveKeys.has(row.key)) continue;
    // Another recorder may be part-way through writing this. Closing it here
    // would mark a live recording finished and leave the row disagreeing with
    // the file that is still growing.
    if (await isLeased(row.key)) continue;
    // What does the bucket actually hold? A row marked complete with nothing
    // behind it is worse than one marked failed: the console would offer a
    // recording that cannot be played, which in an evidence store is a lie.
    const body = await getEvidence(row.r2Key).catch(() => null);
    await db
      .update(voiceRecordings)
      .set(
        body && body.length > 0
          ? { status: "complete", endedAt: sql`now()`, bytes: body.length }
          : { status: "failed", endedAt: sql`now()`, error: "interrupted before anything was written" }
      )
      .where(and(eq(voiceRecordings.id, row.id), sql`${voiceRecordings.status} in ('starting','active')`));
    closed++;
  }
  if (closed > 0) console.log(`✔ Closed ${closed} recording(s) left open by a previous run`);
  return closed;
}
