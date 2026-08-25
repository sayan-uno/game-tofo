// What the server population says in a world, and how it decides to say it.
//
// This file is the whole difference between a room that feels alive and a room
// that feels generated. Three rules it is built around, each of which was the
// obvious tell when it was missing:
//
//   1. NOBODY TALKS IN PARAGRAPHS. Public chat is four words and a full stop
//      that never arrives. Lines are short, lower-case more often than not,
//      and punctuation is the exception.
//   2. A ROOM IS NOT A ROTA. Lines are drawn against a per-world memory of
//      what has already been said, so the same phrase does not come round
//      every few minutes — which is what the eye actually catches.
//   3. PEOPLE ANSWER EACH OTHER. A greeting gets greeted back, a question
//      sometimes gets an answer, "gg" gets a "gg". Not always: a room where
//      every line is replied to is as wrong as one where none is.
//
// Nothing here is game-specific beyond a couple of names, and nothing here is
// ever shown as coming from anything but a player.
import type { BotPersona } from "./botAccounts.js";

/** How likely a persona is to be the one who says the next thing. Quiet
 *  accounts exist mostly to be in the room. */
export const PERSONA_VOICE: Record<BotPersona, number> = { quiet: 1, casual: 4, chatty: 10, hype: 14 };

/** Openers — what somebody says when they have nothing particular to say. */
const IDLE = [
  "yo", "hey", "hi all", "anyone here", "sup", "gm", "gn everyone", "back",
  "finally online", "wifi died lol", "who's playing", "im bored",
  "anyone up for a game", "need 1 more", "queue is fast rn", "servers feel good today",
  "just woke up", "one more match then sleep", "brb food", "back from school",
  "phone is at 4%", "charging, brb", "this room is quiet", "chat is dead lol",
  "lag was crazy last game", "rip my streak", "3rd place again", "so close",
  "first try", "that was clean", "i cant aim today", "my thumbs hurt lol",
];

/** Things that read as being about the platform without promising anything. */
const GAME = [
  "trackline is so fun", "ludo again?", "ludo is rigged fr", "i keep rolling 1s",
  "anyone good at trackline", "that map is hard", "i almost had it",
  "new game when", "trackline > ludo", "ludo > trackline fight me",
  "how do people run that fast", "i crashed on the first turn lol",
  "6 6 6 and still lost", "my luck is gone", "one more one more",
  "best i got was 2nd", "someone carry me", "im ranking up today for real",
  "carrom doubles anyone", "i keep pocketing the striker lol", "queen is mine",
  "carrom or ludo", "my cut shots are terrible", "9-0 carrom lets go",
  "dots and boxes is so underrated", "i always open the long chain",
  "took 9 boxes in one go", "anyone up for dots", "dots is pure maths lol",
  "8 ball anyone", "i scratched on the black again", "that break was filthy",
  "solids or stripes", "cleared the table in one visit", "pool doubles?",
  "my safety game is non existent", "potted the 8 early lol",
];

/** Reactions — the bulk of any real chat. */
const REACT = [
  "lol", "lmao", "same", "fr", "true", "nice", "gg", "ggs", "ez", "oof",
  "rip", "😂", "🔥", "💀", "🫡", "👍", "yep", "nah", "bruh", "w", "L",
  "hahaha", "ok that's wild", "how", "no way", "insane",
];

/** Questions, which are what actually start conversations. */
const ASK = [
  "what rank are you", "anyone else lagging", "how do i change my character",
  "where is everyone", "what time is it there", "anyone here plays daily",
  "is trackline down for anyone", "how long you been playing",
  "anyone up for carrom doubles", "who's good at dots and boxes",
  "anyone play 8 ball", "whos on for pool",
  "whats your best score", "anyone wanna duo", "squad?", "who's the best here",
];

/** Answers, keyed by what they answer. The trigger is a plain substring test —
 *  a cheap one, because this runs on a timer and not on a player's input. */
