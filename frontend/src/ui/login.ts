import { mountGoogleSignIn } from "../auth/google";
import type { User } from "../types";

export function showLogin(onSuccess: (user: User) => void) {
  const root = document.getElementById("ui-root")!;
  const screen = document.createElement("div");
  screen.className = "login-screen";
  screen.innerHTML = `
    <div class="login-card">
      <div class="login-logo">TOFO<span>GAMES</span></div>
      <p class="login-tagline">Squad up. Play together.</p>
      <div id="google-btn" class="google-btn-slot"></div>
      <p class="login-error" id="login-error"></p>
    </div>
  `;
  root.appendChild(screen);

  const errorEl = screen.querySelector<HTMLElement>("#login-error")!;
  mountGoogleSignIn(
    screen.querySelector<HTMLElement>("#google-btn")!,
    (user) => {
      screen.remove();
      onSuccess(user);
    },
    (message) => {
      errorEl.textContent = message;
    }
  ).catch((err) => {
    errorEl.textContent = err instanceof Error ? err.message : "Failed to load Google Sign-In";
  });
}
