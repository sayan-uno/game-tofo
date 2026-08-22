// The event controller: what players are shown when they arrive.
//
// PINNING is the whole point. An unpinned event sits in the list for anybody
// who goes looking; a pinned one is put in front of every player the next time
// they arrive — a fresh sign-in or a reload, and not again until the next one.
// That restraint is deliberate and worth keeping: an event that reappears
// every time somebody switches tabs teaches them to close it without reading.
import { ApiFailure, call, fetchBlobUrl } from "../api";
import { ask } from "../modal";
import { withSudo } from "../sudo";
import { esc, pill, table, toast, when } from "../ui";

interface EventRow {
  id: string;
  title: string;
  kind: "image" | "video" | "html";
  body: string;
  pinned: boolean;
  itemId: string | null;
  createdAt: string;
  deletedAt: string | null;
}

interface Item {
  id: string;
  name: string;
  kind: string;
  withdrawn: boolean;
}

/** Read a chosen file as a data URL. The upload goes through the console's own
 *  API rather than a link to somebody else's server: a link can change after
 *  it is approved, vanish on a Sunday, or count who looked at it. */
const asDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read that file"));
    r.readAsDataURL(file);
  });

/** The uploaded file at its own size, over everything.
 *
 *  Contained rather than cropped: an admin checking a banner needs to see what
 *  players will see, and a picture cropped to a neat rectangle is a different
 *  picture. */
function lightbox(url: string, title: string, isVideo: boolean): void {
  document.querySelector(".ev-lightbox")?.remove();
  const el = document.createElement("div");
  el.className = "ev-lightbox";
  const inner = document.createElement("div");
  inner.className = "ev-lightbox-inner";
  const media = isVideo ? document.createElement("video") : document.createElement("img");
  media.src = url;
  if (media instanceof HTMLVideoElement) {
    media.controls = true;
    media.autoplay = true;
    media.loop = true;
  } else {
    media.alt = title;
  }
  const cap = document.createElement("div");
  cap.className = "ev-lightbox-cap";
  cap.textContent = title;
  inner.append(media, cap);
  el.appendChild(inner);
  // Click anywhere to dismiss: there is nothing else to do here, so a target
  // to hit would only be something to miss.
  el.onclick = () => el.remove();
  document.body.appendChild(el);
}

