// Who you can hear, and how loudly.
//
// The rule is the one the world advertises: full volume inside ten metres,
// fading to nothing at twenty, and past that they are not merely quiet — they
// are UNSUBSCRIBED, so their audio never reaches this device at all. That is
// the difference between a privacy promise and a volume slider, and it is also
// what makes twenty people in one room affordable: a phone decodes the three
// or four voices actually near it rather than nineteen.
//
// This runs on a slow timer of its own (six times a second), not per frame.
// Distance changes at walking pace; recomputing it sixty times a second would
// be fifty-four wasted passes and a WebAudio ramp that never settles.
import { setVoiceProximity } from "../../voice/livekit";
import { HEAR_DROP_M, HEAR_MAX_M, HEAR_SUBSCRIBE_M, hearGain } from "../../shared/games/social/index";

/** Six times a second. Fast enough that walking up to somebody fades them in
 *  smoothly; slow enough to be free. */
const EVERY_MS = 160;

export interface Neighbour {
  uid: string;
  x: number;
  z: number;
}

export class Proximity {
  private nextAt = 0;
  /** Who is currently subscribed, so the band between SUBSCRIBE and DROP can
   *  be hysteretic — somebody pacing across the line does not make their own
   *  voice stutter. */
  private open = new Set<string>();
  private gains = new Map<string, number>();
  /** How many people are inside earshot right now — the HUD prints it, and it
   *  is the one number that tells a player whether anyone can hear them. */
  near = 0;

  /** Is a pass due? Asked separately so the caller does not build a list of
   *  neighbours sixty times a second for a function that reads it six. */
  due(now: number): boolean {
    return now >= this.nextAt;
  }

  update(now: number, meX: number, meZ: number, others: Neighbour[]): void {
    if (now < this.nextAt) return;
    this.nextAt = now + EVERY_MS;
    const next = new Map<string, number>();
    let near = 0;
    for (const o of others) {
      const dx = o.x - meX;
      const dz = o.z - meZ;
      const d = Math.sqrt(dx * dx + dz * dz);
      const was = this.open.has(o.uid);
      // Take the subscription out a little inside the audible edge and drop it
      // a little outside — the gap IS the hysteresis.
      const want = was ? d <= HEAR_DROP_M : d <= HEAR_SUBSCRIBE_M;
      if (!want) {
        this.open.delete(o.uid);
        continue;
      }
      this.open.add(o.uid);
      // The gain still follows the honest curve, so somebody held subscribed
      // past twenty metres by the hysteresis is silent rather than faint.
      const gain = hearGain(d);
      next.set(o.uid, gain);
      if (d <= HEAR_MAX_M) near++;
    }
    this.near = near;
    this.gains = next;
    setVoiceProximity(next);
  }

  /** How loudly this person is being heard, 0 when they are out of range.
   *  Drawn as a ring under their feet, so "why can't they hear me" has an
   *  answer you can see rather than one you have to be told. */
  gainOf(uid: string): number {
    return this.gains.get(uid) ?? 0;
  }

  reset(): void {
    this.open.clear();
    this.gains = new Map();
    this.near = 0;
    this.nextAt = 0;
    setVoiceProximity(new Map());
  }
}
