/** Monogram-first player avatar.
 *
 *  The letter tile IS the element — a Google photo, when the account has one,
 *  is layered over it and simply removed if it never loads (those URLs can
 *  404 or get rate-limited). So there is never a broken-image flash, never a
 *  second layout pass, and no avatar-less state to design around.
 */
export function setAvatar(el: HTMLElement, name: string, avatarUrl: string | null) {
  // [...name] walks code points, so an emoji tag yields the whole glyph.
  const initial = ([...name.trim()][0] ?? "?").toUpperCase();
  el.classList.add("avatar");
  el.textContent = "";

  const mono = document.createElement("i");
  mono.className = "avatar-mono";
  mono.textContent = initial;
  el.appendChild(mono);

  if (!avatarUrl) return;
  const img = document.createElement("img");
  img.className = "avatar-img";
  img.alt = "";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.onerror = () => img.remove();
  img.src = avatarUrl;
  el.appendChild(img);
}