export function mountEvents(host: HTMLElement, role: string): () => void {
  let cancelled = false;
  const senior = role === "admin" || role === "owner";
  let items: Item[] = [];
  host.innerHTML = `<p class="empty">Loading…</p>`;

  const draw = (events: EventRow[]) => {
    const pinned = events.filter((e) => e.pinned && !e.deletedAt).length;
    host.innerHTML = `
      <div class="card">
        <div class="pad" style="font-size:13.5px">
          A picture, a clip, or a piece of HTML. <strong>Pinned</strong> events are put in front of every
          player the next time they arrive — a fresh sign-in or a reload, not every time they switch tabs.
          Attach an item and the event becomes a way into the collection with that thing already selected.
          ${pinned > 0 ? `<strong>${pinned} pinned.</strong>` : ""}
        </div>
        <div class="pad"><button class="btn" id="new" ${senior ? "" : "disabled"}>New event</button></div>
      </div>
      <div class="card">
        <header><h2>Events</h2><span class="spacer"></span><span class="count">${events.length}</span></header>
        ${table(
          ["Made", "Title", "What", "Opens", "", ""].map((h) => `<th>${h}</th>`),
          events.map(
            (e) => `<tr class="${e.deletedAt ? "forfeit" : ""}">
              <td class="muted">${when(e.createdAt)}</td>
              <td><strong>${esc(e.title)}</strong></td>
              <td class="muted">${
                e.kind === "html" ? "html" : `<span class="ev-thumb" data-media="${esc(e.id)}"></span>`
              }</td>
              <td class="muted mono">${e.itemId ? esc(e.itemId) : "—"}</td>
              <td>${
                e.deletedAt ? pill("deleted", "bad") : e.pinned ? pill("pinned", "warn") : pill("in the list", "on")
              }</td>
              <td>${
                e.deletedAt || !senior
                  ? ""
                  : `<button class="btn ghost" data-pin="${esc(e.id)}" data-on="${e.pinned ? "0" : "1"}">${
                      e.pinned ? "Unpin" : "Pin it"
                    }</button>
                     <button class="btn ghost" data-del="${esc(e.id)}">Delete</button>`
              }</td>
            </tr>`
          ),
          "Nothing has been made yet."
        )}
      </div>`;

    host.querySelector<HTMLButtonElement>("#new")?.addEventListener("click", async () => {
      // The file picker lives outside the dialog: a modal cannot hold a File
      // object in a text field, and reading it here keeps the dialog's own
      // contract — strings in, string out — intact.
      let chosen: { dataUrl: string; name: string } | null = null;
      const picker = document.createElement("input");
      picker.type = "file";
      picker.accept = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm";

      const answer = await ask({
        title: "New event",
        intro: "Upload a picture or a clip, or write the HTML yourself.",
        confirm: "Create it",
        fields: [
          { name: "title", label: "Title", placeholder: "e.g. Seraph is here" },
          {
            name: "kind",
            label: "What it is",
            type: "select",
            value: "image",
            options: [
              { value: "image", label: "A picture" },
              { value: "video", label: "A clip" },
              { value: "html", label: "HTML I will write" },
            ],
          },
          { name: "html", label: "HTML (only for the HTML kind)", type: "textarea" },
          {
            // A LIST, not a box to type an id into. The id has to match the
            // catalogue exactly or the event opens the collection at nothing,
            // and asking somebody to remember "crimson-fang" while looking at
            // a picture called "Crimson Fang" is asking for the one mistake
            // this field can make.
            name: "itemId",
            label: "Opens the collection at",
            type: "select",
            value: "",
            options: [
              { value: "", label: "Nothing — just show it" },
              // Withdrawn things are not offered: an event that sends players
              // to something they cannot see is worse than one that sends them
              // nowhere.
              ...items
                .filter((i) => !i.withdrawn)
                .map((i) => ({ value: i.id, label: `${i.name} — ${i.kind} (${i.id})` })),
            ],
          },
          {
            name: "pinned",
            label: "Show it on arrival",
            type: "select",
            value: "yes",
            options: [
              { value: "yes", label: "Yes — pin it" },
              { value: "no", label: "No — just list it" },
            ],
          },
        ],
        async onSubmit(v) {
          if (v.title.trim().length < 2) return "Give it a title.";
          let body = v.html;
          if (v.kind !== "html") {
            if (!chosen) {
              // Ask for the file at the moment it is needed, so somebody who
              // picked HTML is never made to choose one.
              const picked = await new Promise<File | null>((resolve) => {
                picker.onchange = () => resolve(picker.files?.[0] ?? null);
                picker.click();
              });
              if (!picked) return "Choose a file to upload.";
              chosen = { dataUrl: await asDataUrl(picked), name: picked.name };
            }
            body = chosen.dataUrl;
          }
          if (!body?.trim()) return "There is nothing to show.";
          try {
            const done = await withSudo(() =>
              call("/events", {
                method: "POST",
                body: JSON.stringify({
                  title: v.title,
                  kind: v.kind,
                  body,
                  pinned: v.pinned === "yes",
                  itemId: v.itemId,
                }),
              })
            );
            return done === null ? "Cancelled." : null;
          } catch (e) {
            return e instanceof ApiFailure ? e.info.error : "That did not work";
          }
        },
      });
      if (answer) {
        toast("Event created.");
        void load();
      }
    });

    // The picture itself, not just the word "image". An admin reviewing what is
    // pinned to the whole platform should be looking at it, not remembering it.
    //
    // Fetched and turned into a blob rather than set as a src: the console's
    // API wants a bearer token and an <img> tag cannot send one — the same
    // reason the players' media route had to be public.
    host.querySelectorAll<HTMLElement>("[data-media]").forEach((slot) => {
      const row = events.find((x) => x.id === slot.dataset.media);
      void fetchBlobUrl(`/events/${encodeURIComponent(slot.dataset.media!)}/media`)
        .then((url) => {
          if (row?.kind === "video") {
            const v = document.createElement("video");
            v.src = url;
            v.muted = true;
            v.loop = true;
            v.autoplay = true;
            slot.replaceChildren(v);
            slot.classList.add("clickable");
            slot.onclick = () => lightbox(url, row?.title ?? "", true);
            return;
          }
          const img = document.createElement("img");
          img.src = url;
          img.alt = row?.title ?? "";
          slot.replaceChildren(img);
          // A thumbnail is for recognising which row this is; reviewing what
          // is pinned to the whole platform needs the real thing.
          slot.classList.add("clickable");
          slot.onclick = () => lightbox(url, row?.title ?? "", false);
        })
        .catch(() => {
          slot.textContent = row?.deletedAt ? "gone" : "no file";
        });
    });

    host.querySelectorAll<HTMLButtonElement>("[data-pin]").forEach((btn) => {
      btn.onclick = async () => {
        try {
          const done = await withSudo(() =>
            call<{ ok: boolean }>(`/events/${encodeURIComponent(btn.dataset.pin!)}/pin`, {
              method: "POST",
              body: JSON.stringify({ on: btn.dataset.on === "1" }),
            })
          );
          if (done === null) return;
          toast(btn.dataset.on === "1" ? "Pinned — players see it on arrival." : "Unpinned.");
          void load();
        } catch (e) {
          toast(e instanceof ApiFailure ? e.info.error : "That did not work");
        }
      };
    });

    host.querySelectorAll<HTMLButtonElement>("[data-del]").forEach((btn) => {
      btn.onclick = async () => {
        const answer = await ask({
          title: "Delete this event?",
          intro: "It disappears from every player's list and stops being shown on arrival.",
          confirm: "Delete it",
          danger: true,
          async onSubmit() {
            try {
              const done = await withSudo(() =>
                call<{ ok: boolean }>(`/events/${encodeURIComponent(btn.dataset.del!)}`, { method: "DELETE" })
              );
              return done === null ? "Cancelled." : null;
            } catch (e) {
              return e instanceof ApiFailure ? e.info.error : "That did not work";
            }
          },
        });
        if (answer) {
          toast("Deleted.");
          void load();
        }
      };
    });
  };

  const load = async () => {
    try {
      const [{ events }, cat] = await Promise.all([
        call<{ events: EventRow[] }>("/events"),
        call<{ items: Item[] }>("/collection").catch(() => ({ items: [] as Item[] })),
      ]);
      items = cat.items;
      if (!cancelled) draw(events);
    } catch {
      if (!cancelled) host.innerHTML = `<div class="card"><p class="empty">Could not read the events.</p></div>`;
    }
  };

  void load();
  return () => {
    cancelled = true;
  };
}
