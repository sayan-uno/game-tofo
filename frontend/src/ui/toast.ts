let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (!container) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.getElementById("ui-root")!.appendChild(container);
  }
  return container;
}

export function toast(message: string, isError = false, durationMs = 3500) {
  const el = document.createElement("div");
  el.className = `toast${isError ? " toast-error" : ""}`;
  el.textContent = message;
  ensureContainer().appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, durationMs);
}

/** Toast with Accept / Decline buttons (used for lobby invites). */
export function actionToast(
  message: string,
  onAccept: () => void,
  onDecline: () => void,
  durationMs = 15000
) {
  const el = document.createElement("div");
  el.className = "toast toast-action";

  const text = document.createElement("div");
  text.textContent = message;
  el.appendChild(text);

  const row = document.createElement("div");
  row.className = "toast-buttons";
  const acceptBtn = document.createElement("button");
  acceptBtn.className = "btn btn-primary btn-small";
  acceptBtn.textContent = "Accept";
  const declineBtn = document.createElement("button");
  declineBtn.className = "btn btn-ghost btn-small";
  declineBtn.textContent = "Decline";
  row.append(acceptBtn, declineBtn);
  el.appendChild(row);

  const close = () => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  };
  const timer = setTimeout(() => {
    close();
    onDecline();
  }, durationMs);
  acceptBtn.onclick = () => {
    clearTimeout(timer);
    close();
    onAccept();
  };
  declineBtn.onclick = () => {
    clearTimeout(timer);
    close();
    onDecline();
  };

  ensureContainer().appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
}
