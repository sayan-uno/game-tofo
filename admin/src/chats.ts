// A player's conversations, in the console.
//
// Reading somebody's private messages is the most intrusive thing here after
// listening to their voice, so it is shaped the same way: admin-and-above, and
// opening a conversation is audited by name. The console says so out loud
// rather than presenting it as an ordinary panel.
import { ApiFailure, call } from "./api";
import { esc, pill, when } from "./ui";

export interface Thread {
  uid: string;
  username: string | null;
  messages: number;
  sent: number;
  received: number;
  last: string;
  friend: boolean;
}
export interface Message {
  id: string;
  body: string;
  at: string;
  fromUid: string;
}
const stamp = (iso: string) =>
  new Date(iso).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/** Their app splits these into Friends and Recent by whether they are friends
 *  right now, so the console does too — it should show what they see. */
export function renderThreads(threads: Thread[]): string {
  if (threads.length === 0) return `<p class="empty">No messages. Chat is kept for 15 days, so this may simply be older.</p>`;
  const group = (title: string, list: Thread[]) =>
    list.length === 0
      ? ""
      : `<div class="thgroup"><div class="thhead">${title}</div>${list
          .map(
            (t) => `<div class="vrow thread click" data-with="${esc(t.uid)}">
              <div class="vwho">${esc(t.username ?? t.uid)}</div>
              <div class="muted" style="font-size:11.5px">${t.sent} sent · ${t.received} received</div>
              <div class="muted" style="font-size:11.5px">${when(t.last)}</div>
            </div>`
          )
          .join("")}</div>`;
  return (
    group("Friends", threads.filter((t) => t.friend)) +
    group("Recent", threads.filter((t) => !t.friend))
  );
}

export function renderMessages(withWho: { uid: string; username: string | null }, mine: string, rows: Message[]): string {
  if (rows.length === 0) return `<p class="empty">Nothing left in this conversation.</p>`;
  return `<div class="thread-head">with <strong>${esc(withWho.username ?? withWho.uid)}</strong>
            <span class="muted">· ${rows.length} message(s) · kept 15 days</span></div>
    <div class="msgs">${rows
      .map(
        (m) => `<div class="msg ${m.fromUid === mine ? "out" : "in"}">
          <span class="body">${esc(m.body)}</span>
          <span class="stamp">${stamp(m.at)}</span>
        </div>`
      )
      .join("")}</div>`;
}

export const loadThreads = (uid: string) => call<{ threads: Thread[] }>(`/players/${encodeURIComponent(uid)}/chats`);
export const loadConversation = (uid: string, withUid: string) =>
  call<{ with: { uid: string; username: string | null }; messages: Message[] }>(
    `/players/${encodeURIComponent(uid)}/chats/${encodeURIComponent(withUid)}`
  );
export interface Friend {
  uid: string;
  username: string | null;
  status: string;
  since: string;
  theyAsked: boolean;
}
export const loadFriends = (uid: string, q = "") =>
  call<{ friends: Friend[] }>(`/players/${encodeURIComponent(uid)}/friends${q ? `?q=${encodeURIComponent(q)}` : ""}`);

export function renderFriends(list: Friend[]): string {
  if (list.length === 0) return `<p class="empty">Nobody.</p>`;
  return list
    .map(
      (f) => `<div class="vrow">
        <div class="vwho click" data-open="${esc(f.uid)}">${esc(f.username ?? f.uid)}</div>
        <div class="muted mono" style="font-size:11px">${esc(f.uid)}</div>
        <div>${f.status === "accepted" ? pill("friends", "on") : pill(f.theyAsked ? "they asked" : "asked them", "warn")}</div>
        <div class="muted" style="font-size:11.5px">${when(f.since)}</div>
      </div>`
    )
    .join("");
}

export const failure = (e: unknown) => (e instanceof ApiFailure ? e.info.error : "That did not load");
