// GNOME window controls for GenOffice's tab strip on Linux, laid out as
// libadwaita lays out a header bar's: the buttons the desktop's
// button-layout names, on the side it puts them, each a 24 px circle in a
// 34 px button, 3 px apart, 7 px from the window edge and 6 px from the
// strip's own buttons. They replace Electron's title bar overlay, whose
// buttons and spacing cannot be changed.
(() => {
  const api = window.gnomeWindow;
  if (!api || !document.body.classList.contains("overlay-title-bar")) return;

  const ICONS = {
    minimize: "M4 10.0078h8v1.98828H4z",
    maximize: "M3.988281 3.992188v8.011718H12V3.992188zm2 2H10v4.011718H5.988281z",
    restore: "M4.988281 4.992188v6.011718H11V4.992188zm2 2H9v2.011718H6.988281z",
    close:
      "M4 4h1.03125c.253906.011719.511719.128906.6875.3125L8 6.59375l2.3125-2.28125c.265625-.230469.445312-.304688.6875-.3125h1v1c0 .285156-.035156.550781-.25.75L9.46875 8.03125l2.25 2.25c.1875.1875.28125.453125.28125.71875v1h-1c-.265625 0-.53125-.09375-.71875-.28125L8 9.4375l-2.28125 2.28125C5.53125 11.90625 5.265625 12 5 12H4v-1c0-.265625.09375-.53125.28125-.71875l2.28125-2.25L4.28125 5.75C4.070312 5.554688 3.976562 5.28125 4 5z",
  };
  const mask = (name) =>
    `url("data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="${ICONS[name]}"/></svg>`,
    )}")`;
  const LABELS = { minimize: "Minimize", maximize: "Maximize", close: "Close" };

  const style = document.createElement("style");
  style.textContent = `
body.gnome-csd .tab-bar-caption-spacer,
body.gnome-csd .tab-bar-drag-spacer.gnome-start {
  width: auto;
  display: flex;
  align-items: center;
}
.gnome-controls {
  display: flex;
  align-items: center;
  gap: 3px;
  -webkit-app-region: no-drag;
  transition: filter 200ms ease-out;
}
.tab-bar-caption-spacer > .gnome-controls { margin: 0 7px 0 6px; }
/* its 8 px right margin was room before the overlay's buttons */
.tab-overflow-btn:has(+ .tab-bar-caption-spacer > .gnome-controls) { margin-right: 0; }
.tab-bar-drag-spacer > .gnome-controls { margin: 0 6px 0 7px; }
body.gnome-backdrop .gnome-controls { filter: opacity(0.5); }
.gnome-controls > button {
  -webkit-app-region: no-drag;
  box-sizing: border-box;
  width: 34px;
  height: 34px;
  padding: 5px;
  margin: 0;
  border: 0;
  background: none;
  color: var(--tabstrip-text-active, #1f1f1f);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: default;
}
.gnome-controls > button > span {
  width: 24px;
  height: 24px;
  border-radius: 100%;
  background-color: color-mix(in srgb, currentColor 10%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 200ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
}
.gnome-controls > button:hover > span { background-color: color-mix(in srgb, currentColor 15%, transparent); }
.gnome-controls > button:active > span { background-color: color-mix(in srgb, currentColor 30%, transparent); }
.gnome-controls > button:focus-visible > span { outline: 2px solid color-mix(in srgb, #3584e4 50%, transparent); outline-offset: 1px; }
.gnome-controls i {
  width: 16px;
  height: 16px;
  background-color: currentColor;
  -webkit-mask: var(--icon) center / 16px 16px no-repeat;
}`;
  document.head.appendChild(style);

  let state = { layout: "appmenu:minimize,maximize,close", maximized: false, focused: true };

  const buttons = (names) => {
    const box = document.createElement("div");
    box.className = "gnome-controls";
    for (const name of names) {
      const button = document.createElement("button");
      button.dataset.action = name;
      button.title = LABELS[name];
      button.setAttribute("aria-label", LABELS[name]);
      button.addEventListener("click", () => api.action(name));
      const circle = document.createElement("span");
      circle.appendChild(document.createElement("i"));
      button.appendChild(circle);
      box.appendChild(button);
    }
    return box;
  };

  const sides = () => {
    const [start = "", end = ""] = state.layout.split(":");
    const pick = (side) => side.split(",").map((s) => s.trim()).filter((s) => s in LABELS);
    return { start: pick(start), end: pick(end) };
  };

  const paint = () => {
    for (const button of document.querySelectorAll(".gnome-controls > button")) {
      const name = button.dataset.action === "maximize" && state.maximized ? "restore" : button.dataset.action;
      button.querySelector("i").style.setProperty("--icon", mask(name));
      if (button.dataset.action === "maximize") {
        const label = state.maximized ? "Restore" : "Maximize";
        button.title = label;
        button.setAttribute("aria-label", label);
      }
    }
    document.body.classList.toggle("gnome-backdrop", !state.focused);
  };

  // React may render or re-render the strip at any time: put the controls
  // back wherever they are missing.
  const place = () => {
    const { start, end } = sides();
    const lead = document.querySelector(".tab-bar-drag-spacer");
    const trail = document.querySelector(".tab-bar-caption-spacer");
    let changed = false;
    if (lead && start.length && !lead.querySelector(".gnome-controls")) {
      lead.classList.add("gnome-start");
      lead.appendChild(buttons(start));
      changed = true;
    }
    if (trail && end.length && !trail.querySelector(".gnome-controls")) {
      trail.appendChild(buttons(end));
      changed = true;
    }
    if (changed) paint();
  };

  document.body.classList.add("gnome-csd");
  api.onMaximized((maximized) => {
    state.maximized = maximized;
    paint();
  });
  api.onFocused((focused) => {
    state.focused = focused;
    paint();
  });
  api.state().then((initial) => {
    state = { ...state, ...initial };
    place();
    new MutationObserver(place).observe(document.body, { childList: true, subtree: true });
  });
})();