const REPLIES: { when: RegExp; say: string[] }[] = [
  { when: /\b(yo|hey|hi|hello|sup|gm|good morning)\b/i, say: ["yo", "hey", "hi", "sup", "hey hey", "yo yo", "hii"] },
  { when: /\b(gn|good night|sleep)\b/i, say: ["gn", "night", "sleep well", "gn o/"] },
  { when: /\b(gg|ggs)\b/i, say: ["gg", "ggs", "gg wp", "gg all"] },
  { when: /\?\s*$/, say: ["idk", "no idea", "same question", "good q", "someone said yes earlier", "depends"] },
  { when: /\b(rank|level)\b/i, say: ["im lvl 7", "still low lol", "grinding", "lvl 12 here", "not high enough"] },
  { when: /\b(lag|lagging|ping)\b/i, say: ["yeah same", "its fine here", "my ping is ok", "wifi issue maybe", "ping spiked for me too"] },
  { when: /\b(duo|squad|team|party|join)\b/i, say: ["im in", "me", "count me", "sure", "gimme a sec", "yes pls"] },
  { when: /\b(ludo)\b/i, say: ["ludo gang", "i hate ludo lol", "ludo is luck", "one ludo then", "ludo carry me"] },
  { when: /\b(trackline|run|running)\b/i, say: ["trackline is the best", "i keep crashing", "im ok at it", "lets go trackline"] },
  { when: /\b(carrom|striker|queen)\b/i, say: ["carrom gang", "im decent at carrom", "one carrom then", "i always miss the cut", "cover the queen first"] },
  { when: /\b(dots|boxes|chain|square)\b/i, say: ["dots is my game", "count the chains", "i always give the first one away", "one dots then", "never open a long chain"] },
  { when: /\b(pool|8 ?ball|cue|break|snooker|stripes|solids)\b/i, say: ["pool gang", "one 8 ball then", "i always scratch", "never play safe enough", "im on stripes", "call the black"] },
  { when: /\b(win|won|first)\b/i, say: ["nice", "congrats", "gz", "let's go", "sheesh"] },
  { when: /\b(lost|lose|last)\b/i, say: ["unlucky", "next one", "same lol", "happens", "rematch"] },
];

/** How a persona bends a line on the way out. Kept small on purpose — heavy
 *  styling is more obviously synthetic than no styling at all. */
function style(text: string, persona: BotPersona): string {
  if (persona === "hype") {
    if (Math.random() < 0.3) return `${text}!!`;
    if (Math.random() < 0.25) return `${text} ${pick(["🔥", "😤", "💯", "🚀"])}`;
  }
  if (persona === "quiet" && Math.random() < 0.5) return text.split(" ").slice(0, 3).join(" ");
  // A typo now and then. Real chat has them, and their absence is uncanny in a
  // way nobody can name until it is pointed out.
  if (Math.random() < 0.06) return typo(text);
  return text;
}

function typo(text: string): string {
  if (text.length < 4) return text;
  const i = 1 + Math.floor(Math.random() * (text.length - 2));
  if (Math.random() < 0.5) return text.slice(0, i) + text.slice(i + 1); // dropped a letter
  return text.slice(0, i) + text[i] + text.slice(i); // doubled one
}

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)];

/** Per-world memory of what has been said lately, so the room does not loop.
 *  A bounded set: the last N lines, and a line in it is simply not chosen. */
const recent = new Map<string, string[]>();
const RECENT_MAX = 45;

function fresh(worldId: string, pool: readonly string[]): string | null {
  const seen = recent.get(worldId) ?? [];
  const options = pool.filter((line) => !seen.includes(line));
  if (options.length === 0) return null;
  const chosen = pick(options);
  seen.push(chosen);
  while (seen.length > RECENT_MAX) seen.shift();
  recent.set(worldId, seen);
  return chosen;
}

/** The next thing somebody says in this world.
 *
 *  `lastLine` is what was said immediately before, if anything; a reply to it
 *  is preferred when one exists, because a room where nobody responds to
 *  anybody is a list of statements rather than a conversation. */
export function nextLine(worldId: string, persona: BotPersona, lastLine: string | null): string {
  if (lastLine) {
    const rule = REPLIES.find((r) => r.when.test(lastLine));
    // Not every line gets an answer — see the header.
    if (rule && Math.random() < 0.55) return style(pick(rule.say), persona);
  }
  const roll = Math.random();
  const pool = roll < 0.42 ? REACT : roll < 0.7 ? IDLE : roll < 0.9 ? GAME : ASK;
  return style(fresh(worldId, pool) ?? pick(pool), persona);
}

/** What a bot says when it walks into a party. Short, and never twice in a
 *  row from the same group — a squad that gets "yo" three times as three bots
 *  arrive is the tell this exists to avoid. */
const ARRIVALS = ["yo", "hey", "sup", "hi", "yo lets go", "ready when you are", "hey hey", "im in", "lets play"];
export const arrivalLine = (persona: BotPersona): string => style(pick(ARRIVALS), persona);

/** Cleanup for a world that no longer exists. */
export const forgetWorldLines = (worldId: string): void => void recent.delete(worldId);
