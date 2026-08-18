// Confirming with a fresh authenticator code.
//
// The console never asks for a code up front — it tries the action, and only
// if the server says a confirmation is needed does it ask. That way the prompt
// appears exactly when it is meaningful, and for the five minutes afterwards
// it does not appear at all.
//
// Note the code has to be a NEW one: the six digits used to sign in cannot be
// spent twice, which is precisely what makes this prove you are holding the
// phone now rather than that you were twenty minutes ago.
import { ApiFailure, call } from "./api";
import { ask } from "./modal";

async function confirm(): Promise<boolean> {
  const answer = await ask({
    title: "Confirm it is you",
    intro: "Enter the current code from your authenticator. Wait for the next one if you just signed in.",
    fields: [{ name: "code", label: "Authenticator code", type: "code", placeholder: "000000" }],
    confirm: "Confirm",
    async onSubmit(v) {
      if (!/^\d{6}$/.test(v.code)) return "Six digits.";
      try {
        await call("/session/sudo", { method: "POST", body: JSON.stringify({ code: v.code }) });
        return null;
      } catch (e) {
        return e instanceof ApiFailure ? e.info.error : "That did not work";
      }
    },
  });
  return answer !== null;
}

/** Run something, and if the server asks for a confirmation, get one and try
 *  again exactly once. Anything else is passed straight back to the caller. */
export async function withSudo<T>(action: () => Promise<T>): Promise<T | null> {
  try {
    return await action();
  } catch (e) {
    if (e instanceof ApiFailure && e.info.code === "SUDO_REQUIRED") {
      if (!(await confirm())) return null;
      return await action();
    }
    throw e;
  }
}
