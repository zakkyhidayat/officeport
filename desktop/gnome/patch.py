"""Patch an extracted GenOffice app.asar (out/main, out/preload, out/renderer)
so the shell window on Linux draws GNOME window controls (gnome-controls.js)
in place of Electron's title bar overlay.

Usage: python3 -I patch.py EXTRACTED_APP_DIR
"""
import pathlib
import shutil
import sys

app = pathlib.Path(sys.argv[1])
here = pathlib.Path(__file__).resolve().parent


def patch(path, old, new, marker):
    text = path.read_text()
    if marker in text:
        return
    if text.count(old) != 1:
        sys.exit(f"{path}: expected one match for {old[:60]!r}, found {text.count(old)}")
    path.write_text(text.replace(old, new))


main = app / "out/main/index.js"
patch(
    main,
    "titleBarOverlay: tabStripOverlay(require$$1$1.nativeTheme.shouldUseDarkColors, currentUiScale),\n      autoHideMenuBar: true",
    "// GNOME: no overlay; the strip draws the window controls itself\n"
    "      ...process.platform === \"linux\" ? {} : { titleBarOverlay: tabStripOverlay(require$$1$1.nativeTheme.shouldUseDarkColors, currentUiScale) },\n"
    "      autoHideMenuBar: true",
    "GNOME: no overlay",
)
patch(
    main,
    'if (process.platform === "darwin" || !shellWindow || shellWindow.isDestroyed()) return;\n  shellWindow.setTitleBarOverlay(',
    'if (process.platform === "darwin" || process.platform === "linux" || !shellWindow || shellWindow.isDestroyed()) return;\n  shellWindow.setTitleBarOverlay(',
    'process.platform === "linux" || !shellWindow',
)
MAIN_TAIL = """
// GNOME window controls (gnome-controls.js): the desktop's button layout,
// the window's maximized and focused state, and the buttons' actions.
(() => {
  if (process.platform !== "linux") return;
  const { ipcMain, BrowserWindow } = require("electron");
  const { execFileSync } = require("node:child_process");
  const buttonLayout = () => {
    try {
      return execFileSync("gsettings", ["get", "org.gnome.desktop.wm.preferences", "button-layout"], { encoding: "utf8", timeout: 1000 })
        .trim()
        .replace(/^'|'$/g, "");
    } catch {
      return "appmenu:minimize,maximize,close";
    }
  };
  const watched = new WeakSet();
  ipcMain.handle("gnomewin:state", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    if (!watched.has(win)) {
      watched.add(win);
      const send = (channel, value) => {
        if (!event.sender.isDestroyed()) event.sender.send(channel, value);
      };
      win.on("maximize", () => send("gnomewin:maximized", true));
      win.on("unmaximize", () => send("gnomewin:maximized", false));
      win.on("focus", () => send("gnomewin:focused", true));
      win.on("blur", () => send("gnomewin:focused", false));
    }
    return { layout: buttonLayout(), maximized: win.isMaximized(), focused: win.isFocused() };
  });
  ipcMain.on("gnomewin:action", (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === "minimize") win.minimize();
    else if (action === "maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === "close") win.close();
  });
})();
"""
text = main.read_text()
if "gnomewin:state" not in text:
    main.write_text(text + MAIN_TAIL)

preload = app / "out/preload/index.js"
PRELOAD_TAIL = """
if (process.platform === "linux") {
  electron.contextBridge.exposeInMainWorld("gnomeWindow", {
    state: () => electron.ipcRenderer.invoke("gnomewin:state"),
    action: (name) => electron.ipcRenderer.send("gnomewin:action", name),
    onMaximized: (callback) => electron.ipcRenderer.on("gnomewin:maximized", (_event, value) => callback(value)),
    onFocused: (callback) => electron.ipcRenderer.on("gnomewin:focused", (_event, value) => callback(value))
  });
}
"""
text = preload.read_text()
if "gnomeWindow" not in text:
    preload.write_text(text + PRELOAD_TAIL)

html = app / "out/renderer/index.html"
shutil.copy(here / "gnome-controls.js", app / "out/renderer/assets/gnome-controls.js")
text = html.read_text()
if "gnome-controls.js" not in text:
    anchor = '<link rel="stylesheet"'
    if text.count(anchor) != 1:
        sys.exit(f"{html}: stylesheet link not found")
    html.write_text(text.replace(anchor, '<script type="module" src="./assets/gnome-controls.js"></script>\n    ' + anchor))

print("patched", app)
