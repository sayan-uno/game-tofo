import { GOOGLE_CLIENT_ID } from "../config";
import { api, saveSession } from "../api/http";
import type { User } from "../types";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: object) => void;
          renderButton: (el: HTMLElement, options: object) => void;
        };
      };
    };
  }
}

function waitForGis(timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (window.google?.accounts?.id) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("Google Sign-In script failed to load"));
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** Renders the official Google button into `container`.
 *  On success the backend verifies the token, stores the user in Postgres,
 *  and returns our JWT + user (with their unique UID). `needsUsername` is
 *  true until the account has claimed its in-game tag — the caller routes
 *  those players to the claim screen instead of the lobby. */
export async function mountGoogleSignIn(
  container: HTMLElement,
  onSuccess: (user: User, needsUsername: boolean) => void,
  onError: (message: string) => void
): Promise<void> {
  if (!GOOGLE_CLIENT_ID) {
    onError("VITE_GOOGLE_CLIENT_ID is not set in frontend/.env");
    return;
  }
  await waitForGis();
  window.google!.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: async (response: { credential: string }) => {
      try {
        const data = await api.post<{ token: string; user: User; needsUsername?: boolean }>("/api/auth/google", {
          credential: response.credential,
        });
        saveSession(data.token, data.user);
        onSuccess(data.user, data.needsUsername === true);
      } catch (err) {
        onError(err instanceof Error ? err.message : "Sign-in failed");
      }
    },
  });
  // The button is rendered at max width and stretched invisibly over our own
  // styled button (see .google-btn-slot in style.css), so the official Google
  // flow handles every click while the page keeps its custom look.
  window.google!.accounts.id.renderButton(container, {
    theme: "filled_black",
    size: "large",
    shape: "rectangular",
    text: "continue_with",
    width: 400,
  });
}
