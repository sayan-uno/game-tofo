import { mountGoogleSignIn } from "../auth/google";
import type { User } from "../types";

// Inline SVGs: crisp at any size, zero extra requests.
const icons = {
  bolt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 11.5 2 2 4-4.5"/></svg>`,
  tap: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
  gamepad: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.152A4 4 0 0 0 17.32 5z"/></svg>`,
  google: `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`,
};

export function showLogin(onSuccess: (user: User, needsUsername: boolean) => void) {
  const root = document.getElementById("ui-root")!;
  const screen = document.createElement("div");
  screen.className = "login-screen";
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

    <main class="lg-main">
      <h1 class="lg-title">
        <span>Play.</span>
        <span>Compete.</span>
        <span class="accent">Own the game.</span>
      </h1>
      <p class="lg-sub">Jump into epic battles, team up with friends, and experience gaming like never before.</p>

      <ul class="lg-feats">
        <li>${icons.bolt}<span>Fast &amp; Secure<br />Login</span></li>
        <li>${icons.shield}<span>Privacy<br />Protected</span></li>
        <li>${icons.tap}<span>One Tap<br />Access</span></li>
      </ul>

      <div class="lg-google loading" id="google-wrap">
        <div class="lg-google-visual" aria-hidden="true">${icons.google}<span>Continue with Google</span></div>
        <div id="google-btn" class="google-btn-slot"></div>
      </div>

      <p class="lg-secure">${icons.lock}<span>Secure login with Google</span></p>
      <p class="lg-privacy">We never access your personal info.</p>
      <p class="login-error" id="login-error" role="alert"></p>
    </main>

    <div class="lg-badge lg-badge-desktop">
      <span class="lg-badge-icon">${icons.gamepad}</span>
      <span class="lg-badge-text"><strong>Ready to Play?</strong><span>Millions of battles. Zero limits.</span></span>
    </div>
    <div class="lg-badge lg-badge-mobile">
      <span class="lg-badge-icon">${icons.gamepad}</span>
      <span class="lg-badge-text"><strong>Built for Gamers.</strong><span>Designed for Victory.</span></span>
    </div>

    <footer class="lg-footer">© <span class="accent">${new Date().getFullYear()}</span> TOFO GAMES. All rights reserved.</footer>
  `;
  root.appendChild(screen);

  const errorEl = screen.querySelector<HTMLElement>("#login-error")!;
  const googleWrap = screen.querySelector<HTMLElement>("#google-wrap")!;
  mountGoogleSignIn(
    screen.querySelector<HTMLElement>("#google-btn")!,
    (user, needsUsername) => {
      screen.remove();
      onSuccess(user, needsUsername);
    },
    (message) => {
      errorEl.textContent = message;
    }
  )
    .then(() => {
      googleWrap.classList.remove("loading");
    })
    .catch((err) => {
      googleWrap.classList.remove("loading");
      googleWrap.classList.add("failed");
      errorEl.textContent = err instanceof Error ? err.message : "Failed to load Google Sign-In";
    });
}
