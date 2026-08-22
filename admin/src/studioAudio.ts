// The sound of a match, laid over the replay.
//
// The replay already reconstructs what people DID. This is what they said
// while doing it, on the same clock — which is the difference between a report
// that says "he was told to move and ignored it" and one that guesses.
//
// Two kinds of file, and both are wanted:
//   the room mix   — everyone together, which is how a conversation is followed
//   each voice     — one person alone, which is how "who said that" is answered
//
// The mix plays by default and the separate voices are muted, but every one of
// them is decoded and running: their levels are what light the microphone next
// to a name, so the studio can show who is talking even while you listen to
// the mix. Un-muting a voice is then just a gain change on something already
// in step.
//
// Time is the whole point. Each recording carries an offsetMs — how far into
// the match it began, measured from tick 0 — so a file that started forty
// seconds in is placed forty seconds in. Nothing here guesses at alignment.
import { fetchBlobUrl } from "./api";
/** One recording, as the console receives it. Lives here because the audio
 *  deck is the only thing that consumes it now — voice is heard inside a
 *  studio and nowhere else. */
export interface VoiceFile {
  id: string;
  kind: "track" | "mix";
  scope: "match" | "lobby";
  uid: string;
  username: string | null;
  /** Milliseconds from the session's start — for a match, from tick 0. */
  offsetMs: number;
  durationSec: number | null;
  bytes: number | null;
  startedAt: string;
  url: string | null;
  roster: { uid: string; username: string | null }[] | null;
  /** When this person was actually talking, from the recording itself. */
  speech: [number, number][] | null;
}
import { esc } from "./ui";

/** Above this, audio is not merely unpleasant but useless as evidence, and
 *  browsers throttle or mute it anyway. The picture keeps its speed. */
const MAX_AUDIBLE_RATE = 4;
/** How far out of step a track may drift before it is nudged back. Below this,
 *  correcting does more damage (an audible seek) than the drift itself. */
const DRIFT_TOLERANCE_S = 0.25;
/** Loudness at which the microphone icon lights. Chosen against real fake-mic
 *  audio: room noise sits well under it, speech well over. */
const SPEAKING_RMS = 0.045;

interface Deck {
  file: VoiceFile;
  audio: HTMLAudioElement;
  blobUrl: string;
  analyser: AnalyserNode | null;
  gain: GainNode | null;
  data: Uint8Array<ArrayBuffer>;
  /** false while it is muted — the mix starts on, the voices start off. */
  audible: boolean;
}

export interface StudioAudio {
  /** Called from the studio's one frame loop, after the clock has advanced. */
  sync(vTimeMs: number, playing: boolean, speed: number): void;
  /** uids heard talking at this instant, from the sound itself. */
  speaking(): Set<string>;
  /** The mixer, for the panel under the stage. */
  render(): string;
  wire(host: HTMLElement): void;
  /** When somebody was talking, for whoever is currently selected.
   *
   *  Everyone by default — the whole group's voice on one line — and one
   *  person's the moment a single microphone is ticked, because "when did the
   *  room make noise" and "when did HE speak" are different questions and an
   *  admin is usually holding one of them. */
  timeline(): { label: string; spans: [number, number][] };
  /** Called when the selection changes, so the picture can follow it. */
  onSelect(fn: () => void): void;
  resume(): void;
  dispose(): void;
}

