// A dialog that resolves to what the person chose, or null if they backed out.
//
// Promise-shaped on purpose: an action reads as one straight line —
//   const answer = await ask(...); if (!answer) return;
// — rather than as a callback that has to remember what it was doing.
import { el } from "./ui";

export interface Field {
  name: string;
  label: string;
  type?: "text" | "code" | "textarea" | "select";
  placeholder?: string;
  value?: string;
  note?: string;
  options?: { value: string; label: string }[];
}

export interface AskOptions {
  title: string;
  intro?: string;
  fields?: Field[];
  confirm?: string;
  danger?: boolean;
  /** Return an error string to keep the dialog open and show it. */
  onSubmit?(values: Record<string, string>): Promise<string | null>;
}

export function ask(o: AskOptions): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const fields = (o.fields ?? [])
      .map((f) => {
        const id = `f_${f.name}`;
        const input =
          f.type === "textarea"
            ? `<textarea id="${id}" placeholder="${f.placeholder ?? ""}">${f.value ?? ""}</textarea>`
            : f.type === "select"
              ? `<select id="${id}">${(f.options ?? [])
                  .map((op) => `<option value="${op.value}"${op.value === f.value ? " selected" : ""}>${op.label}</option>`)
                  .join("")}</select>`
              : `<input id="${id}" type="text" class="${f.type === "code" ? "code" : ""}" placeholder="${
                  f.placeholder ?? ""
                }" value="${f.value ?? ""}" autocomplete="off" ${f.type === "code" ? 'inputmode="numeric" maxlength="6"' : ""} />`;
        return `<div class="field"><label for="${id}">${f.label}</label>${input}${
          f.note ? `<div class="note">${f.note}</div>` : ""
        }</div>`;
      })
      .join("");

    const overlay = el(`
      <div class="overlay" role="dialog" aria-modal="true">
        <div class="modal">
          <header><h3>${o.title}</h3>${o.intro ? `<p>${o.intro}</p>` : ""}</header>
          <div class="content">${fields}<div class="err" id="err"></div></div>
          <footer>
            <button class="btn ghost" id="cancel">Cancel</button>
            <button class="btn" id="ok">${o.confirm ?? "Confirm"}</button>
          </footer>
        </div>
      </div>`);
    document.body.append(overlay);

    const err = overlay.querySelector<HTMLElement>("#err")!;
    const okBtn = overlay.querySelector<HTMLButtonElement>("#ok")!;
    const first = overlay.querySelector<HTMLInputElement>(".field input, .field textarea, .field select");
    first?.focus();

    const close = (result: Record<string, string> | null) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    };
    const values = (): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const f of o.fields ?? []) {
        out[f.name] = overlay.querySelector<HTMLInputElement>(`#f_${f.name}`)?.value.trim() ?? "";
      }
      return out;
    };
    const submit = async () => {
      err.textContent = "";
      okBtn.disabled = true;
      const v = values();
      try {
        const problem = o.onSubmit ? await o.onSubmit(v) : null;
        if (problem) {
          err.textContent = problem;
          okBtn.disabled = false;
          return;
        }
        close(v);
      } catch (e) {
        err.textContent = e instanceof Error ? e.message : "That did not work";
        okBtn.disabled = false;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(null);
      if (e.key === "Enter" && (e.target as HTMLElement)?.tagName !== "TEXTAREA") void submit();
    };
    document.addEventListener("keydown", onKey);
    okBtn.onclick = () => void submit();
    overlay.querySelector<HTMLButtonElement>("#cancel")!.onclick = () => close(null);
    overlay.onclick = (e) => {
      if (e.target === overlay) close(null);
    };
  });
}
