import { api, ApiError, saveSession } from "../api/http";
import { setNameView } from "./nameview";
import type { User } from "../types";

/** Client mirror of the server rules (backend/src/services/username.ts):
 *  2–15 code points, no ASCII whitespace/control chars — everything else,
 *  exotic Unicode included, is allowed on purpose. The server re-validates. */
const MIN = 2;
const MAX = 15;
const STRIP = /[\u0000-\u0020\u007f]/g;

const codePoints = (s: string) => [...s];
const sanitize = (s: string) => codePoints(s.replace(STRIP, "")).slice(0, MAX).join("");

const lockIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;

/** The one-time gamer-tag claim screen shown between Google sign-in and the
 *  lobby (only while the account has no username yet). Pure DOM + CSS —
 *  Babylon stays un-loaded, so this page is as instant as the login screen. */
export function showUsernameSetup(user: User, onDone: (user: User) => void) {
  const root = document.getElementById("ui-root")!;
  const screen = document.createElement("div");
  screen.className = "username-screen";
  screen.innerHTML = `
    <div class="lg-bg" aria-hidden="true">
      <div class="lg-glow"></div>
      <div class="lg-rings">
        <div class="lg-ring r4"></div>
        <div class="lg-ring r3"></div>
        <div class="lg-ring r2"></div>
        <div class="lg-ring r1"></div>
        <div class="lg-arc a1"></div>
        <div class="lg-arc a2"></div>
        <div class="lg-emblem"><img src="/logo-red.png" alt="" width="290" height="290" /></div>
      </div>
      <div class="lg-city"></div>
      <div class="lg-embers">${"<i></i>".repeat(10)}</div>
      <div class="lg-vignette"></div>
    </div>

    <header class="lg-header">
      <img class="lg-mark" src="/logo-red.png" alt="TOFO Games" width="48" height="48" />
      <div class="lg-word"><span class="t">TOFO</span><span class="g">GAMES</span></div>
    </header>

    <main class="un-main">
      <p class="un-kicker">// One last step</p>
      <h1 class="un-title">Claim your <span class="accent">gamer&nbsp;tag</span></h1>
      <p class="un-sub">The name every rival and squadmate will see. Pick it once — make it count.</p>

      <div class="un-card">
        <div class="un-preview" aria-hidden="true">
          <span class="un-preview-label">In-game preview</span>
          <div class="un-plate">
            <div class="un-plate-name"></div>
            <div class="un-plate-uid">UID ${user.uid}</div>
          </div>
        </div>
        <label class="un-field">
          <input class="un-input" type="text" placeholder="YourTag" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" aria-label="Gamer tag" />
          <span class="un-count">0/${MAX}</span>
        </label>
        <p class="un-status" role="status"></p>
        <button class="btn btn-red un-claim" disabled>CLAIM &amp; ENTER</button>
        <button class="un-skip" type="button">Skip — pick one for me <span>(built from your Google name)</span></button>
      </div>

      <ul class="un-rules">
        <li>${MIN}–${MAX} characters</li>
        <li>No spaces</li>
        <li>One of a kind</li>
      </ul>
      <p class="un-note">${lockIcon}<span>Your Google name stays private — in game, everyone only ever sees your tag.</span></p>
    </main>
  `;
  root.appendChild(screen);

  const input = screen.querySelector<HTMLInputElement>(".un-input")!;
  const count = screen.querySelector<HTMLElement>(".un-count")!;
  const status = screen.querySelector<HTMLElement>(".un-status")!;
  const claimBtn = screen.querySelector<HTMLButtonElement>(".un-claim")!;
  const skipBtn = screen.querySelector<HTMLButtonElement>(".un-skip")!;
  const previewName = screen.querySelector<HTMLElement>(".un-plate-name")!;

  let checkSeq = 0; // ignore answers for anything but the latest value
  let debounceTimer = 0;
  let availableFor: string | null = null; // value the server last blessed
  let busy = false;

  const setStatus = (text: string, kind: "" | "ok" | "bad" | "busy" = "") => {
    status.textContent = text;
    status.className = `un-status${kind ? ` ${kind}` : ""}`;
  };

  const syncClaimButton = () => {
    claimBtn.disabled = busy || input.value.length === 0 || availableFor !== input.value;
  };

  const runCheck = async (value: string) => {
    const seq = ++checkSeq;
    setStatus("Checking availability…", "busy");
    try {
      const res = await api.get<{ available: boolean; reason?: string }>(
        `/api/auth/username/check?u=${encodeURIComponent(value)}`
      );
      if (seq !== checkSeq) return; // they kept typing
      if (res.available) {
        availableFor = value;
        setStatus("Available — it's yours if you claim it", "ok");
      } else {
        setStatus(res.reason ?? "Taken — try another", "bad");
      }
    } catch {
      if (seq !== checkSeq) return;
      // Network hiccup: let them try the claim anyway — the server decides.
      availableFor = value;
      setStatus("Couldn't check right now — you can still try to claim it", "busy");
    }
    syncClaimButton();
  };

  const onInput = () => {
    const cleaned = sanitize(input.value);
    if (input.value !== cleaned) input.value = cleaned;
    const length = codePoints(cleaned).length;
    count.textContent = `${length}/${MAX}`;
    count.classList.toggle("full", length >= MAX);
    setNameView(previewName, cleaned || "YOURTAG");
    availableFor = null;
    checkSeq++; // orphan any in-flight answer
    clearTimeout(debounceTimer);
    if (length === 0) {
      setStatus("Letters, numbers, symbols — anything but spaces.");
    } else if (length < MIN) {
      setStatus(`At least ${MIN} characters`, "busy");
    } else {
      debounceTimer = window.setTimeout(() => void runCheck(cleaned), 350);
    }
    syncClaimButton();
  };
  input.oninput = onInput;

  const finish = (finalUser: User) => {
    clearTimeout(debounceTimer);
    screen.remove();
    onDone(finalUser);
  };

  /** Both tabs open / claimed on another device — accept reality and enter. */
  const recoverAlreadySet = async () => {
    try {
      const { user: me } = await api.get<{ user: User }>("/api/auth/me");
      finish(me);
    } catch {
      setStatus("Something went sideways — reload and try again", "bad");
    }
  };

  const submit = async (payload: { username: string } | { skip: true }) => {
    if (busy) return;
    busy = true;
    screen.classList.add("busy");
    const claimLabel = claimBtn.innerHTML;
    claimBtn.innerHTML = "CLAIMING…";
    skipBtn.disabled = true;
    syncClaimButton();
    try {
      const res = await api.post<{ token: string; user: User }>("/api/auth/username", payload);
      saveSession(res.token, res.user);
      finish(res.user);
      return;
    } catch (err) {
      if (err instanceof ApiError && err.message.includes("already set")) {
        await recoverAlreadySet();
        return;
      }
      availableFor = null;
      setStatus(err instanceof Error ? err.message : "Could not set username", "bad");
    }
    busy = false;
    screen.classList.remove("busy");
    claimBtn.innerHTML = claimLabel;
    skipBtn.disabled = false;
    syncClaimButton();
  };

  claimBtn.onclick = () => void submit({ username: input.value });
  skipBtn.onclick = () => void submit({ skip: true });
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !claimBtn.disabled) void submit({ username: input.value });
  };

  // Head start: their Google name, squeezed into a valid tag. One tap to
  // claim if it's free, and the availability answer is already on screen.
  const suggested = sanitize(user.name);
  if (codePoints(suggested).length >= MIN) input.value = suggested;
  onInput();
  // Autofocus only where no on-screen keyboard would cover the page.
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) input.focus();
}