export async function loadStudioAudio(files: VoiceFile[], mount: HTMLElement): Promise<StudioAudio | null> {
  const usable = files.filter((f) => f.durationSec !== null);
  if (usable.length === 0) return null;

  const ctx = new AudioContext();
  const decks: Deck[] = [];
  const selectListeners = new Set<() => void>();

  for (const file of usable) {
    try {
      const blobUrl = await fetchBlobUrl(`/voice/recordings/${encodeURIComponent(file.id)}/audio`);
      const audio = new Audio(blobUrl);
      audio.preload = "auto";
      // In the document, not floating in a variable. A detached media element
      // plays, but browsers treat it as less "user visible" for autoplay, and
      // nothing — a person debugging, or a test — can see what it is doing.
      audio.hidden = true;
      audio.dataset.uid = file.uid;
      audio.dataset.kind = file.kind;
      // A blob is same-origin, so this graph is allowed to see the samples.
      // A presigned bucket URL would decode to silence here.
      mount.appendChild(audio);
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const gain = ctx.createGain();
      gain.gain.value = file.kind === "mix" ? 1 : 0;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(ctx.destination);
      decks.push({
        file,
        audio,
        blobUrl,
        analyser,
        gain,
        data: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
        audible: file.kind === "mix",
      });
    } catch (err) {
      console.error("[studio] could not load recording", file.id, err);
    }
  }
  if (decks.length === 0) {
    void ctx.close();
    return null;
  }

  const talking = new Set<string>();

  return {
    resume() {
      if (ctx.state === "suspended") void ctx.resume();
    },

    sync(vTimeMs, playing, speed) {
      const audible = speed <= MAX_AUDIBLE_RATE;
      for (const d of decks) {
        const local = (vTimeMs - d.file.offsetMs) / 1000;
        const end = d.file.durationSec ?? 0;
        // Outside its own stretch of the match, a file simply is not playing.
        // This is what makes several recordings that started at different
        // moments behave like one timeline.
        if (local < 0 || local > end) {
          if (!d.audio.paused) d.audio.pause();
          continue;
        }
        if (Math.abs(d.audio.currentTime - local) > DRIFT_TOLERANCE_S) d.audio.currentTime = local;
        d.audio.playbackRate = Math.min(MAX_AUDIBLE_RATE, Math.max(0.25, speed));
        if (d.gain) d.gain.gain.value = d.audible && audible ? 1 : 0;
        if (playing && audible) {
          if (d.audio.paused) void d.audio.play().catch(() => undefined);
        } else if (!d.audio.paused) {
          d.audio.pause();
        }
      }

      // Who is talking, measured rather than assumed: root-mean-square of the
      // last few milliseconds of each SEPARATE voice. The mix is skipped — it
      // is everybody, so it would light everybody.
      talking.clear();
      for (const d of decks) {
        if (d.file.kind !== "track" || !d.analyser || d.audio.paused) continue;
        d.analyser.getByteTimeDomainData(d.data);
        let sum = 0;
        for (let i = 0; i < d.data.length; i++) {
          const v = (d.data[i] - 128) / 128;
          sum += v * v;
        }
        if (Math.sqrt(sum / d.data.length) > SPEAKING_RMS) talking.add(d.file.uid);
      }
    },

    speaking: () => talking,

    render() {
      const row = (d: Deck, i: number) =>
        `<label class="mixrow">
          <input type="checkbox" data-mix="${i}" ${d.audible ? "checked" : ""} />
          <span>${d.file.kind === "mix" ? "🎧 Everyone, together" : `🎙 ${esc(d.file.username ?? d.file.uid)}`}</span>
          <span class="muted mono" style="font-size:11px">${
            d.file.offsetMs > 0 ? `from ${Math.round(d.file.offsetMs / 1000)}s` : "from the start"
          }</span>
        </label>`;
      return `<div class="mixer">
        <div class="mixhead">Sound <span class="muted">— the mix plays; tick a name to hear only them</span></div>
        ${decks.map(row).join("")}
        <p class="muted" style="font-size:11.5px;margin-top:8px">
          Above ${MAX_AUDIBLE_RATE}× the picture keeps its speed and the sound drops out.
        </p>
      </div>`;
    },

    wire(host) {
      host.querySelectorAll<HTMLInputElement>("[data-mix]").forEach((box) => {
        box.onchange = () => {
          const d = decks[Number(box.dataset.mix)];
          if (d) d.audible = box.checked;
          for (const fn of selectListeners) fn();
        };
      });
    },

    timeline() {
      const tracks = decks.filter((d) => d.file.kind === "track");
      const picked = tracks.filter((d) => d.audible);
      // One microphone ticked on its own is a question about that person.
      // Anything else — all of them, none of them, or the mix — is a question
      // about the group, so the line answers for the group.
      if (picked.length === 1 && picked.length < tracks.length) {
        const only = picked[0];
        return {
          label: only.file.username ?? only.file.uid,
          spans: (only.file.speech ?? []).map(([a, b]) => [a, b] as [number, number]),
        };
      }
      const all: [number, number][] = [];
      for (const d of tracks) for (const sp of d.file.speech ?? []) all.push([sp[0], sp[1]]);
      return { label: "everyone", spans: all };
    },

    onSelect(fn) {
      selectListeners.add(fn);
    },

    dispose() {
      for (const d of decks) {
        d.audio.pause();
        d.audio.src = "";
        d.audio.remove();
        URL.revokeObjectURL(d.blobUrl);
      }
      void ctx.close();
    },
  };
}
