// Signing in, one stage at a time.
//
// Google first, then whatever that account still needs: a password if it has
// one, then the authenticator — or enrolment, if this is the first time. The
// server decides which stage comes next and hands back a five-minute pending
// ticket; this screen only renders what it is told to.
import { open, setToken } from "./api";

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(o: { client_id: string; callback: (r: { credential: string }) => void }): void;
          renderButton(el: HTMLElement, o: Record<string, unknown>): void;
        };
      };
    };
  }
}

export interface SignedIn {
  email: string;
  name: string;
  role: string;
}

type Stage = "password" | "totp" | "enrol";
interface StageAnswer {
  stage: Stage;
  pending: string;
  name?: string;
  qr?: string;
  secret?: string;
}
interface SessionAnswer {
  accessToken: string;
  admin: SignedIn;
  recoveryCodes?: string[];
  recoveryCodesLeft?: number;
}

const el = (html: string): HTMLElement => {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstElementChild as HTMLElement;
};

export function showLogin(root: HTMLElement, done: (who: SignedIn) => void): void {
  const gate = el(`
    <div class="gate">
      <div class="box">
        <h1>TOFO Console</h1>
        <p class="lead">Restricted. Every sign-in is recorded and alerted.</p>
        <div id="google-btn"></div>
        <div class="err" id="err"></div>
      </div>
    </div>`);
  root.replaceChildren(gate);
  const err = gate.querySelector<HTMLElement>("#err")!;
  const card = gate.querySelector<HTMLElement>(".box")!;
  const fail = (e: unknown) => {
    err.textContent = e instanceof Error ? e.message : "Something went wrong";
  };

  // ---- stage: the authenticator, and enrolment ----------------------------
  function codeStage(answer: StageAnswer): void {
    const enrolling = answer.stage === "enrol";
    card.replaceChildren(
      el(`
      <div>
        <h1>${enrolling ? "Set up your authenticator" : "Authenticator code"}</h1>
        <p class="lead">${
          enrolling
            ? "Scan this with Google Authenticator, then type the six digits it shows."
            : "Six digits from Google Authenticator."
        }</p>
        ${enrolling && answer.qr ? `<img class="qr" alt="Enrolment QR code" src="${answer.qr}" />` : ""}
        ${enrolling && answer.secret ? `<div class="secret">Can't scan? Enter this key by hand:<br>${answer.secret}</div>` : ""}
        <label for="code">Code</label>
        <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" />
        <button class="btn" id="go">${enrolling ? "Confirm and finish" : "Sign in"}</button>
        ${enrolling ? "" : `<button class="link" id="rec">Lost your phone? Use a recovery code</button>`}
        <div class="err" id="err2"></div>
      </div>`)
    );
    const input = card.querySelector<HTMLInputElement>("#code")!;
    const go = card.querySelector<HTMLButtonElement>("#go")!;
    const err2 = card.querySelector<HTMLElement>("#err2")!;
    input.focus();

    const submit = async () => {
      err2.textContent = "";
      go.disabled = true;
      try {
        const session = await open<SessionAnswer>(enrolling ? "/session/enrol" : "/session/totp", {
          pending: answer.pending,
          code: input.value.trim(),
        });
        setToken(session.accessToken);
        if (session.recoveryCodes) showRecoveryCodes(session);
        else done(session.admin);
      } catch (e) {
        err2.textContent = e instanceof Error ? e.message : "That did not work";
        input.select();
      } finally {
        go.disabled = false;
      }
    };
    go.onclick = () => void submit();
    input.onkeydown = (e) => {
      if (e.key === "Enter") void submit();
    };
    card.querySelector<HTMLButtonElement>("#rec")?.addEventListener("click", () => recoveryStage(answer));
  }

  /** Shown exactly once. There is no second chance to see these, which is the
   *  point of them, so the screen says so and makes you confirm. */
  function showRecoveryCodes(session: SessionAnswer): void {
    card.replaceChildren(
      el(`
      <div>
        <h1>Write these down</h1>
        <p class="lead">Ten single-use codes. They are the only way back in if you lose your phone,
          and this is the only time they will be shown.</p>
        <div class="codes">${(session.recoveryCodes ?? []).map((c) => `<code>${c}</code>`).join("")}</div>
        <button class="btn ghost" id="copy">Copy all</button>
        <button class="btn" id="ack">I have saved them</button>
      </div>`)
    );
    card.querySelector<HTMLButtonElement>("#copy")!.onclick = () => {
      void navigator.clipboard.writeText((session.recoveryCodes ?? []).join("\n"));
    };
    card.querySelector<HTMLButtonElement>("#ack")!.onclick = () => done(session.admin);
  }

  function recoveryStage(answer: StageAnswer): void {
    card.replaceChildren(
      el(`
      <div>
        <h1>Recovery code</h1>
        <p class="lead">One of the ten you saved. It works once, and using it raises an alert.</p>
        <label for="rc">Code</label>
        <input id="rc" type="text" autocomplete="off" placeholder="XXXXX-XXXXX" />
        <button class="btn" id="go">Sign in</button>
        <div class="err" id="err3"></div>
      </div>`)
    );
    const input = card.querySelector<HTMLInputElement>("#rc")!;
    const err3 = card.querySelector<HTMLElement>("#err3")!;
    input.focus();
    card.querySelector<HTMLButtonElement>("#go")!.onclick = async () => {
      err3.textContent = "";
      try {
        const session = await open<SessionAnswer>("/session/recovery", {
          pending: answer.pending,
          code: input.value.trim().toUpperCase(),
        });
        setToken(session.accessToken);
        done(session.admin);
      } catch (e) {
        err3.textContent = e instanceof Error ? e.message : "That did not work";
      }
    };
  }

  function passwordStage(answer: StageAnswer): void {
    card.replaceChildren(
      el(`
      <div>
        <h1>Password</h1>
        <p class="lead">Your console password — the factor that covers your Google account itself.</p>
        <label for="pw">Password</label>
        <input id="pw" type="password" autocomplete="current-password" />
        <button class="btn" id="go">Continue</button>
        <div class="err" id="err4"></div>
      </div>`)
    );
    const input = card.querySelector<HTMLInputElement>("#pw")!;
    const err4 = card.querySelector<HTMLElement>("#err4")!;
    input.focus();
    const submit = async () => {
      err4.textContent = "";
      try {
        codeStage(await open<StageAnswer>("/session/password", { pending: answer.pending, password: input.value }));
      } catch (e) {
        err4.textContent = e instanceof Error ? e.message : "That did not work";
      }
    };
    card.querySelector<HTMLButtonElement>("#go")!.onclick = () => void submit();
    input.onkeydown = (e) => {
      if (e.key === "Enter") void submit();
    };
  }

  const afterGoogle = (answer: StageAnswer) =>
    answer.stage === "password" ? passwordStage(answer) : codeStage(answer);

  // ---- stage: Google ------------------------------------------------------
  const mountGoogle = () => {
    const target = gate.querySelector<HTMLElement>("#google-btn");
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;
    if (!target || !window.google || !clientId) {
      err.textContent = window.google
        ? "VITE_GOOGLE_CLIENT_ID is not set"
        : "Could not reach Google sign-in";
      return;
    }
    window.google.accounts.id.initialize({
      client_id: clientId,
      callback: (r) => {
        err.textContent = "";
        open<StageAnswer>("/session/google", { credential: r.credential })
          .then(afterGoogle)
          .catch((e: unknown) => {
            // 404 here means "not an admin" — the server deliberately does not
            // distinguish that from a path that does not exist.
            fail(e instanceof Error && e.message === "Not found" ? new Error("That account cannot sign in here") : e);
          });
      },
    });
    window.google.accounts.id.renderButton(target, {
      theme: "filled_black",
      size: "large",
      width: 370,
      text: "signin_with",
    });
  };

  if (window.google) mountGoogle();
  else {
    let waited = 0;
    const poll = setInterval(() => {
      waited += 100;
      if (window.google) {
        clearInterval(poll);
        mountGoogle();
      } else if (waited > 6000) {
        clearInterval(poll);
        err.textContent = "Could not reach Google sign-in";
      }
    }, 100);
  }
}
