// Out-of-band alerts.
//
// An admin console you have to remember to open is one you will not open. The
// point of this file is that someone signing in — or failing to, repeatedly —
// reaches you within seconds, on a channel that is deliberately NOT the inbox
// your recovery codes would arrive in. If both live in one Gmail, whoever takes
// that account gets the keys AND the alarm.
//
// Never awaited, never throws, silently absent when unconfigured.
import { config } from "../config.js";

export function alert(text: string): void {
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) return;
  void fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  }).catch((err) => console.error("[alert] could not send:", err));
}

/** Formats the who/where every security alert needs. */
export const who = (email: string, ip: string | null, ua: string | null): string =>
  `${email}\nIP: ${ip ?? "unknown"}\n${(ua ?? "unknown device").slice(0, 90)}`;
