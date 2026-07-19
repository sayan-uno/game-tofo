/** Action sheet shown when the group leader taps a teammate's character:
 *  transfer leadership or kick. Built on demand and removed on any action —
 *  no persistent DOM or listeners while closed. */
export function showMemberMenu(
  memberName: string,
  actions: { onTransfer: () => void; onKick: () => void }
): void {
  document.querySelector(".member-menu-backdrop")?.remove(); // one at a time

  const backdrop = document.createElement("div");
  backdrop.className = "member-menu-backdrop";
  const menu = document.createElement("div");
  menu.className = "member-menu";

  const title = document.createElement("div");
  title.className = "member-menu-title";
  title.textContent = memberName;

  const close = () => backdrop.remove();
  const makeBtn = (label: string, className: string, onClick?: () => void) => {
    const btn = document.createElement("button");
    btn.className = className;
    btn.textContent = label;
    btn.onclick = () => {
      close();
      onClick?.();
    };
    return btn;
  };

  menu.append(
    title,
    makeBtn("👑 Make Leader", "btn btn-primary", actions.onTransfer),
    makeBtn("Kick from group", "btn btn-ghost btn-danger", actions.onKick),
    makeBtn("Cancel", "btn btn-ghost")
  );
  backdrop.appendChild(menu);
  // Tap outside the card closes it.
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close();
  };
  document.getElementById("ui-root")!.appendChild(backdrop);
}
